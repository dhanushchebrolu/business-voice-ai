import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  decideCampaignContactOutcome,
  detectSpecialOutcome,
  type CallTerminalStatus,
} from "../campaign-outcome.ts";
import { callLeadId } from "../sarvam-agent-api.server.ts";
import { normalizeCustomerPhone } from "../phone-number.ts";
import { suppressContact } from "../contact-suppression.server.ts";
import {
  finalCallVariables,
  leadNotesFromVariables,
  retainCallVariables,
} from "../call-variables.ts";

/**
 * Finalization of a SARVAM OUTBOUND call that has reached a final status:
 * billing and the campaign effect, each exactly once, safe to run again.
 *
 * The guarantees live in the database (migration
 * 20261110090000_sarvam_outbound_call_finalization.sql):
 *   - a trigger marks the call `pending` whenever it first becomes final, so
 *     no write path can skip this;
 *   - claim_call_finalization gives one holder a lease;
 *   - apply_call_billing / apply_call_campaign_outcome lock the call row,
 *     refuse a stale lease, skip a step whose checkpoint is set, and write the
 *     step's effects together with its checkpoint in one transaction;
 *   - complete_call_finalization only succeeds once both checkpoints are set.
 *
 * This function only orchestrates: it reads the inputs (rate, retry policy,
 * agent variables), runs every step that isn't done yet — a failed billing
 * step never stops the campaign step, and the reverse — then marks the call
 * done or failed. A failed call stays visible to admins (Calls → Needs review);
 * the sweep.call_finalization job retries pending ones, and admins retry from there.
 *
 * Sarvam inbound, Exotel, Vobiz and LiveKit calls never come here.
 */

export const FINALIZATION_LEASE_SECONDS = 120;

export type FinalizationResult =
  | { state: "done" }
  | { state: "failed"; error: string }
  /** Nothing to do (already done / not a pending call) or another holder's lease is live. */
  | { state: "skipped" };

export interface CallRate {
  customerAmountPerMinute: number;
  providerCostPerMinute: number;
  currency: string;
}

export interface FinalizationDeps {
  /** Defaults to telephony-guard.server.ts's getCallRate. Injectable for tests. */
  getRate?: (organizationId: string, direction: "outbound") => Promise<CallRate>;
}

type Client = SupabaseClient<Database>;
type RpcResult = { data: unknown; error: { message: string } | null };
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;

interface FinalizingCall {
  id: string;
  organization_id: string;
  status: string;
  duration_seconds: number;
  campaign_id: string | null;
  campaign_contact_id: string | null;
  contact_id: string | null;
  business_id?: string | null;
  destination_number?: string | null;
  final_agent_variables: unknown;
  billing_applied_at: string | null;
  campaign_applied_at: string | null;
  /** Locked at admission (admit_single_outbound_call); null on older calls and campaign calls. */
  billing_cap_minutes?: number | null;
  billing_rate_per_minute?: number | null;
}

// Supabase errors are plain objects with a `message`, not Error instances.
const errorMessage = (err: unknown) =>
  err instanceof Error
    ? err.message
    : typeof (err as { message?: unknown })?.message === "string"
      ? (err as { message: string }).message
      : String(err);

export async function finalizeTerminalCall(
  supabaseAdmin: Client,
  callId: string,
  deps: FinalizationDeps = {},
): Promise<FinalizationResult> {
  // Bound to the client: supabase-js's rpc reads `this.rest`. Kept local (as in
  // finalizeCallBilling) until the Supabase types are regenerated with these functions.
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as Rpc;

  const claim = await rpc("claim_call_finalization", {
    _call: callId,
    _lease_seconds: FINALIZATION_LEASE_SECONDS,
  });
  if (claim.error) throw claim.error;
  const token = typeof claim.data === "string" ? claim.data : null;
  if (!token) return { state: "skipped" };

  const errors: string[] = [];
  const { data, error: readError } = await supabaseAdmin
    .from("call_logs")
    .select(
      "id, organization_id, status, duration_seconds, campaign_id, campaign_contact_id, contact_id, business_id, destination_number, final_agent_variables, billing_applied_at, campaign_applied_at, billing_cap_minutes, billing_rate_per_minute",
    )
    .eq("id", callId)
    .single();
  const call = data as FinalizingCall | null;
  if (readError || !call) errors.push(`read: ${readError?.message ?? "call not found"}`);

  if (call && !call.billing_applied_at) {
    try {
      await applyBilling(rpc, call, token, deps);
    } catch (err) {
      errors.push(`billing: ${errorMessage(err)}`);
    }
  }
  if (call && !call.campaign_applied_at) {
    try {
      await applyCampaign(supabaseAdmin, rpc, call, token);
    } catch (err) {
      errors.push(`campaign: ${errorMessage(err)}`);
    }
  }

  if (errors.length === 0) {
    const done = await rpc("complete_call_finalization", { _call: callId, _token: token });
    if (done.error) errors.push(`complete: ${done.error.message}`);
    else if (done.data !== true) errors.push("complete: the lease was lost before finishing");
    else return { state: "done" };
  }

  const message = errors.join("; ");
  const failed = await rpc("fail_call_finalization", {
    _call: callId,
    _token: token,
    _error: message,
  });
  if (failed.error)
    console.error("call_finalization:fail_record_failed", callId, failed.error.message);
  console.error("call_finalization:failed", callId, message);
  return { state: "failed", error: message };
}

/**
 * For call sites that must not fail because finalization did (a webhook, a
 * start-failure path): the call stays `pending`/`failed` and is retried from
 * the admin Calls page.
 */
export async function finalizeTerminalCallSafely(
  supabaseAdmin: Client,
  callId: string,
  deps: FinalizationDeps = {},
): Promise<FinalizationResult> {
  try {
    return await finalizeTerminalCall(supabaseAdmin, callId, deps);
  } catch (err) {
    console.error("call_finalization:deferred", callId, errorMessage(err));
    return { state: "failed", error: errorMessage(err) };
  }
}

/**
 * What a call is billed: started minutes (ceil), never more than the minutes
 * reserved for it at admission, at the price locked at admission. Calls from
 * before admission locked terms (and campaign calls) bill as before: every
 * started minute at the current rate. So a single call's charge is at most
 * billing_cap_minutes x billing_rate_per_minute, exactly what the wallet
 * check reserved for it.
 */
export function billableTerms(
  durationSeconds: number | null | undefined,
  currentRatePerMinute: number,
  locked: { billing_cap_minutes?: number | null; billing_rate_per_minute?: number | null },
): { minutes: number; customerAmountPerMinute: number; capped: boolean } {
  const seconds = durationSeconds ?? 0;
  const started = seconds > 0 ? Math.ceil(seconds / 60) : 0;
  const cap = locked.billing_cap_minutes ?? null;
  const minutes = cap !== null ? Math.min(started, cap) : started;
  return {
    minutes,
    customerAmountPerMinute: locked.billing_rate_per_minute ?? currentRatePerMinute,
    capped: cap !== null && started > cap,
  };
}

async function applyBilling(rpc: Rpc, call: FinalizingCall, token: string, deps: FinalizationDeps) {
  const getRate =
    deps.getRate ??
    (async (org, direction) =>
      (await import("../telephony-guard.server.ts")).getCallRate(org, direction));
  const rate = await getRate(call.organization_id, "outbound");
  const { minutes, customerAmountPerMinute, capped } = billableTerms(
    call.duration_seconds,
    rate.customerAmountPerMinute,
    call,
  );
  if (capped)
    // The provider ran past the agent's limit; ClickAI absorbs the rest, the customer never pays it.
    console.warn("call_finalization:billing_capped", {
      callId: call.id,
      durationSeconds: call.duration_seconds,
      capMinutes: call.billing_cap_minutes,
    });
  const result = await rpc("apply_call_billing", {
    _call: call.id,
    _token: token,
    _amount: minutes * customerAmountPerMinute,
    // What the provider charges ClickAI: every started minute, even past the cap.
    _provider_cost:
      (call.duration_seconds > 0 ? Math.ceil(call.duration_seconds / 60) : 0) *
      rate.providerCostPerMinute,
    _currency: rate.currency,
    _minutes: minutes,
    _description: `outbound call · ${minutes} min`,
  });
  if (result.error) throw result.error;
  if (result.data === "lease_lost") throw new Error("the lease was lost");
}

async function applyCampaign(supabaseAdmin: Client, rpc: Rpc, call: FinalizingCall, token: string) {
  // Flat final variables, whether stored grouped ({ final, output }) or already flat.
  const vars = finalCallVariables(call.final_agent_variables);
  let decision: { status: string; nextAttemptAt: string | null } | null = null;

  if (call.campaign_id && call.campaign_contact_id) {
    const [campaignRes, contactRes] = await Promise.all([
      supabaseAdmin
        .from("campaigns")
        .select("max_attempts, retry_after_minutes, retry_statuses")
        .eq("id", call.campaign_id)
        .maybeSingle(),
      supabaseAdmin
        .from("campaign_contacts")
        .select("attempts")
        .eq("id", call.campaign_contact_id)
        .maybeSingle(),
    ]);
    if (campaignRes.error) throw campaignRes.error;
    if (contactRes.error) throw contactRes.error;
    if (!campaignRes.data || !contactRes.data) throw new Error("campaign or contact not found");
    decision = decideCampaignContactOutcome(
      call.status as CallTerminalStatus,
      contactRes.data.attempts,
      {
        maxAttempts: campaignRes.data.max_attempts,
        retryAfterMinutes: campaignRes.data.retry_after_minutes,
        retryStatuses: campaignRes.data.retry_statuses,
      },
      vars,
    );
  }

  // A single (non-campaign) call: an opt-out goes on the do-not-call list, and a follow-up
  // lead only on an explicit request. Both run before the step's checkpoint and are
  // idempotent, so a retried finalization never doubles either.
  if (!decision) {
    await suppressSingleCallOptOut(supabaseAdmin, call, vars);
    await saveExplicitCallbackLead(supabaseAdmin, call, vars);
  }

  const interest = typeof vars?.["interest_level"] === "string" ? vars["interest_level"] : null;
  const result = await rpc("apply_call_campaign_outcome", {
    _call: call.id,
    _token: token,
    _contact_status: decision?.status ?? null,
    _next_attempt_at: decision?.nextAttemptAt ?? null,
    // Only the retained call fields (call-variables.ts), never the agent's whole context.
    _output_variables: retainCallVariables(vars, "outbound") ?? {},
    // A contact who opted out on this call is never turned into a lead for follow-up.
    _create_lead:
      decision !== null && call.status === "completed" && decision.status !== "opted_out",
    _lead_score: interest === "high" ? "hot" : interest === "low" ? "cold" : "warm",
    _lead_notes: leadNotesFromVariables(vars),
  });
  if (result.error) throw result.error;
  const outcome = result.data as { result?: string } | null;
  if (outcome?.result === "lease_lost") throw new Error("the lease was lost");
}

/**
 * Puts the dialled number of a single (non-campaign) outbound call on the workspace's
 * do-not-call list when the person opted out on it (opted_out / do_not_call). Campaign
 * calls do this in apply_call_campaign_outcome; without this, the next single call to
 * the same person would go through. The number is ClickAI's own dialled number
 * (call_logs.destination_number), never a caller id the agent reported, so this is the
 * "contact ClickAI itself resolved" contact-suppression.server.ts requires. Finds or
 * creates the contact (unique per organization + number), then suppressContact, which is
 * idempotent and never overwrites an earlier opt-out's time or reason.
 */
export async function suppressSingleCallOptOut(
  supabaseAdmin: Client,
  call: Pick<FinalizingCall, "organization_id" | "business_id" | "destination_number">,
  vars: Record<string, unknown> | null,
): Promise<void> {
  if (detectSpecialOutcome(vars) !== "opted_out") return;
  const phone = normalizeCustomerPhone(call.destination_number ?? "", null);
  if (!phone) return;
  const reason = "Requested during an outbound call";
  const findContact = async () => {
    const { data, error } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("organization_id", call.organization_id)
      .eq("phone", phone)
      .maybeSingle();
    if (error) throw error;
    return (data as { id?: string } | null)?.id ?? null;
  };
  let contactId = await findContact();
  if (!contactId) {
    const { error } = await supabaseAdmin.from("contacts").insert({
      organization_id: call.organization_id,
      business_id: call.business_id ?? null,
      phone,
      source: "outbound_call",
      opted_out: true,
      opted_out_at: new Date().toISOString(),
      opted_out_reason: reason,
    });
    // 23505: created meanwhile (another finalization, an import); suppress that one.
    if (error && (error as { code?: string }).code !== "23505") throw error;
    contactId = await findContact();
    if (!contactId) throw new Error("the opted-out contact could not be saved");
  }
  await suppressContact(supabaseAdmin, {
    organizationId: call.organization_id,
    contactId,
    reason,
  });
}

/**
 * One follow-up lead for a single (non-campaign) outbound call, only when the person
 * explicitly asked to be contacted later: outbound_result is exactly "callback_requested"
 * (a value the agent picks from a fixed list after the call), the call completed, and the
 * person neither opted out nor said it was the wrong number (detectSpecialOutcome).
 * Booking interest alone is never enough: on an outbound call the agent sends people to
 * the clinic to book, which is not a callback request.
 *
 * The phone is ClickAI's own dialled number (call_logs.destination_number), never the
 * agent's tool-reported caller id. The id is deterministic per call, so a retried
 * finalization finds the lead (unique violation) instead of adding a second one.
 */
export async function saveExplicitCallbackLead(
  supabaseAdmin: Client,
  call: FinalizingCall,
  vars: Record<string, unknown> | null,
): Promise<void> {
  if (call.status !== "completed" || !vars) return;
  if (vars["outbound_result"] !== "callback_requested" || detectSpecialOutcome(vars)) return;
  const phone = normalizeCustomerPhone(call.destination_number ?? "", null);
  if (!phone) return;
  const rawName = typeof vars["customer_name"] === "string" ? vars["customer_name"].trim() : "";
  const { error } = await supabaseAdmin.from("leads").insert({
    id: await callLeadId("outbound-callback", call.id),
    organization_id: call.organization_id,
    business_id: call.business_id ?? null,
    call_id: call.id,
    name: rawName ? rawName.slice(0, 200) : null,
    phone,
    source: "phone",
    asked_about: "Callback requested on an outbound call",
    notes: leadNotesFromVariables(vars),
  });
  if (error && (error as { code?: string }).code !== "23505") throw error;
}
