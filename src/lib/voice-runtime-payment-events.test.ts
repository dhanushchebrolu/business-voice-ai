import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  startRuntimeSession,
  terminateRuntimeSession,
  injectPaymentEvent,
  type StartRuntimeSessionInput,
  type RuntimeDeps,
} from "./voice-runtime.server.ts";
import { createHarness } from "./telephony/voice-runtime-test-harness.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ClaudeTool } from "./claude.server.ts";

/**
 * INTEGRATION-tier coverage for Subsystem 10 (the "waiting_on_payment"
 * state, its bounded timeout, and injectPaymentEvent — the leg of the
 * event architecture that lets a verified Razorpay webhook, relayed
 * through payment-voice-consumer.server.ts and the Durable Object,
 * interrupt a still-live call to tell the customer their payment came
 * through). Same harness/tier as voice-runtime-harness.test.ts and
 * voice-runtime-tools-harness.test.ts.
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
  greetings: { "en-IN": "Hello, thanks for calling Test Business." },
  transfer_number: null,
  after_hours_behavior: "take_message",
};

function baseInput(
  callId: string,
  bridge: StartRuntimeSessionInput["bridge"],
): StartRuntimeSessionInput {
  return {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: "00000000-0000-0000-0000-000000000002",
    agentVersion: 3,
    instructions: "You are Aria, a helpful receptionist for Test Business.",
    snapshotAgent: minimalAgent,
    businessName: "Test Business",
    bridge,
  };
}

async function drain(hops = 8) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

function newCallId(): string {
  return `harness-payment-events-call-${crypto.randomUUID()}`;
}

/** A RuntimeDeps augmentation whose generateReplyWithTools always reports a successful request_payment call, driving the runtime into waiting_on_payment after the reply is spoken. */
function withPaymentToolDeps(base: RuntimeDeps): RuntimeDeps {
  const tools: ClaudeTool[] = [
    { name: "request_payment", description: "d", input_schema: { type: "object" } },
  ];
  return {
    ...base,
    resolveAvailableTools: async () => tools,
    executeTool: async () => ({ content: JSON.stringify({ success: true }) }),
    generateReplyWithTools: async () => ({
      reply: "I've sent you a payment link — let me know once you've paid.",
      toolCalls: [{ name: "request_payment", input: {}, isError: false }],
    }),
  };
}

describe("waiting_on_payment state", () => {
  test("a successful request_payment tool call moves the runtime to waiting_on_payment, not listening", async () => {
    const h = createHarness();
    const callId = newCallId();
    const deps = withPaymentToolDeps(h.deps);
    const handle = await startRuntimeSession(baseInput(callId, h.bridge), deps);

    h.stt.speakUtterance("Can I pay for my appointment now?");
    await drain();

    assert.equal(handle.state, "waiting_on_payment");
    assert.ok(h.tts.sentTexts.some((t) => t.includes("payment link")));

    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("caller speech while waiting_on_payment moves to transcribing (not interrupted) — the agent wasn't talking", async () => {
    const h = createHarness();
    const callId = newCallId();
    const deps = withPaymentToolDeps(h.deps);
    const handle = await startRuntimeSession(baseInput(callId, h.bridge), deps);

    h.stt.speakUtterance("Can I pay now?");
    await drain();
    assert.equal(handle.state, "waiting_on_payment");

    h.stt.emit({ type: "speech_start" });
    assert.equal(handle.state, "transcribing");

    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("the bounded payment-wait timeout speaks a graceful fallback and returns to listening", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const callId = newCallId();
    const deps = withPaymentToolDeps(h.deps);
    const handle = await startRuntimeSession(baseInput(callId, h.bridge), deps);

    h.stt.speakUtterance("Can I pay now?");
    await drain();
    assert.equal(handle.state, "waiting_on_payment");
    const spokenBefore = h.tts.sentTexts.length;

    t.mock.timers.tick(90_000); // PAYMENT_WAIT_TIMEOUT_MS
    await drain();

    const newChunks = h.tts.sentTexts.slice(spokenBefore);
    assert.ok(newChunks.length >= 1);
    assert.match(newChunks.join(" "), /haven't received confirmation/i);
    assert.equal(handle.state, "listening");

    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("caller speech cancels the payment-wait timer — the fallback never fires afterward", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const callId = newCallId();
    const deps = withPaymentToolDeps(h.deps);
    const handle = await startRuntimeSession(baseInput(callId, h.bridge), deps);

    h.stt.speakUtterance("Can I pay now?");
    await drain();
    assert.equal(handle.state, "waiting_on_payment");

    h.stt.emit({ type: "speech_start" }); // caller engages again — cancels the wait
    const spokenBefore = h.tts.sentTexts.length;
    t.mock.timers.tick(90_000);
    await drain();

    assert.equal(
      h.tts.sentTexts.length,
      spokenBefore,
      "the payment-wait fallback must not fire once the caller has re-engaged",
    );

    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("injectPaymentEvent", () => {
  test("no active session for the callId: returns handled:false without throwing (ended-call fallback)", async () => {
    const result = await injectPaymentEvent("no-such-call-id", "Your payment went through!");
    assert.equal(result.handled, false);
  });

  test("a session in waiting_on_payment: speaks the injected message, clears the wait timer, and returns to listening", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const callId = newCallId();
    const deps = withPaymentToolDeps(h.deps);
    const handle = await startRuntimeSession(baseInput(callId, h.bridge), deps);

    h.stt.speakUtterance("Can I pay now?");
    await drain();
    assert.equal(handle.state, "waiting_on_payment");

    const result = await injectPaymentEvent(callId, "Payment received! Your booking is confirmed.");
    await drain();

    assert.equal(result.handled, true);
    assert.ok(h.tts.sentTexts.some((t2) => t2.includes("Payment received")));
    assert.equal(handle.state, "listening");

    // The payment-wait timer must have been cleared by the injection —
    // injectPaymentEvent's own cleanup re-arms the ordinary silence timer
    // instead (expected, already covered elsewhere), so a later tick may
    // legitimately speak a silence prompt/hangup — the payment-wait
    // fallback specifically must never fire again, though.
    t.mock.timers.tick(90_000);
    await drain();
    assert.ok(
      !h.tts.sentTexts.some((t2) => t2.includes("haven't received confirmation")),
      "the payment-wait timeout fallback must not fire again after the wait already resolved via injection",
    );

    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a session mid-turn (AI still thinking): the injected message interrupts, clearing queued audio first, and the stale in-flight reply is discarded once it resolves", async () => {
    const h = createHarness();
    const callId = newCallId();
    const handle = await startRuntimeSession(baseInput(callId, h.bridge), h.deps);

    h.llm.setDelay(40);
    h.llm.setNextReply("This reply must never be spoken.");
    h.stt.speakUtterance("What are your hours?");
    await drain();
    assert.equal(handle.state, "thinking");

    const clearedBefore = h.bridge.clearedCount;
    const result = await injectPaymentEvent(callId, "Payment received!");

    assert.equal(result.handled, true);
    assert.ok(
      h.bridge.clearedCount > clearedBefore,
      "queued audio must be cleared before the injected message",
    );
    assert.ok(h.tts.sentTexts.some((t) => t.includes("Payment received")));
    assert.equal(handle.state, "listening");

    // Let the now-stale in-flight LLM call actually resolve.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await drain();
    assert.ok(
      !h.tts.sentTexts.some((t) => t.includes("must never be spoken")),
      "a reply generated before the injected event must never be spoken over it",
    );

    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("an ended session: returns handled:false, never tries to speak into a closed call", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(baseInput(callId, h.bridge), h.deps);
    await terminateRuntimeSession(callId, "caller hung up");

    const result = await injectPaymentEvent(callId, "Payment received!");
    assert.equal(result.handled, false);
  });
});
