import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { checkTelephonyAccess, type walletCanAffordOutbound } from "./telephony-guard.server.ts";
import { isOutboundReady } from "./sarvam-outbound-mode.server.ts";
import {
  CALLING_HOURS_MESSAGE,
  OUTBOUND_DISABLED_MESSAGE,
  outboundCallingDisabled,
  withinCallingHours,
} from "./outbound-eligibility.server.ts";
import {
  DAILY_LIMIT_MESSAGE,
  DESTINATION_LIMIT_MESSAGE,
  HOURLY_LIMIT_MESSAGE,
  INSUFFICIENT_BALANCE_MESSAGE,
  SINGLE_CALL_LIMITS,
  TOO_MANY_IN_FLIGHT_MESSAGE,
  sendSarvamInstantOutboundCall,
  type SendInstantOutboundCallResult,
} from "./sarvam-outbound-call.server.ts";

export interface OutboundGates {
  checkTelephonyAccess: typeof checkTelephonyAccess;
}

const DEFAULT_GATES: OutboundGates = { checkTelephonyAccess };

export {
  DAILY_LIMIT_MESSAGE,
  DESTINATION_LIMIT_MESSAGE,
  HOURLY_LIMIT_MESSAGE,
  INSUFFICIENT_BALANCE_MESSAGE,
  SINGLE_CALL_LIMITS,
  TOO_MANY_IN_FLIGHT_MESSAGE,
};

const FINAL_STATUSES = new Set(["completed", "failed", "busy", "no_answer", "cancelled"]);

/**
 * The customer's single Sarvam outbound calls of the last hour: how many, and
 * how many aren't final yet. For the Calls page preview only; the limits
 * themselves are enforced atomically by admit_single_outbound_call.
 */
export async function recentOutboundCallCounts(
  supabaseAdmin: SupabaseClient<Database>,
  orgId: string,
  now: Date = new Date(),
): Promise<{ inFlight: number; lastHour: number }> {
  const { data, error } = await supabaseAdmin
    .from("call_logs")
    .select("id, status")
    .eq("organization_id", orgId)
    .eq("provider", "sarvam")
    .eq("direction", "outbound")
    // Single calls only: a campaign has its own pacing and must not block them.
    .is("campaign_id", null)
    .gt("started_at", new Date(now.getTime() - 60 * 60 * 1000).toISOString());
  if (error) throw error;
  const rows = data ?? [];
  return {
    inFlight: rows.filter((r) => !FINAL_STATUSES.has(r.status)).length,
    lastHour: rows.length,
  };
}

/**
 * The production gate for one Sarvam outbound call on behalf of an
 * organization: the number must belong to `orgId` and be active with outbound
 * enabled, and the phone feature must be unlocked (entitlement/lifecycle/
 * payment). Then the shared sendSarvamInstantOutboundCall, which runs every
 * other rule: eligibility (kill switch, country, calling hours, prior
 * relationship), do-not-call, the test allowlist, connection/agent ownership,
 * outbound readiness, and the atomic admission (limits, wallet, idempotency,
 * one open call per number). The one gate for every single call: the
 * customer's own createSarvamInstantOutboundCall and the admin's
 * call-on-behalf both use it, so an admin can never place a call the
 * customer could not.
 */
export async function placeSarvamCallForOrganization(
  supabaseAdmin: SupabaseClient<Database>,
  params: {
    orgId: string;
    phoneNumberId: string;
    toE164: string;
    objective?: string | undefined;
    idempotencyKey?: string | undefined;
    now?: Date | undefined;
  },
  gates: OutboundGates = DEFAULT_GATES,
): Promise<SendInstantOutboundCallResult> {
  const gate = await gates.checkTelephonyAccess(params.orgId, params.phoneNumberId, "outbound");
  if (!gate.allowed || !gate.phoneNumber)
    throw new Error(gate.reason ?? "Outbound calling is not available.");
  if (gate.phoneNumber.provider !== "sarvam")
    throw new Error("This flow only applies to Sarvam-provisioned numbers.");

  return sendSarvamInstantOutboundCall(supabaseAdmin, {
    phoneNumberId: params.phoneNumberId,
    toE164: params.toE164,
    objective: params.objective,
    idempotencyKey: params.idempotencyKey,
    now: params.now,
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

export interface OutboundCallingNumber {
  id: string;
  e164: string;
  displayNumber: string | null;
  /** Empty when this number can dial now; otherwise why not, for the customer. */
  blockers: string[];
}

export interface OutboundCallingStatus {
  numbers: OutboundCallingNumber[];
  /** Customer price per started minute, in the smallest currency unit. */
  ratePerMinute: number;
  /** The customer's own wallet balance, same unit. */
  walletBalance: number;
  currency: string;
  limits: typeof SINGLE_CALL_LIMITS;
  inFlight: number;
  lastHour: number;
  /** Customer-wide reasons no number can dial (feature locked, balance, limits). */
  blockers: string[];
}

export interface OutboundStatusDeps {
  checkFeatureAccess: (
    orgId: string,
    feature: "phone",
  ) => Promise<{ allowed: boolean; reason: string | null }>;
  walletCanAffordOutbound: typeof walletCanAffordOutbound;
  getCallRate: (
    orgId: string,
    direction: "outbound",
  ) => Promise<{ customerAmountPerMinute: number; currency: string }>;
  now?: () => Date;
}

/**
 * What the customer's Calls page shows before a call: their Sarvam numbers
 * and, for each, why it cannot dial yet, plus the price and limits. A preview
 * only — placeSarvamCallForOrganization re-checks everything at call time.
 * Never returns provider cost.
 */
export async function loadOutboundCallingStatus(
  supabaseAdmin: SupabaseClient<Database>,
  orgId: string,
  deps: OutboundStatusDeps,
): Promise<OutboundCallingStatus> {
  const [numbersRes, feature, rate, counts, walletRes] = await Promise.all([
    supabaseAdmin
      .from("phone_numbers")
      .select("id, e164, display_number, status, provider, outbound_enabled, agent_config_id")
      .eq("organization_id", orgId)
      .eq("provider", "sarvam")
      .eq("status", "active"),
    deps.checkFeatureAccess(orgId, "phone"),
    deps.getCallRate(orgId, "outbound"),
    recentOutboundCallCounts(supabaseAdmin, orgId, deps.now?.()),
    // wallet_balances (migration 20261111090100) is not in the generated types yet.
    (supabaseAdmin as unknown as SupabaseClient)
      .from("wallet_balances")
      .select("balance")
      .eq("organization_id", orgId)
      .maybeSingle(),
  ]);
  if (walletRes.error) throw walletRes.error;
  if (numbersRes.error) throw numbersRes.error;
  const numbers = numbersRes.data ?? [];

  const agentIds = [...new Set(numbers.map((n) => n.agent_config_id).filter(Boolean))] as string[];
  const { data: agents, error: agentError } = agentIds.length
    ? await supabaseAdmin
        .from("agent_configs")
        .select(
          "id, organization_id, sarvam_app_id, sarvam_app_version, sarvam_outbound_ready_app_id, sarvam_outbound_ready_version",
        )
        .in("id", agentIds)
    : { data: [], error: null };
  if (agentError) throw agentError;
  const readyAgents = new Set(
    (agents ?? [])
      .filter((a) => a.organization_id === orgId && isOutboundReady(a))
      .map((a) => a.id),
  );

  const blockers: string[] = [];
  if (outboundCallingDisabled()) blockers.push(OUTBOUND_DISABLED_MESSAGE);
  if (!feature.allowed)
    blockers.push(feature.reason ?? "Phone calling is locked for this workspace.");
  if (!withinCallingHours(deps.now?.() ?? new Date())) blockers.push(CALLING_HOURS_MESSAGE);
  if (counts.inFlight >= SINGLE_CALL_LIMITS.inFlight) blockers.push(TOO_MANY_IN_FLIGHT_MESSAGE);
  else if (counts.lastHour >= SINGLE_CALL_LIMITS.perHour) blockers.push(HOURLY_LIMIT_MESSAGE);
  else if (!(await deps.walletCanAffordOutbound(orgId, counts.inFlight + 1)))
    blockers.push("Your wallet balance is too low for an outbound call. Add funds to call.");

  return {
    numbers: numbers.map((n) => ({
      id: n.id,
      e164: n.e164,
      displayNumber: n.display_number,
      blockers: [
        ...(n.outbound_enabled ? [] : ["Outbound calling is not switched on for this number yet."]),
        ...(n.agent_config_id && readyAgents.has(n.agent_config_id)
          ? []
          : ["Your assistant has not been set up for outbound calls yet."]),
      ],
    })),
    ratePerMinute: rate.customerAmountPerMinute,
    walletBalance: Number((walletRes.data as { balance?: number } | null)?.balance ?? 0),
    currency: rate.currency,
    limits: SINGLE_CALL_LIMITS,
    inFlight: counts.inFlight,
    lastHour: counts.lastHour,
    blockers,
  };
}
