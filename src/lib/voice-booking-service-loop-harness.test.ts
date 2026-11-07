import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  startRuntimeSession,
  terminateRuntimeSession,
  CALLER_ID_QUESTION,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ServiceRow } from "./service-matching.ts";

/**
 * Regression coverage for the Smile Dental service loop: the caller asked
 * for a 4:00 PM appointment, agreed to use their caller ID, then said
 * "Clean my teeth", "to clean my teeth", "Teeth cleaning" and "I want to
 * book teeth cleaning" — and was asked "Which service would you like to
 * book?" every time, so nothing was ever booked.
 *
 * Root cause reproduced here: the model's state marker does not reliably
 * restate the service (these scripted replies deliberately leave it null,
 * as the model did), and the runtime only recognised a service named
 * verbatim, so the service stayed unknown and the deterministic
 * clarification asked the same question on every "book it" turn.
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

const SMILE_DENTAL_SERVICES: ServiceRow[] = [
  { id: "svc-teeth-cleaning", name: "Teeth Cleaning", duration_minutes: 30 },
  { id: "svc-whitening", name: "Teeth Whitening", duration_minutes: 60 },
  { id: "svc-root-canal", name: "Root Canal Treatment", duration_minutes: 90 },
];

const CALLER_ID = "+919876543210";
const DATE = "2030-10-14";
// The harness has no database, so the business timezone falls back to UTC.
const SLOT = { start: `${DATE}T16:00:00.000Z`, end: `${DATE}T16:30:00.000Z` };
const SERVICE_QUESTION = "Which service would you like to book?";

function input(callId: string, h: Harness, services: ServiceRow[]): StartRuntimeSessionInput {
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
    services,
  };
}

async function drain(hops = 120) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

function flushCatchUp(h: Harness) {
  let emitted = 0;
  return () => {
    while (emitted < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      emitted++;
    }
  };
}

/** The model's state block — the service deliberately left null unless given. */
function marker(state: Record<string, unknown>): string {
  return `<<<APPT_STATE:${JSON.stringify({
    service: null,
    customer_name: null,
    phone: null,
    email: null,
    preferred_date: DATE,
    preferred_time: "16:00",
    preferred_period: null,
    wants_next_available: false,
    checking_availability: false,
    ready_to_book: false,
    ...state,
  })}>>>`;
}

/** In-memory booking store: availability excludes booked slots; same key -> same booking. */
function installStore(h: Harness, outcomeStatus = "CONFIRMED") {
  const bookings = new Map<string, Record<string, unknown>>();
  const original = h.deps.executeTool!;
  h.deps.executeTool = async (name, toolInput, ctx) => {
    await original(name, toolInput, ctx); // recorded in h.tools.calls
    if (name === "check_calendar_availability") {
      const taken = [...bookings.values()].some((b) => b["startIso"] === SLOT.start);
      return { content: JSON.stringify({ success: true, data: { slots: taken ? [] : [SLOT] } }) };
    }
    if (name === "book_appointment") {
      const key = `${ctx.callId}:${toolInput["startIso"]}`;
      if (!bookings.has(key))
        bookings.set(key, { ...toolInput, id: `booking-${bookings.size + 1}` });
      const row = bookings.get(key)!;
      return {
        content: JSON.stringify({
          success: true,
          data: {
            id: row["id"],
            status: outcomeStatus,
            startAt: toolInput["startIso"],
            endAt: toolInput["endIso"],
          },
          bookingOutcome:
            outcomeStatus === "CONFIRMED" ? "confirmed" : "saved_calendar_sync_failed",
        }),
      };
    }
    return { content: JSON.stringify({ success: true, data: {} }) };
  };
  return bookings;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function turn(h: Harness, catchUp: () => void, said: string, reply: string, hops = 120) {
  catchUp();
  h.llm.setNextReply(reply);
  const before = h.tts.sentTexts.length;
  h.stt.speakUtterance(said);
  await drain(hops);
  return h.tts.sentTexts.slice(before).join(" ");
}

/**
 * Naming the service completes every detail, so the runtime first checks the
 * real calendar and reads the result back; the booking itself happens when
 * the caller then says to book it (unless they already said "book" in the
 * same breath). Returns everything spoken across both turns.
 */
async function bookIfNotYet(h: Harness, catchUp: () => void, spokenSoFar: string) {
  if (h.tools.calls.some((c) => c.name === "book_appointment")) return spokenSoFar;
  assert.ok(
    h.tools.calls.some((c) => c.name === "check_calendar_availability"),
    "the real calendar was checked once the service completed the details",
  );
  const confirm = await turn(
    h,
    catchUp,
    "Yes, please book it",
    `Booking now.\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
    200,
  );
  return `${spokenSoFar} ${confirm}`;
}

/** The incident's opening: 4 PM today, then "yes" to using the caller ID. */
async function openCall(services = SMILE_DENTAL_SERVICES, outcomeStatus?: string) {
  const h = createHarness();
  const bookings = installStore(h, outcomeStatus);
  const callId = `svc-loop-${crypto.randomUUID()}`;
  await startRuntimeSession(input(callId, h, services), h.deps);
  const catchUp = flushCatchUp(h);
  const first = await turn(
    h,
    catchUp,
    "I want to book an appointment at 4 PM today",
    `Sure, what's your phone number?\n${marker({})}`,
  );
  assert.match(first, new RegExp(CALLER_ID_QUESTION.replace(/[?]/g, "\\?")));
  const second = await turn(h, catchUp, "Yes", `Great. ${SERVICE_QUESTION}\n${marker({})}`);
  assert.match(second, /which service/i, "the first service question is fine");
  return { h, bookings, callId, catchUp };
}

describe("Smile Dental: the service is understood once, then the booking completes", () => {
  test('"Clean my teeth" is captured as Teeth Cleaning — never asked again — and booked with that service, the caller-ID number, the name and 4 PM', async () => {
    const { h, bookings, callId, catchUp } = await openCall();

    const afterService = await turn(
      h,
      catchUp,
      "Clean my teeth",
      `Got it. May I have your name?\n${marker({ phone: null })}`,
    );
    assert.equal(count(afterService, SERVICE_QUESTION), 0, afterService);

    const afterName = await turn(
      h,
      catchUp,
      "My name is Dhanush, please book it",
      `Booking now.\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
      200,
    );
    assert.equal(count(afterName, SERVICE_QUESTION), 0, afterName);

    const bookCalls = h.tools.calls.filter((c) => c.name === "book_appointment");
    assert.equal(bookCalls.length, 1, "booked exactly once");
    const args = bookCalls[0]!.input;
    assert.equal(args["serviceId"], "svc-teeth-cleaning", "the configured service id");
    assert.equal(args["notes"], "Teeth Cleaning");
    assert.equal(args["customerName"], "Dhanush");
    assert.equal(args["customerPhone"], CALLER_ID, "the approved caller-ID number, E.164");
    assert.equal(args["startIso"], SLOT.start);
    assert.equal(args["endIso"], SLOT.end, "the service's own 30-minute duration");
    assert.equal(bookings.size, 1);
    assert.match(afterName, /Teeth Cleaning/);
    assert.match(afterName, /confirmed/i);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  for (const phrase of [
    "Teeth cleaning",
    "I want to book teeth cleaning",
    "to clean my teeth",
    "dental cleaning",
    "cleaning my teeth",
    "general cleaning",
    "general clean",
  ]) {
    test(`"${phrase}" with everything else known books Teeth Cleaning instead of re-asking`, async () => {
      const { h, callId, catchUp } = await openCall();
      await turn(
        h,
        catchUp,
        "My name is Dhanush",
        `Thanks Dhanush. ${SERVICE_QUESTION}\n${marker({ customer_name: "Dhanush" })}`,
      );
      const spoken = await bookIfNotYet(
        h,
        catchUp,
        await turn(
          h,
          catchUp,
          phrase,
          `Booking that.\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
          200,
        ),
      );
      assert.equal(count(spoken, SERVICE_QUESTION), 0, spoken);
      assert.doesNotMatch(spoken, /APPT_STATE/, "the state block is never spoken");
      const bookCalls = h.tools.calls.filter((c) => c.name === "book_appointment");
      assert.equal(bookCalls.length, 1, `booked for "${phrase}"`);
      assert.equal(bookCalls[0]!.input["serviceId"], "svc-teeth-cleaning");
      assert.equal(bookCalls[0]!.input["customerPhone"], CALLER_ID);
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test("a service the model names in its own words is mapped to the configured row", async () => {
    const { h, callId, catchUp } = await openCall();
    await turn(
      h,
      catchUp,
      "the usual cleaning thing",
      `Booking.\n${marker({ service: "dental cleaning", customer_name: "Dhanush", ready_to_book: true })}`,
      200,
    );
    // The model's "ready to book" alone never books — the caller confirms.
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);
    await turn(
      h,
      catchUp,
      "Yes, book it",
      `Booking.\n${marker({ service: "dental cleaning", customer_name: "Dhanush", ready_to_book: true })}`,
      200,
    );
    const bookCalls = h.tools.calls.filter((c) => c.name === "book_appointment");
    assert.equal(bookCalls.length, 1);
    assert.equal(bookCalls[0]!.input["serviceId"], "svc-teeth-cleaning");
    assert.equal(bookCalls[0]!.input["notes"], "Teeth Cleaning");
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("honest outcomes", () => {
  test("a calendar sync failure is never announced as a confirmed booking", async () => {
    const { h, callId, catchUp } = await openCall(SMILE_DENTAL_SERVICES, "CALENDAR_SYNC_FAILED");
    const first = await turn(
      h,
      catchUp,
      "Teeth cleaning please, I'm Dhanush, book it",
      `You're all booked and confirmed!\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
      200,
    );
    // The details arrived on this turn: they're checked and confirmed with
    // the caller first — and the model's "all booked" is never spoken.
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);
    assert.doesNotMatch(first, /\bconfirmed\b|all booked|all set/i, first);
    const spoken = await turn(
      h,
      catchUp,
      "Yes, book it",
      `You're all booked and confirmed!\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
      200,
    );
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 1);
    assert.doesNotMatch(spoken, /\bconfirmed\b|all booked|all set/i, spoken);
    assert.match(spoken, /saved|team|confirm/i, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("a service that can't be identified never loops", () => {
  const NO_CLEANING: ServiceRow[] = [
    { id: "svc-root-canal", name: "Root Canal Treatment", duration_minutes: 90 },
    { id: "svc-whitening", name: "Teeth Whitening", duration_minutes: 60 },
  ];

  test("unsupported wording: ask once, then list the real services, then an honest next step (no callback promise) — and stop asking", async () => {
    const { h, callId, catchUp } = await openCall(NO_CLEANING);
    const replies: string[] = [];
    for (const said of [
      "Clean my teeth",
      "to clean my teeth",
      "Teeth cleaning",
      "I want to book teeth cleaning",
    ]) {
      replies.push(
        await turn(
          h,
          catchUp,
          said,
          `Okay, booking it.\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
        ),
      );
    }
    const all = replies.join(" | ");
    assert.ok(count(all, SERVICE_QUESTION) <= 1, `the same question at most once: ${all}`);
    assert.match(replies[1]!, /We offer Root Canal Treatment and Teeth Whitening/);
    assert.match(replies[2]!, /couldn't match that to one of our services/i);
    assert.match(replies[2]!, /call back during opening hours/i);
    assert.doesNotMatch(replies[2]!, /call you back/i, "no callback exists to promise");
    assert.doesNotMatch(replies[3]!, /which service|we offer/i, "no further service questions");
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a service the model names that the clinic doesn't offer is explained as unavailable", async () => {
    const { h, callId, catchUp } = await openCall(NO_CLEANING);
    const spoken = await turn(
      h,
      catchUp,
      "I'd like a massage",
      `Booking.\n${marker({ service: "massage", customer_name: "Dhanush", ready_to_book: true })}`,
    );
    assert.match(spoken, /we don't offer massage/i, spoken);
    assert.match(spoken, /Root Canal Treatment and Teeth Whitening/);
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("wording that fits two services equally asks which one, naming exactly those", async () => {
    const TWO_CLEANINGS: ServiceRow[] = [
      { id: "svc-basic", name: "Teeth Cleaning", duration_minutes: 30 },
      { id: "svc-deep", name: "Deep Cleaning", duration_minutes: 60 },
    ];
    const { h, callId, catchUp } = await openCall(TWO_CLEANINGS);
    const spoken = await turn(
      h,
      catchUp,
      "Just a cleaning",
      `Booking.\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
    );
    assert.match(
      spoken,
      /Did you mean (Teeth Cleaning or Deep Cleaning|Deep Cleaning or Teeth Cleaning)\?/,
    );
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);
    // The caller picks one; it books that one.
    const picked = await bookIfNotYet(
      h,
      catchUp,
      await turn(
        h,
        catchUp,
        "Deep cleaning",
        `Booking.\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
        200,
      ),
    );
    assert.doesNotMatch(picked, /did you mean/i);
    const bookCalls = h.tools.calls.filter((c) => c.name === "book_appointment");
    assert.equal(bookCalls.length, 1);
    assert.equal(bookCalls[0]!.input["serviceId"], "svc-deep");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("the patient's name is never invented: with no name, the agent asks for it instead of booking", async () => {
    const { h, callId, catchUp } = await openCall();
    const spoken = await turn(
      h,
      catchUp,
      "Teeth cleaning, book it",
      `Booking.\n${marker({ ready_to_book: true })}`,
    );
    assert.match(spoken, /your name/i, spoken);
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("Smile Dental 2026-10-16: time chosen, caller ID accepted, then the service", () => {
  /** Captures this file's runtime log lines (event name -> payloads) while `run` executes. */
  async function withRuntimeLogs<T>(run: () => Promise<T>) {
    const logs: { event: string; payload: Record<string, unknown> }[] = [];
    const original = console.info;
    console.info = (event: unknown, payload?: unknown) => {
      if (typeof event === "string" && event.startsWith("voice_runtime:")) {
        logs.push({ event, payload: (payload ?? {}) as Record<string, unknown> });
      }
    };
    try {
      return { result: await run(), logs };
    } finally {
      console.info = original;
    }
  }

  test('"yes" to the caller-ID question is not a booking confirmation', async () => {
    const h = createHarness();
    installStore(h);
    const callId = `svc-loop-${crypto.randomUUID()}`;
    await startRuntimeSession(input(callId, h, SMILE_DENTAL_SERVICES), h.deps);
    const catchUp = flushCatchUp(h);
    await turn(
      h,
      catchUp,
      "I want to book an appointment at 4 PM today",
      `Sure, what's your phone number?\n${marker({})}`,
    );
    const { result: spoken, logs } = await withRuntimeLogs(() =>
      turn(h, catchUp, "Yes", `Great. What's the reason for your visit?\n${marker({})}`),
    );
    // Before the fix this "yes" made the turn ready_to_book, and the model's
    // reply was overwritten with the deterministic service question.
    assert.match(spoken, /reason for your visit/, spoken);
    assert.equal(count(spoken, SERVICE_QUESTION), 0, spoken);
    assert.equal(
      logs.filter((l) => l.event === "voice_runtime:targeted_clarification").length,
      0,
      "no deterministic clarification replaced the model's reply",
    );
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);

    // The caller's own words for the service move the call forward.
    const afterService = await turn(
      h,
      catchUp,
      "general cleaning",
      `Got it. May I have your name?\n${marker({})}`,
      200,
    );
    assert.equal(count(afterService, SERVICE_QUESTION), 0, afterService);
    const booked = await bookIfNotYet(
      h,
      catchUp,
      await turn(
        h,
        catchUp,
        "My name is Dhanush, please book it",
        `Booking.\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
        200,
      ),
    );
    assert.equal(count(booked, SERVICE_QUESTION), 0, booked);
    const bookCalls = h.tools.calls.filter((c) => c.name === "book_appointment");
    assert.equal(bookCalls.length, 1);
    assert.equal(bookCalls[0]!.input["serviceId"], "svc-teeth-cleaning");
    assert.equal(bookCalls[0]!.input["customerPhone"], CALLER_ID);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("each turn logs what the model's state block held — enum values only", async () => {
    const NO_CLEANING: ServiceRow[] = [
      { id: "svc-root-canal", name: "Root Canal Treatment", duration_minutes: 90 },
    ];
    const { h, callId, catchUp } = await openCall(NO_CLEANING);
    const said = ["general clean", "general clean please", "a massage", "root canal"];
    const replies = [
      "Okay.", // no marker at all
      `Okay.\n<<<APPT_STATE:{"service": "Gen>>>`, // truncated JSON
      `Okay.\n${marker({ service: "massage" })}`, // not offered here
      `Okay.\n${marker({ service: "root canal" })}`, // configured
    ];
    const { logs } = await withRuntimeLogs(async () => {
      for (let i = 0; i < said.length; i++) await turn(h, catchUp, said[i]!, replies[i]!);
    });
    const markers = logs
      .filter((l) => l.event === "voice_runtime:appt_state_marker")
      .map((l) => ({ marker: l.payload["marker"], service: l.payload["service"] }));
    assert.deepEqual(markers, [
      { marker: "absent", service: "none" },
      { marker: "unparseable", service: "none" },
      { marker: "parsed", service: "unmatched" },
      { marker: "parsed", service: "accepted" },
    ]);
    const logged = JSON.stringify(
      logs.filter((l) => l.event === "voice_runtime:appt_state_marker"),
    );
    for (const secret of ["general", "massage", "root canal", "Root Canal", "Okay", CALLER_ID]) {
      assert.ok(!logged.includes(secret), `logged ${secret}`);
    }
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe('Smile Dental production: "Root canal" is understood and booked', () => {
  test('time chosen, caller ID accepted, then "Root canal" — booked once, never re-asked', async () => {
    const { h, callId, catchUp } = await openCall();
    const named = await turn(
      h,
      catchUp,
      "Root canal",
      `Got it. May I have your name?\n${marker({})}`,
      200,
    );
    assert.equal(count(named, SERVICE_QUESTION), 0, named);
    const spoken = await bookIfNotYet(
      h,
      catchUp,
      await turn(
        h,
        catchUp,
        "My name is Dhanush, please book it",
        `Booking.\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
        200,
      ),
    );
    assert.equal(count(spoken, SERVICE_QUESTION), 0, spoken);
    const bookCalls = h.tools.calls.filter((c) => c.name === "book_appointment");
    assert.equal(bookCalls.length, 1);
    assert.equal(bookCalls[0]!.input["serviceId"], "svc-root-canal");
    assert.equal(bookCalls[0]!.input["customerPhone"], CALLER_ID);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  for (const phrase of ["Root canal", "Root canal treatment", "Root kanal", "Route canal"]) {
    test(`"${phrase}" with everything else known books Root Canal Treatment`, async () => {
      const { h, callId, catchUp } = await openCall();
      const spoken = await bookIfNotYet(
        h,
        catchUp,
        await turn(
          h,
          catchUp,
          phrase,
          `Booking that.\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
          200,
        ),
      );
      assert.equal(count(spoken, SERVICE_QUESTION), 0, spoken);
      const bookCalls = h.tools.calls.filter((c) => c.name === "book_appointment");
      assert.equal(bookCalls.length, 1, `booked for "${phrase}"`);
      assert.equal(bookCalls[0]!.input["serviceId"], "svc-root-canal");
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test('"Root canal" at a clinic that doesn\'t offer it never loops: list, then an honest next step, then stop', async () => {
    const NO_RCT: ServiceRow[] = [
      { id: "svc-teeth-cleaning", name: "Teeth Cleaning", duration_minutes: 30 },
      { id: "svc-whitening", name: "Teeth Whitening", duration_minutes: 60 },
    ];
    const { h, callId, catchUp } = await openCall(NO_RCT);
    const replies: string[] = [];
    // Worded slightly differently each time: an identical transcript within
    // two seconds is dropped as a provider redelivery, and the harness
    // clock doesn't advance between turns.
    for (const said of [
      "Root canal",
      "Root canal please",
      "I said root canal",
      "root canal",
      "Root canal.",
    ]) {
      replies.push(
        await turn(
          h,
          catchUp,
          said,
          `Booking it.\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
        ),
      );
    }
    const all = replies.join(" | ");
    assert.ok(count(all, SERVICE_QUESTION) <= 1, `asked at most once more: ${all}`);
    assert.ok(
      /call back during opening hours/i.test(all),
      `an honest next step is offered: ${all}`,
    );
    assert.ok(!/call you back/i.test(all), `no callback is promised: ${all}`);
    assert.doesNotMatch(replies[4]!, /which service|we offer/i, "no further service questions");
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});
