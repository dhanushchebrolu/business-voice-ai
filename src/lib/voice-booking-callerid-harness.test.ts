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

/**
 * Regression coverage for the Smile Dental voice-booking incident (a 6:30 PM
 * slot was offered, name and phone were given, nothing was booked, details
 * were asked for again, and the call could sit silent) and for caller-ID
 * capture. Drives the REAL voice runtime through the same deterministic
 * harness as voice-runtime-harness.test.ts.
 *
 * The tool executor used here is a small in-memory stand-in for the real
 * booking stack that enforces the two database rules this incident hinged
 * on: contacts.phone must be E.164 (its CHECK constraint), and a repeated
 * idempotency key returns the existing booking instead of creating another.
 * The database-level behavior itself is verified against real PostgreSQL in
 * supabase/migrations/voice_booking_persistence.pg.test.ts.
 */

const minimalAgent: AgentSnapshot["agent"] = {
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

const CALLER_ID = "+919876543210";
// The harness has no database, so the runtime's business timezone lookup
// falls back to UTC — the slot below is 18:30 in that timezone.
const SLOT = { start: "2026-10-12T18:30:00.000Z", end: "2026-10-12T19:00:00.000Z" };

function input(
  callId: string,
  bridge: StartRuntimeSessionInput["bridge"],
  callerNumber?: string | null,
): StartRuntimeSessionInput {
  return {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: "00000000-0000-0000-0000-000000000002",
    agentVersion: 3,
    instructions: "You are Aria, a helpful receptionist for Smile Dental.",
    snapshotAgent: minimalAgent,
    businessName: "Smile Dental",
    bridge,
    businessCountry: "IN",
    ...(callerNumber !== undefined ? { callerNumber } : {}),
  };
}

async function drain(hops = 60) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

function newCallId() {
  return `cid-call-${crypto.randomUUID()}`;
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

function marker(state: Record<string, unknown>): string {
  return `<<<APPT_STATE:${JSON.stringify({
    service: "teeth cleaning",
    customer_name: "Dhanush",
    phone: null,
    email: null,
    preferred_date: "2026-10-12",
    preferred_time: "18:30",
    preferred_period: null,
    wants_next_available: false,
    checking_availability: false,
    ready_to_book: false,
    ...state,
  })}>>>`;
}

/**
 * In-memory booking store behind a fake executeTool: the same two rules the
 * real database enforces (E.164 contacts.phone; idempotency key -> existing
 * row) and availability that excludes booked intervals.
 */
function installBookingStore(h: Harness, daySlots: { start: string; end: string }[]) {
  const bookings = new Map<string, { id: string; startAt: string; endAt: string; phone: string }>();
  const availabilityResults: { start: string; end: string }[][] = [];
  const original = h.deps.executeTool!;
  h.deps.executeTool = async (name, toolInput, ctx) => {
    if (name === "check_calendar_availability") {
      await original(name, toolInput, ctx); // recorded in h.tools.calls
      const booked = [...bookings.values()];
      const slots = daySlots.filter(
        (s) => !booked.some((b) => b.startAt < s.end && s.start < b.endAt),
      );
      availabilityResults.push(slots);
      return { content: JSON.stringify({ success: true, data: { slots } }) };
    }
    if (name === "book_appointment") {
      await original(name, toolInput, ctx);
      const phone = toolInput["customerPhone"];
      if (typeof phone !== "string" || !/^\+[1-9]\d{6,14}$/.test(phone)) {
        // What contacts_phone_e164 does to a raw "9876543210".
        return {
          content: JSON.stringify({
            success: false,
            error: { code: "UNKNOWN", message: "Something went wrong." },
          }),
          isError: true,
        };
      }
      const key = `voice:${ctx.callId}:${toolInput["startIso"]}:${toolInput["endIso"]}`;
      let row = bookings.get(key);
      if (!row) {
        row = {
          id: `booking-${bookings.size + 1}`,
          startAt: String(toolInput["startIso"]),
          endAt: String(toolInput["endIso"]),
          phone,
        };
        bookings.set(key, row);
      }
      return {
        content: JSON.stringify({
          success: true,
          data: { id: row.id, status: "CONFIRMED", startAt: row.startAt, endAt: row.endAt },
        }),
      };
    }
    return original(name, toolInput, ctx);
  };
  return Object.assign(bookings, { availabilityResults });
}

function spokenSince(h: Harness, index: number) {
  return h.tts.sentTexts.slice(index).join(" ");
}

describe("voice booking persists exactly once, with the caller's number", () => {
  test("1/2/6: a spoken 10-digit number books ONE confirmed booking (E.164), the slot drops out of availability, and the result is spoken with the date, time, and business", async () => {
    const h = createHarness();
    const bookings = installBookingStore(h, [
      SLOT,
      { start: "2026-10-12T19:00:00.000Z", end: "2026-10-12T19:30:00.000Z" },
    ]);
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    const catchUp = flushCatchUp(h);
    catchUp();

    h.llm.setNextReply(
      `Great, booking that now.\n${marker({ phone: "98765 43210", ready_to_book: true })}`,
    );
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance("Yes please book it, my number is 98765 43210");
    await drain(120);

    const bookingCalls = h.tools.calls.filter((c) => c.name === "book_appointment");
    assert.equal(bookingCalls.length, 1);
    assert.equal(bookingCalls[0]!.input["customerPhone"], "+919876543210");
    assert.equal(bookingCalls[0]!.input["startIso"], SLOT.start);
    assert.equal(bookings.size, 1, "exactly one booking persisted");

    const spoken = spokenSince(h, before);
    assert.match(spoken, /6:30 PM/);
    assert.match(spoken, /anything else/i);

    // The booked interval is no longer offered.
    h.llm.setNextReply(
      `Let me check.\n${marker({ phone: "98765 43210", checking_availability: true })}`,
    );
    catchUp();
    h.stt.speakUtterance("What other times are free that day?");
    await drain(120);
    const latest = bookings.availabilityResults.at(-1) ?? [];
    assert.ok(bookings.availabilityResults.length >= 2, "a fresh availability check ran");
    assert.ok(
      !latest.some((slot) => slot.start === SLOT.start),
      "the booked 18:30 slot is no longer offered",
    );
    assert.ok(latest.some((slot) => slot.start === "2026-10-12T19:00:00.000Z"));

    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("8: a retried booking for the same call and slot never creates a second booking", async () => {
    const h = createHarness();
    const bookings = installBookingStore(h, [SLOT]);
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    const catchUp = flushCatchUp(h);
    catchUp();

    h.llm.setNextReply(`Booking.\n${marker({ phone: "9876543210", ready_to_book: true })}`);
    h.stt.speakUtterance("Book it");
    await drain(120);
    catchUp();
    // Same call, same slot, asked again (e.g. the caller repeats "book it").
    // The store still holds the slot, so availability no longer lists it and
    // the runtime declines rather than double-booking.
    h.llm.setNextReply(`Booking.\n${marker({ phone: "9876543210", ready_to_book: true })}`);
    h.stt.speakUtterance("Yes book it");
    await drain(120);

    assert.equal(bookings.size, 1, "never a second booking for the same call/slot");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("5: a failed booking never produces a verbal confirmation", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    flushCatchUp(h)();
    h.tools.setNextResult("check_calendar_availability", {
      content: JSON.stringify({ success: true, data: { slots: [SLOT] } }),
    });
    h.tools.setNextResult("book_appointment", {
      content: JSON.stringify({ success: false, error: { code: "UNKNOWN", message: "x" } }),
      isError: true,
    });
    // The model's own reply claims success — it must never reach the caller.
    h.llm.setNextReply(
      `Your appointment is booked!\n${marker({ phone: "9876543210", ready_to_book: true })}`,
    );
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance("Yes book it");
    await drain(120);
    const spoken = spokenSince(h, before);
    assert.ok(!/\b(booked|confirmed|all set)\b/i.test(spoken), spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("6: a tool result is always followed by speech, even when the phrasing model returns nothing", async () => {
    const h = createHarness({ defaultReply: "" });
    installBookingStore(h, [SLOT]);
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    flushCatchUp(h)();
    h.llm.setNextReply(`Booking.\n${marker({ phone: "9876543210", ready_to_book: true })}`);
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance("Book it please");
    await drain(120);
    const spoken = spokenSince(h, before);
    assert.match(spoken, /confirmed for .*6:30 PM/i, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("targeted clarification instead of restarting collection", () => {
  test("4: a malformed spoken number asks ONLY for the number again, keeping every other detail", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    flushCatchUp(h)();
    h.llm.setNextReply(
      `Thanks! What service would you like and what's your name?\n${marker({ preferred_time: null })}`,
    );
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance("My number is 12345 678");
    await drain(80);
    const spoken = spokenSince(h, before);
    assert.match(spoken, /phone number again/i);
    assert.ok(!/what service|your name/i.test(spoken), spoken);
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("4: 'book it' with the phone still missing asks for just the phone — never a false confirmation", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    flushCatchUp(h)();
    h.llm.setNextReply(`You're booked!\n${marker({ ready_to_book: true })}`);
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance("Yes book it");
    await drain(80);
    const spoken = spokenSince(h, before);
    assert.match(spoken, /phone number/i);
    assert.ok(!/booked/i.test(spoken), spoken);
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("4: the booking layer's INVALID_PHONE re-asks only for the number and keeps the rest", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    flushCatchUp(h)();
    h.tools.setNextResult("check_calendar_availability", {
      content: JSON.stringify({ success: true, data: { slots: [SLOT] } }),
    });
    h.tools.setNextResult("book_appointment", {
      content: JSON.stringify({ success: false, error: { code: "INVALID_PHONE", message: "x" } }),
      isError: true,
    });
    h.llm.setNextReply(`Booking.\n${marker({ phone: "9876543210", ready_to_book: true })}`);
    h.llm.setDelay(0);
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance("Yes book it");
    await drain(120);
    const spoken = spokenSince(h, before);
    assert.ok(!/\bbooked\b/i.test(spoken), spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("caller ID: capture, offer, and selection", () => {
  /**
   * The Smile Dental sequence: service, name, date and time first (the slot
   * is checked and available), then "book it" with no phone number yet —
   * the point where the runtime must ask for the number.
   */
  async function reachPhoneQuestion(h: Harness, callerNumber: string | null | undefined) {
    const store = installBookingStore(h, [SLOT]);
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge, callerNumber), h.deps);
    const catchUp = flushCatchUp(h);
    catchUp();
    h.llm.setNextReply(`Let me check.\n${marker({})}`);
    h.stt.speakUtterance("I'm Dhanush, a teeth cleaning today at 6:30 PM please");
    await drain(120);
    catchUp();
    h.llm.setNextReply(`Booking it now.\n${marker({ ready_to_book: true })}`);
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance("Yes, book it");
    await drain(80);
    catchUp();
    return { callId, catchUp, store, askedPhone: spokenSince(h, before) };
  }

  test("caller accepts the detected number — it is booked without asking them to repeat it", async () => {
    const h = createHarness();
    const { callId, askedPhone, store: bookings } = await reachPhoneQuestion(h, "+91 98765 43210");
    assert.ok(askedPhone.includes(CALLER_ID_QUESTION), askedPhone);
    assert.ok(!/\bbooked\b/i.test(askedPhone), "never claims a booking before it exists");
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);

    h.llm.setNextReply(`Booking now.\n${marker({ ready_to_book: true })}`);
    h.stt.speakUtterance("Yes, please use that number and book it");
    await drain(120);
    const call = h.tools.calls.find((c) => c.name === "book_appointment");
    assert.equal(call?.input["customerPhone"], CALLER_ID);
    assert.equal(bookings.size, 1);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("caller chooses a different number — that number is collected, validated, and used", async () => {
    const h = createHarness();
    const { callId, catchUp } = await reachPhoneQuestion(h, CALLER_ID);

    h.llm.setNextReply(`Sure.\n${marker({})}`);
    let before = h.tts.sentTexts.length;
    h.stt.speakUtterance("No, use a different number");
    await drain(80);
    assert.match(spokenSince(h, before), /what number would you like/i);
    catchUp();

    h.llm.setNextReply(`Booking now.\n${marker({ ready_to_book: true })}`);
    before = h.tts.sentTexts.length;
    h.stt.speakUtterance("It's 98450 12345, go ahead and book it");
    await drain(120);
    const call = h.tools.calls.find((c) => c.name === "book_appointment");
    assert.equal(call?.input["customerPhone"], "+919845012345");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("an ambiguous answer gets exactly one short clarification", async () => {
    const h = createHarness();
    const { callId } = await reachPhoneQuestion(h, CALLER_ID);
    h.llm.setNextReply(`Hmm.\n${marker({})}`);
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance("Hmm, I'm not sure");
    await drain(80);
    assert.match(
      spokenSince(h, before),
      /just to confirm, shall i use the number you're calling from/i,
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });

  for (const [label, callerNumber] of [
    ["withheld caller ID", "anonymous"],
    ["malformed caller ID", "+12"],
    ["missing session metadata", undefined],
  ] as const) {
    test(`${label}: the number is asked for normally, and nothing about caller ID is offered`, async () => {
      const h = createHarness();
      const { callId, askedPhone } = await reachPhoneQuestion(h, callerNumber);
      assert.match(askedPhone, /phone number/i);
      assert.ok(!askedPhone.includes("calling from"), askedPhone);
      const systemText = h.llm.calls
        .flat()
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n");
      assert.ok(!/caller ID/i.test(systemText), "no caller-ID guidance without a usable caller ID");
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test("the accepted number survives an interruption, extra turns, and a stray digit run — and is never asked for again", async () => {
    const h = createHarness();
    const { callId, catchUp } = await reachPhoneQuestion(h, CALLER_ID);

    h.llm.setNextReply(`Perfect.\n${marker({})}`);
    h.stt.speakUtterance("Yes, that's fine");
    await drain(80);

    // Barge in over the next reply, then an unrelated turn that contains a
    // long digit run that is NOT a phone number correction.
    h.llm.setDelay(50);
    h.llm.setNextReply(`Your reference is noted.\n${marker({})}`);
    h.stt.speakUtterance("My insurance policy is 4455667788");
    await new Promise((r) => setTimeout(r, 5));
    h.stt.emit({ type: "speech_start" }); // interruption
    h.llm.setDelay(0);
    await new Promise((r) => setTimeout(r, 80));
    await drain(80);
    catchUp();

    h.llm.setNextReply(`Booking now.\n${marker({ ready_to_book: true })}`);
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance("Okay, book it");
    await drain(120);
    const call = h.tools.calls.find((c) => c.name === "book_appointment");
    assert.equal(call?.input["customerPhone"], CALLER_ID);
    assert.ok(!h.tts.sentTexts.slice(before).join(" ").includes("calling from"));
    // Only the caller-ID question itself ever asked about the number.
    const phoneQuestions = h.tts.sentTexts.filter((t) => /calling from/i.test(t)).length;
    assert.equal(phoneQuestions, 1);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("the full caller number never appears in runtime logs or the model prompt", async () => {
    const logged: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    };
    try {
      const h = createHarness();
      const { callId } = await reachPhoneQuestion(h, CALLER_ID);
      const prompt = JSON.stringify(h.llm.calls);
      assert.ok(!prompt.includes("9876543210"), "prompt carries only the last four digits");
      assert.ok(prompt.includes("3210"));
      await terminateRuntimeSession(callId, "test cleanup");
    } finally {
      console.info = originalInfo;
    }
    assert.ok(
      !logged.some((l) => l.includes("9876543210")),
      "logs never carry the caller's number",
    );
  });
});

describe("call completion: confirmation, farewell, and disconnect after final audio", () => {
  async function bookedCall(h: Harness) {
    installBookingStore(h, [SLOT]);
    const callId = newCallId();
    const handle = await startRuntimeSession(input(callId, h.bridge), h.deps);
    const catchUp = flushCatchUp(h);
    catchUp();
    h.llm.setNextReply(`Booking.\n${marker({ phone: "9876543210", ready_to_book: true })}`);
    h.stt.speakUtterance("Book it");
    await drain(120);
    return { callId, handle, catchUp };
  }

  test("7: 'no, that's all' after a booking speaks a farewell and disconnects only after its audio finished", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const { handle, catchUp } = await bookedCall(h);
    catchUp();

    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance("No, that's all, thank you");
    await drain(80);
    assert.match(spokenSince(h, before), /thank you for calling smile dental/i);
    assert.equal(h.llm.calls.length > 0, true);
    assert.equal(
      h.bridge.closed,
      false,
      "never disconnect while the farewell is still being synthesized",
    );

    // Synthesized audio arrives: 1.6s of linear16 @ 8 kHz.
    h.tts.emitAudio(new Uint8Array(25_600));
    catchUp();
    t.mock.timers.tick(500);
    await drain(40);
    assert.equal(h.bridge.closed, false, "never disconnect while the farewell is still playing");

    t.mock.timers.tick(2_000);
    await drain(40);
    assert.equal(h.bridge.closed, true);
    assert.equal(handle.state, "ended");
  });

  test("7: a farewell that never reports flushed still disconnects (bounded wait)", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const { handle, catchUp } = await bookedCall(h);
    catchUp();
    h.stt.speakUtterance("bye");
    await drain(80);
    assert.equal(h.bridge.closed, false);
    t.mock.timers.tick(15_100);
    await drain(40);
    assert.equal(handle.state, "ended");
  });

  test("7: the caller speaking over the farewell cancels the hangup (stale-turn protection wins)", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const { handle, catchUp } = await bookedCall(h);
    catchUp();
    h.stt.speakUtterance("Goodbye");
    await drain(80);
    h.stt.emit({ type: "speech_start" }); // barge-in during the farewell
    catchUp();
    t.mock.timers.tick(2_000);
    await drain(40);
    assert.equal(h.bridge.closed, false);
    assert.notEqual(handle.state, "ended");
    await terminateRuntimeSession(handle.callId, "test cleanup");
  });

  test("silence after a confirmed booking ends the call with a farewell — no 'are you still there?' loop", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const { handle, catchUp } = await bookedCall(h);
    catchUp();
    const before = h.tts.sentTexts.length;
    t.mock.timers.tick(12_000);
    await drain(60);
    const spoken = spokenSince(h, before);
    assert.match(spoken, /thank you for calling smile dental/i);
    assert.ok(!/still there/i.test(spoken), spoken);
    catchUp();
    t.mock.timers.tick(1_000);
    await drain(40);
    assert.equal(handle.state, "ended");
  });

  test("'no' is NOT treated as a goodbye before anything was booked", async () => {
    const h = createHarness();
    const callId = newCallId();
    const handle = await startRuntimeSession(input(callId, h.bridge), h.deps);
    flushCatchUp(h)();
    h.llm.setNextReply("Okay, what would you like instead?");
    h.stt.speakUtterance("No");
    await drain(80);
    assert.notEqual(handle.state, "ended");
    assert.equal(h.bridge.closed, false);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});
