import {
  isDestinationCountryAllowed,
  isOutboundDestinationAllowlisted,
  outboundCallingDisabled,
  outboundEmergencyStopActive,
  withinCallingHours,
} from "./outbound-eligibility.server.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getTelephonyAdapter, sarvamOutboundWebhookUrl } from "./telephony.server.ts";
import { checkTelephonyAccess } from "./telephony-guard.server.ts";
import { OUTBOUND_MAX_CALL_SECONDS_CAP } from "./agent-roles.ts";
import { SarvamTelephonyAdapter } from "./telephony/sarvam-provider.server.ts";
import { TEMPLATE_AGENT_COLUMNS, templateCallVariables } from "./sarvam-tenant-variables.server.ts";
import { isWithinCallingWindow, type CampaignSchedule } from "./campaign-schedule.ts";
import { normalizeCustomerPhone } from "./phone-number.ts";
import { decideCampaignContactOutcome, type CallTerminalStatus } from "./campaign-outcome.ts";
import {
  persistStartResult,
  recordCampaignStartFailure,
  recordSarvamStartFailure,
  releaseCampaignClaim,
} from "./sarvam-outbound-call.server.ts";
import { finalizeTerminalCallSafely } from "./telephony/call-finalization.server.ts";
import { retainCallVariables } from "./call-variables.ts";
import { compileCampaignContext, validateCampaignContext } from "./campaign-context.ts";
import {
  isContactSuppressed,
  isNumberSuppressed,
  suppressContact,
} from "./contact-suppression.server.ts";
import {
  OUTBOUND_AGENT_COLUMNS,
  outboundAgentTarget,
  outboundBusinessName,
  outboundCallVariables,
  outboundOpeningLine,
  withoutReservedOutboundVariables,
} from "./sarvam-outbound-mode.server.ts";

/**
 * The outbound campaign dispatcher — Klyro's own pacing/retry engine
 * dialing one contact at a time through the already-verified-as-far-as-
 * possible single-call Sarvam path (createInstantOutbound), because no
 * Sarvam API for creating a provider-side "campaign" or streaming a cohort
 * has ever been confirmed (see the Sarvam API verification audit). This is
 * the deliberate, honest alternative to inventing one: Klyro owns
 * scheduling/pacing/retries entirely. Every dial goes through the same number
 * gate as single calls (checkTelephonyAccess), the platform rules (calling
 * hours, allowed countries, kill switch, test allowlist, do-not-call) and an
 * atomic database admission (admit_campaign_outbound_call: in-flight limit,
 * wallet worst case over every open call, the campaign budget, the call row).
 *
 * Invoked once a minute by the Worker's own scheduler (the `campaign.dispatch`
 * job, src/lib/jobs/handlers.server.ts), and by the cron-authenticated route
 * (src/routes/api/public/cron/dispatch-campaigns.ts) — never by end users or
 * an unauthenticated caller. A pause or cancel stops the batch at the next
 * contact: the campaign is re-read before every claim and again after it.
 *
 * Bounded on purpose: at most MAX_CONTACTS_PER_CAMPAIGN_PER_TICK contacts
 * per running campaign, per invocation — a single cron tick must never try
 * to dial an entire 5,000-row campaign at once. Repeated ticks drain a
 * large campaign over time instead.
 */

const MAX_CONTACTS_PER_CAMPAIGN_PER_TICK = 20;

/**
 * The most outbound calls (single and campaign) one customer may have open at
 * once while a campaign dials; checked atomically by admit_campaign_outbound_call.
 */
export const CAMPAIGN_MAX_IN_FLIGHT = 3;

/** admit_campaign_outbound_call's answer. */
export type CampaignAdmission =
  | {
      result: "admitted";
      call_id: string;
      caller_number: string;
      cap_minutes: number;
      rate_per_minute: number;
    }
  | { result: "refused"; reason: string };

export interface CampaignAdmissionRequest {
  campaignId: string;
  campaignContactId: string;
  callId: string;
  destination: string;
  retryAttempt: number;
  maxInFlight: number;
  /** The reviewed context version the call's text was compiled from. */
  contextReviewedAt: string;
  /** Exactly what the agent receives (stored on the call, immutable). */
  sentObjective: string;
  sentInstructions: string;
}

export interface DispatchSummary {
  campaignsConsidered: number;
  campaignsDialed: number;
  contactsDialed: number;
  contactsSkipped: number;
  campaignsCompleted: number;
  errors: { campaignId: string; message: string }[];
}

/** Everything the dispatcher reads or dials through; tests replace these with fakes. */
export interface DispatchDeps {
  supabaseAdmin: SupabaseClient<Database>;
  checkTelephonyAccess: typeof checkTelephonyAccess;
  /**
   * Atomic admission (admit_campaign_outbound_call): campaign still running and
   * reviewed, in-flight limit, wallet worst case over every open call, the
   * campaign budget, then the call row.
   */
  admitCampaignCall: (request: CampaignAdmissionRequest) => Promise<CampaignAdmission>;
  /** The Sarvam adapter, or null when Sarvam is not configured. */
  adapter: Pick<SarvamTelephonyAdapter, "createInstantOutbound"> | null;
  webhookUrl: ReturnType<typeof sarvamOutboundWebhookUrl>;
  templateVariables: (
    agentConfig: Parameters<typeof templateCallVariables>[1],
    organizationId: string,
  ) => Promise<Record<string, unknown>>;
  finalize: (callId: string) => Promise<unknown>;
  now: () => number;
}

export interface DispatchOptions {
  /** Stop claiming contacts at this time (ms since epoch); calls already started still finish. */
  deadline?: number;
  deps?: DispatchDeps;
}

async function defaultDispatchDeps(): Promise<DispatchDeps> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const adapter = getTelephonyAdapter("sarvam");
  return {
    supabaseAdmin,
    checkTelephonyAccess,
    admitCampaignCall: (request) => admitCampaignCall(supabaseAdmin, request),
    adapter: adapter instanceof SarvamTelephonyAdapter ? adapter : null,
    webhookUrl: sarvamOutboundWebhookUrl(),
    templateVariables: (agentConfig, organizationId) =>
      templateCallVariables(supabaseAdmin, agentConfig, organizationId),
    finalize: (callId) => finalizeTerminalCallSafely(supabaseAdmin, callId),
    now: Date.now,
  };
}

export async function dispatchDueCampaigns(
  options: DispatchOptions = {},
): Promise<DispatchSummary> {
  const deps = options.deps ?? (await defaultDispatchDeps());
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  const { supabaseAdmin } = deps;
  const summary: DispatchSummary = {
    campaignsConsidered: 0,
    campaignsDialed: 0,
    contactsDialed: 0,
    contactsSkipped: 0,
    campaignsCompleted: 0,
    errors: [],
  };
  // The global outbound kill switch, here so every trigger (the scheduled job
  // and the cron route) stops dialling; nothing is read or claimed.
  if (outboundCallingDisabled()) {
    console.warn("campaign_dispatch:outbound_disabled");
    return summary;
  }
  // The platform calling hours (09:00-21:00 India time) bound every campaign's
  // own schedule, exactly as they bound single calls.
  if (!withinCallingHours(new Date(deps.now()))) return summary;
  // The database emergency stop: nothing is read, claimed or dialled.
  if (await outboundEmergencyStopActive(supabaseAdmin)) {
    console.warn("campaign_dispatch:emergency_stop");
    return summary;
  }

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

  // Campaign calling is enabled per workspace by ClickAI
  // (organizations.campaign_dispatch_enabled, 20261129090000), so the platform
  // switch never starts another customer's campaigns. A failed read enables none.
  const orgIds = [...new Set((campaigns ?? []).map((c) => c.organization_id))];
  const { data: orgs, error: orgError } = orgIds.length
    ? await supabaseAdmin
        .from("organizations")
        .select("id, campaign_dispatch_enabled")
        .in("id", orgIds)
    : { data: [], error: null };
  if (orgError) console.error("campaign_dispatch:authorization_read_failed", orgError.message);
  const authorized = new Set(
    orgError
      ? []
      : (orgs ?? [])
          .filter(
            (o) =>
              (o as { campaign_dispatch_enabled?: boolean }).campaign_dispatch_enabled === true,
          )
          .map((o) => o.id),
  );

  for (const campaign of campaigns ?? []) {
    if (deps.now() >= deadline) break;
    if (!authorized.has(campaign.organization_id)) continue;
    summary.campaignsConsidered++;
    try {
      const dialed = await dispatchOneCampaign(campaign, deps, deadline);
      summary.contactsDialed += dialed.dialed;
      summary.contactsSkipped += dialed.skipped;
      if (dialed.dialed > 0) summary.campaignsDialed++;
      if (dialed.completed) summary.campaignsCompleted++;
      // The emergency stop landed mid-run: no other campaign is tried either.
      if (dialed.emergencyStop) break;
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
    context: unknown;
    context_reviewed_at: string | null;
    schedule: unknown;
    max_attempts: number;
    retry_after_minutes: number;
    retry_statuses: string[];
  },
  deps: DispatchDeps,
  deadline: number,
): Promise<{ dialed: number; skipped: number; completed: boolean; emergencyStop?: boolean }> {
  const { supabaseAdmin } = deps;

  if (!isWithinCallingWindow((campaign.schedule as CampaignSchedule) ?? {})) {
    return { dialed: 0, skipped: 0, completed: false };
  }
  if (!campaign.phone_number_id || !campaign.agent_config_id) {
    return { dialed: 0, skipped: 0, completed: false };
  }
  // Only what the customer reviewed is ever said: the stored, reviewed context,
  // compiled here (never the free-text columns, which stay editable).
  const reviewed = campaign.context_reviewed_at ? validateCampaignContext(campaign.context) : null;
  if (!reviewed?.ok) {
    console.error("campaign_dispatch:context_not_reviewed", campaign.id);
    return { dialed: 0, skipped: 0, completed: false };
  }
  const compiledContext = compileCampaignContext(reviewed.context);

  const gate = await deps.checkTelephonyAccess(
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
          .eq("organization_id", campaign.organization_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabaseAdmin
      .from("agent_configs")
      .select(
        `organization_id, sarvam_outbound_max_call_seconds, ${OUTBOUND_AGENT_COLUMNS}, ${TEMPLATE_AGENT_COLUMNS}`,
      )
      .eq("id", campaign.agent_config_id)
      .eq("organization_id", campaign.organization_id)
      .maybeSingle(),
  ]);
  if (!connection?.provider_connection_id || !agentConfig) {
    return { dialed: 0, skipped: 0, completed: false };
  }
  // Only the customer's registered outbound agent, in its confirmed version;
  // never the inbound agent (no fallback).
  const target = outboundAgentTarget(agentConfig);
  if (!target) {
    console.error("campaign_dispatch:agent_not_outbound_ready", campaign.id);
    return { dialed: 0, skipped: 0, completed: false };
  }
  // Every campaign call is capped like a single call: billed for at most the
  // confirmed maximum length, at the price locked at admission. No recorded
  // maximum: nothing is dialled (admission re-checks this under its lock).
  const maxCallSeconds = agentConfig.sarvam_outbound_max_call_seconds;
  if (!maxCallSeconds || maxCallSeconds < 60 || maxCallSeconds > OUTBOUND_MAX_CALL_SECONDS_CAP) {
    console.error("campaign_dispatch:max_call_length_not_set", campaign.id);
    return { dialed: 0, skipped: 0, completed: false };
  }

  const adapter = deps.adapter;
  if (!adapter) {
    return { dialed: 0, skipped: 0, completed: false };
  }
  const templateVariables = await deps.templateVariables(agentConfig, campaign.organization_id);
  const openingLine = outboundOpeningLine(await outboundBusinessName(supabaseAdmin, agentConfig));
  // Authenticated result URL (verify_token). Without it Sarvam's results would
  // be rejected, so nothing is dialled. Only the reason is logged, never the URL.
  const webhook = deps.webhookUrl;
  if (!webhook.ok) {
    console.error("campaign_dispatch:webhook_not_configured", campaign.id, webhook.reason);
    return { dialed: 0, skipped: 0, completed: false };
  }
  const webhookUrl = webhook.url;

  const { data: due } = await supabaseAdmin
    .from("campaign_contacts")
    .select("id, contact_id, status, attempts, variables")
    .eq("campaign_id", campaign.id)
    .in("status", ["pending", "retry_scheduled"])
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${new Date(deps.now()).toISOString()}`)
    .order("created_at")
    .limit(MAX_CONTACTS_PER_CAMPAIGN_PER_TICK);

  let dialed = 0;
  let skipped = 0;
  let emergencyStop = false;

  // Read fresh for every contact, so a pause or cancel stops the batch at the next claim.
  const stillRunning = async () => {
    const { data, error } = await supabaseAdmin
      .from("campaigns")
      .select("status")
      .eq("id", campaign.id)
      .maybeSingle();
    if (error) throw error;
    return data?.status === "running";
  };

  for (const cc of due ?? []) {
    if (deps.now() >= deadline || outboundCallingDisabled() || !(await stillRunning())) break;
    const { data: contact, error: contactError } = await supabaseAdmin
      .from("contacts")
      .select("id, phone, opted_out")
      .eq("id", cc.contact_id)
      .maybeSingle();
    // A failed read is not an opt-out: nothing is dialled or written, and the
    // contact stays due for a later run.
    if (contactError) {
      console.error("campaign_dispatch:contact_read_failed", campaign.id, cc.id);
      skipped++;
      continue;
    }
    if (!contact || contact.opted_out) {
      await supabaseAdmin
        .from("campaign_contacts")
        .update({ status: "opted_out", next_attempt_at: null })
        .eq("id", cc.id);
      // A confirmed opt-out also closes this contact's other not-yet-dialled
      // enrolments (idempotent; the contact flag itself is already set).
      if (contact)
        await suppressContact(supabaseAdmin, {
          organizationId: campaign.organization_id,
          contactId: contact.id,
          reason: "Requested during an outbound call",
        }).catch((err: Error) =>
          console.error("campaign_dispatch:suppress_failed", campaign.id, err.message),
        );
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

    // Countries ClickAI may call (+91 unless configured narrower): never dialled,
    // never retried, and reported with its reason.
    if (!isDestinationCountryAllowed(destination)) {
      await supabaseAdmin
        .from("campaign_contacts")
        .update({
          status: "excluded",
          excluded_reason: "country_not_allowed",
          next_attempt_at: null,
        })
        .eq("id", cc.id)
        .in("status", ["pending", "retry_scheduled"]);
      skipped++;
      continue;
    }

    // Supervised-test allowlist (SARVAM_OUTBOUND_TEST_ALLOWLIST): any other
    // number is left exactly as it is — not claimed, nothing written or dialled.
    if (!isOutboundDestinationAllowlisted(destination)) {
      console.error("campaign_dispatch:destination_not_allowlisted", campaign.id, cc.id);
      skipped++;
      continue;
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
    //
    // The claim also requires the attempt count this run read, so a run working
    // from a stale read can't claim (and under-count) a contact another run
    // has already dialled. It records the call id up front (current_call_id):
    // finalization applies a call's outcome only while the contact still points
    // at that exact call.
    const attempts = cc.attempts + 1;
    const callId = crypto.randomUUID();
    const { data: claimed } = await supabaseAdmin
      .from("campaign_contacts")
      .update({ status: "calling", attempts, current_call_id: callId })
      .eq("id", cc.id)
      .in("status", ["pending", "retry_scheduled"])
      .eq("attempts", cc.attempts)
      .select("id");
    if (!claimed || claimed.length === 0) {
      skipped++;
      continue;
    }
    // A pause or cancel that landed between the check above and this claim:
    // nothing is dialled, and the contact goes back (or is cancelled). A failed
    // read counts as "not running", so the claimed contact is never stranded.
    const running = await stillRunning().catch((err: Error) => {
      console.error("campaign_dispatch:status_check_failed", campaign.id, err.message);
      return false;
    });
    if (!running) {
      await releaseCampaignClaim(supabaseAdmin, {
        campaignId: campaign.id,
        campaignContactId: cc.id,
        previousStatus: cc.status,
        previousAttempts: cc.attempts,
      });
      break;
    }
    // Do-not-call is read again after the claim, immediately before the call row
    // and the dial: an opt-out that landed since the first read stops this call.
    // Both the contact and its normalized number are checked, so no other
    // contact record holding the same number in this workspace can be dialled.
    // A failed read is not an opt-out: nothing is dialled, the claim is given
    // back exactly as it was, and the contact stays due for a later run.
    let suppressed: boolean;
    try {
      const [byContact, byNumber] = await Promise.all([
        isContactSuppressed(supabaseAdmin, contact.id),
        isNumberSuppressed(supabaseAdmin, campaign.organization_id, destination),
      ]);
      suppressed = byContact || byNumber;
    } catch (err) {
      console.error(
        "campaign_dispatch:opt_out_check_failed",
        campaign.id,
        cc.id,
        (err as Error).message,
      );
      await releaseCampaignClaim(supabaseAdmin, {
        campaignId: campaign.id,
        campaignContactId: cc.id,
        previousStatus: cc.status,
        previousAttempts: cc.attempts,
      });
      skipped++;
      continue;
    }
    if (suppressed) {
      await supabaseAdmin
        .from("campaign_contacts")
        .update({
          status: "opted_out",
          next_attempt_at: null,
          attempts: cc.attempts,
          current_call_id: null,
        })
        .eq("id", cc.id)
        .eq("current_call_id", callId);
      skipped++;
      continue;
    }

    // Admission, atomically under the customer's lock: campaign still running and
    // reviewed, in-flight limit, wallet worst case over every open call, the
    // campaign budget, then the call row. Anything refused dials nothing and
    // gives the contact back exactly as it was.
    // The exact campaign text this call sends, recorded on the call by admission.
    const outboundVars = outboundCallVariables({
      callId,
      objective: compiledContext.objective,
      instructions: compiledContext.instructions,
    });
    const admission = await deps
      .admitCampaignCall({
        campaignId: campaign.id,
        campaignContactId: cc.id,
        callId,
        destination,
        retryAttempt: attempts - 1,
        maxInFlight: CAMPAIGN_MAX_IN_FLIGHT,
        contextReviewedAt: campaign.context_reviewed_at!,
        sentObjective: outboundVars["campaign_objective"] ?? "",
        sentInstructions: outboundVars["campaign_instructions"] ?? "",
      })
      .catch((err: Error): CampaignAdmission => {
        console.error("campaign_dispatch:admission_failed", campaign.id, cc.id, err.message);
        return { result: "refused", reason: "admission_error" };
      });
    if (admission.result !== "admitted") {
      await releaseCampaignClaim(supabaseAdmin, {
        campaignId: campaign.id,
        campaignContactId: cc.id,
        previousStatus: cc.status,
        previousAttempts: cc.attempts,
      });
      skipped++;
      // An unresolved call to this number elsewhere: try the next contact.
      if (admission.reason === "destination_busy") {
        console.info("campaign_dispatch:number_reserved", campaign.id, cc.id);
        continue;
      }
      console.info("campaign_dispatch:admission_refused", campaign.id, admission.reason);
      if (admission.reason === "outbound_paused") emergencyStop = true;
      // The budget is spent: pause, so the customer decides (raise it or stop).
      if (admission.reason === "budget_exhausted") {
        await supabaseAdmin
          .from("campaigns")
          .update({ status: "paused", paused_at: new Date().toISOString() })
          .eq("id", campaign.id)
          .eq("status", "running");
      }
      // Wallet, in-flight limit, budget, pause: nothing more this run.
      break;
    }
    const call = { id: admission.call_id };

    // A pause, cancel or stop that landed after admission, or the calling hours
    // ending meanwhile: the call is recorded as never started (no charge, no
    // budget), and nothing is dialled.
    const stillOn =
      !outboundCallingDisabled() &&
      withinCallingHours(new Date(deps.now())) &&
      (await stillRunning().catch((err: Error) => {
        console.error("campaign_dispatch:status_check_failed", campaign.id, err.message);
        return false;
      }));
    // Stopped after admission, before anything is sent: the call is recorded as
    // never started (failed, start_failure: no charge, outside the budget), the
    // contact gets its claim back exactly as it was (status and attempt count,
    // or cancelled with its campaign; no retry is scheduled), and only then is
    // the call finalized, so its "failed" outcome never reaches the contact
    // (finalization matches current_call_id, which is now cleared).
    const stopBeforeDial = async (reason: string) => {
      const recorded = await recordSarvamStartFailure(supabaseAdmin, call.id, new Error(reason));
      if (recorded !== "failed") return;
      await releaseCampaignClaim(supabaseAdmin, {
        campaignId: campaign.id,
        campaignContactId: cc.id,
        previousStatus: cc.status,
        previousAttempts: cc.attempts,
      });
      await deps.finalize(call.id);
    };
    if (!stillOn) {
      await stopBeforeDial("Stopped before dialling");
      skipped++;
      break;
    }

    const agentVariables: Record<string, unknown> = {
      ...withoutReservedOutboundVariables(cc.variables as Record<string, unknown> | null),
      // The customer's own business identity wins over contact columns.
      ...templateVariables,
      // Direction, call id and objective last, so no contact column can change them.
      ...outboundVars,
    };

    // The database emergency stop, read once more immediately before the
    // provider request (a stop set after admission lands here).
    if (await outboundEmergencyStopActive(supabaseAdmin)) {
      console.warn("campaign_dispatch:emergency_stop_before_dial", campaign.id, call.id);
      await stopBeforeDial("emergency_stop: stopped before dialling");
      skipped++;
      emergencyStop = true;
      break;
    }

    try {
      const result = await adapter.createInstantOutbound({
        appId: target.appId,
        appVersion: target.appVersion,
        connectionId: connection.provider_connection_id,
        fromE164: admission.caller_number,
        toE164: destination,
        agentVariables,
        appOverrides: { initialBotMessage: openingLine },
        webhookUrl,
        metadata: {
          organizationId: campaign.organization_id,
          campaignId: campaign.id,
          campaignContactId: cc.id,
          // The webhook route resolves its clientReference fallback by call_logs id.
          callId: call.id,
        },
      });
      await persistStartResult(supabaseAdmin, call.id, result);
      dialed++;
    } catch (err) {
      // Race-safe: only a call still `initiated` is changed, and the contact
      // only follows when that change happened. Ambiguous errors hold both in
      // outcome_unknown (no retry); definite rejections fail and may retry.
      const recorded = await recordCampaignStartFailure(
        supabaseAdmin,
        { callId: call.id, campaignContactId: cc.id },
        err,
        // The campaign's "failed" outcome (which may schedule a retry) is applied
        // by finalization, exactly once, guarded by current_call_id.
        async () => {
          await deps.finalize(call.id);
        },
      );
      if (recorded === "outcome_unknown") {
        console.error("campaign_dispatch:outcome_unknown", call.id, (err as Error).message);
      }
    }
  }

  const completed = await maybeCompleteCampaign(campaign.id, supabaseAdmin);
  return { dialed, skipped, completed, emergencyStop };
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
  client?: SupabaseClient<Database>,
) {
  const supabaseAdmin =
    client ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;
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
      output_variables: (retainCallVariables(agentVariables, "outbound") ?? {}) as never,
    })
    .eq("id", campaignContactId);

  if (decision.status === "opted_out") {
    // The contact is ClickAI's own mapping (campaign_contacts.contact_id), never
    // a number or a provider-supplied identifier. Monotonic and idempotent.
    const { data: cc } = await supabaseAdmin
      .from("campaign_contacts")
      .select("contact_id, organization_id")
      .eq("id", campaignContactId)
      .maybeSingle();
    if (cc) {
      await suppressContact(supabaseAdmin, {
        organizationId: cc.organization_id,
        contactId: cc.contact_id,
        reason: "Requested during an outbound call",
      });
    }
  }
}

/** Marks a campaign completed once every enrolled contact has reached a terminal (non-retryable, non-in-flight) state. */
export async function maybeCompleteCampaign(
  campaignId: string,
  client?: SupabaseClient<Database>,
): Promise<boolean> {
  const supabaseAdmin =
    client ?? (await import("@/integrations/supabase/client.server")).supabaseAdmin;
  // A failed read is "not finished": an unread count must never complete a
  // campaign that still has contacts to dial.
  const { count, error: openError } = await supabaseAdmin
    .from("campaign_contacts")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    // outcome_unknown is unresolved, not finished: it keeps the campaign open.
    .in("status", ["pending", "retry_scheduled", "queued", "calling", "outcome_unknown"]);
  if (openError || count === null || count > 0) return false;

  const { data: campaign, error: campaignError } = await supabaseAdmin
    .from("campaigns")
    .select("id, status")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError || !campaign || campaign.status !== "running") return false;

  const { count: totalCount, error: totalError } = await supabaseAdmin
    .from("campaign_contacts")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  if (totalError || !totalCount) return false; // nothing was ever enrolled — not "completed"

  // Only a campaign still running: a pause or cancel that landed since the read above wins.
  const { data: done, error: updateError } = await supabaseAdmin
    .from("campaigns")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("status", "running")
    .select("id");
  if (updateError) {
    console.error("campaign_dispatch:complete_failed", campaignId, updateError.message);
    return false;
  }
  return (done?.length ?? 0) > 0;
}

/** admit_campaign_outbound_call through the service client. */
export async function admitCampaignCall(
  supabaseAdmin: SupabaseClient<Database>,
  request: CampaignAdmissionRequest,
): Promise<CampaignAdmission> {
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  const { data, error } = await rpc("admit_campaign_outbound_call", {
    _campaign: request.campaignId,
    _campaign_contact: request.campaignContactId,
    _call: request.callId,
    _destination: request.destination,
    _retry_attempt: request.retryAttempt,
    _max_in_flight: request.maxInFlight,
    _context_reviewed_at: request.contextReviewedAt,
    _sent_objective: request.sentObjective,
    _sent_instructions: request.sentInstructions,
  });
  if (error) throw new Error(error.message);
  const answer = (data ?? {}) as Record<string, unknown>;
  if (answer["result"] === "admitted" && typeof answer["call_id"] === "string")
    return answer as unknown as CampaignAdmission;
  return { result: "refused", reason: String(answer["reason"] ?? "unknown") };
}
