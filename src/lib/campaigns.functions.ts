import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { checkTelephonyAccess, walletCanAffordOutbound } from "@/lib/telephony-guard.server";

/**
 * Campaign lifecycle transitions (spec §24/§36/§37/§38). Creating/editing a
 * *draft* campaign's own config columns happens through direct
 * Supabase/RLS writes from the client (same pattern as agent_configs,
 * businesses, services) — the `campaigns` migration's column-level grants
 * already restrict that to config fields, never `status`. Every actual
 * status transition goes through one of the functions below instead, so the
 * full authorization/readiness/billing chain from spec §24 step "When
 * clicked" always re-runs server-side, exactly like handoverClient's
 * provisioning-readiness gate for going ACTIVE.
 *
 * Launching does not itself place any call — it only proves the campaign is
 * dialable and flips status to "running". campaign-dispatch.server.ts (run
 * by the cron-authenticated dispatch route) is the only thing that ever
 * calls out to Sarvam, one contact at a time, respecting the campaign's own
 * calling window/retry rules.
 */

/** The campaign's own organization, once the caller may act on it (dial: owner or admin). */
async function campaignOrgId(
  context: { supabase: unknown; userId: string },
  campaignId: string,
  dial: boolean,
): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { campaignOrganizationForCaller } = await import("@/lib/outbound-authorization.server");
  return campaignOrganizationForCaller(
    { supabase: context.supabase as typeof supabaseAdmin, supabaseAdmin },
    context.userId,
    campaignId,
    { dial },
  );
}

interface LaunchCampaignInput {
  campaignId: string;
}

export const launchCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: LaunchCampaignInput) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const orgId = await campaignOrgId(context, data.campaignId, true);
    // The global outbound kill switch: no campaign starts or resumes while it is on.
    const {
      outboundCallingDisabled,
      outboundEmergencyStopActive,
      OUTBOUND_DISABLED_MESSAGE,
      OUTBOUND_EMERGENCY_STOP_MESSAGE,
    } = await import("@/lib/outbound-eligibility.server");
    if (outboundCallingDisabled()) throw new Error(OUTBOUND_DISABLED_MESSAGE);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // The database emergency stop (fails closed): no campaign starts or resumes.
    if (await outboundEmergencyStopActive(supabaseAdmin))
      throw new Error(OUTBOUND_EMERGENCY_STOP_MESSAGE);

    const { data: campaign } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("id", data.campaignId)
      .maybeSingle();
    if (!campaign || campaign.organization_id !== orgId) throw new Error("Campaign not found.");
    if (!["draft", "scheduled", "paused"].includes(campaign.status))
      throw new Error(`Campaign is already ${campaign.status}.`);

    if (!campaign.agent_config_id) throw new Error("Choose an AI voice agent before launching.");
    // Retries only for unanswered calls, at least 15 minutes apart (also a database constraint).
    const { retrySettingsProblem } = await import("@/lib/campaign-outcome");
    const retryProblem = retrySettingsProblem(campaign);
    if (retryProblem) throw new Error(retryProblem);
    // Every call says only what the customer reviewed; the dispatcher refuses otherwise too.
    if (!campaign.context_reviewed_at)
      throw new Error("Review and save what the AI should say on these calls before launching.");
    if (!campaign.phone_number_id) throw new Error("Choose a caller number before launching.");

    // 1. Number is entitled + active + outbound-enabled (spec §24 steps 5-6),
    // reusing the exact same gate the single-call outbound path already uses
    // — no second authorization system for campaigns.
    const gate = await checkTelephonyAccess(orgId, campaign.phone_number_id, "outbound");
    if (!gate.allowed || !gate.phoneNumber)
      throw new Error(gate.reason ?? "This number cannot make outbound calls.");

    // 2. The agent must already be mapped to a real Sarvam app+version and
    // the number's connection must already be registered — same
    // prerequisites createSarvamInstantOutboundCall enforces per call, just
    // checked once up front here so launch fails fast with a clear reason
    // instead of every contact silently failing one at a time.
    if (gate.phoneNumber.provider === "sarvam") {
      if (!gate.phoneNumber.connection_id)
        throw new Error("This number has no telephony connection configured.");
      const { data: connection } = await supabaseAdmin
        .from("telephony_connections")
        .select("provider, provider_connection_id")
        .eq("id", gate.phoneNumber.connection_id)
        .maybeSingle();
      if (!connection || connection.provider !== "sarvam" || !connection.provider_connection_id)
        throw new Error(
          "This number's Sarvam connection has not been registered yet — contact support.",
        );

      const { data: agentConfig } = await supabaseAdmin
        .from("agent_configs")
        .select(
          "organization_id, sarvam_app_id, sarvam_outbound_app_id, sarvam_outbound_app_version, sarvam_outbound_ready_app_id, sarvam_outbound_ready_version",
        )
        .eq("id", campaign.agent_config_id)
        .maybeSingle();
      if (!agentConfig || agentConfig.organization_id !== orgId)
        throw new Error("This campaign's agent does not belong to this organization.");
      // Only the customer's registered, confirmed outbound agent (never the inbound one).
      const { isOutboundReady, OUTBOUND_NOT_READY_MESSAGE } =
        await import("@/lib/sarvam-outbound-mode.server");
      if (!isOutboundReady(agentConfig)) throw new Error(OUTBOUND_NOT_READY_MESSAGE);
    }

    // 3. Billing: at least one call must be affordable right now (spec §43).
    // The dispatcher re-checks this before every single dial too — this is
    // just a fast, honest fail at launch time rather than silently queuing
    // a campaign that can never actually dial.
    const affordable = await walletCanAffordOutbound(orgId);
    if (!affordable) throw new Error("Insufficient wallet balance to launch this campaign.");

    // 4. There must be someone to call.
    const { count: pendingCount } = await supabaseAdmin
      .from("campaign_contacts")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", data.campaignId)
      .in("status", ["pending", "retry_scheduled"]);
    if (!pendingCount || pendingCount === 0)
      throw new Error("Add at least one contact before launching this campaign.");

    // 5. Only ClickAI's own dispatcher dials campaigns. The Sarvam-paced
    // cohort mode would skip ClickAI's calling hours, country, do-not-call
    // re-check, wallet, budget and in-flight limits, so it is refused.
    if (campaign.dispatch_mode === "sarvam_campaign")
      throw new Error(
        "Sarvam-paced campaigns are not available: every campaign call goes through ClickAI's own safety checks. Switch this campaign to instant_outbound_fallback.",
      );

    // Only from the status checked above: a cancel that landed meanwhile wins.
    const { data: launched, error: launchError } = await supabaseAdmin
      .from("campaigns")
      .update({ status: "running", launched_at: new Date().toISOString() })
      .eq("id", data.campaignId)
      .in("status", ["draft", "scheduled", "paused"])
      .select("id");
    if (launchError) throw launchError;
    if (!launched?.length) throw new Error("The campaign changed status; reload and try again.");

    return { ok: true };
  });

interface CampaignActionInput {
  campaignId: string;
}

function simpleTransition(
  fromStatuses: string[],
  toStatus: string,
  timestampColumn: string | null,
  dial: boolean,
) {
  return createServerFn({ method: "POST" })
    .middleware([requireSupabaseAuth])
    .inputValidator((input: CampaignActionInput) => {
      if (!input?.campaignId) throw new Error("campaignId is required");
      return input;
    })
    .handler(async ({ data, context }) => {
      const orgId = await campaignOrgId(context, data.campaignId, dial);
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: campaign } = await supabaseAdmin
        .from("campaigns")
        .select("id, organization_id, status")
        .eq("id", data.campaignId)
        .maybeSingle();
      if (!campaign || campaign.organization_id !== orgId) throw new Error("Campaign not found.");
      if (!fromStatuses.includes(campaign.status))
        throw new Error(`Campaign is ${campaign.status}, not ${fromStatuses.join(" or ")}.`);

      const patch: Record<string, unknown> = { status: toStatus };
      if (timestampColumn) patch[timestampColumn] = new Date().toISOString();
      // Only from the allowed statuses: a cancel that landed meanwhile is never undone.
      const { data: moved, error } = await supabaseAdmin
        .from("campaigns")
        .update(patch as never)
        .eq("id", data.campaignId)
        .in("status", fromStatuses)
        .select("id");
      if (error) throw error;
      if (!moved?.length) throw new Error("The campaign changed status; reload and try again.");
      return { ok: true };
    });
}

/** Pause: stops the dispatcher from claiming any more due contacts for this campaign. In-flight calls finish normally. */
export const pauseCampaign = simpleTransition(["running"], "paused", "paused_at", false);

/** Resume: identical readiness bar as launch is deliberately NOT re-run here — spec §38 only requires pause->edit->resume for fields that need it; resuming without editing should not re-block on transient billing dips the dispatcher itself already re-checks per call. */
/** Resuming re-runs every launch check (kill switch, emergency stop, number, agent, context, wallet, contacts). */
export const resumeCampaign = launchCampaign;

export const cancelCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CampaignActionInput) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const orgId = await campaignOrgId(context, data.campaignId, false);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: campaign } = await supabaseAdmin
      .from("campaigns")
      .select("id, organization_id, status")
      .eq("id", data.campaignId)
      .maybeSingle();
    if (!campaign || campaign.organization_id !== orgId) throw new Error("Campaign not found.");
    if (["completed", "cancelled"].includes(campaign.status))
      throw new Error(`Campaign is already ${campaign.status}.`);

    const { data: cancelled, error: cancelError } = await supabaseAdmin
      .from("campaigns")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", data.campaignId)
      .not("status", "in", "(completed,cancelled)")
      .select("id");
    if (cancelError) throw cancelError;
    if (!cancelled?.length) throw new Error("The campaign changed status; reload and try again.");
    // Never dial a not-yet-attempted contact from a cancelled campaign.
    await supabaseAdmin
      .from("campaign_contacts")
      .update({ status: "cancelled", next_attempt_at: null })
      .eq("campaign_id", data.campaignId)
      .in("status", ["pending", "retry_scheduled", "queued"]);

    return { ok: true };
  });

/** Sets or removes the campaign budget (paise). Not while running: pause first. */
export const setCampaignBudget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { campaignId: string; budgetLimit: number | null }) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    const b = input.budgetLimit;
    if (b !== null && !(Number.isInteger(b) && b > 0))
      throw new Error("The budget must be a whole number of paise above zero, or empty.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const orgId = await campaignOrgId(context, data.campaignId, true);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: updated, error } = await supabaseAdmin
      .from("campaigns")
      .update({ budget_limit: data.budgetLimit })
      .eq("id", data.campaignId)
      .eq("organization_id", orgId)
      .in("status", ["draft", "scheduled", "paused"])
      .select("id");
    if (error) throw error;
    if (!updated?.length) throw new Error("Pause the campaign before changing its budget.");
    return { ok: true };
  });

export interface CampaignStats {
  totalContacts: number;
  byStatus: Record<string, number>;
  report: import("@/lib/campaign-results").CampaignReport;
  /** Paise: what billed calls cost, and the worst case still reserved by open calls. */
  spent: number;
  reserved: number;
  budgetLimit: number | null;
  /** The outbound agent cannot book; bookings are never reported as campaign conversions. */
  bookingCapable: false;
}

export const getCampaignStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { campaignId: string }) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    return input;
  })
  .handler(async ({ data, context }): Promise<CampaignStats> => {
    const orgId = await campaignOrgId(context, data.campaignId, false);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: campaign } = await supabaseAdmin
      .from("campaigns")
      .select("id, organization_id, budget_limit")
      .eq("id", data.campaignId)
      .maybeSingle();
    if (!campaign || campaign.organization_id !== orgId) throw new Error("Campaign not found.");

    const [{ data: rows }, { data: calls }] = await Promise.all([
      supabaseAdmin
        .from("campaign_contacts")
        .select("status, attempts, excluded_reason, output_variables")
        .eq("campaign_id", data.campaignId)
        .eq("organization_id", orgId),
      supabaseAdmin
        .from("call_logs")
        .select(
          "status, customer_charge, billing_applied_at, billing_cap_minutes, billing_rate_per_minute, resolution_source",
        )
        .eq("campaign_id", data.campaignId)
        .eq("organization_id", orgId),
    ]);

    const byStatus: Record<string, number> = {};
    for (const row of rows ?? []) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    }
    const { buildCampaignReport } = await import("@/lib/campaign-results");
    const { campaignSpend } = await import("@/lib/campaign-results");
    const spend = campaignSpend(calls ?? []);
    return {
      totalContacts: rows?.length ?? 0,
      byStatus,
      report: buildCampaignReport(rows ?? []),
      spent: spend.spent,
      reserved: spend.reserved,
      budgetLimit: campaign.budget_limit ?? null,
      bookingCapable: false,
    };
  });
