import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  startRuntimeSession,
  terminateRuntimeSession,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ServiceRow } from "./service-matching.ts";

/**
 * Two production issues on Worker 6afce0a0:
 *
 * 1. After the agent confirmed a booking the phone call stayed connected.
 *    Sarvam never reported an utterance finished (the TTS connection never
 *    asked for its completion event), so the runtime believed the agent was
 *    still speaking for the rest of the call: the silence timer never
 *    armed, and a closing reply waited the full closing-audio deadline.
 *    These tests reproduce that with a TTS that streams audio but never
 *    sends a completion event, and prove the booking confirmation still
 *    reaches the provider hang-up.
 *
 * 2. The greeting started 3–4 s after the caller answered. Part of that was
 *    the greeting waiting for STT to connect as well as TTS. These tests pin
 *    the new order: the greeting starts as soon as TTS is ready; the
 *    caller's audio during STT's connect is buffered, not lost.
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
  { id: "svc-root-canal", name: "Root Canal Treatment", duration_minutes: 90 },
];
const CALLER_ID = "+919876543210";
const DATE = "2030-10-14";
const SLOT = { start: `${DATE}T16:00:00.000Z`, end: `${DATE}T17:30:00.000Z` };
/** 100 ms of linear16 audio @ 8 kHz (the fake bridge's format). */
const AUDIO_100MS = new Uint8Array(1_600);

async function drain(hops = 400) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

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

function input(callId: string, h: Harness, hangups: string[]): StartRuntimeSessionInput {
  return {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: "00000000-0000-0000-0000-000000000002",
    agentVersion: 1,
    instructions: "You are Aria, a helpful receptionist for Smile Dental.",
    snapshotAgent: agent,
    businessName: "Smile Dental",
    bridge: h.bridge,
    businessCountry: "IN",
    callerNumber: CALLER_ID,
    services: SERVICES,
    requestProviderHangup: async () => {
      hangups.push(h.bridge.closed ? "after_close" : "before_close");
    },
  };
}

function installBookingTools(h: Harness) {
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

/**
 * Production TTS behaviour: every utterance's audio streams back, but no
 * completion ("flushed") event ever arrives.
 */
function streamAudioNoCompletion(h: Harness, seen: { n: number }) {
  while (seen.n < h.tts.sentTexts.length) {
    h.tts.emitAudio(AUDIO_100MS);
    seen.n++;
  }
}

async function bookedCall(t: {
  mock: { timers: { enable: () => void; tick: (ms: number) => void } };
}) {
  t.mock.timers.enable();
  const h = createHarness();
  installBookingTools(h);
  const hangups: string[] = [];
  const callId = `booking-hangup-${crypto.randomUUID()}`;
  const handle = await startRuntimeSession(input(callId, h, hangups), h.deps);
  const seen = { n: 0 };
  const turn = async (said: string, reply: string) => {
    streamAudioNoCompletion(h, seen);
    t.mock.timers.tick(2_000); // the previous audio has long finished playing
    await drain();
    h.llm.setNextReply(reply);
    h.stt.speakUtterance(said);
    await drain();
    streamAudioNoCompletion(h, seen);
  };
  await turn(
    "My name is Dhanush, I need a root canal at 4 PM, use the number I'm calling from",
    `Let me check that time.\n${marker({ customer_name: "Dhanush" })}`,
  );
  if (!h.tools.calls.some((c) => c.name === "book_appointment")) {
    await turn(
      "Yes, please book it",
      `Booking now.\n${marker({ customer_name: "Dhanush", ready_to_book: true })}`,
    );
  }
  const bookCalls = h.tools.calls.filter((c) => c.name === "book_appointment");
  assert.equal(bookCalls.length, 1, "the booking was made");
  assert.equal(bookCalls[0]!.input["serviceId"], "svc-root-canal");
  assert.equal(bookCalls[0]!.input["customerPhone"], CALLER_ID);
  assert.equal(bookCalls[0]!.input["customerName"], "Dhanush");
  assert.match(h.tts.sentTexts.join(" "), /anything else/i, "the confirmation asks anything else");
  return { h, handle, hangups, seen, callId };
}

describe("issue 1: booking confirmation reaches the Vobiz hang-up, even with no TTS completion event", () => {
  test("the caller goes quiet after the confirmation: farewell, then exactly one provider hang-up", async (t) => {
    const { h, handle, hangups, seen } = await bookedCall(t);
    const before = h.tts.sentTexts.length;
    // Before the fix the silence timer never armed here: nothing happened.
    t.mock.timers.tick(2_000); // confirmation audio finishes; its completion is inferred
    await drain();
    t.mock.timers.tick(12_000); // the post-booking silence window
    await drain();
    assert.match(h.tts.sentTexts.slice(before).join(" "), /thank you for calling smile dental/i);
    assert.deepEqual(hangups, [], "not before the farewell has played");
    streamAudioNoCompletion(h, seen); // the farewell's audio
    t.mock.timers.tick(2_000);
    await drain();
    t.mock.timers.tick(1_000);
    await drain();
    assert.deepEqual(hangups, ["before_close"], "one Vobiz hang-up, then the stream closes");
    assert.equal(handle.state, "ended");
    assert.equal(h.persistence.records.length, 1);
  });

  test('"No, thanks" after the confirmation hangs up once the farewell has played — not after the 15 s deadline', async (t) => {
    const { h, handle, hangups, seen } = await bookedCall(t);
    t.mock.timers.tick(2_000);
    await drain();
    h.stt.speakUtterance("No, thanks");
    await drain();
    streamAudioNoCompletion(h, seen); // farewell audio, 100 ms, no completion event
    t.mock.timers.tick(1_000);
    await drain();
    assert.deepEqual(hangups, [], "still within the audio-idle window");
    t.mock.timers.tick(2_000); // ~3 s after the farewell: done playing, inferred
    await drain();
    assert.deepEqual(hangups, ["before_close"]);
    assert.equal(handle.state, "ended");
  });

  test("with Sarvam's completion event, the hang-up follows the farewell directly", async (t) => {
    const { h, handle, hangups, seen } = await bookedCall(t);
    h.tts.emit({ type: "flushed" }); // completion events now arrive
    t.mock.timers.tick(2_000);
    await drain();
    h.stt.speakUtterance("No, thanks");
    await drain();
    streamAudioNoCompletion(h, seen);
    for (let i = 0; i < h.tts.sentTexts.length; i++) h.tts.emit({ type: "flushed" });
    t.mock.timers.tick(1_000);
    await drain();
    assert.deepEqual(hangups, ["before_close"]);
    assert.equal(handle.state, "ended");
  });

  test("audio that is still arriving is never cut off by the hang-up", async (t) => {
    const { h, hangups } = await bookedCall(t);
    t.mock.timers.tick(2_000);
    await drain();
    h.stt.speakUtterance("No, thanks");
    await drain();
    // A long farewell keeps streaming: audio arrives every 500 ms for 4 s.
    for (let i = 0; i < 8; i++) {
      h.tts.emitAudio(AUDIO_100MS);
      t.mock.timers.tick(500);
      await drain();
      assert.deepEqual(hangups, [], `still speaking at ${(i + 1) * 500} ms`);
    }
    t.mock.timers.tick(3_000);
    await drain();
    assert.equal(hangups.length, 1);
  });

  test("a follow-up question after the confirmation keeps the call open", async (t) => {
    const { h, hangups, callId } = await bookedCall(t);
    t.mock.timers.tick(2_000);
    await drain();
    h.llm.setNextReply("We're open until 7 PM.");
    h.stt.speakUtterance("Thanks, what time do you close today?");
    await drain();
    assert.match(h.tts.sentTexts.join(" "), /open until 7 PM/);
    assert.deepEqual(hangups, []);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("issue 2: the greeting starts as soon as TTS is ready", () => {
  test("a slow STT connection no longer delays the greeting — and no caller audio is lost", async () => {
    const h = createHarness({ stt: { connectDelayMs: 200 } });
    const hangups: string[] = [];
    const callId = `greeting-${crypto.randomUUID()}`;
    const started = startRuntimeSession(input(callId, h, hangups), h.deps);
    // TTS connects immediately; STT takes 200 ms.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.match(
      h.tts.sentTexts.join(" "),
      /thanks for calling smile dental/i,
      "the greeting is sent before STT has connected",
    );
    assert.equal(h.stt.connectCalls.length, 1, "STT was still started in parallel");
    // The caller says something while STT is still connecting.
    h.bridge.emitInboundFrame(new Uint8Array([1, 2, 3, 4]));
    h.bridge.emitInboundFrame(new Uint8Array([5, 6, 7, 8]));
    assert.equal(h.stt.sentAudioFrames.length, 0, "STT isn't connected yet");
    const handle = await started;
    assert.equal(handle.state, "listening");
    assert.deepEqual(
      h.stt.sentAudioFrames.map((f) => [...f]),
      [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ],
      "the buffered caller audio reaches STT, in order",
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("STT failing after the greeting started: an honest apology, then one provider hang-up", async () => {
    const h = createHarness({
      stt: { connectDelayMs: 50, failConnectWith: new Error("stt unavailable") },
    });
    const hangups: string[] = [];
    const callId = `greeting-${crypto.randomUUID()}`;
    const started = startRuntimeSession(input(callId, h, hangups), h.deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(h.tts.sentTexts.join(" "), /thanks for calling/i, "greeting first");
    // Every queued chunk reports delivered so the apology's wait completes.
    const flusher = setInterval(() => {
      for (let i = 0; i < h.tts.sentTexts.length; i++) h.tts.emit({ type: "flushed" });
    }, 20);
    const handle = await started;
    clearInterval(flusher);
    assert.equal(handle.state, "failed");
    assert.match(h.tts.sentTexts.join(" "), /sorry/i);
    assert.deepEqual(hangups, ["before_close"]);
    assert.equal(h.bridge.closed, true);
    assert.equal(h.persistence.records.length, 1);
  });

  test("TTS failing still fails the call (and ends the phone call) without waiting on the greeting", async () => {
    const h = createHarness({ tts: { failConnectWith: new Error("tts unavailable") } });
    const hangups: string[] = [];
    const callId = `greeting-${crypto.randomUUID()}`;
    const handle = await startRuntimeSession(input(callId, h, hangups), h.deps);
    assert.equal(handle.state, "failed");
    assert.equal(h.tts.sentTexts.length, 0);
    assert.deepEqual(hangups, ["before_close"]);
    assert.equal(h.stt.closed, true, "a connected STT session is closed, never leaked");
  });

  test("the greeting is still sent exactly once", async () => {
    const h = createHarness({ stt: { connectDelayMs: 30 } });
    const callId = `greeting-${crypto.randomUUID()}`;
    await startRuntimeSession(input(callId, h, []), h.deps);
    const greetings = h.tts.sentTexts.filter((t) => /thanks for calling smile dental/i.test(t));
    assert.equal(greetings.length, 1);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("completion event semantics and hang-up evidence", () => {
  async function capture<T>(run: () => Promise<T>) {
    const logs: { event: string; payload: Record<string, unknown> }[] = [];
    const original = console.info;
    console.info = (event: unknown, payload?: unknown) => {
      if (typeof event === "string") {
        logs.push({ event, payload: (payload ?? {}) as Record<string, unknown> });
      }
    };
    try {
      return { result: await run(), logs };
    } finally {
      console.info = original;
    }
  }

  test("Sarvam's completion event (synthesis done) never cuts off audio that is still playing", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const hangups: string[] = [];
    const callId = `semantics-${crypto.randomUUID()}`;
    await startRuntimeSession(input(callId, h, hangups), h.deps);
    h.tts.emit({ type: "flushed" });
    h.stt.speakUtterance("Bye");
    await drain();
    // 2 s of farewell audio arrives, and the completion event right after it.
    h.tts.emitAudio(new Uint8Array(32_000));
    for (let i = 0; i < h.tts.sentTexts.length; i++) h.tts.emit({ type: "flushed" });
    t.mock.timers.tick(1_000);
    await drain();
    assert.deepEqual(hangups, [], "synthesis finished, but the caller is still hearing it");
    t.mock.timers.tick(1_500);
    await drain();
    assert.deepEqual(hangups, ["before_close"]);
  });

  test("the silence window starts after the audio has played, not when Sarvam reports synthesis done", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const callId = `silence-window-${crypto.randomUUID()}`;
    await startRuntimeSession(input(callId, h, []), h.deps);
    // A 5 s greeting arrives at once, with its completion event.
    h.tts.emitAudio(new Uint8Array(80_000));
    h.tts.emit({ type: "flushed" });
    await drain();
    const before = h.tts.sentTexts.length;
    // Real time passes in small steps (one big tick would skip the timers'
    // own re-checks along the way).
    const advance = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 250) {
        t.mock.timers.tick(250);
        await drain(50);
      }
    };
    await advance(13_000); // 12 s after the event, but only 8 s after playback ended
    assert.doesNotMatch(h.tts.sentTexts.slice(before).join(" "), /still there/i);
    await advance(5_000); // 12 s after playback ended
    assert.match(h.tts.sentTexts.slice(before).join(" "), /still there/i);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  for (const webhookFirst of [false, true]) {
    test(`a 404 from the provider is recorded as call_not_found (${webhookFirst ? "confirmed" : "NOT confirmed"} by the call-ended webhook)`, async (t) => {
      t.mock.timers.enable();
      const h = createHarness();
      const callId = `notfound-${crypto.randomUUID()}`;
      const { logs } = await capture(async () => {
        const session = input(callId, h, []);
        session.requestProviderHangup = async () => {
          if (webhookFirst) await terminateRuntimeSession(callId, "call ended: completed");
          return "call_not_found";
        };
        await startRuntimeSession(session, h.deps);
        h.tts.emit({ type: "flushed" });
        h.stt.speakUtterance("Bye");
        await drain();
        for (let i = 0; i < h.tts.sentTexts.length; i++) h.tts.emit({ type: "flushed" });
        t.mock.timers.tick(1_000);
        await drain();
      });
      const requested = logs.find((l) => l.event === "voice_runtime:provider_hangup_requested");
      assert.equal(requested?.payload["outcome"], "call_not_found");
      const notFound = logs.find((l) => l.event === "voice_runtime:provider_hangup_call_not_found");
      assert.equal(notFound?.payload["provider_reported_end"], webhookFirst);
    });
  }

  test("a 2xx hang-up is recorded as hung_up", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const callId = `hungup-${crypto.randomUUID()}`;
    const { logs } = await capture(async () => {
      const session = input(callId, h, []);
      session.requestProviderHangup = async () => "hung_up";
      await startRuntimeSession(session, h.deps);
      h.tts.emit({ type: "flushed" });
      h.stt.speakUtterance("Please hang up");
      await drain();
      for (let i = 0; i < h.tts.sentTexts.length; i++) h.tts.emit({ type: "flushed" });
      t.mock.timers.tick(1_000);
      await drain();
    });
    const requested = logs.find((l) => l.event === "voice_runtime:provider_hangup_requested");
    assert.equal(requested?.payload["outcome"], "hung_up");
    assert.ok(!logs.some((l) => l.event === "voice_runtime:provider_hangup_call_not_found"));
  });

  test("greeting latency is measured on the greeting's first audio frame", async () => {
    const h = createHarness();
    const callId = `latency-${crypto.randomUUID()}`;
    const { logs } = await capture(async () => {
      const session = input(callId, h, []);
      session.routingStartedAt = Date.now() - 1_200;
      await startRuntimeSession(session, h.deps);
      h.tts.emitAudio(AUDIO_100MS);
      await terminateRuntimeSession(callId, "test cleanup");
    });
    const measured = logs.filter((l) => l.event === "voice_runtime:greeting_first_audio");
    assert.equal(measured.length, 1, "logged once");
    const p = measured[0]!.payload;
    assert.ok((p["ms_since_routing_start"] as number) >= 1_200);
    assert.equal(typeof p["ms_since_runtime_start"], "number");
    assert.equal(typeof p["ms_since_tts_connected"], "number");
  });
});
