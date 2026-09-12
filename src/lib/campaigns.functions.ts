import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { checkTelephonyAccess, walletCanAffordOutbound } from "@/lib/telephony-guard.server";
import { getTelephonyAdapter } from "@/lib/telephony.server";
import { SarvamTelephonyAdapter } from "@/lib/telephony/sarvam-provider.server";
import { buildCohortPayload } from "@/lib/campaign-cohort";

/**
 * Platform-wide kill switch for the experimental `sarvam_campaign` dispatch
 * mode (spec "THIRD"/"SIXTH"). Defaults closed: unless an operator has
 * explicitly set KLYRO_DISPATCH_MODE=sarvam_campaign in the server
 * environment, EVERY campaign dials through instant_outbound_fallback
 * regardless of what its own `dispatch_mode` column says — a per-campaign
 * setting can request the experimental mode, but only this env var can
 * actually arm it platform-wide. This is the "never silently switch"
 * requirement: a campaign stuck wanting sarvam_campaign mode while this is
 * off fails launch with an explicit error, it never silently falls back.
 */
function sarvamCampaignModeArmed(): boolean {
  return process.env["KLYRO_DISPATCH_MODE"] === "sarvam_campaign";
}

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

async function resolveOrgId(context: { supabase: unknown; userId: string }): Promise<string> {
  const supabase = context.supabase as import("@supabase/supabase-js").SupabaseClient;
  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", context.userId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (!membership) throw new Error("No workspace found for this account");
  return membership.organization_id as string;
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
    const orgId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: campaign } = await supabaseAdmin
      .from("campaigns")
      .select("*")
      .eq("id", data.campaignId)
      .maybeSingle();
    if (!campaign || campaign.organization_id !== orgId) throw new Error("Campaign not found.");
    if (!["draft", "scheduled", "paused"].includes(campaign.status))
      throw new Error(`Campaign is already ${campaign.status}.`);

    if (!campaign.agent_config_id) throw new Error("Choose an AI voice agent before launching.");
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
        .select("organization_id, sarvam_app_id, sarvam_app_version")
        .eq("id", campaign.agent_config_id)
        .maybeSingle();
      if (!agentConfig || agentConfig.organization_id !== orgId)
        throw new Error("This campaign's agent does not belong to this organization.");
      if (!agentConfig.sarvam_app_id || !agentConfig.sarvam_app_version)
        throw new Error(
          "This campaign's agent has not been mapped to a Sarvam app yet — contact support.",
        );
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

    // 5. Dispatch mode (spec "THIRD"/"SIXTH"): sarvam_campaign is never
    // entered silently. Either it's fully armed and configured, or launch
    // fails with an explicit, actionable reason — it never falls back to
    // instant_outbound_fallback on its own.
    if (campaign.dispatch_mode === "sarvam_campaign") {
      if (!sarvamCampaignModeArmed()) {
        throw new Error(
          "This campaign is set to sarvam_campaign dispatch mode, but that mode is not armed on this platform (KLYRO_DISPATCH_MODE is not set to sarvam_campaign). Switch this campaign to instant_outbound_fallback, or ask an operator to arm sarvam_campaign mode.",
        );
      }
      if (!campaign.provider_campaign_id) {
        throw new Error(
          "This campaign has no Sarvam campaign mapped (provider_campaign_id is unset). An admin must create the campaign in Sarvam's dashboard and record its id before launching in sarvam_campaign mode.",
        );
      }
      await launchViaSarvamCampaign(campaign, orgId);
    }

    await supabaseAdmin
      .from("campaigns")
      .update({ status: "running", launched_at: new Date().toISOString() })
      .eq("id", data.campaignId);

    return { ok: true };
  });

/**
 * EXPERIMENTAL, PARTIAL — sarvam_campaign dispatch mode's launch action:
 * uploads every pending campaign_contact as one Sarvam cohort via
 * uploadCohort. Per that function's doc, the underlying endpoint's schema
 * is MEDIUM-confidence, not independently verified against a live response
 * — this code path only runs at all when KLYRO_DISPATCH_MODE=sarvam_campaign
 * is explicitly set (see sarvamCampaignModeArmed above), which an operator
 * should not do until it has been exercised with a real test contact (spec
 * "SIXTH").
 *
 * KNOWN GAP, DELIBERATELY NOT BUILT: after this upload, campaign_contacts
 * are marked "queued" and STAY there — there is no code path that ever
 * moves them to a terminal status for this mode. An earlier version of this
 * change also lazily created a call_logs row from the webhook's
 * user_identifier the first time Sarvam reported an attempt, which would
 * have closed this gap — but doing so required weakening an existing,
 * deliberate security-invariant test in the webhook route (exactly one
 * call_logs INSERT in the whole route, guarding "outbound events must never
 * insert a call_logs row from webhook data alone"). Rather than loosen that
 * invariant for an unverified, off-by-default experimental path, this gap
 * is left open and reported honestly: a sarvam_campaign-mode campaign will
 * never auto-complete, and campaign_contacts enrolled in it will never show
 * a real outcome, until that webhook-correlation piece is built (ideally
 * after the underlying cohort/webhook contract is actually confirmed).
 *
 * Idempotent: if this campaign already has a provider_cohort_id, the upload
 * is skipped (re-launching a paused sarvam_campaign-mode campaign must never
 * re-upload and double-dial the same cohort).
 */
async function launchViaSarvamCampaign(
  campaign: {
    id: string;
    organization_id: string;
    provider_campaign_id: string | null;
    provider_cohort_id: string | null;
  },
  orgId: string,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  if (campaign.provider_cohort_id) return; // already uploaded — never re-upload on resume

  const adapter = getTelephonyAdapter("sarvam");
  if (!adapter || !(adapter instanceof SarvamTelephonyAdapter))
    throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");

  const { data: pending } = await supabaseAdmin
    .from("campaign_contacts")
    .select("id, variables, contacts(phone)")
    .eq("campaign_id", campaign.id)
    .in("status", ["pending", "retry_scheduled"]);

  const rows = (pending ?? [])
    .filter((cc) => (cc as { contacts: { phone: string } | null }).contacts?.phone)
    .map((cc) => {
      const typed = cc as {
        id: string;
        variables: Record<string, string>;
        contacts: { phone: string };
      };
      return {
        campaignContactId: typed.id,
        phone: typed.contacts.phone,
        variables: typed.variables,
      };
    });
  if (rows.length === 0) return;

  const payload = buildCohortPayload(rows);
  const result = await adapter.uploadCohort({
    campaignId: campaign.provider_campaign_id!,
    cohortName: `klyro-${campaign.id.slice(0, 8)}-${Date.now()}`,
    csvText: payload.csvText,
    transformation: payload.transformation,
  });

  await supabaseAdmin
    .from("campaigns")
    .update({ provider_cohort_id: result.cohortId })
    .eq("id", campaign.id);
  await supabaseAdmin
    .from("campaign_contacts")
    .update({ status: "queued" })
    .eq("campaign_id", campaign.id)
    .in(
      "id",
      rows.map((r) => r.campaignContactId),
    );

  if (result.rejectedRecords > 0) {
    console.error(
      "campaigns:sarvam_cohort_rejected_records",
      campaign.id,
      result.cohortId,
      result.rejectedRecords,
    );
  }
}

interface CampaignActionInput {
  campaignId: string;
}

function simpleTransition(
  fromStatuses: string[],
  toStatus: string,
  timestampColumn: string | null,
) {
  return createServerFn({ method: "POST" })
    .middleware([requireSupabaseAuth])
    .inputValidator((input: CampaignActionInput) => {
      if (!input?.campaignId) throw new Error("campaignId is required");
      return input;
    })
    .handler(async ({ data, context }) => {
      const orgId = await resolveOrgId(context);
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
      await supabaseAdmin
        .from("campaigns")
        .update(patch as never)
        .eq("id", data.campaignId);
      return { ok: true };
    });
}

/** Pause: stops the dispatcher from claiming any more due contacts for this campaign. In-flight calls finish normally. */
export const pauseCampaign = simpleTransition(["running"], "paused", "paused_at");

/** Resume: identical readiness bar as launch is deliberately NOT re-run here — spec §38 only requires pause->edit->resume for fields that need it; resuming without editing should not re-block on transient billing dips the dispatcher itself already re-checks per call. */
export const resumeCampaign = simpleTransition(["paused"], "running", null);

export const cancelCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CampaignActionInput) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: campaign } = await supabaseAdmin
      .from("campaigns")
      .select("id, organization_id, status")
      .eq("id", data.campaignId)
      .maybeSingle();
    if (!campaign || campaign.organization_id !== orgId) throw new Error("Campaign not found.");
    if (["completed", "cancelled"].includes(campaign.status))
      throw new Error(`Campaign is already ${campaign.status}.`);

    await supabaseAdmin
      .from("campaigns")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", data.campaignId);
    // Never dial a not-yet-attempted contact from a cancelled campaign.
    await supabaseAdmin
      .from("campaign_contacts")
      .update({ status: "cancelled", next_attempt_at: null })
      .eq("campaign_id", data.campaignId)
      .in("status", ["pending", "retry_scheduled", "queued"]);

    return { ok: true };
  });

export interface CampaignStats {
  totalContacts: number;
  byStatus: Record<string, number>;
}

export const getCampaignStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { campaignId: string }) => {
    if (!input?.campaignId) throw new Error("campaignId is required");
    return input;
  })
  .handler(async ({ data, context }): Promise<CampaignStats> => {
    const orgId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: campaign } = await supabaseAdmin
      .from("campaigns")
      .select("id, organization_id")
      .eq("id", data.campaignId)
      .maybeSingle();
    if (!campaign || campaign.organization_id !== orgId) throw new Error("Campaign not found.");

    const { data: rows } = await supabaseAdmin
      .from("campaign_contacts")
      .select("status")
      .eq("campaign_id", data.campaignId);

    const byStatus: Record<string, number> = {};
    for (const row of rows ?? []) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    }
    return { totalContacts: rows?.length ?? 0, byStatus };
  });
