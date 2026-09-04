import type { Database } from "@/integrations/supabase/types";
import type { NormalizedCallStatus } from "./telephony/adapter";

/**
 * Shared server-only telephony authorization, call-state-machine and
 * billing logic. Used by both the inbound webhook route and the outbound
 * call server function so the two flows can never drift into different
 * rules (spec §5: "do not create a parallel authorization system").
 *
 * Every check here re-derives its answer from the database on each call —
 * nothing is cached across requests and nothing is ever taken on the
 * browser's word.
 */

type PhoneNumberRow = Database["public"]["Tables"]["phone_numbers"]["Row"];
type CallLogRow = Database["public"]["Tables"]["call_logs"]["Row"];

export type CallDirection = "inbound" | "outbound";

/* ------------------------------------------------------------------ */
/* Entitlement gate (spec §5)                                          */
/* ------------------------------------------------------------------ */

export interface TelephonyGateResult {
  allowed: boolean;
  reason: string | null;
  phoneNumber: PhoneNumberRow | null;
}

/**
 * Full pre-call authorization check. Reuses the existing `feature_locked()`
 * resolver (customer lock -> explicit feature lock -> entitlement ->
 * payment enforcement -> platform default) for everything account-level,
 * and only adds the two checks that are specific to telephony: the number's
 * own provisioning status and its inbound/outbound flags.
 */
export async function checkTelephonyAccess(
  orgId: string,
  phoneNumberId: string,
  direction: CallDirection,
): Promise<TelephonyGateResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: locked, error: lockError } = await supabaseAdmin.rpc("feature_locked", {
    _org: orgId,
    _feature: "phone",
  });
  if (lockError)
    return {
      allowed: false,
      reason: "Could not evaluate telephony entitlement.",
      phoneNumber: null,
    };
  if (locked)
    return { allowed: false, reason: "Telephony is locked for this customer.", phoneNumber: null };

  const { data: number } = await supabaseAdmin
    .from("phone_numbers")
    .select("*")
    .eq("id", phoneNumberId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!number)
    return {
      allowed: false,
      reason: "This phone number is not assigned to this organization.",
      phoneNumber: null,
    };
  if (number.status !== "active")
    return {
      allowed: false,
      reason: `This number is ${number.status}, not active.`,
      phoneNumber: number,
    };
  if (direction === "inbound" && !number.inbound_enabled)
    return {
      allowed: false,
      reason: "Inbound calling is disabled on this number.",
      phoneNumber: number,
    };
  if (direction === "outbound" && !number.outbound_enabled)
    return {
      allowed: false,
      reason: "Outbound calling is disabled on this number.",
      phoneNumber: number,
    };

  return { allowed: true, reason: null, phoneNumber: number };
}

/* ------------------------------------------------------------------ */
/* Call state machine (spec §7)                                        */
/* ------------------------------------------------------------------ */

const ALLOWED_TRANSITIONS: Record<NormalizedCallStatus, NormalizedCallStatus[]> = {
  initiated: ["ringing", "answered", "in_progress", "failed", "busy", "no_answer", "cancelled"],
  ringing: ["answered", "in_progress", "failed", "busy", "no_answer", "cancelled"],
  answered: ["in_progress", "completed", "failed"],
  in_progress: ["completed", "failed"],
  completed: [],
  failed: [],
  busy: [],
  no_answer: [],
  cancelled: [],
};

export interface TransitionCheck {
  ok: boolean;
  changed: boolean;
  reason?: string;
}

/** Server-side transition validation (spec §7). Same-state events are a no-op, never an error. */
export function checkCallTransition(current: string, next: NormalizedCallStatus): TransitionCheck {
  if (current === next) return { ok: true, changed: false };
  const from = current as NormalizedCallStatus;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) return { ok: true, changed: true }; // unknown legacy status value — do not block, just record
  if (!allowed.includes(next)) {
    return { ok: false, changed: false, reason: `Illegal call transition: ${current} -> ${next}` };
  }
  return { ok: true, changed: true };
}

export const TERMINAL_CALL_STATUSES: NormalizedCallStatus[] = [
  "completed",
  "failed",
  "busy",
  "no_answer",
  "cancelled",
];

/* ------------------------------------------------------------------ */
/* Pricing + billing (spec §12/§13/§14)                                 */
/* ------------------------------------------------------------------ */

const PRICING_KEY: Record<CallDirection, string> = {
  inbound: "voice_minute",
  outbound: "outbound_minute",
};

export interface CallRate {
  customerAmountPerMinute: number;
  providerCostPerMinute: number;
  currency: string;
}

/**
 * Per-minute rate for a call direction, honouring a per-customer pricing
 * override the same way `customer_rate()` does for the customer-safe path —
 * but this runs fully server-side (service_role) so it may also read
 * provider_cost, which customer_rate() deliberately never returns.
 */
export async function getCallRate(orgId: string, direction: CallDirection): Promise<CallRate> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const key = PRICING_KEY[direction];

  const [{ data: rule }, { data: override }] = await Promise.all([
    supabaseAdmin
      .from("pricing_rules")
      .select("customer_amount, provider_cost, currency")
      .eq("key", key)
      .maybeSingle(),
    supabaseAdmin
      .from("organization_pricing_overrides")
      .select("customer_amount, provider_cost")
      .eq("organization_id", orgId)
      .eq("key", key)
      .maybeSingle(),
  ]);

  return {
    customerAmountPerMinute: override?.customer_amount ?? rule?.customer_amount ?? 0,
    providerCostPerMinute: override?.provider_cost ?? rule?.provider_cost ?? 0,
    currency: rule?.currency ?? "INR",
  };
}

/** Pre-dial affordability check for outbound calls (spec §13, first minute must be covered). */
export async function walletCanAffordOutbound(orgId: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const rate = await getCallRate(orgId, "outbound");
  if (rate.customerAmountPerMinute <= 0) return true;
  const { data, error } = await supabaseAdmin.rpc("wallet_can_afford", {
    _org: orgId,
    _amount: rate.customerAmountPerMinute,
  });
  if (error) return false;
  return Boolean(data);
}

export interface FinalizeBillingResult {
  customerCharge: number;
  providerCost: number;
  currency: string;
  walletBalance: number;
}

/**
 * Applies the real, final cost of a completed/failed call: rounds duration
 * up to whole minutes (standard telephony billing), atomically debits the
 * wallet (idempotent per call — see debit_wallet_for_call in the Phase D
 * migration), writes the amounts onto call_logs for the admin/customer view,
 * and records one usage_records row so the existing profit/margin dashboard
 * (getProfitAnalytics) picks it up without any changes on its side.
 */
export async function finalizeCallBilling(
  call: Pick<CallLogRow, "id" | "organization_id" | "direction">,
  durationSeconds: number,
): Promise<FinalizeBillingResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const direction = (call.direction === "outbound" ? "outbound" : "inbound") as CallDirection;
  const rate = await getCallRate(call.organization_id, direction);
  const billableMinutes = durationSeconds > 0 ? Math.ceil(durationSeconds / 60) : 0;
  const customerCharge = billableMinutes * rate.customerAmountPerMinute;
  const providerCost = billableMinutes * rate.providerCostPerMinute;

  const { data: debitRows, error: debitError } = await supabaseAdmin.rpc("debit_wallet_for_call", {
    _org: call.organization_id,
    _call_id: call.id,
    _amount: customerCharge,
    _description: `${direction} call · ${billableMinutes} min`,
  });
  if (debitError) throw debitError;
  const debit = debitRows?.[0];

  await supabaseAdmin
    .from("call_logs")
    .update({
      customer_charge: customerCharge,
      provider_cost: providerCost,
      currency: rate.currency,
    })
    .eq("id", call.id);

  if (!debit?.already_applied && billableMinutes > 0) {
    // Idempotent at the storage layer too (unique on call_id+kind) — a retry
    // that reaches here after a partial prior failure still cannot double-count.
    await supabaseAdmin.from("usage_records").upsert(
      {
        organization_id: call.organization_id,
        call_id: call.id,
        kind: "call",
        provider: "telephony",
        quantity: billableMinutes,
        unit: "minute",
        provider_cost: providerCost,
        billable_cost: customerCharge,
      },
      { onConflict: "call_id,kind", ignoreDuplicates: true },
    );
  }

  return {
    customerCharge,
    providerCost,
    currency: rate.currency,
    walletBalance: debit?.balance ?? 0,
  };
}
