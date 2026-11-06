/**
 * Phase 2.19 issue 3: closing the conversation. In the smoke test "సరే,
 * ధన్యవాదాలు" (okay, thanks) after a price answer was read only as "yes",
 * and the next step stayed "ask for the date", so the agent reopened the
 * booking. The state now models wrapping up: close when nothing is pending,
 * ask once when a booking or clarification is still open, never reopen a
 * finished booking, and never ask a question in the goodbye.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { initializeLogger, voice } from "@livekit/agents";
import { ReceptionistAgent, directive } from "../src/agent/receptionist.ts";
import { InMemoryBookingBackend } from "../src/backend/in-memory.ts";
import { ReplyGuard } from "../src/conversation/guard.ts";
import {
  agentSaid,
  applyReading,
  newConversation,
  nextStep,
  type BusinessContext,
  type ConversationState,
} from "../src/conversation/state.ts";
import { readUtterance, type ServiceRow } from "../src/conversation/understanding.ts";

initializeLogger({ pretty: false, level: "error" });

const SERVICES: ServiceRow[] = [
  {
    id: "svc-cleaning",
    name: "Cleaning",
    aliases: ["క్లీనింగ్", "क्लीनिंग"],
    durationMinutes: 30,
    priceInr: 800,
  },
  {
    id: "svc-whitening",
    name: "Whitening",
    aliases: ["వైటెనింగ్"],
    durationMinutes: 45,
    priceInr: 3500,
  },
];
const NOW = new Date("2026-11-02T04:30:00Z"); // Monday 10:00 IST
const ctx: BusinessContext = {
  businessName: "Smile Dental",
  timeZone: "Asia/Kolkata",
  services: SERVICES,
  now: () => NOW,
};
const read = (t: string) => readUtterance(t, { catalog: SERVICES });

function call(): ConversationState {
  return newConversation({ callId: "c1", callerId: "+919876543210", primaryLanguage: "en-IN" });
}
function say(s: ConversationState, text: string) {
  applyReading(s, read(text), ctx);
  return nextStep(s);
}
const spoken = (s: ConversationState) => agentSaid(s, nextStep(s), { interrupted: false });
function offer(s: ConversationState, ...hhmm: string[]) {
  s.booking.offered = hhmm.map((h) => ({ hhmm: h, startIso: `2026-11-03T${h}:00+05:30` }));
  s.booking.status = "slots_offered";
}
/** A caller who has confirmed everything and been booked. */
function booked(): ConversationState {
  const s = call();
  say(s, "cleaning tomorrow at 4 PM");
  offer(s, "16:00");
  say(s, "yes");
  say(s, "my name is Ravi");
  spoken(s); // confirm caller id
  say(s, "yes");
  spoken(s); // final read-back
  say(s, "yes");
  s.booking.status = "confirmed";
  s.booking.bookingId = "bk_1";
  return s;
}

describe("closing: wrap-up expressions (en/hi/te, romanized, code-mixed)", () => {
  for (const t of [
    "okay, thanks",
    "Okay, I'll think about it, thanks",
    "that's all",
    "nothing else, bye",
    "thank you so much",
    "ok thanks andi",
    "धन्यवाद",
    "ठीक है, शुक्रिया",
    "बस इतना ही",
    "और कुछ नहीं",
    "theek hai, thank you",
    "bas itna hi, dhanyavaad",
    "సరే, ధన్యవాదాలు",
    "అంతే అండి",
    "ఇంకేమీ లేదు",
    "sare, thanks andi",
    "inkemi ledu, dhanyavadalu",
    "తర్వాత చెప్తాను",
  ])
    test(`'${t}' is a wrap-up`, () => assert.equal(read(t).closing, true));
  for (const t of ["okay", "yes", "haan", "సరే", "4 PM is fine", "book it", "cleaning please"])
    test(`'${t}' is not`, () => assert.equal(read(t).closing, false));
});

describe("closing: nothing pending -> close naturally", () => {
  test("smoke scenario 1 (Telugu): price answered, 'సరే, ధన్యవాదాలు' closes; date is not asked", () => {
    const s = call();
    say(s, "నమస్కారం");
    assert.equal(say(s, "మీ దగ్గర క్లీనింగ్ ఎంత అవుతుంది?").kind, "ask");
    assert.deepEqual(say(s, "సరే, ధన్యవాదాలు"), { kind: "close", outcome: "not_booked" });
  });

  test("smoke scenario 2 (English): slots offered, 'I'll think about it, thanks' closes", () => {
    const s = call();
    say(s, "Is there any time free for a cleaning tomorrow afternoon?");
    offer(s, "15:00", "16:00");
    assert.deepEqual(say(s, "Okay, I'll think about it, thanks"), {
      kind: "close",
      outcome: "not_booked",
    });
  });

  test("Hindi: nothing free, 'ठीक है, धन्यवाद' closes", () => {
    const s = call();
    say(s, "कल शाम चार बजे क्लीनिंग चाहिए");
    s.booking.status = "no_availability";
    assert.equal(say(s, "ठीक है, धन्यवाद").kind, "close");
  });

  test("the goodbye is recorded; a second thanks closes again without reopening anything", () => {
    const s = call();
    say(s, "how much is cleaning");
    assert.equal(say(s, "thanks, that's all").kind, "close");
    spoken(s);
    assert.equal(s.currentTask, "closed");
    assert.equal(s.closing.closed, true);
    assert.equal(say(s, "ok bye").kind, "close");
  });

  test("the close directive forbids questions and reopening", () => {
    const s = call();
    say(s, "how much is cleaning");
    const step = say(s, "ok thanks");
    const d = directive(step, s, ctx);
    assert.match(d, /say goodbye/i);
    assert.match(d, /Ask no question/);
  });
});

describe("closing: a completed booking is never reopened", () => {
  for (const t of [
    "okay, thanks",
    "धन्यवाद, बस इतना ही",
    "సరే అండి, ధన్యవాదాలు",
    "thank you, bye",
  ]) {
    test(`after booking, '${t}' closes as booked`, () => {
      const s = booked();
      assert.deepEqual(say(s, t), { kind: "close", outcome: "booked" });
    });
  }
  test("after the booking was announced, later turns don't repeat it or ask booking details", () => {
    const s = booked();
    assert.equal(nextStep(s).kind, "done");
    spoken(s);
    assert.equal(s.bookingAnnounced, true);
    const d = directive(say(s, "and do you have parking?"), s, ctx);
    assert.match(d, /do not repeat the booking/);
    assert.match(d, /do not ask for any booking detail/);
  });
  test("'book it again' after a booking is not a new booking (idempotency preserved)", () => {
    const s = booked();
    assert.equal(say(s, "एक बार फिर से बुक कर दीजिए").kind, "done");
  });
});

describe("closing: never premature while something is pending", () => {
  test("slot chosen, not yet confirmed: 'okay thanks' asks once whether to finish now", () => {
    const s = call();
    say(s, "book a cleaning tomorrow at 4 PM");
    offer(s, "16:00");
    say(s, "yes");
    assert.equal(s.booking.status, "slot_selected");
    assert.equal(say(s, "okay thanks").kind, "confirm_leave");
  });

  test("... 'yes, go ahead' resumes the booking where it was", () => {
    const s = call();
    say(s, "book a cleaning tomorrow at 4 PM");
    offer(s, "16:00");
    say(s, "yes");
    say(s, "thanks");
    spoken(s); // "finish now, or leave it?"
    const step = say(s, "yes");
    assert.notEqual(step.kind, "close");
    assert.equal(s.closing.requested, false);
    assert.equal(s.booking.status, "slot_selected");
  });

  test("... 'no, leave it' / 'वद्दु' closes without booking", () => {
    for (const answer of ["no, leave it", "नहीं, रहने दीजिए", "వద్దు"]) {
      const s = call();
      say(s, "book a cleaning tomorrow at 4 PM");
      offer(s, "16:00");
      say(s, "yes");
      say(s, "thanks");
      spoken(s);
      assert.deepEqual(say(s, answer), { kind: "close", outcome: "not_booked" }, answer);
    }
  });

  test("... asked once only: another 'thanks, bye' closes", () => {
    const s = call();
    say(s, "book a cleaning tomorrow");
    assert.equal(say(s, "ok thanks").kind, "confirm_leave");
    spoken(s);
    say(s, "hmm okay"); // neither yes nor no to the question
    assert.equal(say(s, "thanks, bye").kind, "close");
  });

  test("an open clarification ('2 or 3 PM?') is not dropped by a thank-you", () => {
    const s = call();
    say(s, "book cleaning tomorrow at 2 or 3 PM");
    assert.equal(say(s, "thanks").kind, "confirm_leave");
  });

  test("'yes, thanks' to the final read-back confirms the booking; it is not a goodbye", () => {
    const s = call();
    say(s, "cleaning tomorrow at 4 PM");
    offer(s, "16:00");
    say(s, "yes");
    say(s, "my name is Ravi");
    spoken(s);
    say(s, "yes");
    spoken(s); // final read-back
    assert.equal(say(s, "yes, thanks").kind, "book");
    assert.equal(s.closing.requested, false);
  });

  test("'no thanks' to the final read-back declines: close, nothing booked", () => {
    const s = call();
    say(s, "cleaning tomorrow at 4 PM");
    offer(s, "16:00");
    say(s, "yes");
    say(s, "my name is Ravi");
    spoken(s);
    say(s, "yes");
    spoken(s);
    assert.deepEqual(say(s, "no thanks"), { kind: "close", outcome: "not_booked" });
    assert.notEqual(s.booking.status, "awaiting_final_confirmation");
  });

  test("a new request in the same breath reopens: 'thanks, and how much is whitening?'", () => {
    const s = call();
    say(s, "how much is cleaning");
    assert.equal(say(s, "thanks").kind, "close");
    spoken(s);
    assert.notEqual(say(s, "thanks, and how much is whitening?").kind, "close");
    assert.equal(s.closing.requested, false);
    assert.equal(s.currentTask, "collecting");
  });
});

describe("closing: the guard keeps the goodbye question-free", () => {
  test("questions are removed in close mode; plain goodbye passes", () => {
    const s = call();
    const g = new ReplyGuard(s, { knownPrices: [], noQuestions: true });
    assert.equal(g.check("Is there anything else I can help with?"), null);
    assert.equal(g.check("Which day would you like?"), null);
    assert.ok(g.check("Thank you for calling, goodbye!"));
    assert.deepEqual(
      g.removed.map((r) => r.rule),
      ["question_on_close", "question_on_close"],
    );
  });
});

/* ------------------------------------------------------------------ end to end */

const sessions: voice.AgentSession[] = [];
after(async () => {
  for (const s of sessions) await s.close();
});

describe("closing end to end (AgentSession, scripted model)", () => {
  test("a model that reopens ('Which day?') after 'okay thanks' is cut to a clean goodbye", async () => {
    const backend = new InMemoryBookingBackend({
      timeZoneOffset: "+05:30",
      openHours: ["16:00"],
      callId: "c1",
    });
    const state = call();
    const guarded: string[] = [];
    const agent = new ReceptionistAgent({
      business: ctx,
      backend,
      state,
      onGuard: (r) => guarded.push(...r.map((x) => x.rule)),
    });
    const session = new voice.AgentSession({
      llm: new voice.testing.FakeLLM([
        { input: "నమస్కారం", content: "మీరు ఏ సర్వీస్ బుక్ చేయాలనుకుంటున్నారు?" },
        { input: "సరే, ధన్యవాదాలు", content: "మీరు ఏ రోజు రావాలనుకుంటున్నారు?" },
      ]),
    });
    sessions.push(session);
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item.type === "message" && ev.item.role === "assistant")
        agent.recordSpoken(ev.item.interrupted);
    });
    await session.start({ agent });
    await session.run({ userInput: "నమస్కారం" }).wait();
    const r = await session.run({ userInput: "సరే, ధన్యవాదాలు" }).wait();
    const said = r.events
      .filter((e) => e.type === "message")
      .map((e) => (e as { item: { textContent?: string } }).item.textContent ?? "")
      .join(" ");
    assert.ok(!said.includes("?"), `no question in the goodbye: ${said}`);
    assert.match(said, /ధన్యవాదాలు/, "the Telugu goodbye was spoken instead");
    assert.ok(guarded.includes("question_on_close"));
    assert.equal(state.currentTask, "closed");
    assert.equal(backend.calls.availability + backend.calls.book, 0);
  });
});
