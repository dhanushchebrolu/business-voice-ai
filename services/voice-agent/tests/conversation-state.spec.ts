import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  agentSaid,
  applyReading,
  missingDetails,
  newConversation,
  nextStep,
  readyToBook,
  type BusinessContext,
  type ConversationState,
} from "../src/conversation/state.ts";
import { readUtterance, type ServiceRow } from "../src/conversation/understanding.ts";

const SERVICES: ServiceRow[] = [
  { id: "svc-cleaning", name: "Cleaning", aliases: ["క్లీనింగ్", "क्लीनिंग"], durationMinutes: 30 },
  {
    id: "svc-root-canal",
    name: "Root Canal",
    aliases: ["రూట్ కెనాల్", "रूट कैनाल"],
    durationMinutes: 60,
  },
];
const NOW = new Date("2026-11-02T04:30:00Z"); // 10:00 IST
const ctx: BusinessContext = {
  businessName: "Smile Dental",
  timeZone: "Asia/Kolkata",
  services: SERVICES,
  now: () => NOW,
};

function call(callerId: string | null = "+919876543210"): ConversationState {
  return newConversation({ callId: "c1", callerId, primaryLanguage: "en-IN" });
}
function say(s: ConversationState, text: string, stt: string | null = null) {
  applyReading(s, readUtterance(text, { catalog: SERVICES, sttLanguage: stt }), ctx);
  return nextStep(s);
}
/** The agent said the step to the caller (not interrupted). */
function spoken(s: ConversationState) {
  agentSaid(s, nextStep(s), { interrupted: false });
}
function offer(s: ConversationState, ...hhmm: string[]) {
  s.booking.offered = hhmm.map((h) => ({ hhmm: h, startIso: `2026-11-02T${h}:00+05:30` }));
  s.booking.status = "slots_offered";
}

describe("provenance: nothing uncertain becomes a fact silently", () => {
  test("caller ID is inferred until the caller agrees", () => {
    const s = call();
    assert.equal(s.phone?.provenance, "inferred");
    assert.ok(missingDetails(s).includes("phone"));
  });
  test("an ambiguous time is clarified before anything else", () => {
    const s = call();
    say(s, "cleaning today");
    const step = say(s, "at 12");
    assert.equal(s.time?.provenance, "uncertain");
    assert.equal(step.kind, "clarify");
    assert.deepEqual(step.kind === "clarify" && step.options.sort(), ["12 midnight", "12 noon"]);
  });
  test("'2 or 3 PM' is clarified, never picked", () => {
    const s = call();
    const step = say(s, "cleaning today, 2 or 3 PM");
    assert.equal(step.kind, "clarify");
    assert.equal(s.time?.provenance, "uncertain");
  });
  test("an inferred time is usable for checking but only confirmed by the read-back", () => {
    const s = call();
    say(s, "cleaning today at 4");
    assert.equal(s.time?.provenance, "inferred");
    assert.equal(nextStep(s).kind, "check_availability");
  });
  test("a bare 'no' to a read-back makes the value doubtful, it is not kept as true", () => {
    const s = call();
    say(s, "cleaning today at 4 PM");
    offer(s, "16:00");
    say(s, "4 PM");
    say(s, "my name is Ravi");
    say(s, "yes"); // to nothing: nothing pending, nothing confirmed
    assert.equal(s.customerName?.provenance, "explicit");
    spoken(s); // "can we use the number ending 3210?"
    assert.equal(s.pendingReadBack, "phone");
    say(s, "no");
    assert.equal(s.phone, null, "caller-ID number dropped, not kept");
    assert.deepEqual(nextStep(s), { kind: "ask", slot: "phone" });
  });
});

describe("one question at a time, no repeats", () => {
  test("answered details are never asked again; the next missing one is", () => {
    const s = call();
    const steps = [say(s, "I need a cleaning"), say(s, "tomorrow"), say(s, "after 2 PM")];
    assert.deepEqual(
      steps.map((x) => (x.kind === "ask" ? x.slot : x.kind)),
      ["date", "time", "check_availability"],
    );
  });
  test("an interrupted question was not asked", () => {
    const s = call();
    say(s, "I need a cleaning");
    agentSaid(s, nextStep(s), { interrupted: true });
    assert.equal(s.timesAsked.date, undefined);
    assert.equal(s.lastQuestion, null);
    agentSaid(s, nextStep(s), { interrupted: false });
    assert.equal(s.timesAsked.date, 1);
  });
  test("noise and long-pause fillers change nothing", () => {
    const s = call();
    say(s, "cleaning tomorrow");
    const before = JSON.stringify(s.service) + JSON.stringify(s.date);
    for (const t of ["hmm", "[noise]", "", "..."]) say(s, t);
    assert.equal(JSON.stringify(s.service) + JSON.stringify(s.date), before);
  });
});

describe("corrections and changes", () => {
  test("changing the selected time drops the selection and re-checks", () => {
    const s = call();
    say(s, "cleaning today at 3 PM");
    offer(s, "15:00");
    say(s, "yes");
    assert.equal(s.booking.status, "slot_selected");
    const step = say(s, "actually, make it 5 PM");
    assert.equal(s.booking.selected, null);
    assert.equal(s.booking.status, "none");
    assert.deepEqual(s.time?.value, { kind: "exact", hhmm: "17:00" });
    assert.equal(step.kind, "check_availability");
    assert.ok(s.changes.some((c) => c.slot === "time" && c.reason === "caller corrected"));
  });
  test("correcting the service is recorded and invalidates offered slots", () => {
    const s = call();
    say(s, "cleaning tomorrow after 2 PM");
    offer(s, "14:00", "15:00");
    say(s, "sorry, not cleaning, root canal");
    assert.equal(s.service?.value.id, "svc-root-canal");
    assert.equal(s.booking.offered.length, 0);
  });
  test("choosing an offered slot by a bare hour resolves AM/PM from the offer", () => {
    const s = call();
    say(s, "cleaning today after 2 PM");
    offer(s, "15:00", "16:00");
    say(s, "4");
    assert.equal(s.booking.selected?.hhmm, "16:00");
    assert.equal(s.time?.provenance, "explicit");
  });
  test("a time that was not offered cannot be selected", () => {
    const s = call();
    say(s, "cleaning today after 2 PM");
    offer(s, "15:00", "16:00");
    say(s, "11 AM");
    assert.equal(s.booking.selected, null);
  });
});

describe("booking requires confirmed facts", () => {
  test("not bookable until the final read-back is affirmed", () => {
    const s = call();
    say(s, "cleaning today at 4 PM");
    offer(s, "16:00");
    say(s, "yes");
    say(s, "my name is Ravi");
    spoken(s); // caller ID question
    say(s, "yes");
    assert.equal(s.phone?.provenance, "confirmed");
    assert.equal(readyToBook(s).ok, false);
    assert.equal(nextStep(s).kind, "final_confirmation");
    spoken(s); // the read-back
    say(s, "yes");
    assert.deepEqual(readyToBook(s), { ok: true });
    for (const k of ["service", "date", "time", "customerName", "phone"] as const)
      assert.equal(s[k]?.provenance, "confirmed", k);
  });
});

/**
 * The Smile Dental production call of 2026-10-29 (reconstructed in
 * src/lib/voice-multilingual-booking-flow.test.ts): English greeting ->
 * Telugu booking request -> Telugu "which slots today?" -> English -> Hindi
 * "4 PM cleaning" -> name -> confirmation. On that call the agent answered
 * the Telugu slot question with "I can't hear you clearly" and the booking
 * never happened. Here the caller's words drive the state in every language.
 */
describe("regression: Smile Dental production call (2026-10-29)", () => {
  test("the caller's own words carry the booking across Telugu, English and Hindi", () => {
    const s = call();
    const trace: string[] = [];
    const step = (text: string, stt: string) => {
      const n = say(s, text, stt);
      trace.push(`${s.language.current} ${n.kind}${n.kind === "ask" ? ":" + n.slot : ""}`);
      return n;
    };
    step("Hello", "en-IN");
    step("నాకు అపాయింట్మెంట్ బుక్ చేయాలి", "te-IN");
    assert.equal(s.intent?.value, "book");
    const slots = step("ఈరోజు ఏ టైం స్లాట్స్ అందుబాటులో ఉన్నాయి?", "te-IN");
    assert.equal(s.intent?.value, "book", "asking for free slots keeps the booking intent");
    assert.equal(s.date?.provenance, "explicit");
    assert.deepEqual(
      slots,
      { kind: "ask", slot: "service" },
      "one question: which service (date already known)",
    );
    step("Cleaning", "en-IN");
    const hi = step("आज शाम चार बजे क्लीनिंग चाहिए", "hi-IN");
    assert.equal(s.language.current, "hi-IN");
    assert.deepEqual(s.time?.value, { kind: "exact", hhmm: "16:00" });
    assert.equal(s.time?.provenance, "explicit", "शाम (evening) makes 4 explicit");
    assert.equal(hi.kind, "check_availability");
    offer(s, "16:00");
    step("हाँ", "hi-IN");
    assert.equal(s.booking.status, "slot_selected");
    step("मेरा नाम धनुष है", "hi-IN");
    assert.equal(s.customerName?.value, "धनुष");
    assert.deepEqual(nextStep(s), { kind: "confirm_caller_id", digits: "9876543210" });
    spoken(s);
    step("हाँ जी, इसी नंबर पर", "hi-IN");
    assert.equal(s.phone?.provenance, "confirmed");
    assert.equal(nextStep(s).kind, "final_confirmation");
    spoken(s);
    step("हाँ", "hi-IN");
    assert.deepEqual(readyToBook(s), { ok: true });
    assert.equal(s.language.switches, 3);
    assert.equal(trace.length, 9);
  });
});
