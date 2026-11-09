import { getTelephonyAdapter, sarvamWebhookUrl } from "@/lib/telephony.server";
import { checkTelephonyAccess, walletCanAffordOutbound } from "@/lib/telephony-guard.server";
import { SarvamTelephonyAdapter } from "@/lib/telephony/sarvam-provider.server";
import { isWithinCallingWindow, type CampaignSchedule } from "@/lib/campaign-schedule";
import { normalizeCustomerPhone } from "@/lib/phone-number";
import { decideCampaignContactOutcome, type CallTerminalStatus } from "@/lib/campaign-outcome";
import {
  recordCampaignStartFailure,
  releaseCampaignClaim,
} from "@/lib/sarvam-outbound-call.server";

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

  // Only ever dispatches instant_outbound_fallback campaigns (spec "THIRD"):
  // a sarvam_campaign-mode campaign already had its full contact list
  // uploaded to Sarvam as a cohort at launch time (campaigns.functions.ts) —
  // Sarvam paces/dials it, not this loop. Dispatching it here too would be
  // exactly the double-dial this migration's unique index exists to prevent.
  const { data: campaigns } = await supabaseAdmin
    .from("campaigns")
    .select("*")
    .eq("status", "running")
    .eq("dispatch_mode", "instant_outbound_fallback");

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
  const webhookUrl = sarvamWebhookUrl();
  if (!webhookUrl) {
    return { dialed: 0, skipped: 0, completed: false };
  }

  const { data: due } = await supabaseAdmin
    .from("campaign_contacts")
    .select("id, contact_id, status, attempts, variables")
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

    // The canonical form every outbound path uses (phone-number.ts), so the
    // number reservation sees a single call and this campaign call as the same
    // number. A stored number that isn't canonical-valid is never dialled.
    const destination = normalizeCustomerPhone(contact.phone, null);
    if (!destination) {
      await supabaseAdmin
        .from("campaign_contacts")
        .update({ status: "wrong_number", outcome: "invalid_number", next_attempt_at: null })
        .eq("id", cc.id)
        .in("status", ["pending", "retry_scheduled"]);
      console.error("campaign_dispatch:invalid_number", campaign.id, cc.id);
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

    // Atomic claim (spec "SEVENTH" — no duplicate dispatch): the UPDATE's
    // own WHERE clause re-checks status is still pending/retry_scheduled at
    // the moment of the write, not just at SELECT time above. If a
    // concurrent dispatcher tick (or a retried cron invocation) already
    // claimed this exact row between our SELECT and this UPDATE, the
    // conditional match fails, `claimed` comes back empty, and we skip this
    // contact entirely rather than dialing it a second time. Also
    // backstopped at the storage layer by
    // idx_call_logs_campaign_contact_inflight (a partial unique index) —
    // even a bug here could not produce two live call_logs rows for the
    // same campaign_contact.
    const attempts = cc.attempts + 1;
    const { data: claimed } = await supabaseAdmin
      .from("campaign_contacts")
      .update({ status: "calling", attempts })
      .eq("id", cc.id)
      .in("status", ["pending", "retry_scheduled"])
      .select("id");
    if (!claimed || claimed.length === 0) {
      skipped++;
      continue;
    }

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
        destination_number: destination,
        status: "initiated",
        started_at: new Date().toISOString(),
        retry_attempt: attempts - 1,
      })
      .select("id")
      .single();
    if (insertError) {
      // Nothing was dialled: give the contact back exactly as it was, so it is
      // never stranded in `calling` without a call row.
      await releaseCampaignClaim(supabaseAdmin, {
        campaignId: campaign.id,
        campaignContactId: cc.id,
        previousStatus: cc.status,
        previousAttempts: cc.attempts,
      });
      // 23505: an unresolved Sarvam call to this number (a single call or
      // another campaign's) holds the number reservation. Defer this contact
      // to a later run and keep dispatching the rest.
      if (insertError.code === "23505") {
        console.info("campaign_dispatch:number_reserved", campaign.id, cc.id);
        skipped++;
        continue;
      }
      throw insertError;
    }

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
        fromE164: gate.phoneNumber.e164,
        toE164: destination,
        agentVariables,
        webhookUrl,
        metadata: {
          organizationId: campaign.organization_id,
          campaignId: campaign.id,
          campaignContactId: cc.id,
          // The webhook route resolves its clientReference fallback by call_logs id.
          callId: call.id,
        },
      });
      // Only Sarvam's attempt_id (on every single-call webhook) becomes
      // provider_call_id; see sendSarvamInstantOutboundCall for why never interaction_id.
      const patch: Record<string, unknown> = {};
      if (result.attemptId) patch["provider_call_id"] = result.attemptId;
      if (result.interactionId)
        patch["provider_metadata"] = { interaction_id: result.interactionId };
      if (Object.keys(patch).length > 0) {
        await supabaseAdmin
          .from("call_logs")
          .update(patch as never)
          .eq("id", call.id);
      }
      dialed++;
    } catch (err) {
      // Race-safe: only a call still `initiated` is changed, and the contact
      // only follows when that change happened. Ambiguous errors hold both in
      // outcome_unknown (no retry); definite rejections fail and may retry.
      const recorded = await recordCampaignStartFailure(
        supabaseAdmin,
        { callId: call.id, campaignContactId: cc.id },
        err,
        () => applyOutcomeToCampaignContact(cc.id, "failed", attempts, campaign, null),
      );
      if (recorded === "outcome_unknown") {
        console.error("campaign_dispatch:outcome_unknown", call.id, (err as Error).message);
      }
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
    // outcome_unknown is unresolved, not finished: it keeps the campaign open.
    .in("status", ["pending", "retry_scheduled", "queued", "calling", "outcome_unknown"]);
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
