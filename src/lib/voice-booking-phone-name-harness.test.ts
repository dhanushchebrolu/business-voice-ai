import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  startRuntimeSession,
  terminateRuntimeSession,
  CALLER_ID_QUESTION,
  emptyAppointmentState,
  extractCallerName,
  guardPhoneRequests,
  parseApptStateMarker,
  resolveCallerIdAnswer,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ServiceRow } from "./service-matching.ts";

/**
 * Production call dfcf72ca-af1f-42fc-ba6d-414f3e6ea3b6 (Worker 53fe2359):
 * Root Canal Treatment was recognised, but
 *  1. the caller agreed to use the number they were calling from and was
 *     still asked for a number — then "use the number I'm calling from" was
 *     refused;
 *  2. the caller gave their name (more than once), confirmed the details
 *     the agent read back, and was asked for their name again.
 *
 * The model's replies below misbehave the way the production model did: it
 * words the caller-ID question its own way, asks for a number it already
 * has, and leaves the name out of (or blank in) its state block. The
 * runtime must hold the caller's answers regardless.
 *
 * Drives the REAL voice runtime through the deterministic harness; the
 * booking tool is an in-memory stand-in. No network, database or calendar.
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
  greetings: { "en-IN": "Hello, thanks for calling Smile Dental." },
  transfer_number: null,
  after_hours_behavior: "take_message",
};

const SERVICES: ServiceRow[] = [
  { id: "svc-teeth-cleaning", name: "Teeth Cleaning", duration_minutes: 30 },
  { id: "svc-root-canal", name: "Root Canal Treatment", duration_minutes: 90 },
];

const CALLER_ID = "+919876543210";
const DATE = "2030-10-14";
const SLOT = { start: `${DATE}T16:00:00.000Z`, end: `${DATE}T17:30:00.000Z` };
const NAME_QUESTION =
  /\b(may i have|what(?:'s| is)|could i (?:get|have)|can i (?:get|have))\b[^.?!]*\byour (?:full )?name\b/i;
// Any request for a number, question or imperative ("Please tell me your
// phone number."), and any refusal to use the calling number.
const PHONE_QUESTION =
  /\b(?:your|a) (?:phone|mobile|contact)(?: number)?\b[^.!]*\?|\b(?:tell|give|share|provide|say)\b[^.?!]*\b(?:phone|mobile|contact)? ?number\b|\bwhat(?:'s| is) your number\b|\b(?:can'?t|cannot|unable to)\b[^.?!]*\bnumber\b/i;

function input(callId: string, h: Harness, callerNumber: string | null): StartRuntimeSessionInput {
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
    callerNumber,
    services: SERVICES,
  };
}

async function drain(hops = 200) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

/** The model's state block. Only the fields given are set; the rest are null/false. */
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
const WHEN = { preferred_date: DATE, preferred_time: "16:00" };

function installStore(h: Harness) {
  const original = h.deps.executeTool!;
  h.deps.executeTool = async (name, toolInput, ctx) => {
    await original(name, toolInput, ctx);
    if (name === "check_calendar_availability") {
      return { content: JSON.stringify({ success: true, data: { slots: [SLOT] } }) };
    }
    if (name === "book_appointment") {
      return {
        content: JSON.stringify({
          success: true,
          data: { id: "booking-1", status: "CONFIRMED", startAt: SLOT.start, endAt: SLOT.end },
          bookingOutcome: "confirmed",
        }),
      };
    }
    return { content: JSON.stringify({ success: true, data: {} }) };
  };
}

async function openCall(callerNumber: string | null = CALLER_ID) {
  const h = createHarness();
  installStore(h);
  const callId = `phone-name-${crypto.randomUUID()}`;
  await startRuntimeSession(input(callId, h, callerNumber), h.deps);
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
  const bookings = () => h.tools.calls.filter((c) => c.name === "book_appointment");
  return { h, callId, turn, bookings };
}

/** Appointment -> Root Canal Treatment -> 4 PM, ending on the model's own phone request. */
async function upToPhoneRequest(
  turn: Awaited<ReturnType<typeof openCall>>["turn"],
  phoneRequest: string,
) {
  await turn(
    "Hi, I'd like to book an appointment",
    `Sure. Which service would you like?\n${marker({})}`,
  );
  const service = await turn(
    "Root canal treatment",
    `Root Canal Treatment, noted. When would you like to come in?\n${marker({})}`,
  );
  assert.doesNotMatch(service, /which service/i, "the service was recognised");
  return turn("Today at 4 PM", `${phoneRequest}\n${marker(WHEN)}`);
}

describe("call dfcf72ca: consent to the caller's number, name, confirmation, booking", () => {
  test("the exact production conversation books once, never re-asking for the number or the name", async () => {
    const { callId, turn, bookings } = await openCall();
    const offer = await upToPhoneRequest(turn, "Great. Can I have your phone number please?");
    assert.ok(offer.includes(CALLER_ID_QUESTION), offer);

    // 1. Agrees to the caller-ID number; the model still asks for a number.
    const afterYes = await turn(
      "Yes, you can use it",
      `Thank you. Could you please tell me your phone number?\n${marker(WHEN)}`,
    );
    assert.doesNotMatch(afterYes, PHONE_QUESTION, `asked for the number again: ${afterYes}`);

    // 1b. Says to use the calling number anyway: never refused.
    const useIt = await turn(
      "Just use the number I'm calling from",
      `I'm sorry, I can't see your number. Please tell me your phone number.\n${marker(WHEN)}`,
    );
    assert.doesNotMatch(useIt, PHONE_QUESTION, `refused the calling number: ${useIt}`);

    // 2. Gives the name once; the model's state block leaves it blank.
    await turn(
      "My name is Dhanush",
      `Thanks Dhanush. That's Root Canal Treatment today at 4 PM. Shall I book it?\n${marker({ ...WHEN, customer_name: "" })}`,
    );

    // Confirms; the model's state block omits the name entirely.
    const confirmed = await turn(
      "Yes, that's correct, please book it",
      `Booking it now.\n${marker({ ...WHEN, ready_to_book: true })}`,
    );
    assert.doesNotMatch(confirmed, NAME_QUESTION, `asked for the name again: ${confirmed}`);

    assert.equal(bookings().length, 1, "booked exactly once");
    const booked = bookings()[0]!.input;
    assert.equal(booked["serviceId"], "svc-root-canal");
    assert.equal(booked["customerPhone"], CALLER_ID);
    assert.equal(booked["customerName"], "Dhanush");
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("caller-ID consent", () => {
  test('the model\'s own wording of the caller-ID question still makes "yes" select that number', async () => {
    const { callId, turn, bookings } = await openCall();
    await upToPhoneRequest(turn, "Shall I use the number you are calling on for this booking?");
    const afterYes = await turn("Yes", `Okay. And your name please?\n${marker(WHEN)}`);
    assert.doesNotMatch(afterYes, PHONE_QUESTION, afterYes);
    await turn("Dhanush", `Thanks.\n${marker(WHEN)}`);
    await turn("Yes, book it", `Booking.\n${marker({ ...WHEN, ready_to_book: true })}`);
    assert.equal(bookings().length, 1);
    assert.equal(bookings()[0]!.input["customerPhone"], CALLER_ID);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test('"use the number I\'m calling from" selects caller ID even before it was offered', async () => {
    const { callId, turn, bookings } = await openCall();
    await turn("I'd like to book a root canal today at 4 PM", `Sure.\n${marker(WHEN)}`);
    const reply = await turn(
      "My name is Dhanush, and use the number I'm calling from",
      `Thanks.\n${marker(WHEN)}`,
    );
    assert.doesNotMatch(reply, PHONE_QUESTION, reply);
    await turn("Yes, book it", `Booking.\n${marker({ ...WHEN, ready_to_book: true })}`);
    assert.equal(bookings().length, 1);
    assert.equal(bookings()[0]!.input["customerPhone"], CALLER_ID);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test('a plain "yes" with no caller-ID question pending never selects a number', async () => {
    const { callId, turn, bookings } = await openCall();
    await turn(
      "I'd like a root canal today at 4 PM",
      `Sure, may I have your name?\n${marker(WHEN)}`,
    );
    await turn("Dhanush", `Thanks Dhanush. Shall I check that time?\n${marker(WHEN)}`);
    await turn("Yes", `Checking.\n${marker(WHEN)}`);
    assert.equal(bookings().length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("with no caller ID, the agent never offers the calling number — it asks for one", async () => {
    const { callId, turn } = await openCall(null);
    const reply = await upToPhoneRequest(
      turn,
      "Can I use the number you're calling from for the booking?",
    );
    assert.doesNotMatch(reply, /calling from|calling on/i, reply);
    assert.match(reply, /phone number/i, reply);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("the caller's name", () => {
  test("a bare answer to the name question is kept when the model's state block omits it", async () => {
    const { callId, turn, bookings } = await openCall();
    await upToPhoneRequest(turn, "Can I have your phone number please?");
    await turn("Yes", `Thank you. May I have your name please?\n${marker(WHEN)}`);
    await turn("Dhanush", `Thanks. Shall I book it?\n${marker(WHEN)}`);
    const confirmed = await turn(
      "Yes please book it",
      `Booking.\n${marker({ ...WHEN, ready_to_book: true })}`,
    );
    assert.doesNotMatch(confirmed, NAME_QUESTION, confirmed);
    assert.equal(bookings().length, 1);
    assert.equal(bookings()[0]!.input["customerName"], "Dhanush");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a blank name in the model's state block never erases a name already given", async () => {
    const { callId, turn, bookings } = await openCall();
    await upToPhoneRequest(turn, "Can I have your phone number please?");
    await turn("Yes", `Thanks. Your name?\n${marker({ ...WHEN, customer_name: "Dhanush" })}`);
    await turn("That's right", `Okay.\n${marker({ ...WHEN, customer_name: " " })}`);
    await turn(
      "Yes, book it",
      `Booking.\n${marker({ ...WHEN, customer_name: "", ready_to_book: true })}`,
    );
    assert.equal(bookings().length, 1);
    assert.equal(bookings()[0]!.input["customerName"], "Dhanush");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("words that aren't a name are never stored as one", async () => {
    const { callId, turn, bookings } = await openCall();
    await upToPhoneRequest(turn, "Can I have your phone number please?");
    await turn("Yes", `Thanks. May I have your name?\n${marker(WHEN)}`);
    const reply = await turn(
      "Yes please book it",
      `Booking.\n${marker({ ...WHEN, ready_to_book: true })}`,
    );
    assert.equal(bookings().length, 0, "no booking without a real name");
    assert.match(reply, /your name/i, reply);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("unit: extractCallerName", () => {
  test("explicit forms are always taken", () => {
    assert.equal(extractCallerName("My name is Dhanush", false), "Dhanush");
    assert.equal(
      extractCallerName("my name is dhanush chebrolu and book it", false),
      "Dhanush Chebrolu",
    );
    assert.equal(
      extractCallerName("My name is Dhanush, use the number I'm calling from", false),
      "Dhanush",
    );
    assert.equal(extractCallerName("call me Priya please", false), "Priya");
  });
  test("short answers count only right after the name question", () => {
    assert.equal(extractCallerName("Dhanush", true), "Dhanush");
    assert.equal(extractCallerName("It's Dhanush.", true), "Dhanush");
    assert.equal(extractCallerName("This is Ravi Kumar", true), "Ravi Kumar");
    assert.equal(extractCallerName("Dhanush", false), null);
    assert.equal(extractCallerName("I'm Dhanush", false), null);
  });
  test("never a name", () => {
    for (const said of [
      "Yes",
      "Yes please book it",
      "Okay",
      "Today at 4 PM",
      "Root canal",
      "I'm calling about my teeth",
      "Use the number I'm calling from",
      "9876543210",
    ]) {
      assert.equal(extractCallerName(said, true), null, said);
    }
  });
});

describe("unit: caller-ID consent and phone-request guard", () => {
  const notOffered = { phone: null, callerIdChoice: "not_offered" as const };
  test("an explicit reference to the calling number selects caller ID in any state", () => {
    for (const choice of ["not_offered", "offered", "clarifying", "declined"] as const) {
      const r = resolveCallerIdAnswer(
        "Just use the number I'm calling from",
        { phone: null, callerIdChoice: choice },
        CALLER_ID,
      );
      assert.equal(r?.phone, CALLER_ID, choice);
      assert.equal(r?.callerIdChoice, "accepted", choice);
    }
  });
  test("negated, hedged or unanswered references never select it", () => {
    assert.equal(
      resolveCallerIdAnswer("Don't use the number I'm calling from", notOffered, CALLER_ID)
        ?.phone ?? null,
      null,
    );
    assert.equal(resolveCallerIdAnswer("Yes", notOffered, CALLER_ID), null);
    assert.equal(resolveCallerIdAnswer("use the number I'm calling from", notOffered, null), null);
  });
  test("with the number settled, requests for it and refusals are removed", () => {
    const state = {
      ...emptyAppointmentState(),
      phone: CALLER_ID,
      phoneSource: "caller_id" as const,
      callerIdChoice: "accepted" as const,
    };
    const g = guardPhoneRequests("Thank you. Could you please tell me your phone number?", state);
    assert.equal(g.reply, "Thank you.");
    const r = guardPhoneRequests(
      "I'm sorry, I can't see your number. Please tell me your phone number.",
      state,
    );
    assert.doesNotMatch(r.reply, /number/i, r.reply);
    const keep = guardPhoneRequests("Great, see you at 4 PM.", state);
    assert.equal(keep.changed, false);
  });
  test("with no caller ID, an offer of the calling number becomes a plain request", () => {
    const g = guardPhoneRequests(
      "Can I use the number you're calling from?",
      emptyAppointmentState(),
    );
    assert.equal(g.reply, "What's the best phone number to reach you?");
  });
});

describe("unit: the model's state block", () => {
  test("blank strings are treated as not stated", () => {
    const { state } = parseApptStateMarker(
      `Ok <<<APPT_STATE:{"service":"","customer_name":"  ","phone":"","preferred_date":"","preferred_time":""}>>>`,
    );
    assert.deepEqual(state, {});
  });
});
