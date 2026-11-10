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

export interface SendInstantOutboundCallResult {
  callId: string;
  interactionId: string | null;
  /** "unknown": Sarvam may or may not have placed the call — see recordSarvamStartFailure. */
  outcome: "started" | "unknown";
}

export type StartFailureOutcome = "failed" | "outcome_unknown" | "superseded";

export const INVALID_DESTINATION_MESSAGE =
  "A valid destination number with its country code (for example +91…) is required";

export const UNRESOLVED_CALL_MESSAGE =
  "An earlier call to this number hasn't finished or has an unconfirmed outcome. Wait for it, or resolve it in call history, before calling again.";

/** Returned by the generic initiateOutboundCall for a Sarvam number. */
export const SARVAM_USE_INSTANT_OUTBOUND_MESSAGE =
  "Sarvam numbers place outbound calls through createSarvamInstantOutboundCall, not initiateOutboundCall.";

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
  },
): Promise<SendInstantOutboundCallResult> {
  // Canonical E.164 before anything is read, written or dialled, so the
  // reserved destination_number is the same string a campaign would use.
  const toE164 = normalizeCustomerPhone(params.toE164, null);
  if (!toE164) throw new Error(INVALID_DESTINATION_MESSAGE);
  if (!isSarvamOutboundDestinationAllowed(toE164)) throw new Error(OUTBOUND_TEST_ALLOWLIST_MESSAGE);

  const { data: phoneNumber } = await supabaseAdmin
    .from("phone_numbers")
    .select("id, e164, organization_id, provider, connection_id, agent_config_id")
    .eq("id", params.phoneNumberId)
    .maybeSingle();
  if (!phoneNumber) throw new Error("Phone number not found.");
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

  const adapter = getTelephonyAdapter("sarvam");
  if (!adapter) throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");
  if (!(adapter instanceof SarvamTelephonyAdapter))
    throw new Error("Unexpected adapter type for provider 'sarvam'.");

  const { data: connection } = await supabaseAdmin
    .from("telephony_connections")
    .select("id, provider, provider_connection_id")
    .eq("id", phoneNumber.connection_id)
    .maybeSingle();
  if (!connection || connection.provider !== "sarvam" || !connection.provider_connection_id)
    throw new Error("This number's Sarvam connection has not been registered yet.");

  const { data: agentConfig } = await supabaseAdmin
    .from("agent_configs")
    .select("id, organization_id, sarvam_app_id, sarvam_app_version")
    .eq("id", phoneNumber.agent_config_id)
    .maybeSingle();
  if (!agentConfig || agentConfig.organization_id !== phoneNumber.organization_id)
    throw new Error("This number's agent does not belong to this organization.");
  if (!agentConfig.sarvam_app_id || !agentConfig.sarvam_app_version)
    throw new Error("This number's agent has not been mapped to a Sarvam app yet.");

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
    .select("id")
    .eq("organization_id", phoneNumber.organization_id)
    .eq("provider", "sarvam")
    .eq("direction", "outbound")
    .eq("destination_number", toE164)
    .in("status", [...UNRESOLVED_SARVAM_STATUSES])
    .limit(1)
    .maybeSingle();
  if (unresolved) throw new Error(UNRESOLVED_CALL_MESSAGE);

  const { data: call, error: insertError } = await supabaseAdmin
    .from("call_logs")
    .insert({
      organization_id: phoneNumber.organization_id,
      phone_number_id: phoneNumber.id,
      provider: "sarvam",
      direction: "outbound",
      caller_number: phoneNumber.e164,
      destination_number: toE164,
      status: "initiated",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  // 23505: a concurrent request reserved this number first. Nothing was dialled.
  if (insertError?.code === "23505") throw new Error(UNRESOLVED_CALL_MESSAGE);
  if (insertError) throw insertError;

  try {
    const dialed = await adapter.createInstantOutbound({
      appId: agentConfig.sarvam_app_id,
      appVersion: agentConfig.sarvam_app_version,
      connectionId: connection.provider_connection_id,
      fromE164: phoneNumber.e164,
      toE164,
      agentVariables: params.agentVariables,
      webhookUrl,
      metadata: { organizationId: phoneNumber.organization_id, callId: call.id },
    });

    // Sarvam's documented response is { attempt_id }, the same key every
    // single-call webhook carries, so only it becomes provider_call_id. When
    // it is missing, provider_call_id stays null (never an interaction_id, so
    // the webhook route's attempt-id check can't reject the real webhook) and
    // the webhook's metadata.call_id fallback backfills it.
    const patch: Record<string, unknown> = {};
    if (dialed.attemptId) patch["provider_call_id"] = dialed.attemptId;
    if (dialed.interactionId) patch["provider_metadata"] = { interaction_id: dialed.interactionId };
    if (Object.keys(patch).length > 0) {
      await supabaseAdmin
        .from("call_logs")
        .update(patch as never)
        .eq("id", call.id);
    }
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
