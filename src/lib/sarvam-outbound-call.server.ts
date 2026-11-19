import { TEMPLATE_AGENT_COLUMNS, templateCallVariables } from "./sarvam-tenant-variables.server.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  getTelephonyAdapter,
  SARVAM_WEBHOOK_SECRET_MISSING_MESSAGE,
  sarvamOutboundWebhookUrl,
} from "./telephony.server.ts";
import { SarvamTelephonyAdapter } from "./telephony/sarvam-provider.server.ts";
import { TelephonyAdapterError } from "./telephony/adapter.ts";
import { UNRESOLVED_SARVAM_STATUSES } from "./sarvam-call-review.ts";
import { normalizeCustomerPhone } from "./phone-number.ts";
import { finalizeTerminalCallSafely } from "./telephony/call-finalization.server.ts";
import { isNumberSuppressed, OPT_OUT_NUMBER_MESSAGE } from "./contact-suppression.server.ts";
import {
  hasPriorRelationship,
  NO_RELATIONSHIP_MESSAGE,
  staticEligibilityBlocker,
} from "./outbound-eligibility.server.ts";
import {
  isOutboundReady,
  OUTBOUND_NOT_READY_MESSAGE,
  outboundBusinessName,
  outboundCallVariables,
  outboundOpeningLine,
  withoutReservedOutboundVariables,
} from "./sarvam-outbound-mode.server.ts";

export interface SendInstantOutboundCallResult {
  callId: string;
  interactionId: string | null;
  /** "unknown": Sarvam may or may not have placed the call — see recordSarvamStartFailure. */
  outcome: "started" | "unknown";
  /** True when this request repeated an earlier one (same idempotency key): nothing was dialled. */
  duplicate?: boolean;
}

/**
 * Per-customer limits on single outbound calls, enforced atomically by
 * admit_single_outbound_call (migration 20261119090000) under the customer's
 * row lock, so simultaneous requests can never pass together. Campaign calls
 * never count. Windows: calls not final yet (last 24 h), started in the last
 * hour, started in the last 24 h, and to one number in the last 24 h.
 */
export const SINGLE_CALL_LIMITS = {
  inFlight: 3,
  perHour: 30,
  perDay: 100,
  perDestinationDay: 2,
} as const;

export const TOO_MANY_IN_FLIGHT_MESSAGE = `You already have ${SINGLE_CALL_LIMITS.inFlight} outbound calls in progress. Wait for one to finish before placing another.`;
export const HOURLY_LIMIT_MESSAGE = `You have reached the limit of ${SINGLE_CALL_LIMITS.perHour} outbound calls an hour. Try again later.`;
export const DAILY_LIMIT_MESSAGE = `You have reached the limit of ${SINGLE_CALL_LIMITS.perDay} outbound calls a day. Try again tomorrow.`;
export const DESTINATION_LIMIT_MESSAGE = `This number has already been called ${SINGLE_CALL_LIMITS.perDestinationDay} times in the last 24 hours. Try again tomorrow.`;
export const INSUFFICIENT_BALANCE_MESSAGE =
  "Insufficient wallet balance to place this call. Your balance must cover the longest this call can run, plus any calls still in progress.";
export const MAX_CALL_LENGTH_NOT_SET_MESSAGE =
  "This customer's agent has no maximum call length recorded for outbound calls yet.";
export const IDEMPOTENCY_KEY_REUSED_MESSAGE =
  "This request was already used for a different number. Close the dialog and try again.";
export { REQUEST_KEY_SPENT_MESSAGE as DUPLICATE_FAILED_MESSAGE } from "./request-key.ts";
import { REQUEST_KEY_SPENT_MESSAGE } from "./request-key.ts";

/** Why admit_single_outbound_call refused, as the caller is told. */
export function admissionRefusalMessage(reason: unknown): string {
  switch (reason) {
    case "in_flight_limit":
      return TOO_MANY_IN_FLIGHT_MESSAGE;
    case "hourly_limit":
      return HOURLY_LIMIT_MESSAGE;
    case "daily_limit":
      return DAILY_LIMIT_MESSAGE;
    case "destination_daily_limit":
      return DESTINATION_LIMIT_MESSAGE;
    case "insufficient_balance":
      return INSUFFICIENT_BALANCE_MESSAGE;
    case "destination_busy":
      return UNRESOLVED_CALL_MESSAGE;
    case "number_not_owned":
      return "This phone number is not assigned to this organization.";
    case "idempotency_key_reused":
      return IDEMPOTENCY_KEY_REUSED_MESSAGE;
    case "invalid_destination":
      return INVALID_DESTINATION_MESSAGE;
    case "max_call_length_not_set":
      return MAX_CALL_LENGTH_NOT_SET_MESSAGE;
    default:
      return "This call could not be admitted. Try again, or contact support if it keeps happening.";
  }
}

/** A client-supplied idempotency key: 16–100 letters, digits, "_" or "-" (the database's own rule). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

function newIdempotencyKey(): string {
  return `srv_${crypto.randomUUID().replace(/-/g, "")}`;
}

export type StartFailureOutcome = "failed" | "outcome_unknown" | "superseded";

export const INVALID_DESTINATION_MESSAGE =
  "A valid destination number with its country code (for example +91…) is required";

export const UNRESOLVED_CALL_MESSAGE =
  "An earlier call to this number hasn't finished or has an unconfirmed outcome. Wait for it, or resolve it in call history, before calling again.";

export const OUTBOUND_TEST_ALLOWLIST_MESSAGE =
  "Sarvam outbound calling is limited to approved test numbers right now.";

/**
 * Supervised-test guard. When SARVAM_OUTBOUND_TEST_ALLOWLIST is set (comma-
 * separated numbers, canonicalized like every outbound number), every Sarvam
 * outbound path — single calls, the admin test call and the campaign
 * dispatcher — refuses any other destination before anything is written or
 * dialled. Unset means no restriction. Set but with no valid number means
 * nothing is allowed (fails closed). Remove it at production rollout.
 */
export function isSarvamOutboundDestinationAllowed(toE164: string): boolean {
  const raw = process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"];
  if (!raw || !raw.trim()) return true;
  const allowed = raw
    .split(",")
    .map((n) => normalizeCustomerPhone(n.trim(), null))
    .filter((n): n is string => n !== null);
  return allowed.includes(toE164);
}

/**
 * Records a failed Sarvam start-call request on its call_logs row, only while
 * the row is still `initiated` (a database condition, not a read-then-write).
 *
 * - Ambiguous errors (TelephonyAdapterError.outcomeUnknown: timeout, network,
 *   5xx, 429, ...) -> `outcome_unknown`: Sarvam may have placed the call, so
 *   it is never treated as failed or retried automatically.
 * - Anything else (a definite rejection, or an error before any request was
 *   sent) -> `failed`.
 * - "superseded": the row had already left `initiated` — a webhook resolved
 *   the call first — so nothing is written and callers must not touch
 *   campaign state either.
 */
export async function recordSarvamStartFailure(
  supabaseAdmin: SupabaseClient<Database>,
  callId: string,
  err: unknown,
): Promise<StartFailureOutcome> {
  const unknown = err instanceof TelephonyAdapterError && err.outcomeUnknown;
  const message = err instanceof Error ? err.message : String(err);
  const patch = unknown
    ? { status: "outcome_unknown", failure_reason: message }
    : {
        status: "failed",
        failure_reason: message,
        ended_at: new Date().toISOString(),
        resolution_source: "start_failure",
      };
  const { data, error } = await supabaseAdmin
    .from("call_logs")
    .update(patch)
    .eq("id", callId)
    .eq("status", "initiated")
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) return "superseded";
  return unknown ? "outcome_unknown" : "failed";
}

/**
 * Saves Sarvam's start response on the call row: only `attempt_id` becomes
 * provider_call_id (never interaction_id, so the webhook's attempt-id check
 * cannot reject the real result); interaction_id goes to provider_metadata.
 *
 * Never throws: the call has been placed, so a failed write must not be
 * mistaken for a failed start. One retry, then a log line. The call still
 * resolves: Sarvam's result webhook finds the row by metadata.call_id and
 * backfills provider_call_id. Returns whether the response was saved.
 */
export async function persistStartResult(
  supabaseAdmin: SupabaseClient<Database>,
  callId: string,
  started: { attemptId?: string | undefined; interactionId?: string | undefined },
): Promise<boolean> {
  const patch: Record<string, unknown> = {};
  if (started.attemptId) patch["provider_call_id"] = started.attemptId;
  if (started.interactionId) patch["provider_metadata"] = { interaction_id: started.interactionId };
  if (Object.keys(patch).length === 0) return true;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { error } = await supabaseAdmin
        .from("call_logs")
        .update(patch as never)
        .eq("id", callId);
      if (!error) return true;
      console.error("sarvam_outbound:start_result_not_saved", {
        callId,
        attempt,
        code: (error as { code?: string }).code ?? null,
      });
    } catch (err) {
      console.error("sarvam_outbound:start_result_not_saved", {
        callId,
        attempt,
        error: (err as Error).message,
      });
    }
  }
  return false;
}

/**
 * Undoes the campaign dispatcher's claim on a contact when its call row could
 * not be inserted — nothing was dialled, so this is a deferral, not a retry.
 * Restores the contact's previous status and attempt count, but only while it
 * is still exactly as this claim left it (`calling`, attempts + 1), so a later
 * claim or a webhook outcome is never overwritten. `next_attempt_at` is left
 * as it was, so the contact is simply due again on a later dispatch run.
 *
 * A cancelled campaign keeps its cancellation: the contact becomes
 * `cancelled` instead of pending/retry_scheduled. cancelCampaign
 * (campaigns.functions.ts) marks the campaign cancelled BEFORE it cancels the
 * open contacts, so checking the campaign again after restoring closes the
 * window where a cancellation lands between the two: either its contact
 * update sees the restored row, or this re-check sees the cancelled campaign.
 */
export async function releaseCampaignClaim(
  supabaseAdmin: SupabaseClient<Database>,
  claim: {
    campaignId: string;
    campaignContactId: string;
    previousStatus: string;
    previousAttempts: number;
  },
): Promise<"restored" | "cancelled" | "unchanged"> {
  const campaignCancelled = async () => {
    const { data, error } = await supabaseAdmin
      .from("campaigns")
      .select("status")
      .eq("id", claim.campaignId)
      .maybeSingle();
    if (error) throw error;
    return data?.status === "cancelled";
  };
  const cancelled = await campaignCancelled();
  const { data, error } = await supabaseAdmin
    .from("campaign_contacts")
    .update(
      // current_call_id: the claim's call was never inserted, so nothing points here.
      cancelled
        ? {
            status: "cancelled",
            attempts: claim.previousAttempts,
            next_attempt_at: null,
            current_call_id: null,
          }
        : { status: claim.previousStatus, attempts: claim.previousAttempts, current_call_id: null },
    )
    .eq("id", claim.campaignContactId)
    .eq("status", "calling")
    .eq("attempts", claim.previousAttempts + 1)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) return "unchanged";
  if (cancelled) return "cancelled";

  if (!(await campaignCancelled())) return "restored";
  const { error: cancelError } = await supabaseAdmin
    .from("campaign_contacts")
    .update({ status: "cancelled", next_attempt_at: null })
    .eq("id", claim.campaignContactId)
    .eq("status", claim.previousStatus);
  if (cancelError) throw cancelError;
  return "cancelled";
}

/**
 * Campaign-dispatcher variant: records the call first (recordSarvamStartFailure)
 * and touches the campaign contact only if that transition actually happened.
 * - failed: runs the normal campaign outcome (`onDefiniteFailure`), which may retry.
 * - outcome_unknown: holds the contact in outcome_unknown, only while it is
 *   still `calling` — a webhook that already resolved it wins. Never retried.
 * - superseded: the webhook already applied the campaign outcome; no change.
 */
export async function recordCampaignStartFailure(
  supabaseAdmin: SupabaseClient<Database>,
  ids: { callId: string; campaignContactId: string },
  err: unknown,
  onDefiniteFailure: () => Promise<void>,
): Promise<StartFailureOutcome> {
  const recorded = await recordSarvamStartFailure(supabaseAdmin, ids.callId, err);
  if (recorded === "failed") await onDefiniteFailure();
  if (recorded === "outcome_unknown") {
    const { error } = await supabaseAdmin
      .from("campaign_contacts")
      .update({ status: "outcome_unknown", next_attempt_at: null })
      .eq("id", ids.campaignContactId)
      .eq("status", "calling");
    if (error) throw error;
  }
  return recorded;
}

/**
 * Core validation + Sarvam call for placing one instant outbound call,
 * extracted from sarvam-outbound.functions.ts's createSarvamInstantOutboundCall
 * so the admin-only test action (Task list item 5, sarvam-admin.functions.ts's
 * testSarvamOutboundCall) calls exactly the same logic the customer-facing
 * path uses — not a second reimplementation. Mirrors
 * sarvam-inbound-deployment.server.ts's createInboundDeploymentForNumbers
 * in shape and intent.
 *
 * Callers own authorization: this function performs no auth, entitlement,
 * or wallet check itself. The customer-facing function gates on org
 * membership + checkTelephonyAccess + wallet affordability before calling
 * this; the admin test action gates on assertPlatformAdmin + an explicit
 * confirmTest flag + a demo/test-organization restriction before calling
 * this.
 *
 * Preserves the existing create-call-log-first pattern: the call_logs row
 * is created, and its own id is sent to Sarvam as metadata.callId, BEFORE
 * the provider is ever called — so even when Sarvam's response carries no
 * interaction_id synchronously, the webhook's own clientReference fallback
 * can still find and backfill this exact row. Does not fake success: a
 * definitely-rejected adapter call marks the row failed and rethrows; an
 * ambiguous one (timeout, 5xx, 429, ...) marks it outcome_unknown and
 * returns outcome "unknown" — see recordSarvamStartFailure.
 */
export async function sendSarvamInstantOutboundCall(
  supabaseAdmin: SupabaseClient<Database>,
  params: {
    phoneNumberId: string;
    toE164: string;
    agentVariables?: Record<string, unknown> | undefined;
    /** Why this call is made; reaches the agent as campaign_objective. */
    objective?: string | undefined;
    /** Extra instructions from the customer; reaches the agent as campaign_instructions. */
    instructions?: string | undefined;
    /**
     * The client's request id: a repeat (double click, retry, refresh) returns
     * the first request's call and dials nothing. Generated when absent.
     */
    idempotencyKey?: string | undefined;
    /** The clock for the calling-hours rule. Defaults to now; tests fix it. */
    now?: Date | undefined;
  },
): Promise<SendInstantOutboundCallResult> {
  // Canonical E.164 before anything is read, written or dialled, so the
  // reserved destination_number is the same string a campaign would use.
  const toE164 = normalizeCustomerPhone(params.toE164, null);
  if (!toE164) throw new Error(INVALID_DESTINATION_MESSAGE);
  if (params.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(params.idempotencyKey))
    throw new Error("This request is missing a valid request id.");
  const idempotencyKey = params.idempotencyKey ?? newIdempotencyKey();
  // Kill switch, destination country, calling hours (outbound-eligibility.server.ts).
  const blocked = staticEligibilityBlocker(toE164, params.now ?? new Date());
  if (blocked) throw new Error(blocked);
  if (!isSarvamOutboundDestinationAllowed(toE164)) throw new Error(OUTBOUND_TEST_ALLOWLIST_MESSAGE);

  const { data: phoneNumber } = await supabaseAdmin
    .from("phone_numbers")
    .select("id, e164, organization_id, provider, connection_id, agent_config_id, outbound_enabled")
    .eq("id", params.phoneNumberId)
    .maybeSingle();
  if (!phoneNumber) throw new Error("Phone number not found.");
  // Every path, including the admin demo test, respects the number's own outbound switch.
  if (phoneNumber.outbound_enabled !== true)
    throw new Error("Outbound calling is disabled on this number.");
  if (phoneNumber.provider !== "sarvam")
    throw new Error("This flow only applies to Sarvam-provisioned numbers.");
  if (!phoneNumber.organization_id)
    throw new Error("This phone number has no organization assigned.");
  if (!phoneNumber.connection_id)
    throw new Error("This number has no telephony connection configured.");
  if (!phoneNumber.agent_config_id) throw new Error("This number has no agent configured.");

  // Authenticated result URL (verify_token); refuse rather than dial a call
  // whose result Klyro would reject. Never logged: it contains the secret.
  const webhook = sarvamOutboundWebhookUrl();
  if (!webhook.ok)
    throw new Error(
      webhook.reason === "webhook_secret_missing"
        ? SARVAM_WEBHOOK_SECRET_MISSING_MESSAGE
        : "Outbound calling is not configured on this platform yet.",
    );
  const webhookUrl = webhook.url;
  // Do-not-call: refused before anything is written or dialled.
  if (await isNumberSuppressed(supabaseAdmin, phoneNumber.organization_id, toE164))
    throw new Error(OPT_OUT_NUMBER_MESSAGE);
  // No cold calls: the person must already have dealt with this business.
  if (!(await hasPriorRelationship(supabaseAdmin, phoneNumber.organization_id, toE164)))
    throw new Error(NO_RELATIONSHIP_MESSAGE);

  const adapter = getTelephonyAdapter("sarvam");
  if (!adapter) throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");
  if (!(adapter instanceof SarvamTelephonyAdapter))
    throw new Error("Unexpected adapter type for provider 'sarvam'.");

  const { data: connection } = await supabaseAdmin
    .from("telephony_connections")
    .select("id, organization_id, provider, provider_connection_id")
    .eq("id", phoneNumber.connection_id)
    .maybeSingle();
  if (!connection || connection.provider !== "sarvam" || !connection.provider_connection_id)
    throw new Error("This number's Sarvam connection has not been registered yet.");
  // A reassigned number must never dial through its previous customer's connection.
  if (connection.organization_id !== phoneNumber.organization_id)
    throw new Error("This number's Sarvam connection does not belong to this organization.");

  const { data: agentConfig } = await supabaseAdmin
    .from("agent_configs")
    .select(
      `id, organization_id, sarvam_app_id, sarvam_app_version, sarvam_outbound_ready_app_id, sarvam_outbound_ready_version, ${TEMPLATE_AGENT_COLUMNS}`,
    )
    .eq("id", phoneNumber.agent_config_id)
    .maybeSingle();
  if (!agentConfig || agentConfig.organization_id !== phoneNumber.organization_id)
    throw new Error("This number's agent does not belong to this organization.");
  if (!agentConfig.sarvam_app_id || !agentConfig.sarvam_app_version)
    throw new Error("This number's agent has not been mapped to a Sarvam app yet.");
  // The customer's one agent dials only in a version confirmed for outbound.
  if (!isOutboundReady(agentConfig)) throw new Error(OUTBOUND_NOT_READY_MESSAGE);
  // Read before the call row is reserved, so a missing profile dials nothing.
  const templateVariables = await templateCallVariables(
    supabaseAdmin,
    agentConfig,
    phoneNumber.organization_id,
  );
  const openingLine = outboundOpeningLine(await outboundBusinessName(supabaseAdmin, agentConfig));

  // An earlier Sarvam call to this number that is still unresolved —
  // `initiated` (in progress, or its start request never finished) or
  // `outcome_unknown` — must finish or be resolved first, or calling again
  // risks a duplicate. This read only gives the early, clear message; the
  // atomic guarantee — against concurrent single calls and campaign calls
  // alike — is the idx_call_logs_sarvam_outbound_number_reservation unique
  // index on the insert below. Same set an operator can resolve
  // (isResolvableSarvamCall).
  const { data: unresolved } = await supabaseAdmin
    .from("call_logs")
    .select("id, status, idempotency_key")
    .eq("organization_id", phoneNumber.organization_id)
    .eq("provider", "sarvam")
    .eq("direction", "outbound")
    .eq("destination_number", toE164)
    .in("status", [...UNRESOLVED_SARVAM_STATUSES])
    .limit(1)
    .maybeSingle();
  // The same request again while its call is still open: that call, nothing dialled.
  if (unresolved && unresolved.idempotency_key === idempotencyKey)
    return duplicateResult(unresolved.id, unresolved.status);
  if (unresolved) throw new Error(UNRESOLVED_CALL_MESSAGE);

  // The reservation: limits, wallet, idempotency and the call row, atomically
  // (admit_single_outbound_call, under the customer's row lock).
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  const { data: admission, error: admissionError } = await rpc("admit_single_outbound_call", {
    _org: phoneNumber.organization_id,
    _phone_number_id: phoneNumber.id,
    _destination: toE164,
    _caller_number: phoneNumber.e164,
    _idempotency_key: idempotencyKey,
    _max_in_flight: SINGLE_CALL_LIMITS.inFlight,
    _max_per_hour: SINGLE_CALL_LIMITS.perHour,
    _max_per_day: SINGLE_CALL_LIMITS.perDay,
    _max_per_destination_day: SINGLE_CALL_LIMITS.perDestinationDay,
  });
  if (admissionError) throw admissionError;
  const admitted = (admission ?? {}) as {
    result?: string;
    reason?: string;
    call_id?: string;
    status?: string;
  };
  if (admitted.result === "duplicate" && admitted.call_id)
    return duplicateResult(admitted.call_id, admitted.status ?? "initiated");
  if (admitted.result !== "admitted" || !admitted.call_id) {
    console.info("sarvam_outbound:admission_refused", {
      organizationId: phoneNumber.organization_id,
      reason: admitted.reason ?? "unknown",
    });
    throw new Error(admissionRefusalMessage(admitted.reason));
  }
  const call = { id: admitted.call_id };

  try {
    const dialed = await adapter.createInstantOutbound({
      appId: agentConfig.sarvam_app_id,
      appVersion: agentConfig.sarvam_app_version,
      connectionId: connection.provider_connection_id,
      fromE164: phoneNumber.e164,
      toE164,
      // Direction, call id and objective last, so nothing else can change them.
      agentVariables: {
        ...withoutReservedOutboundVariables(params.agentVariables),
        ...templateVariables,
        ...outboundCallVariables({
          callId: call.id,
          objective: params.objective,
          instructions: params.instructions,
        }),
      },
      appOverrides: { initialBotMessage: openingLine },
      webhookUrl,
      metadata: { organizationId: phoneNumber.organization_id, callId: call.id },
    });

    // Sarvam's documented response is { attempt_id }; when it is missing the
    // webhook's metadata.call_id fallback backfills provider_call_id.
    await persistStartResult(supabaseAdmin, call.id, dialed);
    return { callId: call.id, interactionId: dialed.interactionId ?? null, outcome: "started" };
  } catch (err) {
    const recorded = await recordSarvamStartFailure(supabaseAdmin, call.id, err);
    if (recorded === "failed") {
      // Not placed: finalization records a zero charge and marks it done.
      await finalizeTerminalCallSafely(supabaseAdmin, call.id);
      throw err;
    }
    // outcome_unknown: held for a webhook or operator. superseded: a webhook
    // already recorded the real outcome, so Sarvam did place the call.
    return {
      callId: call.id,
      interactionId: null,
      outcome: recorded === "outcome_unknown" ? "unknown" : "started",
    };
  }
}

/** A repeated request: report the first request's call without dialling again. */
function duplicateResult(callId: string, status: string): SendInstantOutboundCallResult {
  if (status === "failed" || status === "cancelled") throw new Error(REQUEST_KEY_SPENT_MESSAGE);
  return {
    callId,
    interactionId: null,
    outcome: status === "outcome_unknown" ? "unknown" : "started",
    duplicate: true,
  };
}
