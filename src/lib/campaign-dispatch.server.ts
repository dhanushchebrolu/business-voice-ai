import { getTelephonyAdapter } from "@/lib/telephony.server";
import { checkTelephonyAccess, walletCanAffordOutbound } from "@/lib/telephony-guard.server";
import { SarvamTelephonyAdapter } from "@/lib/telephony/sarvam-provider.server";
import { isWithinCallingWindow, type CampaignSchedule } from "@/lib/campaign-schedule";
import { decideCampaignContactOutcome, type CallTerminalStatus } from "@/lib/campaign-outcome";

/**
 * The outbound campaign dispatcher — Klyro's own pacing/retry engine
 * dialing one contact at a time through the already-verified-as-far-as-
 * possible single-call Sarvam path (createInstantOutbound), because no
 * Sarvam API for creating a provider-side "campaign" or streaming a cohort
 * has ever been confirmed (see the Sarvam API verification audit). This is
 * the deliberate, honest alternative to inventing one: Klyro owns
 * scheduling/pacing/retries entirely, and every dial still goes through the
 * exact same authorization/billing gate (checkTelephonyAccess,
 * walletCanAffordOutbound) the existing single-call outbound flow already
 * uses — no second, competing authorization or billing system.
 *
 * Invoked by the cron-authenticated route
 * (src/routes/api/public/cron/dispatch-campaigns.ts) on whatever interval
 * the platform's own scheduler is configured for — not by end users, and
 * never by an unauthenticated caller (see authenticateCronRequest).
 *
 * Bounded on purpose: at most MAX_CONTACTS_PER_CAMPAIGN_PER_TICK contacts
 * per running campaign, per invocation — a single cron tick must never try
 * to dial an entire 5,000-row campaign at once. Repeated ticks drain a
 * large campaign over time instead.
 */

const MAX_CONTACTS_PER_CAMPAIGN_PER_TICK = 20;

export interface DispatchSummary {
  campaignsConsidered: number;
  campaignsDialed: number;
  contactsDialed: number;
  contactsSkipped: number;
  campaignsCompleted: number;
  errors: { campaignId: string; message: string }[];
}

export async function dispatchDueCampaigns(): Promise<DispatchSummary> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const summary: DispatchSummary = {
    campaignsConsidered: 0,
    campaignsDialed: 0,
    contactsDialed: 0,
    contactsSkipped: 0,
    campaignsCompleted: 0,
    errors: [],
  };

  const { data: campaigns } = await supabaseAdmin
    .from("campaigns")
    .select("*")
    .eq("status", "running");

  for (const campaign of campaigns ?? []) {
    summary.campaignsConsidered++;
    try {
      const dialed = await dispatchOneCampaign(campaign);
      summary.contactsDialed += dialed.dialed;
      summary.contactsSkipped += dialed.skipped;
      if (dialed.dialed > 0) summary.campaignsDialed++;
      if (dialed.completed) summary.campaignsCompleted++;
    } catch (err) {
      summary.errors.push({ campaignId: campaign.id, message: (err as Error).message });
      console.error("campaign_dispatch:campaign_failed", campaign.id, (err as Error).message);
    }
  }

  return summary;
}

async function dispatchOneCampaign(
  campaign: Record<string, unknown> & {
    id: string;
    organization_id: string;
    phone_number_id: string | null;
    agent_config_id: string | null;
    objective: string | null;
    call_instructions: string | null;
    schedule: unknown;
    max_attempts: number;
    retry_after_minutes: number;
    retry_statuses: string[];
  },
): Promise<{ dialed: number; skipped: number; completed: boolean }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  if (!isWithinCallingWindow((campaign.schedule as CampaignSchedule) ?? {})) {
    return { dialed: 0, skipped: 0, completed: false };
  }
  if (!campaign.phone_number_id || !campaign.agent_config_id) {
    return { dialed: 0, skipped: 0, completed: false };
  }

  const gate = await checkTelephonyAccess(
    campaign.organization_id,
    campaign.phone_number_id,
    "outbound",
  );
  if (!gate.allowed || !gate.phoneNumber || gate.phoneNumber.provider !== "sarvam") {
    return { dialed: 0, skipped: 0, completed: false };
  }

  const [{ data: connection }, { data: agentConfig }] = await Promise.all([
    gate.phoneNumber.connection_id
      ? supabaseAdmin
          .from("telephony_connections")
          .select("provider, provider_connection_id")
          .eq("id", gate.phoneNumber.connection_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabaseAdmin
      .from("agent_configs")
      .select("sarvam_app_id, sarvam_app_version")
      .eq("id", campaign.agent_config_id)
      .maybeSingle(),
  ]);
  if (
    !connection?.provider_connection_id ||
    !agentConfig?.sarvam_app_id ||
    !agentConfig.sarvam_app_version
  ) {
    return { dialed: 0, skipped: 0, completed: false };
  }

  const adapter = getTelephonyAdapter("sarvam");
  if (!adapter || !(adapter instanceof SarvamTelephonyAdapter)) {
    return { dialed: 0, skipped: 0, completed: false };
  }

  const { data: due } = await supabaseAdmin
    .from("campaign_contacts")
    .select("id, contact_id, attempts, variables")
    .eq("campaign_id", campaign.id)
    .in("status", ["pending", "retry_scheduled"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${new Date().toISOString()}`)
    .order("created_at")
    .limit(MAX_CONTACTS_PER_CAMPAIGN_PER_TICK);

  let dialed = 0;
  let skipped = 0;

  for (const cc of due ?? []) {
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id, phone, opted_out")
      .eq("id", cc.contact_id)
      .maybeSingle();
    if (!contact || contact.opted_out) {
      await supabaseAdmin
        .from("campaign_contacts")
        .update({ status: "opted_out", next_attempt_at: null })
        .eq("id", cc.id);
      skipped++;
      continue;
    }

    // Re-check affordability per contact, not once per campaign — a
    // campaign can run out of wallet balance mid-run, and every remaining
    // contact must simply stay "pending" (never marked failed) until
    // there's balance again, exactly like the single-call path's own gate.
    const affordable = await walletCanAffordOutbound(campaign.organization_id);
    if (!affordable) {
      skipped++;
      break; // no point trying the rest of this campaign's batch this tick
    }

    const attempts = cc.attempts + 1;
    await supabaseAdmin
      .from("campaign_contacts")
      .update({ status: "calling", attempts })
      .eq("id", cc.id);

    const { data: call, error: insertError } = await supabaseAdmin
      .from("call_logs")
      .insert({
        organization_id: campaign.organization_id,
        campaign_id: campaign.id,
        campaign_contact_id: cc.id,
        contact_id: contact.id,
        phone_number_id: campaign.phone_number_id,
        provider: "sarvam",
        direction: "outbound",
        caller_number: gate.phoneNumber.e164,
        destination_number: contact.phone,
        status: "initiated",
        started_at: new Date().toISOString(),
        retry_attempt: attempts - 1,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    const agentVariables: Record<string, unknown> = {
      ...((cc.variables as Record<string, unknown> | null) ?? {}),
    };
    if (campaign.objective) agentVariables["campaign_objective"] = campaign.objective;
    if (campaign.call_instructions)
      agentVariables["campaign_instructions"] = campaign.call_instructions;

    try {
      const result = await adapter.createInstantOutbound({
        appId: agentConfig.sarvam_app_id,
        appVersion: agentConfig.sarvam_app_version,
        connectionId: connection.provider_connection_id,
        toE164: contact.phone,
        agentVariables,
        clientReference: call.id,
      });
      if (result.interactionId) {
        await supabaseAdmin
          .from("call_logs")
          .update({ provider_call_id: result.interactionId })
          .eq("id", call.id);
      }
      dialed++;
    } catch (err) {
      const message = (err as Error).message;
      await supabaseAdmin
        .from("call_logs")
        .update({ status: "failed", failure_reason: message, ended_at: new Date().toISOString() })
        .eq("id", call.id);
      await applyOutcomeToCampaignContact(cc.id, "failed", attempts, campaign, null);
    }
  }

  const completed = await maybeCompleteCampaign(campaign.id);
  return { dialed, skipped, completed };
}

/**
 * Shared by both the synchronous dispatch-failure path above and the
 * asynchronous webhook path (telephony.ts) — one place decides retry vs.
 * terminal state, so the two call sites can never disagree.
 */
export async function applyOutcomeToCampaignContact(
  campaignContactId: string,
  terminalStatus: CallTerminalStatus,
  attempts: number,
  campaign: { max_attempts: number; retry_after_minutes: number; retry_statuses: string[] },
  agentVariables: Record<string, unknown> | null,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const decision = decideCampaignContactOutcome(
    terminalStatus,
    attempts,
    {
      maxAttempts: campaign.max_attempts,
      retryAfterMinutes: campaign.retry_after_minutes,
      retryStatuses: campaign.retry_statuses,
    },
    agentVariables,
  );

  await supabaseAdmin
    .from("campaign_contacts")
    .update({
      status: decision.status,
      next_attempt_at: decision.nextAttemptAt,
      outcome: terminalStatus,
      output_variables: (agentVariables ?? {}) as never,
    })
    .eq("id", campaignContactId);

  if (decision.status === "opted_out") {
    const { data: cc } = await supabaseAdmin
      .from("campaign_contacts")
      .select("contact_id")
      .eq("id", campaignContactId)
      .maybeSingle();
    if (cc) {
      await supabaseAdmin
        .from("contacts")
        .update({
          opted_out: true,
          opted_out_at: new Date().toISOString(),
          opted_out_reason: "Requested during an outbound call",
        })
        .eq("id", cc.contact_id);
    }
  }
}

/** Marks a campaign completed once every enrolled contact has reached a terminal (non-retryable, non-in-flight) state. */
export async function maybeCompleteCampaign(campaignId: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { count } = await supabaseAdmin
    .from("campaign_contacts")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .in("status", ["pending", "retry_scheduled", "queued", "calling"]);
  if (count && count > 0) return false;

  const { data: campaign } = await supabaseAdmin
    .from("campaigns")
    .select("id, status")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign || campaign.status !== "running") return false;

  const { count: totalCount } = await supabaseAdmin
    .from("campaign_contacts")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  if (!totalCount || totalCount === 0) return false; // nothing was ever enrolled — not "completed"

  await supabaseAdmin
    .from("campaigns")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", campaignId);
  return true;
}
