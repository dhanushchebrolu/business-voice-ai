import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { decideCampaignContactOutcome, type CallTerminalStatus } from "../campaign-outcome.ts";

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
 * done or failed. Nothing retries automatically: a failed call stays visible
 * to admins (Calls → Needs review) and is retried from there.
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
  final_agent_variables: unknown;
  billing_applied_at: string | null;
  campaign_applied_at: string | null;
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
      "id, organization_id, status, duration_seconds, campaign_id, campaign_contact_id, contact_id, final_agent_variables, billing_applied_at, campaign_applied_at",
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

async function applyBilling(rpc: Rpc, call: FinalizingCall, token: string, deps: FinalizationDeps) {
  const getRate =
    deps.getRate ??
    (async (org, direction) =>
      (await import("../telephony-guard.server.ts")).getCallRate(org, direction));
  const rate = await getRate(call.organization_id, "outbound");
  const seconds = call.duration_seconds ?? 0;
  const minutes = seconds > 0 ? Math.ceil(seconds / 60) : 0;
  const result = await rpc("apply_call_billing", {
    _call: call.id,
    _token: token,
    _amount: minutes * rate.customerAmountPerMinute,
    _provider_cost: minutes * rate.providerCostPerMinute,
    _currency: rate.currency,
    _minutes: minutes,
    _description: `outbound call · ${minutes} min`,
  });
  if (result.error) throw result.error;
  if (result.data === "lease_lost") throw new Error("the lease was lost");
}

async function applyCampaign(supabaseAdmin: Client, rpc: Rpc, call: FinalizingCall, token: string) {
  const vars =
    call.final_agent_variables && typeof call.final_agent_variables === "object"
      ? (call.final_agent_variables as Record<string, unknown>)
      : null;
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

  const interest = typeof vars?.["interest_level"] === "string" ? vars["interest_level"] : null;
  const result = await rpc("apply_call_campaign_outcome", {
    _call: call.id,
    _token: token,
    _contact_status: decision?.status ?? null,
    _next_attempt_at: decision?.nextAttemptAt ?? null,
    _output_variables: vars ?? {},
    _create_lead: decision !== null && call.status === "completed",
    _lead_score: interest === "high" ? "hot" : interest === "low" ? "cold" : "warm",
    _lead_notes: vars && Object.keys(vars).length > 0 ? JSON.stringify(vars) : null,
  });
  if (result.error) throw result.error;
  const outcome = result.data as { result?: string } | null;
  if (outcome?.result === "lease_lost") throw new Error("the lease was lost");
}
