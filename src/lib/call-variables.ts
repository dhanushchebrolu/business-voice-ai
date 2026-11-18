/**
 * Which of an AI call's final agent variables ClickAI keeps, and what reaches
 * customer-readable lead notes.
 *
 * Sarvam sends every agent variable at the end of a call — for Smile Dental
 * about 60, mostly the clinic's own business context. ClickAI stores only what
 * its own processing needs:
 *   - inbound: end-of-call outcome recovery (call-outcome-reconciliation) —
 *     outcome, summary, name, interest, requested slot, opt-out;
 *   - outbound: the same plus what call finalization reads for the campaign
 *     decision and the lead score (campaign-outcome.detectSpecialOutcome,
 *     call-finalization.server.ts) — interest_level, do_not_call, wrong_number.
 * Stored copies are cleared after the recovery window (call-variable-retention).
 */

export const INBOUND_RETAINED_VARIABLES = [
  "call_outcome",
  "call_summary",
  "customer_name",
  "caller_interest",
  "requested_slot",
  "opted_out",
] as const;

export const OUTBOUND_RETAINED_VARIABLES = [
  ...INBOUND_RETAINED_VARIABLES,
  "interest_level",
  "do_not_call",
  "wrong_number",
] as const;

/** What a campaign lead's notes may show: the call's own result, never the agent's context. */
export const LEAD_NOTE_VARIABLES = [
  "call_outcome",
  "call_summary",
  "caller_interest",
  "requested_slot",
  "interest_level",
] as const;

const MAX_VALUE_LENGTH = 2000;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * The variables the agent ended the call with, as one flat object.
 *
 * Sarvam's webhook parser (sarvam-provider collectAgentVariables) keeps the
 * payload's groups apart: { initial, final, output }. This returns `final`
 * (what the agent held at the end), with any name it lacks taken from `output`
 * (the subset flagged for reporting); `initial` (call-start inputs) is not an
 * outcome and is left out. An object that is already flat — what ClickAI now
 * stores, or another provider's shape — is returned as it is.
 */
export function finalCallVariables(vars: unknown): Record<string, unknown> | null {
  if (!isPlainObject(vars)) return null;
  const grouped = ["initial", "final", "output"].some((k) => isPlainObject(vars[k]));
  if (!grouped) return vars;
  const output = isPlainObject(vars["output"]) ? vars["output"] : {};
  const final = isPlainObject(vars["final"]) ? vars["final"] : {};
  return { ...output, ...final };
}

function pick(
  vars: unknown,
  keys: readonly string[],
): Record<string, string | number | boolean> | null {
  const source = finalCallVariables(vars);
  if (!source) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") out[key] = value.slice(0, MAX_VALUE_LENGTH);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

/**
 * The variables ClickAI stores for a call (call_logs.final_agent_variables),
 * or null when there are none. Only scalar values of allowlisted names survive.
 */
export function retainCallVariables(
  vars: unknown,
  direction: "inbound" | "outbound" | string,
): Record<string, string | number | boolean> | null {
  const kept = pick(
    vars,
    direction === "outbound" ? OUTBOUND_RETAINED_VARIABLES : INBOUND_RETAINED_VARIABLES,
  );
  return kept && Object.keys(kept).length > 0 ? kept : null;
}

/** Notes for a campaign lead: the call's result fields only, as JSON; null when there are none. */
export function leadNotesFromVariables(vars: unknown): string | null {
  const kept = pick(vars, LEAD_NOTE_VARIABLES);
  return kept && Object.keys(kept).length > 0 ? JSON.stringify(kept) : null;
}
