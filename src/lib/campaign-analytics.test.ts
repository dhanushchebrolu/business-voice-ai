import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildCampaignAnalytics,
  contactsToCsv,
  csvCell,
  type AnalyticsAnalysis,
  type AnalyticsCall,
  type AnalyticsContact,
} from "./campaign-analytics.ts";
import type { CallAnalysis } from "./call-analysis.ts";

const base: CallAnalysis = {
  summary: null,
  customer_said: [],
  intent: null,
  outcome: "other",
  interest_level: null,
  sentiment: null,
  response: null,
  objections: [],
  questions: [],
  preferences: [],
  price_sensitivity: null,
  competitors: [],
  purchase_intent: null,
  callback: { requested: false, when: null },
  follow_up_required: false,
  next_action: null,
  appointment: { outcome: "none", booking_id: null },
  extracted: {},
  language: null,
};
const an = (
  callId: string,
  over: Partial<CallAnalysis>,
  source = "ai",
  status = "done",
): AnalyticsAnalysis => ({
  callId,
  source,
  status,
  analysis: { ...base, ...over },
});
const contact = (id: string, over: Partial<AnalyticsContact> = {}): AnalyticsContact => ({
  id,
  status: "completed",
  attempts: 1,
  excludedReason: null,
  outputVariables: null,
  name: `Name ${id}`,
  phone: `+9198000000${id.slice(1).padStart(2, "0")}`,
  ...over,
});
const call = (id: string, contactId: string, over: Partial<AnalyticsCall> = {}): AnalyticsCall => ({
  id,
  campaignContactId: contactId,
  status: "completed",
  durationSeconds: 60,
  startedAt: "2026-11-25T09:00:00Z",
  customerCharge: 400,
  billingApplied: true,
  resolutionSource: "provider",
  hasRecording: false,
  ...over,
});

/**
 * 12 contacts, one of them excluded; 13 calls. Hand-checked figures are in the tests.
 *  c1 interested (60s, follow-up)     c2 not interested (120s)      c3 voicemail (30s)
 *  c4 no answer                       c5 busy (opted out earlier)   c6 failed
 *  c7 excluded                        c8 booked (90s)               c9 callback (45s, follow-up)
 *  c10 answered 20s, not analysed     c11 cancelled (50s)           c12 rescheduled (40s)
 * c1 was also tried once before and did not answer; k8 was never dialled (start failure).
 */
function fixture() {
  const contacts = [
    contact("c1"),
    contact("c2"),
    contact("c3"),
    contact("c4", { status: "no_answer" }),
    contact("c5", { status: "opted_out" }),
    contact("c6", { status: "failed" }),
    contact("c7", { status: "excluded", attempts: 0, excludedReason: "country_not_allowed" }),
    contact("c8"),
    contact("c9"),
    contact("c10"),
    contact("c11"),
    contact("c12"),
  ];
  const calls = [
    call("k1", "c1", { startedAt: "2026-11-25T10:00:00Z" }),
    call("k7", "c1", {
      status: "no_answer",
      durationSeconds: 0,
      customerCharge: 0,
      billingApplied: false,
      startedAt: "2026-11-25T08:00:00Z",
    }),
    call("k2", "c2", { durationSeconds: 120, customerCharge: 800 }),
    call("k3", "c3", { durationSeconds: 30 }),
    call("k4", "c4", {
      status: "no_answer",
      durationSeconds: 0,
      customerCharge: 0,
      billingApplied: false,
    }),
    call("k5", "c5", {
      status: "busy",
      durationSeconds: 0,
      customerCharge: 0,
      billingApplied: false,
    }),
    call("k6", "c6", {
      status: "failed",
      durationSeconds: 0,
      customerCharge: 0,
      billingApplied: false,
    }),
    call("k8", "c2", {
      status: "failed",
      durationSeconds: 0,
      customerCharge: 0,
      billingApplied: false,
      resolutionSource: "start_failure",
    }),
    call("k9", "c8", { durationSeconds: 90, customerCharge: 800 }),
    call("k10", "c9", { durationSeconds: 45 }),
    call("k11", "c10", { durationSeconds: 20 }),
    call("k12", "c11", { durationSeconds: 50 }),
    call("k13", "c12", { durationSeconds: 40 }),
  ];
  const analyses = [
    an("k1", {
      outcome: "interested",
      response: "positive",
      sentiment: "positive",
      follow_up_required: true,
    }),
    an("k2", { outcome: "not_interested", response: "negative", sentiment: "negative" }),
    an("k3", { outcome: "voicemail" }),
    an("k9", {
      outcome: "appointment_booked",
      response: "positive",
      sentiment: "positive",
      appointment: { outcome: "booked", booking_id: "bk-1" },
    }),
    an("k10", {
      outcome: "callback_requested",
      response: "neutral",
      sentiment: "neutral",
      callback: { requested: true, when: "Friday" },
      follow_up_required: true,
    }),
    an("k12", {
      outcome: "appointment_cancelled",
      response: "neutral",
      sentiment: "neutral",
      follow_up_required: true,
      appointment: { outcome: "cancelled", booking_id: "bk-2" },
    }),
    an("k13", {
      outcome: "appointment_rescheduled",
      response: "positive",
      sentiment: "positive",
      appointment: { outcome: "rescheduled", booking_id: "bk-3" },
    }),
  ];
  return { contacts, calls, analyses, leadsCaptured: 2 };
}

describe("campaign-level metrics are computed from the calls, not estimated", () => {
  const r = buildCampaignAnalytics(fixture());

  test("calls: attempted excludes a call that was never dialled; answered needs talk time", () => {
    assert.equal(r.totals.contacts, 12);
    assert.equal(r.totals.eligibleContacts, 11);
    assert.equal(r.totals.callsAttempted, 12, "13 calls, one never started");
    assert.equal(r.totals.answered, 8);
    assert.equal(r.totals.noAnswer, 2);
    assert.equal(r.totals.busy, 1);
    assert.equal(r.totals.failed, 1, "the never-started call is not a failed call of the campaign");
  });

  test("conversations are answered calls with a real person: voicemail and unanalysed calls are not", () => {
    assert.equal(r.totals.conversations, 6);
  });

  test("talk time and average length", () => {
    assert.equal(r.totals.connectedSeconds, 455);
    assert.equal(r.totals.avgConversationSeconds, 68, "405 s over 6 conversations");
  });

  test("contact success and conversion", () => {
    assert.equal(r.rates.contactSuccessRate, 72.7, "8 of 11 eligible contacts were reached");
    assert.equal(r.rates.conversionRate, 50, "3 of 6 conversations reached the campaign's goal");
  });

  test("positive, negative and neutral share of the conversations that have a response", () => {
    assert.equal(r.rates.positivePct, 50);
    assert.equal(r.rates.negativePct, 16.7);
    assert.equal(r.rates.neutralPct, 33.3);
    assert.deepEqual(r.sentiment, { positive: 3, negative: 1, neutral: 2, mixed: 0, unknown: 0 });
  });

  test("interested, not interested and callback shares", () => {
    assert.equal(r.rates.interestedPct, 50);
    assert.equal(r.rates.notInterestedPct, 16.7);
    assert.equal(r.rates.callbackPct, 16.7);
  });

  test("outcome distribution counts each contact's latest conversation once", () => {
    assert.deepEqual(r.outcomes, {
      interested: 1,
      not_interested: 1,
      appointment_booked: 1,
      callback_requested: 1,
      appointment_cancelled: 1,
      appointment_rescheduled: 1,
    });
  });

  test("follow-ups, appointments, leads and do-not-call", () => {
    assert.equal(r.followUps, 3);
    assert.deepEqual(r.appointments, { booked: 1, rescheduled: 1, cancelled: 1 });
    assert.equal(r.leadsCaptured, 2);
    assert.equal(r.doNotCall, 1);
  });

  test("cost is what was billed, and each cost-per figure divides it by what it is per", () => {
    assert.equal(r.cost.totalPaise, 4000);
    assert.equal(r.cost.perAnsweredCall, 500);
    assert.equal(r.cost.perInterestedContact, 1333);
    assert.equal(r.cost.perSuccessfulContact, 1333);
  });

  test("coverage says how much of this rests on an analysis", () => {
    assert.deepEqual(r.coverage, { calls: 8, analysed: 7, basic: 0, pending: 1 });
  });
});

describe("nothing is invented", () => {
  test("an empty campaign: zeros and unavailable, never NaN or a made-up rate", () => {
    const r = buildCampaignAnalytics({ contacts: [], calls: [], analyses: [], leadsCaptured: 0 });
    assert.equal(r.totals.answered, 0);
    assert.equal(r.totals.avgConversationSeconds, null);
    for (const v of Object.values(r.rates)) assert.equal(v, null);
    assert.equal(r.cost.perAnsweredCall, null);
    assert.equal(r.cost.perInterestedContact, null);
    assert.equal(r.cost.perSuccessfulContact, null);
    assert.equal(r.cost.totalPaise, 0);
  });

  test("calls but nobody analysed: counts stand, outcome-based figures are unavailable", () => {
    const f = fixture();
    const r = buildCampaignAnalytics({ ...f, analyses: [] });
    assert.equal(r.totals.answered, 8);
    assert.equal(r.totals.conversations, 0);
    assert.equal(r.rates.conversionRate, null);
    assert.equal(r.rates.positivePct, null);
    assert.equal(r.cost.perInterestedContact, null);
    assert.equal(r.coverage.pending, 8);
  });

  test("a response not stated is left out of the share, not counted as neutral", () => {
    const f = fixture();
    f.analyses = [an("k1", { outcome: "interested", response: null, sentiment: null })];
    const r = buildCampaignAnalytics(f);
    assert.equal(r.rates.positivePct, null);
    assert.equal(r.sentiment.unknown, 1);
  });

  test("an answered call with no talk time is not answered", () => {
    const f = fixture();
    f.calls = [call("z", "c1", { durationSeconds: 0 })];
    assert.equal(buildCampaignAnalytics(f).totals.answered, 0);
  });
});

describe("retries and duplicates do not inflate the report", () => {
  test("a contact called three times appears once, in its latest conversation", () => {
    const f = fixture();
    f.calls.push(
      call("r1", "c2", { startedAt: "2026-11-25T11:00:00Z", durationSeconds: 80 }),
      call("r2", "c2", { startedAt: "2026-11-25T12:00:00Z", durationSeconds: 70 }),
    );
    f.analyses.push(
      an("r1", { outcome: "callback_requested", response: "neutral", sentiment: "neutral" }),
      an("r2", { outcome: "interested", response: "positive", sentiment: "positive" }),
    );
    const r = buildCampaignAnalytics(f);
    assert.equal(r.totals.contacts, 12);
    assert.equal(r.totals.answered, 10, "every call counts as a call");
    assert.equal(r.outcomes.interested, 2, "c1 and c2 (latest = r2)");
    assert.equal(r.outcomes.not_interested, undefined, "c2's older call no longer counts");
    assert.equal(r.contacts.find((c) => c.id === "c2")!.analysis!.outcome, "interested");
    const withConversation = Object.values(r.outcomes).reduce((a, b) => a + (b ?? 0), 0);
    assert.equal(withConversation, 6, "still 6 people, not 8");
  });

  test("the same analysis supplied twice changes nothing", () => {
    const f = fixture();
    const once = buildCampaignAnalytics(f);
    const twice = buildCampaignAnalytics({ ...f, analyses: [...f.analyses, ...f.analyses] });
    assert.deepEqual(twice.totals, once.totals);
    assert.deepEqual(twice.appointments, once.appointments, "an appointment is not counted twice");
  });
});

describe("the contact-by-contact report", () => {
  const r = buildCampaignAnalytics(fixture());
  const row = (id: string) => r.contacts.find((c) => c.id === id)!;

  test("every contact has a row, in the order given", () => {
    assert.deepEqual(
      r.contacts.map((c) => c.id),
      ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12"],
    );
  });

  test("answered vs unanswered, with the call's own length", () => {
    assert.equal(row("c2").lastCall!.answered, true);
    assert.equal(row("c2").lastCall!.durationSeconds, 120);
    assert.equal(row("c4").lastCall!.answered, false);
    assert.equal(row("c7").lastCall, null, "an excluded contact was never called");
  });

  test("the analysis state tells the truth: analysed, waiting, or nothing to analyse", () => {
    assert.equal(row("c1").analysisState, "ai");
    assert.equal(row("c10").analysisState, "pending", "answered but not analysed yet");
    assert.equal(row("c4").analysisState, "none", "never connected");
    assert.equal(row("c10").analysis, null);
  });

  test("a call analysed from ClickAI's records only is labelled basic", () => {
    const f = fixture();
    f.analyses = [an("k1", { outcome: "interested" }, "rules", "no_transcript")];
    assert.equal(buildCampaignAnalytics(f).contacts[0]!.analysisState, "basic");
    f.analyses = [an("k1", { outcome: "interested" }, "rules", "pending_ai")];
    assert.equal(buildCampaignAnalytics(f).contacts[0]!.analysisState, "pending");
  });

  test("the result label comes from ClickAI's existing classification", () => {
    assert.equal(row("c7").resultLabel, "Excluded");
    assert.equal(row("c5").resultLabel, "Opted out");
  });
});

describe("CSV download", () => {
  test("a cell that could run as a formula is neutralised", () => {
    for (const bad of ['=HYPERLINK("http://x")', "+1+1", "-2+3", "@SUM(A1)", "\tcmd"])
      assert.ok(csvCell(bad).replace(/^"/, "").startsWith("'"), bad);
    assert.equal(csvCell("Ravi"), "Ravi");
    assert.equal(csvCell(5), "5");
    assert.equal(csvCell(null), "");
  });

  test("commas, quotes and line breaks are quoted", () => {
    assert.equal(csvCell('Said "yes", twice'), '"Said ""yes"", twice"');
    assert.equal(csvCell("a\nb"), '"a\nb"');
  });

  test("one header row and one row per contact, with the analysis fields", () => {
    const f = fixture();
    f.contacts[0] = contact("c1", { name: "=Evil()" });
    f.analyses[0] = an("k1", {
      outcome: "interested",
      summary: "Wants a check-up, asked about cost.",
      objections: ["too expensive", "far away"],
      follow_up_required: true,
      next_action: "Call back Monday",
    });
    const lines = contactsToCsv(buildCampaignAnalytics(f).contacts).split("\n");
    assert.equal(lines.length, 13);
    assert.match(lines[0]!, /^Name,Phone,Status,Result/);
    assert.match(lines[1]!, /^'=Evil\(\),/);
    assert.match(lines[1]!, /too expensive; far away/);
    assert.match(lines[1]!, /Call back Monday/);
  });
});
