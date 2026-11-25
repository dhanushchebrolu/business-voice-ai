import {
  NOT_A_CONVERSATION,
  OUTCOMES,
  OUTCOME_LABEL,
  SUCCESS_OUTCOMES,
  wasAnswered,
  type CallAnalysis,
  type Outcome,
} from "./call-analysis.ts";
import { classifyCampaignResult, RESULT_LABEL } from "./campaign-results.ts";

/**
 * A campaign's report, computed from what actually happened: the calls placed, the contacts,
 * and the stored analysis of each finished call. Nothing here is estimated. A figure whose
 * denominator is empty is `null` and the page says "unavailable"; a call that is not
 * analysed yet is counted in `coverage`, not guessed into a bucket.
 *
 * Counting rules (so the numbers can be checked):
 *  - A call is ATTEMPTED if it was dialled (not one that was recorded as never started).
 *  - A call is ANSWERED if it connected and has talk time (status completed, duration > 0).
 *  - A call is a CONVERSATION if it was answered and its analysis says it was a real conversation
 *    with the intended person: not voicemail, wrong number or no real conversation.
 *  - Retries do not double-count people: percentages and outcome distributions use each
 *    contact's LATEST conversation. Call counts, talk time and cost count every call.
 */
export interface AnalyticsContact {
  id: string;
  status: string;
  attempts: number;
  excludedReason: string | null;
  outputVariables: unknown;
  name: string | null;
  phone: string | null;
}

export interface AnalyticsCall {
  id: string;
  campaignContactId: string | null;
  status: string;
  durationSeconds: number;
  startedAt: string;
  customerCharge: number;
  billingApplied: boolean;
  resolutionSource: string | null;
  hasRecording: boolean;
}

export interface AnalyticsAnalysis {
  callId: string;
  status: string;
  source: string;
  analysis: CallAnalysis;
}

export interface AnalyticsInput {
  contacts: AnalyticsContact[];
  calls: AnalyticsCall[];
  analyses: AnalyticsAnalysis[];
  /** Leads ClickAI saved from this campaign's calls. */
  leadsCaptured: number;
}

/** Interest in the offer or visit: wanted it, or booked/confirmed it. */
const INTERESTED: readonly Outcome[] = [
  "interested",
  "appointment_booked",
  "appointment_rescheduled",
  "appointment_confirmed",
];

export type AnalysisState = "ai" | "basic" | "pending" | "none";

export interface ContactReportRow {
  id: string;
  name: string | null;
  phone: string | null;
  status: string;
  resultLabel: string;
  attempts: number;
  lastCall: {
    id: string;
    status: string;
    answered: boolean;
    durationSeconds: number;
    startedAt: string;
    hasRecording: boolean;
  } | null;
  analysisState: AnalysisState;
  analysis: CallAnalysis | null;
}

export interface CampaignAnalytics {
  coverage: { calls: number; analysed: number; basic: number; pending: number };
  totals: {
    contacts: number;
    eligibleContacts: number;
    callsAttempted: number;
    answered: number;
    noAnswer: number;
    busy: number;
    failed: number;
    conversations: number;
    connectedSeconds: number;
    avgConversationSeconds: number | null;
  };
  rates: {
    contactSuccessRate: number | null;
    conversionRate: number | null;
    positivePct: number | null;
    negativePct: number | null;
    neutralPct: number | null;
    interestedPct: number | null;
    notInterestedPct: number | null;
    callbackPct: number | null;
  };
  /** Contacts' latest conversation, by outcome. */
  outcomes: Partial<Record<Outcome, number>>;
  sentiment: {
    positive: number;
    negative: number;
    neutral: number;
    mixed: number;
    unknown: number;
  };
  followUps: number;
  appointments: { booked: number; rescheduled: number; cancelled: number };
  leadsCaptured: number;
  doNotCall: number;
  cost: {
    totalPaise: number;
    perAnsweredCall: number | null;
    perInterestedContact: number | null;
    perSuccessfulContact: number | null;
  };
  contacts: ContactReportRow[];
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const per = (total: number, d: number) => (d > 0 ? Math.round(total / d) : null);

const analysisState = (a: AnalyticsAnalysis | undefined, answered: boolean): AnalysisState => {
  if (!a) return answered ? "pending" : "none";
  if (a.source === "ai") return "ai";
  return a.status === "pending_ai" || a.status === "failed" ? "pending" : "basic";
};

export function buildCampaignAnalytics(input: AnalyticsInput): CampaignAnalytics {
  const analysisByCall = new Map(input.analyses.map((a) => [a.callId, a]));
  const callsByContact = new Map<string, AnalyticsCall[]>();
  for (const c of input.calls) {
    if (!c.campaignContactId) continue;
    const list = callsByContact.get(c.campaignContactId) ?? [];
    list.push(c);
    callsByContact.set(c.campaignContactId, list);
  }
  const placed = input.calls.filter((c) => c.resolutionSource !== "start_failure");
  const answeredCalls = placed.filter((c) => wasAnswered(c.status, c.durationSeconds));
  const isConversation = (c: AnalyticsCall) => {
    const a = analysisByCall.get(c.id);
    return Boolean(a) && !NOT_A_CONVERSATION.includes(a!.analysis.outcome);
  };
  const conversationCalls = answeredCalls.filter(isConversation);

  const outcomes: Partial<Record<Outcome, number>> = {};
  const sentiment = { positive: 0, negative: 0, neutral: 0, mixed: 0, unknown: 0 };
  const appointments = { booked: 0, rescheduled: 0, cancelled: 0 };
  // One analysis per call (the map), so an appointment is never counted twice.
  for (const a of analysisByCall.values()) {
    const o = a.analysis.appointment.outcome;
    if (o !== "none") appointments[o]++;
  }

  let reached = 0;
  let withConversation = 0;
  let successful = 0;
  let interested = 0;
  let notInterested = 0;
  let callbacks = 0;
  let followUps = 0;
  let doNotCall = 0;
  let responseKnown = 0;
  const response = { positive: 0, negative: 0, neutral: 0 };
  const rows: ContactReportRow[] = [];

  for (const contact of input.contacts) {
    const calls = (callsByContact.get(contact.id) ?? [])
      .slice()
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const placedCalls = calls.filter((c) => c.resolutionSource !== "start_failure");
    const answered = placedCalls.filter((c) => wasAnswered(c.status, c.durationSeconds));
    if (answered.length > 0) reached++;
    const latestConversation = answered.find(isConversation);
    const last = placedCalls[0] ?? null;
    const shown = latestConversation ?? last;
    const analysis = shown ? analysisByCall.get(shown.id) : undefined;

    if (latestConversation) {
      const a = analysisByCall.get(latestConversation.id)!.analysis;
      withConversation++;
      outcomes[a.outcome] = (outcomes[a.outcome] ?? 0) + 1;
      if (SUCCESS_OUTCOMES.includes(a.outcome)) successful++;
      if (INTERESTED.includes(a.outcome)) interested++;
      if (a.outcome === "not_interested") notInterested++;
      if (a.outcome === "callback_requested" || a.callback.requested) callbacks++;
      if (a.follow_up_required) followUps++;
      sentiment[a.sentiment ?? "unknown"]++;
      if (a.response) {
        responseKnown++;
        response[a.response]++;
      }
    }
    // Opt-outs count even when the call was short: any call that ended in one.
    if (
      answered.some((c) => analysisByCall.get(c.id)?.analysis.outcome === "opted_out") ||
      contact.status === "opted_out"
    )
      doNotCall++;

    rows.push({
      id: contact.id,
      name: contact.name,
      phone: contact.phone,
      status: contact.status,
      resultLabel:
        RESULT_LABEL[
          classifyCampaignResult(
            contact.status,
            contact.outputVariables as Record<string, unknown> | null,
          )
        ],
      attempts: contact.attempts,
      lastCall: last
        ? {
            id: last.id,
            status: last.status,
            answered: wasAnswered(last.status, last.durationSeconds),
            durationSeconds: last.durationSeconds,
            startedAt: last.startedAt,
            hasRecording: last.hasRecording,
          }
        : null,
      analysisState: analysisState(
        analysis,
        Boolean(shown && wasAnswered(shown.status, shown.durationSeconds)),
      ),
      analysis: analysis?.analysis ?? null,
    });
  }

  const eligible = input.contacts.filter((c) => c.status !== "excluded").length;
  const connectedSeconds = answeredCalls.reduce((s, c) => s + c.durationSeconds, 0);
  const conversationSeconds = conversationCalls.reduce((s, c) => s + c.durationSeconds, 0);
  const totalPaise = placed
    .filter((c) => c.billingApplied)
    .reduce((s, c) => s + (c.customerCharge ?? 0), 0);

  const analysed = answeredCalls.filter((c) => analysisByCall.get(c.id)?.source === "ai").length;
  const basic = answeredCalls.filter((c) => {
    const a = analysisByCall.get(c.id);
    return a && a.source !== "ai" && a.status !== "pending_ai" && a.status !== "failed";
  }).length;

  return {
    coverage: {
      calls: answeredCalls.length,
      analysed,
      basic,
      pending: answeredCalls.length - analysed - basic,
    },
    totals: {
      contacts: input.contacts.length,
      eligibleContacts: eligible,
      callsAttempted: placed.length,
      answered: answeredCalls.length,
      noAnswer: placed.filter((c) => c.status === "no_answer").length,
      busy: placed.filter((c) => c.status === "busy").length,
      failed: placed.filter((c) => c.status === "failed" || c.status === "cancelled").length,
      conversations: conversationCalls.length,
      connectedSeconds,
      avgConversationSeconds:
        conversationCalls.length > 0
          ? Math.round(conversationSeconds / conversationCalls.length)
          : null,
    },
    rates: {
      contactSuccessRate: pct(reached, eligible),
      conversionRate: pct(successful, withConversation),
      positivePct: pct(response.positive, responseKnown),
      negativePct: pct(response.negative, responseKnown),
      neutralPct: pct(response.neutral, responseKnown),
      interestedPct: pct(interested, withConversation),
      notInterestedPct: pct(notInterested, withConversation),
      callbackPct: pct(callbacks, withConversation),
    },
    outcomes,
    sentiment,
    followUps,
    appointments,
    leadsCaptured: input.leadsCaptured,
    doNotCall,
    cost: {
      totalPaise,
      perAnsweredCall: per(totalPaise, answeredCalls.length),
      perInterestedContact: per(totalPaise, interested),
      perSuccessfulContact: per(totalPaise, successful),
    },
    contacts: rows,
  };
}

/** A spreadsheet cell that cannot run as a formula when the file is opened. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_HEADER = [
  "Name",
  "Phone",
  "Status",
  "Result",
  "Attempts",
  "Answered",
  "Talk time (s)",
  "Outcome",
  "Sentiment",
  "Interest",
  "Purchase intent",
  "Summary",
  "Objections",
  "Questions",
  "Follow-up needed",
  "Next action",
  "Appointment",
  "Analysis",
];

export function contactsToCsv(rows: ContactReportRow[]): string {
  const lines = rows.map((r) => {
    const a = r.analysis;
    return [
      r.name,
      r.phone,
      r.status,
      r.resultLabel,
      r.attempts,
      r.lastCall ? (r.lastCall.answered ? "yes" : "no") : "",
      r.lastCall?.durationSeconds ?? "",
      a ? OUTCOME_LABEL[a.outcome] : "",
      a?.sentiment ?? "",
      a?.interest_level ?? "",
      a?.purchase_intent ?? "",
      a?.summary ?? "",
      a?.objections.join("; ") ?? "",
      a?.questions.join("; ") ?? "",
      a ? (a.follow_up_required ? "yes" : "no") : "",
      a?.next_action ?? "",
      a && a.appointment.outcome !== "none" ? a.appointment.outcome : "",
      r.analysisState,
    ]
      .map(csvCell)
      .join(",");
  });
  return [CSV_HEADER.join(","), ...lines].join("\n");
}

export { OUTCOMES, OUTCOME_LABEL };
