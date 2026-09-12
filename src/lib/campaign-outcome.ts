/**
 * Pure decision logic for what happens to one campaign_contact after a call
 * attempt ends — shared by the synchronous dispatch failure path
 * (campaign-dispatch.server.ts) and the asynchronous webhook path
 * (the telephony webhook route), so retry/opt-out rules can never drift
 * between the two call sites. No I/O here; callers own reading/writing the
 * database with whatever values this function decides.
 */

export type CallTerminalStatus = "completed" | "failed" | "busy" | "no_answer" | "cancelled";

export type CampaignContactStatus =
  | "pending"
  | "queued"
  | "calling"
  | "connected"
  | "no_answer"
  | "busy"
  | "failed"
  | "completed"
  | "retry_scheduled"
  | "opted_out"
  | "wrong_number"
  | "cancelled";

export interface CampaignRetryPolicy {
  maxAttempts: number;
  retryAfterMinutes: number;
  retryStatuses: string[];
}

export interface OutcomeDecision {
  status: CampaignContactStatus;
  nextAttemptAt: string | null;
}

/**
 * Opportunistically reads a do-not-call / wrong-number signal out of
 * whatever agent variables the provider returned. Purely additive — an
 * agent whose Sarvam configuration never sets these keys simply never
 * triggers this path, and the call is scored on its call_logs status alone.
 * Never invents a Sarvam-side contract; these are Klyro-side convention
 * keys a campaign's own agent instructions can choose to populate.
 */
function detectSpecialOutcome(
  agentVariables: Record<string, unknown> | null | undefined,
): "opted_out" | "wrong_number" | null {
  if (!agentVariables) return null;
  const truthy = (v: unknown) => v === true || v === "true" || v === "yes";
  if (truthy(agentVariables["opted_out"]) || truthy(agentVariables["do_not_call"]))
    return "opted_out";
  if (truthy(agentVariables["wrong_number"]) || agentVariables["call_outcome"] === "wrong_number")
    return "wrong_number";
  return null;
}

/**
 * Decides the next campaign_contact state after a call attempt reaches a
 * terminal status. `attempts` is the count INCLUDING the attempt that just
 * finished (i.e. already incremented by the caller before this runs).
 */
export function decideCampaignContactOutcome(
  terminalStatus: CallTerminalStatus,
  attempts: number,
  policy: CampaignRetryPolicy,
  agentVariables?: Record<string, unknown> | null,
  now: Date = new Date(),
): OutcomeDecision {
  const special = detectSpecialOutcome(agentVariables);
  if (special) return { status: special, nextAttemptAt: null };

  const isRetryable = policy.retryStatuses.includes(terminalStatus);
  if (isRetryable && attempts < policy.maxAttempts) {
    const next = new Date(now.getTime() + policy.retryAfterMinutes * 60_000);
    return { status: "retry_scheduled", nextAttemptAt: next.toISOString() };
  }

  // terminalStatus already uses the exact same vocabulary as
  // CampaignContactStatus for these five values (completed/failed/busy/
  // no_answer/cancelled) — no separate mapping table needed.
  return { status: terminalStatus, nextAttemptAt: null };
}
