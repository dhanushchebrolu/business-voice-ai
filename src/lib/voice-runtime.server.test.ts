import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  chunkIntoSentences,
  startRuntimeSession,
  getActiveSession,
  isValidRuntimeTransition,
  type RuntimeState,
} from "./voice-runtime.server.ts";
import type { AudioMediaBridge, AudioFrame } from "./telephony/audio-bridge";
import type { AgentSnapshot } from "./agent-instructions";

const ALL_STATES: RuntimeState[] = [
  "created",
  "connecting",
  "greeting",
  "listening",
  "transcribing",
  "thinking",
  "speaking",
  "interrupted",
  "ending",
  "ended",
  "failed",
];

describe("isValidRuntimeTransition — the runtime state machine", () => {
  test("every state is trivially a valid transition to itself (same-state events are a no-op, never an error)", () => {
    for (const s of ALL_STATES) assert.equal(isValidRuntimeTransition(s, s), true);
  });

  test("the normal happy-path startup sequence is valid: created -> connecting -> greeting -> listening", () => {
    assert.equal(isValidRuntimeTransition("created", "connecting"), true);
    assert.equal(isValidRuntimeTransition("connecting", "greeting"), true);
    assert.equal(isValidRuntimeTransition("greeting", "listening"), true);
  });

  test("the normal turn-taking cycle is valid: listening -> transcribing -> thinking -> speaking -> listening", () => {
    assert.equal(isValidRuntimeTransition("listening", "transcribing"), true);
    assert.equal(isValidRuntimeTransition("transcribing", "thinking"), true);
    assert.equal(isValidRuntimeTransition("thinking", "speaking"), true);
    assert.equal(isValidRuntimeTransition("speaking", "listening"), true);
  });

  test("barge-in is valid from every state the agent could be mid-turn in: greeting/thinking/speaking -> interrupted", () => {
    assert.equal(isValidRuntimeTransition("greeting", "interrupted"), true);
    assert.equal(isValidRuntimeTransition("thinking", "interrupted"), true);
    assert.equal(isValidRuntimeTransition("speaking", "interrupted"), true);
  });

  test("interrupted resolves forward into a new turn (thinking) or back to listening/transcribing", () => {
    assert.equal(isValidRuntimeTransition("interrupted", "thinking"), true);
    assert.equal(isValidRuntimeTransition("interrupted", "listening"), true);
    assert.equal(isValidRuntimeTransition("interrupted", "transcribing"), true);
  });

  test("every non-terminal state can move to ending (a session can be torn down from anywhere)", () => {
    for (const s of ALL_STATES) {
      if (s === "ended" || s === "failed") continue;
      assert.equal(isValidRuntimeTransition(s, "ending"), true, `${s} -> ending should be valid`);
    }
  });

  test("every non-terminal state can move to failed (a runtime error can happen from anywhere)", () => {
    for (const s of ALL_STATES) {
      if (s === "ended" || s === "failed") continue;
      assert.equal(isValidRuntimeTransition(s, "failed"), true, `${s} -> failed should be valid`);
    }
  });

  test("ended and failed are terminal — nothing transitions out of them, not even to each other", () => {
    for (const s of ALL_STATES) {
      assert.equal(isValidRuntimeTransition("ended", s), s === "ended");
      assert.equal(isValidRuntimeTransition("failed", s), s === "failed");
    }
  });

  test("invalid, unreachable jumps are rejected: created -> speaking, listening -> greeting, speaking -> transcribing", () => {
    assert.equal(isValidRuntimeTransition("created", "speaking"), false);
    assert.equal(isValidRuntimeTransition("listening", "greeting"), false);
    assert.equal(isValidRuntimeTransition("speaking", "transcribing"), false);
  });

  test("a session cannot go backwards from ending to a live conversational state", () => {
    for (const s of [
      "greeting",
      "listening",
      "transcribing",
      "thinking",
      "speaking",
      "interrupted",
    ] as const) {
      assert.equal(isValidRuntimeTransition("ending", s), false);
    }
  });
});

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

test("startRuntimeSession: without SARVAM_API_KEY, fails closed into 'failed' (never throws)", async () => {
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
  assert.equal(handle.state, "failed");
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

  test("armSilenceTimer only ever arms while waiting on the caller (listening/transcribing/interrupted)", () => {
    const fnStart = src.indexOf("function armSilenceTimer(session: Session) {");
    const fnBody = src.slice(fnStart, src.indexOf("\n}\n", fnStart));
    assert.match(fnBody, /if \(!isAwaitingCaller\(session\.handle\.state\)\) return;/);
    const isAwaitingCallerBody = src.slice(
      src.indexOf("function isAwaitingCaller(state: RuntimeState): boolean {"),
      src.indexOf(
        "\n}\n",
        src.indexOf("function isAwaitingCaller(state: RuntimeState): boolean {"),
      ),
    );
    assert.match(isAwaitingCallerBody, /state === "listening"/);
    assert.match(isAwaitingCallerBody, /state === "transcribing"/);
    assert.match(isAwaitingCallerBody, /state === "interrupted"/);
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
      'if (state === "greeting" || state === "speaking" || state === "thinking")',
      caseStart,
    );
    const clearIdx = src.indexOf("clearSilenceTimer(session);", caseStart);
    const resetIdx = src.indexOf("session.silencePromptSent = false;", caseStart);
    assert.ok(caseStart > -1 && bargeInIdx > -1 && clearIdx > -1 && resetIdx > -1);
    assert.ok(clearIdx < bargeInIdx && resetIdx < bargeInIdx);
  });

  test("barge-in works during the greeting too, not only during later speaking/thinking turns", () => {
    const caseStart = src.indexOf('case "speech_start": {');
    const caseEnd = src.indexOf('case "speech_end":', caseStart);
    const caseBody = src.slice(caseStart, caseEnd);
    assert.match(caseBody, /state === "greeting"/);
    assert.match(caseBody, /setState\(session, "interrupted"\);/);
  });

  test("speech_start while listening (or waiting_on_payment, Phase 4) moves to transcribing (a distinct, explicit state)", () => {
    const caseStart = src.indexOf('case "speech_start": {');
    const caseEnd = src.indexOf('case "speech_end":', caseStart);
    const caseBody = src.slice(caseStart, caseEnd);
    assert.match(
      caseBody,
      /else if \(state === "listening" \|\| state === "waiting_on_payment"\) \{\s*\n\s*setState\(session, "transcribing"\);/,
    );
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
      /setState\(session, "listening"\);\s*\n\s*armSilenceTimer\(session\);\s*\n\s*log\("greeting_played"/,
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

/**
 * stt:transcript_final_forwarded (production incident round 4): once
 * sarvam-realtime.server.ts's transcript field-name bug was fixed
 * (`text` vs `transcript`), final_transcript events finally reach
 * onSttEvent — but nothing here proved they actually reach
 * handleUserUtterance, the only path to the LLM and a spoken reply, versus
 * being silently dropped by the duplicate-delivery guard or an empty
 * string. Source-scanned since onSttEvent/handleUserUtterance aren't
 * exported (same convention as the silence-timer suite above).
 */
describe("stt:transcript_final_forwarded — verifies a final transcript actually reaches handleUserUtterance (the LLM/reply path), not just that an event fired", () => {
  function finalTranscriptCaseBody() {
    const caseStart = src.indexOf('case "final_transcript": {');
    const caseEnd = src.indexOf('case "language_detected"', caseStart);
    return src.slice(caseStart, caseEnd);
  }

  test("the duplicate-delivery guard logs forwarded:false with reason duplicate_within_window and never reaches handleUserUtterance", () => {
    const body = finalTranscriptCaseBody();
    const dupGuardIdx = body.indexOf('log("duplicate_final_transcript_ignored"');
    const dupBreakIdx = body.indexOf("break;", dupGuardIdx);
    const dupSection = body.slice(dupGuardIdx, dupBreakIdx);
    assert.match(dupSection, /log\("stt:transcript_final_forwarded", session, \{/);
    assert.match(dupSection, /forwarded: false/);
    assert.match(dupSection, /reason: "duplicate_within_window"/);
    assert.doesNotMatch(dupSection, /handleUserUtterance/);
  });

  test("an empty event.text logs forwarded:false with reason empty_text and never reaches handleUserUtterance", () => {
    const body = finalTranscriptCaseBody();
    const emptyGuardIdx = body.indexOf("if (!event.text) {");
    assert.ok(emptyGuardIdx > -1, "expected an explicit empty-text guard");
    const emptyBreakIdx = body.indexOf("break;", emptyGuardIdx);
    const emptySection = body.slice(emptyGuardIdx, emptyBreakIdx);
    assert.match(emptySection, /log\("stt:transcript_final_forwarded", session, \{/);
    assert.match(emptySection, /forwarded: false/);
    assert.match(emptySection, /reason: "empty_text"/);
    assert.doesNotMatch(emptySection, /handleUserUtterance/);
  });

  test("a valid, non-duplicate, non-empty transcript logs forwarded:true with reason ok and then calls handleUserUtterance with that same text", () => {
    const body = finalTranscriptCaseBody();
    const okLogIdx = body.lastIndexOf('log("stt:transcript_final_forwarded", session, {');
    const callIdx = body.indexOf("void handleUserUtterance(session, event.text);", okLogIdx);
    assert.ok(callIdx > okLogIdx, "the forwarded:true log must precede the actual call");
    const okSection = body.slice(okLogIdx, callIdx);
    assert.match(okSection, /forwarded: true/);
    assert.match(okSection, /reason: "ok"/);
  });

  test("none of the three stt:transcript_final_forwarded log calls include the transcript text itself — only textLength", () => {
    const body = finalTranscriptCaseBody();
    const logCalls =
      body.match(/log\("stt:transcript_final_forwarded", session, \{[\s\S]*?\}\);/g) ?? [];
    assert.equal(logCalls.length, 3, "expected exactly three call sites: duplicate, empty, and ok");
    for (const call of logCalls) {
      assert.match(call, /textLength:/);
      assert.doesNotMatch(
        call,
        /\btext:/,
        "must never pass the transcript text itself, only its length",
      );
    }
  });
});

/**
 * Format-verification diagnostic (production incident follow-up): once
 * Sarvam's TTS config schema bugs were fixed (model moved to a WS URL query
 * param, the bogus output_audio_bitrate field removed), nothing in this
 * codebase actually confirmed Sarvam's synthesized audio matches the
 * format declared to it — the Vobiz bridge trusts frame bytes as mulaw/8kHz
 * without checking. onTtsEvent now logs a one-time comparison on the first
 * audio chunk of each session, source-scanned here since onTtsEvent/Session
 * aren't exported (same convention as the silence-timer suite above).
 */
describe("first_outbound_audio_frame — verifies synthesized audio format against what was declared, rather than assuming a match", () => {
  test("fires exactly once per session, gated by firstOutboundAudioFrameLogged, inside the audio case", () => {
    const caseStart = src.indexOf('case "audio": {', src.indexOf("function onTtsEvent"));
    const caseEnd = src.indexOf('case "error":', caseStart);
    const caseBody = src.slice(caseStart, caseEnd);
    assert.match(caseBody, /if \(!session\.firstOutboundAudioFrameLogged\) \{/);
    assert.match(caseBody, /session\.firstOutboundAudioFrameLogged = true;/);
    assert.match(caseBody, /log\("first_outbound_audio_frame", session, \{/);
  });

  test("logs the declared codec/sample rate alongside whatever metadata Sarvam's own audio event carried, never a guessed field", () => {
    const caseStart = src.indexOf('case "audio": {', src.indexOf("function onTtsEvent"));
    const caseEnd = src.indexOf('case "error":', caseStart);
    const caseBody = src.slice(caseStart, caseEnd);
    assert.match(caseBody, /declaredCodec: session\.declaredTtsOutputCodec/);
    assert.match(caseBody, /declaredSampleRateHz: session\.declaredTtsOutputSampleRateHz/);
    assert.match(caseBody, /sarvamMeta: event\.meta/);
  });

  test("declaredTtsOutputCodec/declaredTtsOutputSampleRateHz are set from the same values actually sent to connectTts, not re-derived separately", () => {
    const connectIdx = src.indexOf("session.tts = await deps.connectTts({");
    const before = src.slice(Math.max(0, connectIdx - 400), connectIdx);
    assert.match(before, /session\.declaredTtsOutputCodec = outputCodec;/);
    assert.match(before, /session\.declaredTtsOutputSampleRateHz = outputSampleRateHz;/);
  });

  test("its own comment states plainly that this diagnostic is verification only, not the mechanism that makes the format correct", () => {
    const caseStart = src.indexOf('case "audio": {', src.indexOf("function onTtsEvent"));
    const logIdx = src.indexOf('log("first_outbound_audio_frame"', caseStart);
    const comment = src.slice(caseStart, logIdx);
    assert.match(comment, /VERIFICATION ONLY/);
    assert.match(comment, /does not itself guarantee the audio[\s\S]*format is correct/);
  });

  test("no resampling/transcoding: event.data is forwarded to the bridge byte-for-byte, never passed through a transform call first", () => {
    const caseStart = src.indexOf('case "audio": {', src.indexOf("function onTtsEvent"));
    const caseEnd = src.indexOf('case "error":', caseStart);
    const caseBody = src.slice(caseStart, caseEnd);
    assert.match(
      caseBody,
      /const frame: AudioFrame = \{ data: event\.data, timestampMs: Date\.now\(\) - session\.startedAt \};/,
      "the AudioFrame handed to the bridge must use event.data verbatim — any resample()/transcode()-style wrapper here would mean the declared format and the actual bytes could silently diverge",
    );
    assert.doesNotMatch(caseBody, /resample|transcode|convertSampleRate/i);
  });
});

/**
 * Provider adapter boundary (requirement 8): the AI runtime must not know
 * whether audio came from Exotel, Twilio, Plivo, SIP, or a test harness —
 * it programs only against AudioMediaBridge (audio-bridge.ts) and
 * RuntimeDeps. A source scan for provider-specific tokens is the most
 * direct proof of this: if any of these ever appear in this file (or in
 * sarvam-realtime.server.ts, the Sarvam STT/TTS client this file drives),
 * that is itself the isolation violation, whatever the surrounding code
 * happens to do.
 */
describe("provider adapter boundary — voice-runtime.server.ts stays provider-neutral", () => {
  // Doc comments are allowed to *explain* the boundary (e.g. "Exotel is one
  // concrete AudioMediaBridge implementation") without violating it — what
  // must never appear is provider-specific identifiers in actual code:
  // imports, variable/field names, protocol event strings. Strip /** */
  // block comments before scanning so documentation prose doesn't trip this.
  function stripBlockComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, "");
  }

  const PROVIDER_SPECIFIC_TOKENS = [
    /\bexotel\b/i,
    /CallSid/,
    /stream_sid/i,
    /streamSid/,
    /\btwilio\b/i,
    /\bplivo\b/i,
  ];

  test("voice-runtime.server.ts's code (outside doc comments) contains no Exotel/Twilio/Plivo-specific identifiers", () => {
    const code = stripBlockComments(src);
    for (const pattern of PROVIDER_SPECIFIC_TOKENS) {
      assert.doesNotMatch(code, pattern, `found provider-specific token matching ${pattern}`);
    }
  });

  test("sarvam-realtime.server.ts (the STT/TTS client this file drives) is equally provider-neutral on the telephony side", () => {
    const sarvamRealtimeSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "sarvam-realtime.server.ts"),
      "utf8",
    );
    const code = stripBlockComments(sarvamRealtimeSrc);
    for (const pattern of PROVIDER_SPECIFIC_TOKENS) {
      assert.doesNotMatch(code, pattern, `found provider-specific token matching ${pattern}`);
    }
  });

  test("the only telephony-layer import is the provider-neutral AudioMediaBridge/AudioFrame contract, never a concrete adapter", () => {
    assert.match(
      src,
      /import type \{ AudioMediaBridge, AudioFrame \} from "\.\/telephony\/audio-bridge\.ts";/,
    );
    assert.doesNotMatch(
      stripBlockComments(src),
      /exotel-media-bridge|exotel-provider|ExotelMediaBridge|ExotelTelephonyAdapter/i,
    );
  });
});
