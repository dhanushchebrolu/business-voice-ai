import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { checkTelephonyAccess, walletCanAffordOutbound } from "./telephony-guard.server.ts";
import {
  sendSarvamInstantOutboundCall,
  type SendInstantOutboundCallResult,
} from "./sarvam-outbound-call.server.ts";

export interface OutboundGates {
  checkTelephonyAccess: typeof checkTelephonyAccess;
  walletCanAffordOutbound: typeof walletCanAffordOutbound;
}

const DEFAULT_GATES: OutboundGates = { checkTelephonyAccess, walletCanAffordOutbound };

/**
 * The production gate for one Sarvam outbound call on behalf of an
 * organization: the number must belong to `orgId` and be active with outbound
 * enabled, the phone feature must be unlocked (entitlement/lifecycle/payment),
 * and the wallet must afford a minute. Only then is the shared
 * sendSarvamInstantOutboundCall called, which adds the connection/agent
 * ownership checks, the test allowlist and the one-unresolved-call-per-
 * destination reservation. Same gates, in the same order, as the customer's
 * own createSarvamInstantOutboundCall; used by the admin's call-on-behalf
 * action so an admin can never place a call the customer could not.
 */
export async function placeSarvamCallForOrganization(
  supabaseAdmin: SupabaseClient<Database>,
  params: { orgId: string; phoneNumberId: string; toE164: string },
  gates: OutboundGates = DEFAULT_GATES,
): Promise<SendInstantOutboundCallResult> {
  const gate = await gates.checkTelephonyAccess(params.orgId, params.phoneNumberId, "outbound");
  if (!gate.allowed || !gate.phoneNumber)
    throw new Error(gate.reason ?? "Outbound calling is not available.");
  if (gate.phoneNumber.provider !== "sarvam")
    throw new Error("This flow only applies to Sarvam-provisioned numbers.");

  if (!(await gates.walletCanAffordOutbound(params.orgId)))
    throw new Error("Insufficient wallet balance to place this call.");

  return sendSarvamInstantOutboundCall(supabaseAdmin, {
    phoneNumberId: params.phoneNumberId,
    toE164: params.toE164,
  });
}

/**
 * Everything an admin needs to inspect one call, read from what Klyro
 * actually stored. Fields Sarvam does not send are returned as null and
 * labelled by the UI, never filled in: Sarvam's webhook carries no recording
 * URL (sarvam-provider.server.ts always records recordingUrl: null).
 */
export async function loadCallDetail(supabaseAdmin: SupabaseClient<Database>, callId: string) {
  const { data: call, error } = await supabaseAdmin
    .from("call_logs")
    .select("*")
    .eq("id", callId)
    .maybeSingle();
  if (error) throw error;
  if (!call) throw new Error("Call not found.");

  const interactionId =
    call.provider_metadata &&
    typeof call.provider_metadata === "object" &&
    !Array.isArray(call.provider_metadata) &&
    typeof call.provider_metadata["interaction_id"] === "string"
      ? call.provider_metadata["interaction_id"]
      : null;
  // The telephony webhook route stores each event under the provider's
  // attempt id (Sarvam) or interaction id.
  const eventIds = [call.provider_call_id, interactionId].filter((v): v is string => !!v);

  const [{ data: org }, { data: number }, { data: walletDebits }, { data: events }] =
    await Promise.all([
      supabaseAdmin
        .from("organizations")
        .select("id, name, client_id")
        .eq("id", call.organization_id)
        .maybeSingle(),
      call.phone_number_id
        ? supabaseAdmin
            .from("phone_numbers")
            .select("id, e164, agent_config_id")
            .eq("id", call.phone_number_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabaseAdmin
        .from("wallet_transactions")
        .select("amount, currency, created_at")
        .eq("organization_id", call.organization_id)
        .eq("kind", "call_usage")
        .eq("reference", call.id),
      eventIds.length
        ? supabaseAdmin
            .from("webhook_events")
            .select("event_id, event_type, created_at, processed_at, error")
            .eq("provider", call.provider)
            .in("event_id", eventIds)
            .order("created_at")
        : Promise.resolve({ data: [] }),
    ]);

  const { data: agent } = number?.agent_config_id
    ? await supabaseAdmin
        .from("agent_configs")
        .select("id, agent_name, sarvam_app_id, sarvam_app_version")
        .eq("id", number.agent_config_id)
        .eq("organization_id", call.organization_id)
        .maybeSingle()
    : { data: null };

  const transcript = Array.isArray(call.transcript)
    ? call.transcript.flatMap((t) =>
        t && typeof t === "object" && !Array.isArray(t) && typeof t["text"] === "string"
          ? [{ role: String(t["role"] ?? ""), text: t["text"] }]
          : [],
      )
    : null;

  return {
    id: call.id,
    providerCallId: call.provider_call_id,
    interactionId,
    provider: call.provider,
    direction: call.direction,
    status: call.status,
    customer: {
      id: call.organization_id,
      name: org?.name ?? null,
      clientId: org?.client_id ?? null,
    },
    fromNumber: call.caller_number,
    destinationNumber: call.destination_number,
    phoneNumber: number?.e164 ?? null,
    /** The number's agent now — call_logs does not record which agent answered. */
    agent: agent
      ? {
          name: agent.agent_name,
          sarvamAppId: agent.sarvam_app_id,
          sarvamAppVersion: agent.sarvam_app_version,
        }
      : null,
    startedAt: call.started_at,
    answeredAt: call.answered_at,
    endedAt: call.ended_at,
    durationSeconds: call.duration_seconds,
    recordingUrl: call.recording_url,
    transcript: transcript && transcript.length > 0 ? transcript : null,
    summary: call.summary,
    outcome: call.outcome,
    failureReason: call.failure_reason,
    currency: call.currency,
    providerCost: call.provider_cost,
    customerCharge: call.customer_charge,
    walletDebits: walletDebits ?? [],
    finalizationState: call.finalization_state,
    finalizationError: call.finalization_error,
    finalizationAttempts: call.finalization_attempts,
    billingAppliedAt: call.billing_applied_at,
    resolutionSource: call.resolution_source,
    resolutionConflict: call.resolution_conflict,
    webhookEvents: events ?? [],
  };
}

export type CallDetail = Awaited<ReturnType<typeof loadCallDetail>>;
