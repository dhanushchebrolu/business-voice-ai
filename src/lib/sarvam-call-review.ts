/**
 * Which Sarvam outbound calls an operator may resolve by hand: every call that
 * hasn't reached a final status — `outcome_unknown` (the start request failed
 * ambiguously) or `initiated` (in progress, its webhook never arrived, or the
 * start request never finished, e.g. a crash before Sarvam answered and so no
 * attempt id). These are exactly the calls that hold a number's outbound
 * reservation (idx_call_logs_sarvam_outbound_number_reservation), so a blocked
 * number always has an operator way out. Shared by the admin Calls page, its
 * "Needs review" query and sarvam-call-resolution.server.ts.
 */
export const UNRESOLVED_SARVAM_STATUSES = ["initiated", "outcome_unknown"] as const;

export function isResolvableSarvamCall(call: {
  provider: string;
  direction: string;
  status: string;
}): boolean {
  if (call.provider !== "sarvam" || call.direction !== "outbound") return false;
  return (UNRESOLVED_SARVAM_STATUSES as readonly string[]).includes(call.status);
}

/**
 * A final Sarvam outbound call whose billing/campaign finalization hasn't
 * finished (call-finalization.server.ts). An admin retries it from the Calls
 * page; nothing retries automatically.
 */
export function needsFinalizationRetry(call: {
  provider: string;
  direction: string;
  finalizationState: string | null;
}): boolean {
  if (call.provider !== "sarvam" || call.direction !== "outbound") return false;
  return call.finalizationState === "pending" || call.finalizationState === "failed";
}

/**
 * What the admin is told after resolving a call: the outcome that was
 * recorded, and whether billing and the campaign update finished. Only a
 * fully finished resolution is reported as a plain success.
 */
export function describeResolutionResult(result: {
  status: string;
  finalization: "done" | "failed" | "skipped";
}): { tone: "success" | "warning"; title: string; description: string } {
  const outcome = `Recorded as ${result.status.replace(/_/g, " ")}.`;
  if (result.finalization === "done")
    return {
      tone: "success",
      title: "Call resolved",
      description: `${outcome} Billing and campaign update finished.`,
    };
  if (result.finalization === "failed")
    return {
      tone: "warning",
      title: "Resolved, but billing/campaign update failed",
      description: `${outcome} The outcome is saved; the charge and/or campaign update didn't finish. The error is shown on the call — use Retry there.`,
    };
  return {
    tone: "warning",
    title: "Resolved, billing/campaign update still pending",
    description: `${outcome} Another update of this call is in progress. If the call still shows "pending" afterwards, use Retry on it.`,
  };
}
