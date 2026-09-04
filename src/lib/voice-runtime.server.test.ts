import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkIntoSentences,
  startRuntimeSession,
  getActiveSession,
} from "./voice-runtime.server.ts";
import type { AudioMediaBridge, AudioFrame } from "./telephony/audio-bridge";
import type { AgentSnapshot } from "./agent-instructions";

test("chunkIntoSentences: splits on sentence boundaries", () => {
  const chunks = chunkIntoSentences("Hello there, welcome! How can I help you today? Sure thing.");
  assert.deepEqual(chunks, ["Hello there, welcome!", "How can I help you today?", "Sure thing."]);
});

test("chunkIntoSentences: short fragments are merged rather than sent as tiny chunks", () => {
  const chunks = chunkIntoSentences("Ok. Yes. Sure, no problem at all, happy to help with that.");
  // "Ok." and "Yes." are each under the 20-char minimum, so they merge
  // forward into the next chunk instead of firing two near-empty TTS calls.
  assert.ok(chunks.length <= 2);
  assert.ok(chunks.join(" ").includes("Ok."));
});

test("chunkIntoSentences: empty input yields no chunks", () => {
  assert.deepEqual(chunkIntoSentences(""), []);
  assert.deepEqual(chunkIntoSentences("   "), []);
});

function fakeBridge(): AudioMediaBridge {
  return {
    inboundFormat: { encoding: "mulaw", sampleRateHz: 8000 },
    outboundFormat: { encoding: "mulaw", sampleRateHz: 8000 },
    onInboundFrame: (_cb: (frame: AudioFrame) => void) => {},
    sendOutboundFrame: () => {},
    clearOutboundBuffer: () => {},
    onClose: (_cb: (reason: string) => void) => {},
    close: () => {},
  };
}

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
  greetings: { "en-IN": "Hello, thanks for calling." },
  transfer_number: null,
  after_hours_behavior: "take_message",
};

test("startRuntimeSession: without SARVAM_API_KEY, fails closed into ERROR (never throws)", async () => {
  delete process.env["SARVAM_API_KEY"];
  const callId = `test-call-${crypto.randomUUID()}`;
  const handle = await startRuntimeSession({
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: null,
    agentVersion: null,
    instructions: "You are a helpful receptionist.",
    snapshotAgent: minimalAgent,
    businessName: "Test Business",
    bridge: fakeBridge(),
  });
  assert.equal(handle.state, "ERROR");
  // Cleanup already ran (terminateRuntimeSession is called internally on
  // connect failure), so the session must not be left dangling in memory.
  assert.equal(getActiveSession(callId), null);
});

test("startRuntimeSession: concurrent calls for the same call_id do not start two sessions", async () => {
  delete process.env["SARVAM_API_KEY"];
  const callId = `test-call-dup-${crypto.randomUUID()}`;
  const bridge = fakeBridge();
  const input = {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: null,
    agentVersion: null,
    instructions: "You are a helpful receptionist.",
    snapshotAgent: minimalAgent,
    businessName: "Test Business",
    bridge,
  };
  // Fired back-to-back, synchronously, before either has awaited anything —
  // the second call must observe the first's session already registered.
  const [h1, h2] = await Promise.all([startRuntimeSession(input), startRuntimeSession(input)]);
  assert.equal(h1.runtimeSessionId, h2.runtimeSessionId);
});
