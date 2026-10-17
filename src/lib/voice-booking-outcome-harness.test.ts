import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  startRuntimeSession,
  terminateRuntimeSession,
  type RuntimeDeps,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ClaudeTool } from "./claude.server.ts";

/**
 * What the caller hears must match what was actually stored — booking
 * confirmation, Google Calendar sync failure, idempotent retries, empty
 * model replies after tool calls — and a finished call is hung up through
 * the provider only after its final audio has played. Drives the REAL voice
 * runtime through the deterministic harness (same seam as
 * voice-runtime-harness.test.ts).
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

// No database in the harness: the business timezone falls back to UTC.
const SLOT = { start: "2030-10-14T18:30:00.000Z", end: "2030-10-14T19:00:00.000Z" };

function input(
  callId: string,
  bridge: StartRuntimeSessionInput["bridge"],
  extra: Partial<StartRuntimeSessionInput> = {},
): StartRuntimeSessionInput {
  return {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: "00000000-0000-0000-0000-000000000002",
    agentVersion: 3,
    instructions: "You are Aria, a receptionist for Smile Dental.",
    snapshotAgent: agent,
    businessName: "Smile Dental",
    bridge,
    businessCountry: "IN",
    ...extra,
  };
}

async function drain(hops = 120) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

const newCallId = () => `outcome-call-${crypto.randomUUID()}`;

function catchUp(h: Harness) {
  let emitted = 0;
  return () => {
    while (emitted < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      emitted++;
    }
  };
}

const readyToBook = `Booking it.\n<<<APPT_STATE:${JSON.stringify({
  service: "teeth cleaning",
  customer_name: "Dhanush",
  phone: "9876543210",
  preferred_date: "2030-10-14",
  preferred_time: "18:30",
  ready_to_book: true,
})}>>>`;

function slotsAvailable(h: Harness) {
  h.tools.setNextResult("check_calendar_availability", {
    content: JSON.stringify({ success: true, data: { slots: [SLOT] } }),
  });
}

function bookingResult(h: Harness, payload: Record<string, unknown>, isError = false) {
  h.tools.setNextResult("book_appointment", { content: JSON.stringify(payload), isError });
}

/** The details, as the model's state block carries them before the caller has confirmed. */
const detailsKnown = readyToBook
  .replace("Booking it.", "Let me check that time.")
  .replace('"ready_to_book":true', '"ready_to_book":false');

/**
 * The caller gives the details (the runtime checks the slot), then says
 * "Yes, book it" — the booking needs the caller's own confirmation; the
 * model's "ready to book" alone never books. The calendar answers the
 * booking step's last-moment re-check the same way it answered the first
 * check, so each test's configured availability result applies to both.
 */
async function bookOnce(h: Harness, extra: Partial<StartRuntimeSessionInput> = {}) {
  const execute = h.deps.executeTool!;
  let lastAvailability: { content: string; isError?: boolean } | null = null;
  h.deps.executeTool = async (name, toolInput, ctx) => {
    const result = await execute(name, toolInput, ctx);
    if (name !== "check_calendar_availability") return result;
    if (lastAvailability && result.isError && result.content.includes("NOT_CONFIGURED")) {
      return lastAvailability;
    }
    lastAvailability = result;
    return result;
  };
  const callId = newCallId();
  const handle = await startRuntimeSession(input(callId, h.bridge, extra), h.deps);
  const flush = catchUp(h);
  flush();
  h.llm.setNextReply(detailsKnown);
  h.stt.speakUtterance("Teeth cleaning on the 14th at 6:30 PM please");
  await drain();
  assert.equal(
    h.tools.calls.filter((c) => c.name === "book_appointment").length,
    0,
    "nothing is booked before the caller confirms",
  );
  flush();
  const before = h.tts.sentTexts.length;
  // The confirmed slot is booked without a conversational model call, so
  // the only model call left is the outcome's wording (the harness default).
  h.stt.speakUtterance("Yes, book it");
  await drain(300);
  return { callId, handle, flush, spoken: h.tts.sentTexts.slice(before).join(" ") };
}

describe("the caller is told exactly what was stored", () => {
  test("CONFIRMED: confirmed with the real date, time, and business", async () => {
    const h = createHarness();
    slotsAvailable(h);
    bookingResult(h, {
      success: true,
      bookingOutcome: "confirmed",
      data: { id: "b1", status: "CONFIRMED", startAt: SLOT.start },
    });
    const { callId, spoken } = await bookOnce(h);
    assert.match(spoken, /confirmed for .*6:30 PM/i);
    assert.match(spoken, /Smile Dental/);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("Google Calendar failed but the booking is saved: 'saved, team will confirm' — never 'failed', never 'confirmed'", async () => {
    const h = createHarness();
    slotsAvailable(h);
    bookingResult(h, {
      success: true,
      bookingOutcome: "saved_calendar_sync_failed",
      data: { id: "b1", status: "CALENDAR_SYNC_FAILED", startAt: SLOT.start },
    });
    const { callId, spoken } = await bookOnce(h);
    assert.match(spoken, /saved/i);
    assert.match(spoken, /team will confirm/i);
    assert.ok(!/\b(failed|wasn't able|unable)\b/i.test(spoken), spoken);
    assert.ok(!/\bis confirmed\b|all set/i.test(spoken), spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("an idempotent retry that finds a CANCELLED booking is never confirmed", async () => {
    const h = createHarness();
    slotsAvailable(h);
    // What ai-tools returns for a retried key whose booking was cancelled.
    bookingResult(h, { success: false, error: { code: "BOOKING_NOT_ACTIVE", message: "x" } }, true);
    const { callId, spoken } = await bookOnce(h);
    assert.ok(
      !/\b(confirmed|all set|booked for)\b/i.test(spoken) || /not|n't/i.test(spoken),
      spoken,
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a success result with no stored status is NOT confirmed", async () => {
    const h = createHarness();
    slotsAvailable(h);
    bookingResult(h, { success: true, data: { id: "b1" } });
    const { callId, spoken } = await bookOnce(h);
    assert.ok(!/\bis confirmed\b|all set/i.test(spoken), spoken);
    assert.match(spoken, /wasn't able/i);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("PENDING_CONFIRMATION (a concurrent request still confirming) is described as not confirmed yet", async () => {
    const h = createHarness();
    slotsAvailable(h);
    bookingResult(h, {
      success: true,
      bookingOutcome: "pending",
      data: { id: "b1", status: "PENDING_CONFIRMATION", startAt: SLOT.start },
    });
    const { callId, spoken } = await bookOnce(h);
    assert.match(spoken, /isn't confirmed yet/i);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("tool errors and empty model replies are always audible", () => {
  test("book_appointment fails and the phrasing model returns nothing: a fallback sentence is spoken", async () => {
    const h = createHarness({ defaultReply: "   " });
    slotsAvailable(h);
    bookingResult(h, { success: false, error: { code: "UNKNOWN", message: "x" } }, true);
    const { callId, spoken } = await bookOnce(h);
    assert.match(spoken, /booking attempt failed/i);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("the availability check fails and the phrasing model returns nothing: a fallback sentence is spoken", async () => {
    const h = createHarness({ defaultReply: "" });
    h.tools.setNextResult("check_calendar_availability", {
      content: JSON.stringify({ success: false, error: { code: "UNKNOWN", message: "x" } }),
      isError: true,
    });
    const { callId, spoken } = await bookOnce(h);
    assert.match(spoken, /couldn't reach the calendar/i);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  function toolCallingDeps(
    h: Harness,
    toolResult: { content: string; isError?: boolean },
    reply: string,
  ): RuntimeDeps {
    const tools: ClaudeTool[] = [
      { name: "book_appointment", description: "d", input_schema: { type: "object" } },
    ];
    return {
      ...h.deps,
      resolveAvailableTools: async () => tools,
      executeTool: async () => toolResult,
      generateReplyWithTools: async (_messages, _tools, executeTool) => {
        const result = await executeTool("book_appointment", {
          startIso: SLOT.start,
          endIso: SLOT.end,
        });
        return {
          reply,
          toolCalls: [{ name: "book_appointment", input: {}, isError: Boolean(result.isError) }],
        };
      },
    };
  }

  async function toolTurn(deps: RuntimeDeps, h: Harness) {
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), deps);
    catchUp(h)();
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance("Please book me in");
    await drain();
    return { callId, spoken: h.tts.sentTexts.slice(before).join(" ") };
  }

  test("tool-calling path: an empty model reply after book_appointment speaks the stored outcome", async () => {
    const h = createHarness();
    const deps = toolCallingDeps(
      h,
      {
        content: JSON.stringify({
          success: true,
          bookingOutcome: "confirmed",
          data: { status: "CONFIRMED" },
        }),
        isError: false,
      },
      "",
    );
    const { callId, spoken } = await toolTurn(deps, h);
    assert.match(spoken, /your appointment is confirmed/i);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("tool-calling path: a model reply claiming 'booked' when Google sync failed is corrected", async () => {
    const h = createHarness();
    const deps = toolCallingDeps(
      h,
      {
        content: JSON.stringify({
          success: true,
          bookingOutcome: "saved_calendar_sync_failed",
          data: { status: "CALENDAR_SYNC_FAILED" },
        }),
        isError: false,
      },
      "Great, you're booked!",
    );
    const { callId, spoken } = await toolTurn(deps, h);
    assert.match(spoken, /saved, and our team will confirm/i);
    assert.ok(!/you're booked/i.test(spoken), spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("tool-calling path: a failed tool call followed by an empty reply is never silence", async () => {
    const h = createHarness();
    const deps = toolCallingDeps(
      h,
      { content: JSON.stringify({ success: false, error: { code: "UNKNOWN" } }), isError: true },
      "",
    );
    const { callId, spoken } = await toolTurn(deps, h);
    assert.ok(spoken.trim().length > 0);
    assert.match(spoken, /wasn't able to complete that booking/i);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("final audio completes before the provider hangs up", () => {
  function confirmedBooking(h: Harness) {
    slotsAvailable(h);
    bookingResult(h, {
      success: true,
      bookingOutcome: "confirmed",
      data: { id: "b1", status: "CONFIRMED", startAt: SLOT.start },
    });
  }

  test("'no, that's all': farewell plays fully, THEN the provider hang-up, THEN the stream closes", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    confirmedBooking(h);
    const events: string[] = [];
    const { handle, flush } = await bookOnce(h, {
      requestProviderHangup: async () => {
        events.push(`hangup(bridgeClosed=${h.bridge.closed})`);
      },
    });
    flush();
    h.stt.speakUtterance("No, that's all, thanks");
    await drain();
    assert.match(h.tts.sentTexts.join(" "), /thank you for calling smile dental/i);
    assert.deepEqual(events, [], "no hang-up while the farewell is still being synthesized");

    h.tts.emitAudio(new Uint8Array(32_000)); // 2 s of linear16 @ 8 kHz
    flush();
    t.mock.timers.tick(1_000);
    await drain(40);
    assert.deepEqual(events, [], "no hang-up while the farewell is still playing");

    t.mock.timers.tick(2_000);
    await drain(60);
    assert.deepEqual(
      events,
      ["hangup(bridgeClosed=false)"],
      "provider hang-up happens before the stream closes",
    );
    assert.equal(h.bridge.closed, true);
    assert.equal(handle.state, "ended");
  });

  test("a failing provider hang-up still ends the call (stream close fallback)", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    confirmedBooking(h);
    const { handle, flush } = await bookOnce(h, {
      requestProviderHangup: async () => {
        throw new Error("Vobiz returned 500");
      },
    });
    flush();
    h.stt.speakUtterance("bye");
    await drain();
    flush();
    t.mock.timers.tick(1_000);
    await drain(60);
    assert.equal(handle.state, "ended");
    assert.equal(h.bridge.closed, true);
  });

  test("silence after the booking: farewell, provider hang-up after its audio, no 'are you still there?'", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    confirmedBooking(h);
    let hangups = 0;
    const { handle, flush } = await bookOnce(h, {
      requestProviderHangup: async () => {
        hangups++;
      },
    });
    flush();
    const before = h.tts.sentTexts.length;
    t.mock.timers.tick(12_000);
    await drain(60);
    assert.match(h.tts.sentTexts.slice(before).join(" "), /thank you for calling/i);
    assert.ok(!/still there/i.test(h.tts.sentTexts.slice(before).join(" ")));
    assert.equal(hangups, 0, "not before the farewell's audio is delivered");
    flush();
    t.mock.timers.tick(1_000);
    await drain(60);
    assert.equal(hangups, 1);
    assert.equal(handle.state, "ended");
  });

  test("a follow-up question after the booking is answered — the call does not end", async () => {
    const h = createHarness();
    confirmedBooking(h);
    let hangups = 0;
    const { callId, handle, flush } = await bookOnce(h, {
      requestProviderHangup: async () => {
        hangups++;
      },
    });
    flush();
    h.llm.setNextReply("We're open until 7 PM on weekdays.");
    h.stt.speakUtterance("Thanks, what time do you close on Fridays?");
    await drain();
    assert.match(h.tts.sentTexts.join(" "), /open until 7 PM/);
    assert.equal(hangups, 0);
    assert.notEqual(handle.state, "ended");
    await terminateRuntimeSession(callId, "test cleanup");
  });
});
