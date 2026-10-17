import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  startRuntimeSession,
  terminateRuntimeSession,
  callerAuthorizesBooking,
  type RuntimeDeps,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ServiceRow } from "./service-matching.ts";
import type { ClaudeTool } from "./claude.server.ts";

/**
 * The runtime — not the model — decides when a booking may be created: only
 * the caller's own clear "yes" to the agent's booking question (or an
 * explicit "book it"), for the slot that was asked about. The model marking
 * the booking "ready to book", or calling book_appointment itself, never
 * books on its own.
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
  { id: "svc-root-canal", name: "Root Canal Treatment", duration_minutes: 30 },
];
const CALLER_ID = "+919876543210";
const DATE = "2030-10-14";
const SLOT_7PM = { start: `${DATE}T19:00:00.000Z`, end: `${DATE}T19:30:00.000Z` };
const SLOT_8PM = { start: `${DATE}T20:00:00.000Z`, end: `${DATE}T20:30:00.000Z` };
const KNOWN = {
  service: "Root Canal Treatment",
  customer_name: "Dhanush",
  preferred_date: DATE,
  preferred_time: "19:00",
};

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
/** The model claiming it is booking, with its state block saying "ready to book". */
const EAGER = (state: Record<string, unknown> = {}) =>
  `Great, booking that for you now!\n${marker({ ...KNOWN, ready_to_book: true, ...state })}`;

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

function installCalendar(h: Harness) {
  const record = h.deps.executeTool!;
  h.deps.executeTool = async (name, toolInput, ctx) => {
    await record(name, toolInput, ctx);
    if (name === "check_calendar_availability") {
      return { content: JSON.stringify({ success: true, data: { slots: [SLOT_7PM, SLOT_8PM] } }) };
    }
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
  // A real calendar result is worded by a narrow model call given only the
  // facts; answer that one faithfully, every other call with the script.
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
}

async function openCall(extraDeps: Partial<RuntimeDeps> = {}) {
  const h = createHarness();
  installCalendar(h);
  Object.assign(h.deps, extraDeps);
  const callId = `confirm-gate-${crypto.randomUUID()}`;
  await startRuntimeSession(input(callId, h), h.deps);
  let emitted = 0;
  const flush = () => {
    while (emitted < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      emitted++;
    }
  };
  const turn = async (said: string, reply: string) => {
    flush();
    h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance(said);
    await drain();
    return h.tts.sentTexts.slice(before).join(" ");
  };
  const bookings = () => h.tools.calls.filter((c) => c.name === "book_appointment");
  const checks = () => h.tools.calls.filter((c) => c.name === "check_calendar_availability");
  return { h, callId, turn, flush, bookings, checks };
}

/** Root canal, 7 PM, caller-ID consent, name — the runtime checks 7 PM and asks to book it. */
async function upToBookingQuestion(t: Awaited<ReturnType<typeof openCall>>["turn"]) {
  await t(
    "Root canal treatment today at 7 PM",
    `Sure. May I use the number you're calling from?\n${marker({ ...KNOWN, customer_name: null })}`,
  );
  await t(
    "Yes, use the number I'm calling from",
    `Thanks. May I have your name?\n${marker({ ...KNOWN, customer_name: null })}`,
  );
  const asked = await t("I am Dhanush", `Thanks Dhanush.\n${marker(KNOWN)}`);
  assert.match(asked, /would you like me to book it\?/i, asked);
  return asked;
}

describe("1. the automatic availability check never books", () => {
  test("details complete → the slot is checked and the caller asked; nothing booked", async () => {
    const { callId, turn, bookings, checks } = await openCall();
    await upToBookingQuestion(turn);
    assert.equal(checks().length, 1);
    assert.equal(bookings().length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("2. the model's 'ready to book' alone never books", () => {
  test("an unrelated question with the model's state saying ready_to_book: nothing booked, its 'booking now' never spoken", async () => {
    const { callId, turn, bookings } = await openCall();
    await upToBookingQuestion(turn);
    const reply = await turn("How much does it cost?", EAGER());
    assert.equal(bookings().length, 0);
    assert.doesNotMatch(reply, /booking that for you now/i, reply);
    assert.match(reply, /Shall I book it\?/, `asks the caller to confirm instead: ${reply}`);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("the model's ready_to_book on the very turn the details first appear: checked and asked, never booked", async () => {
    const { callId, turn, bookings } = await openCall();
    await turn("Root canal today at 7 PM, I'm Dhanush, use this number", EAGER());
    assert.equal(bookings().length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("native tool-calling: the model calling book_appointment without the caller's yes is refused and nothing executes", async () => {
    const tools: ClaudeTool[] = [
      { name: "book_appointment", description: "d", input_schema: { type: "object" } },
    ];
    const toolResults: string[] = [];
    let executed = 0;
    const { callId, h } = await openCall({
      resolveAvailableTools: async () => tools,
      generateReplyWithTools: async (_messages, _tools, execute) => {
        const result = await execute("book_appointment", {
          startIso: SLOT_7PM.start,
          endIso: SLOT_7PM.end,
          customerName: "Dhanush",
        });
        toolResults.push(result.content);
        return {
          reply: "I've booked it.",
          toolCalls: [{ name: "book_appointment", input: {}, isError: Boolean(result.isError) }],
        };
      },
    });
    const realExecute = h.deps.executeTool!;
    h.deps.executeTool = async (...args) => {
      executed++;
      return realExecute(...args);
    };
    h.stt.speakUtterance("What are your opening hours?");
    await drain();
    assert.equal(executed, 0, "book_appointment never reached the booking layer");
    assert.match(toolResults[0] ?? "", /CALLER_CONFIRMATION_REQUIRED/);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("native tool-calling: after the caller's yes to the booking question, book_appointment runs", async () => {
    const tools: ClaudeTool[] = [
      { name: "book_appointment", description: "d", input_schema: { type: "object" } },
    ];
    let attempt = 0;
    const results: string[] = [];
    const { callId, h } = await openCall({
      resolveAvailableTools: async () => tools,
      generateReplyWithTools: async (_messages, _tools, execute) => {
        attempt++;
        if (attempt === 1) {
          return {
            reply: "Root canal at 7 PM today for Dhanush. Shall I book it?",
            toolCalls: [],
          };
        }
        const result = await execute("book_appointment", {
          startIso: SLOT_7PM.start,
          endIso: SLOT_7PM.end,
        });
        results.push(result.content);
        return {
          reply: "Booked.",
          toolCalls: [{ name: "book_appointment", input: {}, isError: Boolean(result.isError) }],
        };
      },
    });
    let emitted = 0;
    const flush = () => {
      while (emitted < h.tts.sentTexts.length) {
        h.tts.emit({ type: "flushed" });
        emitted++;
      }
    };
    flush();
    h.stt.speakUtterance("Root canal at 7 PM please");
    await drain();
    flush();
    h.stt.speakUtterance("Yes");
    await drain();
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 1);
    assert.doesNotMatch(results[0] ?? "", /CALLER_CONFIRMATION_REQUIRED/);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("3. a clear yes to the booking question books — with the details intact", () => {
  for (const yes of [
    "Yes",
    "Yes please",
    "Yeah, go ahead",
    "Sure",
    "Yes, that's correct",
    "Book it",
  ]) {
    test(`"${yes}" books the asked-about slot exactly once`, async () => {
      const { callId, turn, bookings } = await openCall();
      await upToBookingQuestion(turn);
      await turn(yes, EAGER());
      assert.equal(bookings().length, 1);
      const booked = bookings()[0]!.input;
      assert.equal(booked["startIso"], SLOT_7PM.start);
      assert.equal(booked["customerName"], "Dhanush");
      assert.equal(booked["customerPhone"], CALLER_ID);
      assert.equal(booked["serviceId"], "svc-root-canal");
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test("a yes after the read-back question books", async () => {
    const { callId, turn, bookings } = await openCall();
    await upToBookingQuestion(turn);
    const readback = await turn("How much does it cost?", EAGER());
    assert.match(
      readback,
      /Just to confirm — Root Canal Treatment .*7 PM for Dhanush\. Shall I book it\?/,
    );
    await turn("Yes", `Okay.\n${marker(KNOWN)}`);
    assert.equal(bookings().length, 1);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("4. nothing else counts as a confirmation", () => {
  const nonConfirmations = [
    "Hello",
    "Hello?",
    "Can you hear me?",
    "I am Dhanush",
    "My name is Dhanush",
    "Guys",
    "Hmm",
    "Uh",
    "Okay",
    "Alright",
    "What?",
    "Sorry, I didn't catch that",
    "How much does it cost?",
  ];
  for (const said of nonConfirmations) {
    test(`"${said}" after the booking question never books, even with the model saying ready_to_book`, async () => {
      const { callId, turn, bookings } = await openCall();
      await upToBookingQuestion(turn);
      await turn(said, EAGER());
      assert.equal(bookings().length, 0, said);
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test("a 'yes' to a question that isn't the booking question never books", async () => {
    const { callId, turn, bookings } = await openCall();
    await upToBookingQuestion(turn);
    await turn(
      "Do you offer payment plans?",
      `We do. Would you like to hear about them?\n${marker(KNOWN)}`,
    );
    await turn("Yes", EAGER());
    assert.equal(bookings().length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("silence after the booking question never books", async (t) => {
    t.mock.timers.enable();
    const { callId, turn, flush, bookings } = await openCall();
    await upToBookingQuestion(turn);
    flush();
    t.mock.timers.tick(12_000);
    await drain();
    flush();
    t.mock.timers.tick(10_000);
    await drain();
    assert.equal(bookings().length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("5. no, not yet, or a different time never books", () => {
  for (const said of [
    "No",
    "No thanks",
    "Not yet",
    "Wait",
    "Don't book it yet",
    "No, cancel that",
  ]) {
    test(`"${said}" books nothing`, async () => {
      const { callId, turn, bookings } = await openCall();
      await upToBookingQuestion(turn);
      await turn(said, EAGER());
      assert.equal(bookings().length, 0, said);
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test("'Yes, but make it 8 PM' checks 8 PM and asks again — never books either slot", async () => {
    const { callId, turn, bookings, checks } = await openCall();
    await upToBookingQuestion(turn);
    const reply = await turn("Yes, but make it 8 PM", EAGER({ preferred_time: "20:00" }));
    assert.equal(bookings().length, 0, "the changed slot hasn't been confirmed");
    assert.equal(checks().length, 2, "8 PM is checked");
    assert.match(reply, /8 PM is available\. Would you like me to book it\?/, reply);
    await turn("Yes", EAGER({ preferred_time: "20:00" }));
    assert.equal(bookings().length, 1);
    assert.equal(bookings()[0]!.input["startIso"], SLOT_8PM.start, "only the confirmed 8 PM slot");
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("callerAuthorizesBooking", () => {
  const ASKED = "Good news — 7 PM is available. Would you like me to book it?";
  test("a clear yes answers the booking question; an explicit 'book it' stands alone", () => {
    for (const yes of [
      "Yes",
      "yes please",
      "Yeah",
      "Sure",
      "Go ahead",
      "That's correct",
      "Sounds good",
    ]) {
      assert.equal(callerAuthorizesBooking(yes, ASKED), true, yes);
    }
    for (const explicit of ["Book it", "Please book", "Okay, book it", "Confirm the booking"]) {
      assert.equal(callerAuthorizesBooking(explicit, "Anything else?"), true, explicit);
    }
  });

  test("the booking questions it recognises", () => {
    for (const asked of [
      "Would you like me to book it?",
      "Shall I book that for you?",
      "Shall I go ahead and book it?",
      "Should I confirm it?",
      "Do you want me to book this?",
      "Just to confirm — root canal at 7 PM. Shall I book it?",
    ]) {
      assert.equal(callerAuthorizesBooking("Yes", asked), true, asked);
    }
  });

  test("never: a yes to another question, negations, presence checks, fillers", () => {
    assert.equal(callerAuthorizesBooking("Yes", "Would you like to hear our prices?"), false);
    assert.equal(
      callerAuthorizesBooking("Yes", "May I use the number you're calling from?"),
      false,
    );
    for (const said of [
      "No",
      "Not yet",
      "Yes, wait",
      "Don't book it",
      "No, cancel",
      "Hello?",
      "Okay",
      "Hmm",
      "I am Dhanush",
    ]) {
      assert.equal(callerAuthorizesBooking(said, ASKED), false, said);
    }
  });
});
