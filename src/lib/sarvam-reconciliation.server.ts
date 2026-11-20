import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { SarvamAttemptSummary } from "./telephony/sarvam-api-client.server.ts";
import type { ResolutionOutcome } from "./sarvam-call-resolution.server.ts";

/**
 * Automatic reconciliation of a Sarvam outbound call whose result webhook
 * never arrived (still `initiated` with a recorded attempt_id). It reads the
 * attempt from Sarvam's analytics API and, only when Sarvam reports a final
 * outcome for that exact attempt, applies it through the same idempotent
 * path an operator uses (sarvam-call-resolution.server.ts: webhook_events
 * dedupe under the attempt_id, the shared event pipeline pinned to this one
 * call, finalization exactly once). It never dials and never guesses:
 *
 *   - no attempt_id recorded (an ambiguous start, `outcome_unknown`)
 *     -> needs_operator: nothing can tie it to a Sarvam attempt safely;
 *   - attempt not found yet, or Sarvam will retry it -> pending (checked again later);
 *   - connected / no_answer / failed -> resolved.
 */

export type ReconcileResult =
  | { state: "already_final"; status: string }
  | { state: "needs_operator"; reason: string }
  | { state: "pending"; reason: string }
  | { state: "resolved"; outcome: ResolutionOutcome; durationSeconds: number };

/** Sarvam's attempt -> a final outcome, or null when it is not final yet. */
export function outcomeFromAttempt(
  attempt: SarvamAttemptSummary,
): { outcome: ResolutionOutcome; durationSeconds: number } | null {
  if (attempt.nextActionStatus?.toLowerCase() === "retry") return null;
  switch (attempt.connectivityStatus?.toLowerCase()) {
    case "connected":
      return {
        outcome: "completed",
        durationSeconds: Math.max(0, Math.round(attempt.durationSeconds)),
      };
    case "no_answer":
      return { outcome: "no_answer", durationSeconds: 0 };
    case "failed":
      return { outcome: "failed", durationSeconds: 0 };
    default:
      return null;
  }
}

export interface ReconcileDeps {
  findAttempt: (
    appId: string,
    attemptId: string,
    since: Date,
    until: Date,
  ) => Promise<SarvamAttemptSummary | null>;
  resolve: (input: {
    callId: string;
    outcome: ResolutionOutcome;
    durationSeconds: number;
    attemptId: string;
  }) => Promise<unknown>;
  now?: () => Date;
}

/** How far around the call's start Sarvam's attempt is searched for. */
const SEARCH_BEFORE_MS = 10 * 60 * 1000;
const SEARCH_AFTER_MS = 6 * 60 * 60 * 1000;

export async function reconcileSarvamCall(
  supabaseAdmin: SupabaseClient<Database>,
  callId: string,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const now = deps.now?.() ?? new Date();
  const { data: call } = await supabaseAdmin
    .from("call_logs")
    .select(
      "id, organization_id, provider, direction, status, provider_call_id, phone_number_id, started_at",
    )
    .eq("id", callId)
    .maybeSingle();
  if (!call || call.provider !== "sarvam" || call.direction !== "outbound")
    return { state: "needs_operator", reason: "not a Sarvam outbound call" };
  if (call.status !== "initiated" && call.status !== "outcome_unknown")
    return { state: "already_final", status: call.status };
  if (!call.provider_call_id)
    return { state: "needs_operator", reason: "no Sarvam attempt id was recorded for this call" };

  // The agent's app id, through this call's own number (same organization only).
  const { data: number } = call.phone_number_id
    ? await supabaseAdmin
        .from("phone_numbers")
        .select("organization_id, agent_config_id")
        .eq("id", call.phone_number_id)
        .maybeSingle()
    : { data: null };
  const { data: agent } = number?.agent_config_id
    ? await supabaseAdmin
        .from("agent_configs")
        .select("organization_id, sarvam_app_id")
        .eq("id", number.agent_config_id)
        .maybeSingle()
    : { data: null };
  if (
    !number ||
    !agent?.sarvam_app_id ||
    number.organization_id !== call.organization_id ||
    agent.organization_id !== call.organization_id
  )
    return {
      state: "needs_operator",
      reason: "the call's number or agent no longer maps to its Sarvam app",
    };

  const started = new Date(call.started_at);
  const until = new Date(Math.min(now.getTime(), started.getTime() + SEARCH_AFTER_MS));
  const attempt = await deps.findAttempt(
    agent.sarvam_app_id,
    call.provider_call_id,
    new Date(started.getTime() - SEARCH_BEFORE_MS),
    until,
  );
  if (!attempt) return { state: "pending", reason: "Sarvam has not reported this attempt yet" };
  const final = outcomeFromAttempt(attempt);
  if (!final)
    return {
      state: "pending",
      reason: `Sarvam reports ${attempt.connectivityStatus ?? "no status"} (${attempt.nextActionStatus ?? "no next action"})`,
    };

  await deps.resolve({
    callId: call.id,
    outcome: final.outcome,
    durationSeconds: final.durationSeconds,
    attemptId: call.provider_call_id,
  });
  return { state: "resolved", outcome: final.outcome, durationSeconds: final.durationSeconds };
}

/** How long a single call may sit in `initiated` without a Sarvam attempt id. */
export const START_WITHOUT_ATTEMPT_MAX_AGE_MS = 30 * 60 * 1000;

export const START_NOT_CONFIRMED_REASON =
  "Sarvam never confirmed this call started (no attempt id and no result). Check Sarvam before resolving it.";

/**
 * A single outbound call still `initiated` with no attempt id after 30
 * minutes: the start request never returned (a crash or timeout before
 * Sarvam answered) and no result webhook came. Nothing can tie it to a Sarvam
 * attempt, so reconcileSarvamCall cannot help, and leaving it `initiated`
 * shows customers a call "in progress" forever. It becomes `outcome_unknown`:
 * shown as unconfirmed, listed for operators, never billed or retried, and a
 * late Sarvam webhook still resolves it (found by metadata.call_id). Only
 * while it is still exactly that (a conditional update). A campaign call's
 * contact follows into outcome_unknown (never redialled automatically; an
 * operator resolves it), so the campaign shows it instead of "calling".
 */
export async function flagStartsWithoutAttempt(
  supabaseAdmin: SupabaseClient<Database>,
  now: Date = new Date(),
): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("call_logs")
    .update({ status: "outcome_unknown", failure_reason: START_NOT_CONFIRMED_REASON })
    .eq("provider", "sarvam")
    .eq("direction", "outbound")
    .eq("status", "initiated")
    .is("provider_call_id", null)
    .lt("started_at", new Date(now.getTime() - START_WITHOUT_ATTEMPT_MAX_AGE_MS).toISOString())
    .select("id, campaign_contact_id");
  if (error) throw error;
  for (const row of (data ?? []) as { id: string; campaign_contact_id?: string | null }[]) {
    console.warn("sarvam_outbound:start_not_confirmed", { callId: row.id });
    if (!row.campaign_contact_id) continue;
    const { error: ccError } = await supabaseAdmin
      .from("campaign_contacts")
      .update({ status: "outcome_unknown", next_attempt_at: null })
      .eq("id", row.campaign_contact_id)
      .eq("status", "calling")
      .eq("current_call_id", row.id);
    if (ccError) throw ccError;
  }
  return data?.length ?? 0;
}

/** A claim older than this with no call row was abandoned (the Worker stopped between claim and admission). */
export const ORPHANED_CLAIM_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Gives back campaign contacts left `calling` with no call row: the Worker
 * stopped after claiming them and before admission wrote the call. Nothing was
 * dialled (admission writes the row before any dial), so the contact returns
 * to `pending` with its attempt count restored. Conditional on the exact
 * claim, so a contact that moved on meanwhile is left alone.
 */
export async function releaseOrphanedCampaignClaims(
  supabaseAdmin: SupabaseClient<Database>,
  now: Date = new Date(),
): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("campaign_contacts")
    .select("id, attempts, current_call_id")
    .eq("status", "calling")
    .lt("updated_at", new Date(now.getTime() - ORPHANED_CLAIM_MAX_AGE_MS).toISOString())
    .limit(100);
  if (error) throw error;
  let released = 0;
  for (const cc of (data ?? []) as {
    id: string;
    attempts: number;
    current_call_id: string | null;
  }[]) {
    if (cc.current_call_id) {
      const { data: call, error: callError } = await supabaseAdmin
        .from("call_logs")
        .select("id")
        .eq("id", cc.current_call_id)
        .maybeSingle();
      if (callError) throw callError;
      if (call) continue; // a call exists: finalization or reconciliation owns it
    }
    let release = supabaseAdmin
      .from("campaign_contacts")
      .update({ status: "pending", attempts: Math.max(cc.attempts - 1, 0), current_call_id: null })
      .eq("id", cc.id)
      .eq("status", "calling")
      .eq("attempts", cc.attempts);
    release = cc.current_call_id
      ? release.eq("current_call_id", cc.current_call_id)
      : release.is("current_call_id", null);
    const { data: done, error: releaseError } = await release.select("id");
    if (releaseError) throw releaseError;
    if (done?.length) {
      released++;
      console.warn("campaign_dispatch:orphaned_claim_released", { campaignContactId: cc.id });
    }
  }
  return released;
}
