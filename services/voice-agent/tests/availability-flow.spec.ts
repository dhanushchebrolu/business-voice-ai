/**
 * Phase 2.19 issue 2: the availability conversation. In the smoke test the
 * caller said "4 or 5, either" and then "which one is free?", and the agent
 * asked "4 PM or 5 PM?" twice without ever checking the calendar: the
 * state treated every "X or Y" as an ambiguity to clarify, and a question
 * back ("which is free?") left it unresolved, so the directive repeated the
 * same clarification. These tests pin the fix: a choice the caller leaves to
 * the calendar is checked for every candidate, empty/malformed/unavailable
 * answers are handled explicitly, and availability is never invented.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { initializeLogger, voice } from "@livekit/agents";
import { ReceptionistAgent, buildTools, usableSlots } from "../src/agent/receptionist.ts";
import { InMemoryBookingBackend } from "../src/backend/in-memory.ts";
import type { AvailabilityResult, BookingBackend } from "../src/backend/types.ts";
import { ReplyGuard } from "../src/conversation/guard.ts";
import {
  agentSaid,
  applyReading,
  bookingExists,
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
];
const NOW = new Date("2026-11-02T04:30:00Z"); // Monday 10:00 IST
const ctx: BusinessContext = {
  businessName: "Smile Dental",
  timeZone: "Asia/Kolkata",
  services: SERVICES,
  now: () => NOW,
};
const slot = (date: string, hhmm: string, mins = 30) => {
  const start = new Date(`${date}T${hhmm}:00+05:30`);
  return {
    startIso: start.toISOString(),
    endIso: new Date(start.getTime() + mins * 60_000).toISOString(),
  };
};

function call(): ConversationState {
  return newConversation({ callId: "c1", callerId: "+919876543210", primaryLanguage: "en-IN" });
}
function say(s: ConversationState, text: string) {
  applyReading(s, readUtterance(text, { catalog: SERVICES }), ctx);
  return nextStep(s);
}
const spoken = (s: ConversationState) => agentSaid(s, nextStep(s), { interrupted: false });

/** Runs the real check_availability tool against a backend, as the model would. */
async function checkWith(s: ConversationState, backend: BookingBackend): Promise<string> {
  const tools = buildTools({ business: ctx, backend, state: s }, new Set());
  return String(
    await tools.check_availability.execute({}, { ctx: {} as never, toolCallId: "t1" } as never),
  );
}
const stub = (...results: AvailabilityResult[]) => {
  const queries: unknown[] = [];
  const b: BookingBackend = {
    checkAvailability: async (q) => (queries.push(q), results.shift() ?? results.at(-1)!),
    book: async () => {
      throw new Error("book must not be called");
    },
  };
  return { b, queries };
};

describe("availability: '4 or 5' left to the calendar is checked, not re-asked", () => {
  test("the smoke-test transcript: clarify once, then 'which one is free?' checks both", () => {
    const s = call();
    say(s, "hello andi");
    let step = say(s, "repu evening cleaning kavali, 4 or 5");
    assert.equal(step.kind, "clarify");
    spoken(s);
    step = say(s, "hmm, ఏది free gaa undi?");
    assert.equal(step.kind, "check_availability", "not the same clarification again");
    assert.deepEqual(s.time?.value, { kind: "anyOf", hhmms: ["16:00", "17:00"] });
    assert.equal(s.time?.provenance, "inferred");
    assert.equal(s.date?.value, "2026-11-03");
  });

  test("'either' in the request itself: no clarification at all (en/hi/te/code-mixed)", () => {
    for (const t of [
      "repu evening cleaning kavali, 4 or 5 lo edaina",
      "cleaning tomorrow at 4 or 5 PM, whichever is free",
      "कल शाम 4 या 5 बजे, कोई भी, क्लीनिंग",
      "రేపు సాయంత్రం 4 లేదా 5, ఏదైనా పర్వాలేదు, క్లీనింగ్",
    ]) {
      const s = call();
      assert.equal(say(s, t).kind, "check_availability", t);
      assert.deepEqual(s.time?.value, { kind: "anyOf", hhmms: ["16:00", "17:00"] }, t);
    }
  });

  test("deferring answers convert the open choice into a check (en/hi/te)", () => {
    for (const reply of [
      "which one is free?",
      "you tell me",
      "आप बताइए",
      "कौन सा खाली है?",
      "మీ ఇష్టం",
      "ఏది ఖాళీగా ఉంది?",
    ]) {
      const s = call();
      say(s, "cleaning tomorrow at 4 or 5");
      spoken(s);
      assert.equal(say(s, reply).kind, "check_availability", reply);
    }
  });

  test("the same clarification is never asked twice in a row", () => {
    const s = call();
    say(s, "cleaning tomorrow at 2 or 3 PM");
    assert.equal(nextStep(s).kind, "clarify");
    spoken(s);
    // An answer that does not resolve it (here: an unrelated remark).
    const step = say(s, "my name is Ravi");
    assert.notEqual(step.kind, "clarify");
    assert.deepEqual(s.time?.value, { kind: "anyOf", hhmms: ["14:00", "15:00"] });
  });

  test("a plain 'X or Y' with no deferral is still clarified first (never picked)", () => {
    const s = call();
    const step = say(s, "cleaning tomorrow at 2 or 3 PM");
    assert.equal(step.kind, "clarify");
    assert.equal(s.time?.provenance, "uncertain");
  });

  test("answering the clarification resolves it normally", () => {
    const s = call();
    say(s, "cleaning tomorrow at 4 or 5");
    spoken(s);
    assert.equal(say(s, "5 PM").kind, "check_availability");
    assert.deepEqual(s.time?.value, { kind: "exact", hhmm: "17:00" });
  });
});

describe("availability: the calendar's answer, every shape", () => {
  const ready = () => {
    const s = call();
    say(s, "cleaning tomorrow at 4 or 5, either");
    return s;
  };

  test("both free: offered exactly the caller's candidates", async () => {
    const { b } = stub({
      ok: true,
      slots: [slot("2026-11-03", "16:00"), slot("2026-11-03", "17:00")],
    });
    const s = ready();
    assert.equal(await checkWith(s, b), "OFFER: Free times: 4 PM, 5 PM. Ask which one.");
    assert.equal(s.booking.status, "slots_offered");
    assert.equal(nextStep(s).kind, "offer_slots");
  });

  test("one free: the taken one is named as not free; only the free one is offered", async () => {
    const { b } = stub({
      ok: true,
      slots: [slot("2026-11-03", "16:30"), slot("2026-11-03", "17:00")],
    });
    const s = ready();
    assert.equal(
      await checkWith(s, b),
      "OFFER: 4 PM is not free. Free times: 5 PM. Ask which one.",
    );
    assert.deepEqual(
      s.booking.offered.map((o) => o.hhmm),
      ["17:00"],
      "4:30 is not one of theirs",
    );
  });

  test("empty: NO_SLOTS, then ask for another day/time; the same check is not repeated", async () => {
    const { b, queries } = stub({ ok: true, slots: [] });
    const s = ready();
    assert.match(await checkWith(s, b), /^NO_SLOTS/);
    assert.equal(s.booking.status, "no_availability");
    assert.equal(nextStep(s).kind, "ask_alternative");
    // Repeating the same request does not re-check or loop.
    say(s, "4 or 5 tomorrow, either");
    assert.equal(nextStep(s).kind, "ask_alternative");
    assert.equal(queries.length, 1);
    // A different time does re-check.
    say(s, "then 11 AM");
    assert.equal(nextStep(s).kind, "check_availability");
  });

  for (const [label, result] of [
    ["slots: null", { ok: true, slots: null }],
    ["slots: an object", { ok: true, slots: { "16:00": true } }],
    ["no slots key", { ok: true }],
    ["undefined result", undefined],
    ["ok:false", { ok: false, error: "calendar_unreachable", retryable: true }],
  ] as const) {
    test(`${label}: FAILED (never 'nothing free', never 'free'); nothing offered`, async () => {
      const { b } = stub(result as unknown as AvailabilityResult);
      const s = ready();
      assert.match(await checkWith(s, b), /^FAILED: the calendar could not be checked/);
      assert.equal(s.booking.status, "failed");
      assert.deepEqual(s.booking.offered, []);
    });
  }

  test("bad entries are dropped: invalid, reversed, wrong day, past, out of window, duplicates", () => {
    const good = slot("2026-11-03", "16:00");
    const r = usableSlots(
      [
        slot("2026-11-03", "17:00"),
        good,
        { ...good }, // duplicate
        { startIso: "not a date", endIso: good.endIso },
        { startIso: good.endIso, endIso: good.startIso }, // ends before it starts
        slot("2026-11-04", "16:00"), // another day
        slot("2026-11-02", "09:00"), // today, already past
        slot("2026-11-03", "19:00"), // outside the window
        null,
        42,
      ],
      { date: "2026-11-03", notBefore: "16:00", notAfter: "17:00" },
      ctx,
    );
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(
        r.slots.map((x) => x.hhmm),
        ["16:00", "17:00"],
        "sorted, de-duplicated",
      );
      assert.equal(r.dropped, 8);
    }
    assert.deepEqual(usableSlots("garbage", { date: "2026-11-03" }, ctx), {
      ok: false,
      error: "malformed_response",
    });
  });

  test("a slot later today that has already passed is never offered", async () => {
    const { b } = stub({
      ok: true,
      slots: [slot("2026-11-02", "09:30"), slot("2026-11-02", "10:00")],
    });
    const s = call();
    say(s, "cleaning today in the morning");
    assert.match(await checkWith(s, b), /^NO_SLOTS/, "09:30 and 10:00 are not after 10:00 IST");
  });
});

describe("availability is not a booking", () => {
  test("offered and even selected slots are not bookings; booking still needs the read-back", async () => {
    const backend = new InMemoryBookingBackend({
      timeZoneOffset: "+05:30",
      openHours: ["16:00", "17:00"],
      callId: "c1",
    });
    const s = call();
    say(s, "cleaning tomorrow at 4 or 5, either");
    await checkWith(s, backend);
    assert.equal(bookingExists(s), false);
    say(s, "5 PM");
    assert.equal(s.booking.status, "slot_selected");
    const tools = buildTools({ business: ctx, backend, state: s }, new Set());
    const r = String(await tools.book_appointment.execute({}, { toolCallId: "b1" } as never));
    assert.match(r, /^NOT_ALLOWED/);
    assert.equal(backend.bookings.size, 0);
  });
});

describe("availability: the guard never lets invented availability through", () => {
  const offered = (...hhmm: string[]) => {
    const s = call();
    say(s, "cleaning tomorrow at 4 or 5");
    s.booking.offered = hhmm.map((h) => ({ hhmm: h, startIso: slot("2026-11-03", h).startIso }));
    s.booking.status = hhmm.length ? "slots_offered" : "none";
    return s;
  };
  const check = (s: ConversationState, sentence: string) =>
    new ReplyGuard(s, { knownPrices: [] }).check(sentence);

  test("'we have a slot at 2 PM' (not offered) is removed; offered times pass", () => {
    const s = offered("17:00");
    assert.equal(check(s, "We have a slot at 2 PM tomorrow."), null);
    assert.equal(check(s, "We have a slot at 4 PM tomorrow."), null, "4 PM was not offered");
    assert.ok(check(s, "We have a slot at 5 PM tomorrow."));
  });
  test("before any check: no time may be called free, but the clarifying question survives", () => {
    const s = offered();
    assert.equal(check(s, "4 PM is free."), null);
    assert.ok(check(s, "Would you like the 4 PM or the 5 PM slot?"), "the caller's own options");
    assert.ok(check(s, "Which time slot suits you?"));
  });
  test("after NO_SLOTS, an honest 'nothing is free' is spoken; a free claim is not", () => {
    const s = offered();
    s.booking.status = "no_availability";
    assert.ok(check(s, "Sorry, nothing is free at 4 or 5 PM tomorrow."));
    assert.equal(check(s, "6 PM is free."), null);
  });
});

/* ------------------------------------------------------------------ end to end */

const sessions: voice.AgentSession[] = [];
after(async () => {
  for (const s of sessions) await s.close();
});

describe("availability end to end (AgentSession, scripted model)", () => {
  test("a model that keeps asking '4 or 5?' is overridden by the state: the calendar gets checked", async () => {
    const backend = new InMemoryBookingBackend({
      timeZoneOffset: "+05:30",
      openHours: ["16:00", "17:00"],
      callId: "c1",
    });
    const state = call();
    const directives: string[] = [];
    const agent = new ReceptionistAgent({
      business: ctx,
      backend,
      state,
      onTurn: ({ step }) => directives.push(step.kind),
    });
    const session = new voice.AgentSession({
      llm: new voice.testing.FakeLLM([
        { input: "repu evening cleaning kavali, 4 or 5", content: "4 PM or 5 PM?" },
        {
          input: "hmm, ఏది free gaa undi?",
          content: "చూస్తున్నాను.",
          toolCalls: [{ name: "check_availability", args: {} }],
        },
      ]),
    });
    sessions.push(session);
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      if (ev.item.type === "message" && ev.item.role === "assistant")
        agent.recordSpoken(ev.item.interrupted);
    });
    await session.start({ agent });
    await session.run({ userInput: "repu evening cleaning kavali, 4 or 5" }).wait();
    await session.run({ userInput: "hmm, ఏది free gaa undi?" }).wait();
    assert.deepEqual(directives, ["clarify", "check_availability"]);
    assert.equal(backend.calls.availability, 1);
    assert.deepEqual(
      state.booking.offered.map((o) => o.hhmm),
      ["16:00", "17:00"],
    );
    assert.equal(bookingExists(state), false);
  });
});
