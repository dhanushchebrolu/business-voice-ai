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

    await supabaseAdmin
      .from("campaigns")
      .update({ status: "running", launched_at: new Date().toISOString() })
      .eq("id", data.campaignId);

    return { ok: true };
  });

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
