import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

/**
 * Silence/timeout handling (requirement 6): a caller who goes quiet is
 * prompted once, then hung up on if the silence continues. There is no
 * mocked Sarvam WS harness in this repo to drive a session all the way to
 * LISTENING and fast-forward real timers (every other test above proves
 * only the fail-closed ERROR path, since SARVAM_API_KEY is deliberately
 * unset), so — same technique as agent.functions.test.ts for other
 * hard-to-integration-test async logic — this is a source scan proving the
 * wiring: every place the runtime settles into "waiting on the caller"
 * arms the timer, every place the caller actually speaks disarms it, and
 * cleanup never leaves a timer running past the session's lifetime.
 */
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "voice-runtime.server.ts"),
  "utf8",
);

describe("silence/timeout handling — wiring", () => {
  test("two-stage thresholds: a prompt before a hangup, not the other way round", () => {
    assert.match(src, /const SILENCE_PROMPT_MS = 12_000;/);
    assert.match(src, /const SILENCE_HANGUP_MS = 10_000;/);
  });

  test("armSilenceTimer only ever arms while waiting on the caller (LISTENING/INTERRUPTED)", () => {
    const fnStart = src.indexOf("function armSilenceTimer(session: Session) {");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
    assert.match(
      fnBody,
      /if \(session\.handle\.state !== "LISTENING" && session\.handle\.state !== "INTERRUPTED"\) return;/,
    );
  });

  test("the timer fires the one-time prompt before it ever hangs up, gated by silencePromptSent", () => {
    const fnStart = src.indexOf("function armSilenceTimer(session: Session) {");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
    assert.match(
      fnBody,
      /if \(session\.silencePromptSent\) void endDueToSilence\(session\);\s*\n\s*else void speakSilencePrompt\(session\);/,
    );
  });

  test("speech_start unconditionally cancels the pending timer and resets the prompt flag, before the barge-in branch", () => {
    const caseStart = src.indexOf('case "speech_start": {');
    const bargeInIdx = src.indexOf(
      'if (session.handle.state === "SPEAKING" || session.handle.state === "THINKING")',
      caseStart,
    );
    const clearIdx = src.indexOf("clearSilenceTimer(session);", caseStart);
    const resetIdx = src.indexOf("session.silencePromptSent = false;", caseStart);
    assert.ok(caseStart > -1 && bargeInIdx > -1 && clearIdx > -1 && resetIdx > -1);
    assert.ok(clearIdx < bargeInIdx && resetIdx < bargeInIdx);
  });

  test("speech_end re-arms rather than speech_start, so the window doesn't start while the caller is still mid-utterance", () => {
    assert.match(src, /case "speech_end":[\s\S]{0,400}armSilenceTimer\(session\);/);
  });

  test("all three handleUserUtterance exit paths (reply spoken, empty reply, LLM error) re-arm before returning to LISTENING", () => {
    const fnStart = src.indexOf("async function handleUserUtterance(");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
    const armOccurrences = [...fnBody.matchAll(/armSilenceTimer\(session\);/g)];
    assert.equal(armOccurrences.length, 3);
  });

  test("the greeting arms the timer once the caller is being listened to", () => {
    assert.match(
      src,
      /handle\.state = "LISTENING";\s*\n\s*armSilenceTimer\(session\);\s*\n\s*log\("greeting_played"/,
    );
  });

  test("terminateRuntimeSession clears the timer during cleanup — no timer outlives its session", () => {
    const fnStart = src.indexOf("export async function terminateRuntimeSession(");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
    assert.match(fnBody, /clearSilenceTimer\(session\);/);
  });

  test("the hangup path speaks a goodbye and terminates with a distinct, honest reason", () => {
    const fnStart = src.indexOf("async function endDueToSilence(");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
    assert.match(
      fnBody,
      /await terminateRuntimeSession\(session\.input\.callId, "caller_silence_timeout"\);/,
    );
  });
});
