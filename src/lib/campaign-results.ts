/**
 * Campaign contact eligibility and result classification (pure).
 *
 * Results are derived from what ClickAI already stores per contact (its status
 * and the outbound variables retained at finalization), so reporting never
 * claims more than happened: a booking made during a campaign call is not
 * counted here as a campaign conversion.
 */

export type ExclusionReason =
  "opted_out" | "invalid_number" | "country_not_allowed" | "duplicate_number";

export const EXCLUSION_LABEL: Record<ExclusionReason, string> = {
  opted_out: "Asked not to be called (do-not-call)",
  invalid_number: "Not a valid phone number",
  country_not_allowed: "Not a callable number (regular +91 numbers only; no toll-free or premium)",
  duplicate_number: "Same number as another contact in this campaign",
};

export interface EligibilityInput {
  /** The contact's number, already normalized to E.164, or null when it is not valid. */
  e164: string | null;
  optedOut: boolean;
}

/**
 * Evaluates contacts in order. A number that appears twice is called once:
 * the later contact is excluded as a duplicate.
 */
export function evaluateEligibility(
  contacts: EligibilityInput[],
  isCountryAllowed: (e164: string) => boolean,
): ({ eligible: true } | { eligible: false; reason: ExclusionReason })[] {
  const seen = new Set<string>();
  return contacts.map((c) => {
    if (c.optedOut) return { eligible: false, reason: "opted_out" };
    if (!c.e164) return { eligible: false, reason: "invalid_number" };
    if (!isCountryAllowed(c.e164)) return { eligible: false, reason: "country_not_allowed" };
    if (seen.has(c.e164)) return { eligible: false, reason: "duplicate_number" };
    seen.add(c.e164);
    return { eligible: true };
  });
}

export type CampaignResult =
  | "queued"
  | "in_progress"
  | "unconfirmed"
  | "interested"
  | "appointment_intent"
  | "callback_requested"
  | "not_interested"
  | "opted_out"
  | "wrong_number"
  | "voicemail"
  | "no_answer"
  | "busy"
  | "failed"
  | "unclassified"
  | "excluded"
  | "cancelled";

export const RESULT_LABEL: Record<CampaignResult, string> = {
  queued: "Queued",
  in_progress: "In progress",
  unconfirmed: "Unconfirmed (being resolved)",
  interested: "Interested",
  appointment_intent: "Wants an appointment",
  callback_requested: "Asked to be contacted later",
  not_interested: "Not interested",
  opted_out: "Opted out",
  wrong_number: "Wrong number",
  voicemail: "Voicemail",
  no_answer: "No answer",
  busy: "Busy",
  failed: "Failed",
  unclassified: "Connected, no clear result",
  excluded: "Excluded",
  cancelled: "Cancelled",
};

const yes = (v: unknown) => typeof v === "string" && v.trim().toLowerCase() === "yes";
const str = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** One contact's result, from its campaign status and its retained call variables. */
export function classifyCampaignResult(
  status: string,
  vars: Record<string, unknown> | null | undefined,
): CampaignResult {
  const v = vars ?? {};
  const result = str(v["outbound_result"]);
  switch (status) {
    case "excluded":
      return "excluded";
    case "cancelled":
      return "cancelled";
    case "pending":
    case "retry_scheduled":
    case "queued":
      return "queued";
    case "calling":
    case "connected":
      return "in_progress";
    case "outcome_unknown":
      return "unconfirmed";
  }
  if (
    status === "opted_out" ||
    yes(v["opted_out"]) ||
    yes(v["do_not_call"]) ||
    result === "opted_out"
  )
    return "opted_out";
  if (status === "wrong_number" || yes(v["wrong_number"]) || result === "wrong_person")
    return "wrong_number";
  if (result === "voicemail") return "voicemail";
  if (status === "no_answer") return "no_answer";
  if (status === "busy") return "busy";
  if (status === "failed") return "failed";
  if (result === "callback_requested") return "callback_requested";
  if (result === "not_interested") return "not_interested";
  if (result === "interested")
    return str(v["requested_slot"]) ? "appointment_intent" : "interested";
  return "unclassified";
}

/** The follow-up a result implies, and whether ClickAI has already done it. */
export function nextAction(result: CampaignResult): { action: string; done: boolean } | null {
  switch (result) {
    case "callback_requested":
      return { action: "Contact them: a follow-up lead was created", done: false };
    case "appointment_intent":
      return {
        action: "They were asked to call the business to book; nothing was booked",
        done: false,
      };
    case "interested":
      return { action: "Consider a follow-up", done: false };
    case "opted_out":
      return { action: "Never call again (recorded)", done: true };
    default:
      return null;
  }
}

export interface CampaignReport {
  total: number;
  eligible: number;
  excluded: number;
  excludedByReason: Partial<Record<string, number>>;
  queued: number;
  inProgress: number;
  attempted: number;
  connected: number;
  interested: number;
  callbacks: number;
  optOuts: number;
  failed: number;
  byResult: Partial<Record<CampaignResult, number>>;
}

const CONNECTED: CampaignResult[] = [
  "interested",
  "appointment_intent",
  "callback_requested",
  "not_interested",
  "opted_out",
  "wrong_number",
  "unclassified",
];

export function buildCampaignReport(
  rows: {
    status: string;
    attempts: number;
    excluded_reason?: string | null;
    output_variables?: unknown;
  }[],
): CampaignReport {
  const byResult: Partial<Record<CampaignResult, number>> = {};
  const excludedByReason: Partial<Record<string, number>> = {};
  let attempted = 0;
  for (const row of rows) {
    const r = classifyCampaignResult(
      row.status,
      row.output_variables as Record<string, unknown> | null,
    );
    byResult[r] = (byResult[r] ?? 0) + 1;
    if (r === "excluded") {
      const reason = row.excluded_reason ?? "other";
      excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
    }
    if (row.attempts > 0) attempted++;
  }
  const n = (...rs: CampaignResult[]) => rs.reduce((s, r) => s + (byResult[r] ?? 0), 0);
  return {
    total: rows.length,
    eligible: rows.length - n("excluded"),
    excluded: n("excluded"),
    excludedByReason,
    queued: n("queued"),
    inProgress: n("in_progress", "unconfirmed"),
    attempted,
    connected: n(...CONNECTED),
    interested: n("interested", "appointment_intent", "callback_requested"),
    callbacks: n("callback_requested"),
    optOuts: n("opted_out"),
    failed: n("failed"),
    byResult,
  };
}

/**
 * What a campaign has cost and still holds in reserve (paise), by the same rule
 * admission uses for the budget: billed calls at their charge, calls not yet
 * billed at their worst case; a start that failed before dialling cost nothing.
 */
export function campaignSpend(
  calls: {
    status: string;
    customer_charge: number | null;
    billing_applied_at: string | null;
    billing_cap_minutes: number | null;
    billing_rate_per_minute: number | null;
    resolution_source?: string | null;
  }[],
): { spent: number; reserved: number } {
  let spent = 0;
  let reserved = 0;
  for (const c of calls) {
    if (c.resolution_source === "start_failure") continue;
    if (c.billing_applied_at) spent += c.customer_charge ?? 0;
    else reserved += (c.billing_cap_minutes ?? 1) * (c.billing_rate_per_minute ?? 0);
  }
  return { spent, reserved };
}
