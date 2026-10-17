import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  startRuntimeSession,
  terminateRuntimeSession,
  extractCallerName,
  isPresenceCheck,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ServiceRow } from "./service-matching.ts";

/**
 * Production call (Smile Dental, root canal today at 7 PM): the caller
 * agreed to use their calling number, said "I am Dhanush", and the agent
 * answered "Hello Dhanush, can you hear me? I was just confirming your
 * name for the appointment. Once you confirm, I'll check if we have
 * availability…" — then, through "Guys", "I am Dhanush", "My name is
 * Dhanush" and several "Hello"s, kept asking the caller to confirm their
 * name and never checked availability.
 *
 * The model's replies below misbehave the way the production model did:
 * it acknowledges the name but never asks the runtime to check
 * availability, and keeps asking for a confirmation nothing needs. The
 * runtime must save the name once and move straight on to the real
 * availability check.
 *
 * Drives the REAL voice runtime through the deterministic harness; the
 * calendar tools are in-memory stand-ins. No network, database or calendar.
 */

const agent: AgentSnapshot["agent"] = {
  agent_name: "Aria",
  persona: "professional",
  custom_personality: null,
  objectives: ["answer_questions"],
  capabilities: {},
  primary_language: "en-IN",
  extra_languages: [],
  multilingual: false,
  voice_id: "ritu",
  speaking_pace: 1,
  greetings: { "en-IN": "Hello, thanks for calling Smile Dental. How can I help you today?" },
  transfer_number: null,
  after_hours_behavior: "take_message",
};

const SERVICES: ServiceRow[] = [
  { id: "svc-teeth-cleaning", name: "Teeth Cleaning", duration_minutes: 30 },
  { id: "svc-root-canal", name: "Root Canal Treatment", duration_minutes: 30 },
];

const CALLER_ID = "+919876543210";
const DATE = "2030-10-14";
const SLOT = { start: `${DATE}T19:00:00.000Z`, end: `${DATE}T19:30:00.000Z` };
const SLOT_8PM = { start: `${DATE}T20:00:00.000Z`, end: `${DATE}T20:30:00.000Z` };
const NAME_QUESTION =
  /\b(may i have|what(?:'s| is)|confirm(?:ing)?)\b[^.?!]*\byour (?:full )?name\b/i;
const GREETING = /thanks for calling Smile Dental/i;

function input(callId: string, h: Harness): StartRuntimeSessionInput {
  return {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: "00000000-0000-0000-0000-000000000002",
    agentVersion: 3,
    instructions: "You are Aria, a helpful receptionist for Smile Dental.",
    snapshotAgent: agent,
    businessName: "Smile Dental",
    bridge: h.bridge,
    businessCountry: "IN",
    callerNumber: CALLER_ID,
    services: SERVICES,
  };
}

async function drain(hops = 300) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

function marker(state: Record<string, unknown>): string {
  return `<<<APPT_STATE:${JSON.stringify({
    service: null,
    customer_name: null,
    phone: null,
    email: null,
    preferred_date: null,
    preferred_time: null,
    preferred_period: null,
    wants_next_available: false,
    checking_availability: false,
    ready_to_book: false,
    ...state,
  })}>>>`;
}

const KNOWN = { service: "Root Canal Treatment", preferred_date: DATE, preferred_time: "19:00" };
/** The production model's reply to every turn after the name: acknowledge, ask for a confirmation, never check. */
const STALL_REPLY = (name: unknown = "Dhanush") =>
  `Hello Dhanush, can you hear me? I was just confirming your name for the appointment. Once you confirm, I'll check if we have availability for root canal treatment today at 7 PM.\n${marker({ ...KNOWN, customer_name: name })}`;

async function openCall(
  availability: () => { content: string; isError?: boolean } = () => ({
    content: JSON.stringify({ success: true, data: { slots: [SLOT, SLOT_8PM] } }),
  }),
) {
  const h = createHarness();
  const record = h.deps.executeTool!;
  h.deps.executeTool = async (name, toolInput, ctx) => {
    await record(name, toolInput, ctx);
    if (name === "check_calendar_availability") return availability();
    if (name === "book_appointment") {
      return {
        content: JSON.stringify({
          success: true,
          data: {
            id: "booking-1",
            status: "CONFIRMED",
            startAt: toolInput["startIso"],
            endAt: toolInput["endIso"],
          },
          bookingOutcome: "confirmed",
        }),
      };
    }
    return { content: JSON.stringify({ success: true, data: {} }) };
  };
  // The runtime words a real calendar result with a second, narrow model
  // call (composeHonestBookingReply) given only the facts; answer that one
  // faithfully, and every main conversational call with the scripted reply.
  const conversational = h.deps.generateReply;
  h.deps.generateReply = async (messages) => {
    if (/a phone receptionist\. Respond in language code/.test(messages[0]?.content ?? "")) {
      const facts = messages.at(-1)?.content ?? "";
      return {
        reply: /\bIS available\b/.test(facts)
          ? `Good news — ${/\(20:00 /.test(facts) ? "8 PM" : "7 PM"} is available. Would you like me to book it?`
          : "I'm sorry, I couldn't check the calendar just now.",
      };
    }
    return conversational(messages);
  };
  const callId = `name-stall-${crypto.randomUUID()}`;
  await startRuntimeSession(input(callId, h), h.deps);
  let emitted = 0;
  const turn = async (said: string, reply: string) => {
    while (emitted < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      emitted++;
    }
    h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance(said);
    await drain();
    return h.tts.sentTexts.slice(before).join(" ");
  };
  const calls = (name: string) => h.tools.calls.filter((c) => c.name === name);
  return { h, callId, turn, calls };
}

/** The production call up to (and including) the caller giving the name. */
async function upToName(t: Awaited<ReturnType<typeof openCall>>["turn"]) {
  const quote = await t(
    "I'd like root canal treatment today at 7:00 PM",
    `Root canal treatment costs ₹5,000. May I use the phone number you're calling from?\n${marker(KNOWN)}`,
  );
  const askName = await t(
    "Yeah, use the phone number which I'm calling from.",
    `Thank you. May I have your name please?\n${marker(KNOWN)}`,
  );
  const afterName = await t("I am Dhanush.", STALL_REPLY());
  return { quote, askName, afterName };
}

describe("production call: name given, agent stuck asking to confirm it", () => {
  test("'I am Dhanush' saves the name and goes straight to the real availability check", async () => {
    const { callId, turn, calls } = await openCall();
    const { askName, afterName } = await upToName(turn);
    assert.match(askName, /your name/i, askName);
    assert.equal(calls("check_calendar_availability").length, 1, "availability was checked");
    assert.doesNotMatch(afterName, NAME_QUESTION, `asked to confirm the name: ${afterName}`);
    assert.doesNotMatch(afterName, /can you hear me/i, afterName);
    assert.match(afterName, /Thanks, Dhanush/, afterName);
    assert.match(afterName, /available/i, "reports the real availability result");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("the exact production sequence — 'Guys', repeated names and 'Hello's — never regresses the booking", async () => {
    const { callId, turn, calls } = await openCall();
    await upToName(turn);
    const checksAfterName = calls("check_calendar_availability").length;
    assert.equal(checksAfterName, 1);

    const said: string[] = [];
    for (const utterance of [
      "Guys",
      "I am Dhanush",
      "My name is Dhanush",
      "Hello",
      "Hello?",
      "Hello, hello",
    ]) {
      said.push(await turn(utterance, STALL_REPLY()));
    }
    for (const reply of said) {
      assert.doesNotMatch(reply, NAME_QUESTION, `asked for or to confirm the name again: ${reply}`);
      assert.doesNotMatch(reply, GREETING, `restarted the greeting: ${reply}`);
      assert.doesNotMatch(reply, /\b(booked|confirmed|all set)\b/i, `claimed a booking: ${reply}`);
    }
    // "Hello": a brief "I can hear you", then the step the call is on.
    for (const reply of said.slice(3)) {
      assert.match(reply, /I can hear you/i, reply);
      assert.match(reply, /book/i, `continues the pending step: ${reply}`);
    }
    assert.equal(
      calls("check_calendar_availability").length,
      checksAfterName,
      "repeated turns never re-run (or lose) the completed availability check",
    );
    assert.equal(calls("book_appointment").length, 0, "nothing booked without a yes");

    // The collected details survived every turn: one "yes" books exactly them.
    await turn("Yes, please book it", `Booking.\n${marker({ ...KNOWN, ready_to_book: true })}`);
    assert.equal(calls("book_appointment").length, 1);
    const booked = calls("book_appointment")[0]!.input;
    assert.equal(booked["customerName"], "Dhanush", "the name was saved once and kept");
    assert.equal(booked["customerPhone"], CALLER_ID, "caller-ID consent kept");
    assert.equal(booked["serviceId"], "svc-root-canal", "treatment kept");
    assert.equal(booked["startIso"], SLOT.start, "date and time kept");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a model state block that blanks or drops the name never un-saves it", async () => {
    const { callId, turn, calls } = await openCall();
    await turn(
      "I'd like root canal treatment today at 7:00 PM",
      `Root canal treatment costs ₹5,000. May I use the phone number you're calling from?\n${marker(KNOWN)}`,
    );
    await turn(
      "Yeah, use the phone number which I'm calling from.",
      `Thank you. May I have your name please?\n${marker(KNOWN)}`,
    );
    const afterName = await turn("I am Dhanush.", STALL_REPLY(""));
    assert.equal(calls("check_calendar_availability").length, 1);
    assert.doesNotMatch(afterName, NAME_QUESTION, afterName);
    await turn("Hello", STALL_REPLY(null));
    await turn("Yes, book it", `Booking.\n${marker({ ...KNOWN, ready_to_book: true })}`);
    assert.equal(calls("book_appointment")[0]?.input["customerName"], "Dhanush");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a redelivered final transcript (duplicate event) is processed once", async () => {
    const { h, callId, turn, calls } = await openCall();
    await turn(
      "I'd like root canal treatment today at 7:00 PM",
      `Root canal treatment costs ₹5,000. May I use the phone number you're calling from?\n${marker(KNOWN)}`,
    );
    await turn(
      "Yeah, use the phone number which I'm calling from.",
      `Thank you. May I have your name please?\n${marker(KNOWN)}`,
    );
    h.llm.setNextReply(STALL_REPLY());
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "partial_transcript", text: "I am" });
    h.stt.emit({ type: "partial_transcript", text: "I am Dhan" });
    h.stt.emit({ type: "final_transcript", text: "I am Dhanush.", language: "en-IN" });
    h.stt.emit({ type: "final_transcript", text: "I am Dhanush.", language: "en-IN" });
    await drain(600);
    assert.equal(calls("check_calendar_availability").length, 1, "checked once, not twice");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("two different finals arriving back to back are handled in order, without losing the name", async () => {
    const { h, callId, turn, calls } = await openCall();
    await turn(
      "I'd like root canal treatment today at 7:00 PM",
      `Root canal treatment costs ₹5,000. May I use the phone number you're calling from?\n${marker(KNOWN)}`,
    );
    await turn(
      "Yeah, use the phone number which I'm calling from.",
      `Thank you. May I have your name please?\n${marker(KNOWN)}`,
    );
    const before = h.tts.sentTexts.length;
    h.llm.setNextReply(STALL_REPLY());
    h.stt.speakUtterance("I am Dhanush.");
    h.stt.speakUtterance("Hello?");
    await drain(900);
    assert.equal(calls("check_calendar_availability").length, 1);
    const spoken = h.tts.sentTexts.slice(before).join(" ");
    assert.doesNotMatch(spoken, NAME_QUESTION, spoken);
    await turn("Yes, book it", `Booking.\n${marker({ ...KNOWN, ready_to_book: true })}`);
    assert.equal(calls("book_appointment")[0]?.input["customerName"], "Dhanush");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("availability is never claimed when the calendar check fails", async () => {
    const { callId, turn, calls } = await openCall(() => ({
      content: JSON.stringify({
        success: false,
        error: { code: "CALENDAR_TIMEOUT", message: "x" },
      }),
      isError: true,
    }));
    const { afterName } = await upToName(turn);
    assert.equal(calls("check_calendar_availability").length, 1);
    assert.match(afterName, /couldn't check the calendar/i, afterName);
    assert.doesNotMatch(
      afterName,
      /good news|(?<!whether [^.]*)\bis available\b|\bbooked\b|\bconfirmed\b|book it\?/i,
      afterName,
    );
    assert.equal(calls("book_appointment").length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("the automatic availability check never books on its own", () => {
  test("details complete → availability checked, nothing booked; only the caller's own 'yes' books", async () => {
    const { callId, turn, calls } = await openCall();
    await upToName(turn);
    assert.equal(calls("check_calendar_availability").length, 1);
    assert.equal(calls("book_appointment").length, 0, "the automatic check booked nothing");

    // Turns that confirm nothing — even with a model state block that
    // claims ready_to_book — never book: they're answered without the model.
    const eager = `Booking now.\n${marker({ ...KNOWN, customer_name: "Dhanush", ready_to_book: true })}`;
    for (const said of ["Hello?", "Can you hear me?", "I am Dhanush", "My name is Dhanush"]) {
      await turn(said, eager);
    }
    assert.equal(calls("book_appointment").length, 0, "no booking without the caller's yes");

    await turn("Yes, please book it", `Booking.\n${marker({ ...KNOWN, ready_to_book: true })}`);
    assert.equal(calls("book_appointment").length, 1);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a 'no' to 'would you like me to book it?' books nothing", async () => {
    const { callId, turn, calls } = await openCall();
    await upToName(turn);
    await turn(
      "No, not yet",
      `Okay, no problem.\n${marker({ ...KNOWN, customer_name: "Dhanush" })}`,
    );
    assert.equal(calls("book_appointment").length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("changing the requested time after the details are collected", () => {
  test("the new slot is checked exactly once, and only the new slot is booked", async () => {
    const { callId, turn, calls } = await openCall();
    await upToName(turn);
    assert.equal(calls("check_calendar_availability").length, 1, "7 PM checked once");

    // The model's state block still says 7 PM — the caller's own words win.
    const changed = await turn(
      "Actually, can we make it 8 PM instead?",
      `Sure.\n${marker({ ...KNOWN, customer_name: "Dhanush" })}`,
    );
    assert.equal(calls("check_calendar_availability").length, 2, "8 PM checked once");
    assert.match(changed, /8 PM/, changed);
    assert.doesNotMatch(changed, /\b7 PM is available\b/, changed);
    assert.equal(calls("book_appointment").length, 0, "changing the time books nothing");

    // Nothing re-checks the 8 PM slot on turns that change nothing.
    for (const said of ["Hello?", "I am Dhanush", "Can you hear me?"]) {
      await turn(
        said,
        `Okay.\n${marker({ ...KNOWN, preferred_time: "20:00", customer_name: "Dhanush" })}`,
      );
    }
    assert.equal(calls("check_calendar_availability").length, 2, "no repeat checks");

    await turn(
      "Yes, book 8 PM",
      `Booking.\n${marker({ ...KNOWN, preferred_time: "20:00", ready_to_book: true })}`,
    );
    const bookings = calls("book_appointment");
    assert.equal(bookings.length, 1, "exactly one booking");
    assert.equal(bookings[0]!.input["startIso"], SLOT_8PM.start, "booked the new slot");
    assert.equal(bookings[0]!.input["endIso"], SLOT_8PM.end);
    assert.notEqual(bookings[0]!.input["startIso"], SLOT.start, "never the old slot");
    // The booking step re-reads the calendar right before booking (its own
    // last-moment conflict check) — the one extra read on the "yes" turn.
    assert.equal(calls("check_calendar_availability").length, 3);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a change the model resolves (no clock time spoken) is checked once, then booked at the new time", async () => {
    const { callId, turn, calls } = await openCall();
    await upToName(turn);
    await turn(
      "Can we push it an hour later?",
      `Sure, 8 PM then.\n${marker({ ...KNOWN, preferred_time: "20:00", customer_name: "Dhanush" })}`,
    );
    assert.equal(calls("check_calendar_availability").length, 2, "8 PM checked once");
    assert.equal(calls("book_appointment").length, 0);
    await turn("Hello?", `Okay.\n${marker({ ...KNOWN, preferred_time: "20:00" })}`);
    assert.equal(calls("check_calendar_availability").length, 2);
    await turn(
      "Yes, book it",
      `Booking.\n${marker({ ...KNOWN, preferred_time: "20:00", ready_to_book: true })}`,
    );
    assert.equal(calls("book_appointment").length, 1);
    assert.equal(calls("book_appointment")[0]!.input["startIso"], SLOT_8PM.start);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("7 PM → 8 PM → back to 7 PM: each change is checked once, and 'yes' books the latest choice only", async () => {
    const { callId, turn, calls } = await openCall();
    await upToName(turn);
    await turn("Make it 8 PM", `Sure.\n${marker({ ...KNOWN, customer_name: "Dhanush" })}`);
    assert.equal(calls("check_calendar_availability").length, 2);
    const back = await turn(
      "Sorry, 7 PM is better after all",
      `Sure.\n${marker({ ...KNOWN, preferred_time: "20:00", customer_name: "Dhanush" })}`,
    );
    assert.equal(calls("check_calendar_availability").length, 3, "7 PM checked again, once");
    assert.match(back, /7 PM/, back);
    await turn("Hello?", `Okay.\n${marker(KNOWN)}`);
    assert.equal(calls("check_calendar_availability").length, 3);
    assert.equal(calls("book_appointment").length, 0);
    await turn("Yes, book it", `Booking.\n${marker({ ...KNOWN, ready_to_book: true })}`);
    assert.equal(calls("book_appointment").length, 1);
    assert.equal(
      calls("book_appointment")[0]!.input["startIso"],
      SLOT.start,
      "booked 7 PM, not 8 PM",
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("helpers", () => {
  test("extractCallerName: 'I am Dhanush' after a name question; interjections are never names", () => {
    assert.equal(extractCallerName("I am Dhanush.", true), "Dhanush");
    assert.equal(extractCallerName("My name is Dhanush", false), "Dhanush");
    for (const notName of ["Guys", "Hello", "Hello?", "Sir", "Listen", "Can you hear me"]) {
      assert.equal(extractCallerName(notName, true), null, notName);
    }
  });

  test("isPresenceCheck: only a bare 'are you there' turn, never one carrying content", () => {
    for (const t of [
      "Hello",
      "Hello?",
      "Hello, hello",
      "hello hello hello",
      "Can you hear me?",
      "Are you there?",
      "Guys",
      "Hi",
      "Hey, hello?",
    ]) {
      assert.equal(isPresenceCheck(t), true, t);
    }
    for (const t of [
      "Hello, I'm Dhanush",
      "Hi, I want to book",
      "Hello, 7 PM",
      "yes",
      "I am Dhanush",
    ]) {
      assert.equal(isPresenceCheck(t), false, t);
    }
  });
});
