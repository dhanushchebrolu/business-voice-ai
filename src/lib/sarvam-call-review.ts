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
