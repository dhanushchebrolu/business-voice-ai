import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  startRuntimeSession,
  terminateRuntimeSession,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import {
  CLOSING_MESSAGES,
  DEFAULT_CALL_LIFECYCLE_POLICY,
  agentAskedAnythingElse,
  agentSaidGoodbye,
  classifyCallerClosingIntent,
  closingMessageFor,
  isTransientHangupError,
  lifecyclePhaseFor,
  resolveCallLifecyclePolicy,
  type CallLifecyclePolicy,
} from "./call-lifecycle-policy.ts";

/**
 * Universal call lifecycle: every way a call ends (completed conversation,
 * caller's request, silence, repeated questions or errors, caller hang-up,
 * dropped media, maximum length) goes through one closing path — final
 * message, wait for its audio, exactly one provider hang-up, terminate with
 * the transcript persisted. Real voice runtime through the deterministic
 * harness; timers are mocked; the provider hang-up is a counter. No real
 * calls, network or database.
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

async function drain(hops = 400) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

interface Call {
  h: Harness;
  callId: string;
  handle: Awaited<ReturnType<typeof startRuntimeSession>>;
  hangups: string[];
  /** Every queued TTS chunk reports delivered (the audio "finished"). */
  flush: () => void;
  /** Caller says something; the model's next reply is `reply`. */
  turn: (said: string, reply?: string) => Promise<string>;
  spokenSince: (index: number) => string;
}

async function openCall(
  t: { mock: { timers: { enable: () => void } } },
  opts: {
    policy?: Partial<CallLifecyclePolicy>;
    hangup?: () => Promise<void>;
    harness?: Harness;
  } = {},
): Promise<Call> {
  t.mock.timers.enable();
  const h = opts.harness ?? createHarness();
  const hangups: string[] = [];
  const callId = `lifecycle-${crypto.randomUUID()}`;
  const input: StartRuntimeSessionInput = {
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
    callerNumber: "+919876543210",
    services: [],
    ...(opts.policy ? { lifecyclePolicy: opts.policy } : {}),
    requestProviderHangup: async () => {
      hangups.push(h.bridge.closed ? "after_close" : "before_close");
      await opts.hangup?.();
    },
  };
  const handle = await startRuntimeSession(input, h.deps);
  let emitted = 0;
  const flush = () => {
    while (emitted < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      emitted++;
    }
  };
  flush();
  const turn = async (said: string, reply?: string) => {
    flush();
    if (reply !== undefined) h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance(said);
    await drain();
    return h.tts.sentTexts.slice(before).join(" ");
  };
  return {
    h,
    callId,
    handle,
    hangups,
    flush,
    turn,
    spokenSince: (i) => h.tts.sentTexts.slice(i).join(" "),
  };
}

/** Let the final message's audio finish and the closing path run to the end. */
async function finishAudio(call: Call, t: { mock: { timers: { tick: (ms: number) => void } } }) {
  call.flush();
  t.mock.timers.tick(1_000);
  await drain(200);
}

/* ------------------------------------------------------------------ */
/* A/B. Normal completion and explicit requests                         */
/* ------------------------------------------------------------------ */

describe("normal completion ends the call after the final audio, with one hang-up", () => {
  test('an answered enquiry, then "no thanks": farewell, audio, one hang-up, transcript saved', async (t) => {
    const call = await openCall(t);
    const answer = await call.turn(
      "What are your opening hours?",
      "We're open from 9 AM to 6 PM, Monday to Saturday. Is there anything else I can help you with?",
    );
    assert.match(answer, /9 AM to 6 PM/);

    const before = call.h.tts.sentTexts.length;
    await call.turn("No thanks");
    assert.match(call.spokenSince(before), /thank you for calling smile dental/i);
    assert.deepEqual(call.hangups, [], "never before the farewell has played");
    assert.equal(call.h.bridge.closed, false);

    await finishAudio(call, t);
    assert.deepEqual(
      call.hangups,
      ["before_close"],
      "one provider hang-up, then the stream closes",
    );
    assert.equal(call.h.bridge.closed, true);
    assert.equal(call.handle.state, "ended");
    assert.equal(call.h.persistence.records.length, 1, "transcript persisted once");
  });

  test('"goodbye" before any workflow ends the call cleanly', async (t) => {
    const call = await openCall(t);
    await call.turn("Oh sorry, wrong number. Goodbye");
    await finishAudio(call, t);
    assert.deepEqual(call.hangups, ["before_close"]);
    assert.equal(call.handle.state, "ended");
    assert.equal(call.h.llm.calls.length, 0, "no model round trip to say goodbye");
  });

  for (const said of ["Please hang up", "You can end the call now", "Just disconnect"]) {
    test(`"${said}": a brief acknowledgement, then one hang-up — no further questions`, async (t) => {
      const call = await openCall(t);
      const before = call.h.tts.sentTexts.length;
      await call.turn(said);
      const spoken = call.spokenSince(before);
      assert.match(spoken, /^of course\. thank you for calling smile dental/i);
      assert.doesNotMatch(spoken, /\?/, "never asks the caller anything else");
      await finishAudio(call, t);
      assert.deepEqual(call.hangups, ["before_close"]);
      assert.equal(call.handle.state, "ended");
    });
  }

  test('"that\'s all" at any point ends the call', async (t) => {
    const call = await openCall(t);
    await call.turn("What's your address?", "We're at 12 MG Road, Bengaluru.");
    await call.turn("Okay, that's all");
    await finishAudio(call, t);
    assert.deepEqual(call.hangups, ["before_close"]);
  });

  test('"don\'t hang up" never ends the call', async (t) => {
    const call = await openCall(t);
    await call.turn("Don't hang up, I need to check something", "Of course, take your time.");
    t.mock.timers.tick(1_000);
    await drain();
    assert.deepEqual(call.hangups, []);
    assert.notEqual(call.handle.state, "ended");
    await terminateRuntimeSession(call.callId, "test cleanup");
  });

  test("a follow-up question after a completed request keeps the call open, and re-opens normal silence handling", async (t) => {
    const call = await openCall(t);
    await call.turn(
      "Do you do teeth cleaning?",
      "Yes, we offer teeth cleaning. Is there anything else I can help you with?",
    );
    const reply = await call.turn("Yes, how much does it cost?", "Teeth cleaning is 800 rupees.");
    assert.match(reply, /800 rupees/);
    call.flush();
    const before = call.h.tts.sentTexts.length;
    t.mock.timers.tick(DEFAULT_CALL_LIFECYCLE_POLICY.silencePromptMs);
    await drain();
    assert.match(
      call.spokenSince(before),
      /still there/i,
      "an open conversation gets the prompt, not a farewell",
    );
    assert.deepEqual(call.hangups, []);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });

  test('silence after the agent asked "anything else?" ends with a farewell — no prompt', async (t) => {
    const call = await openCall(t);
    await call.turn(
      "Are you open on Sunday?",
      "No, we're closed on Sundays. Is there anything else I can help you with?",
    );
    call.flush();
    const before = call.h.tts.sentTexts.length;
    t.mock.timers.tick(DEFAULT_CALL_LIFECYCLE_POLICY.silencePromptMs);
    await drain(200);
    const spoken = call.spokenSince(before);
    assert.match(spoken, /thank you for calling/i);
    assert.doesNotMatch(spoken, /still there/i);
    await finishAudio(call, t);
    assert.deepEqual(call.hangups, ["before_close"]);
  });

  test("when the agent already said goodbye, silence hangs up without a second goodbye", async (t) => {
    const call = await openCall(t);
    await call.turn("Thanks for the help", "You're welcome. Have a great day!");
    call.flush();
    const before = call.h.tts.sentTexts.length;
    t.mock.timers.tick(DEFAULT_CALL_LIFECYCLE_POLICY.silencePromptMs);
    await drain(200);
    await finishAudio(call, t);
    assert.equal(call.spokenSince(before), "", "nothing more is said");
    assert.deepEqual(call.hangups, ["before_close"]);
  });
});

/* ------------------------------------------------------------------ */
/* C. Silence                                                           */
/* ------------------------------------------------------------------ */

describe("silence: one prompt, then a goodbye and one hang-up", () => {
  test("prompts once, then ends within the configured limits — never a second prompt", async (t) => {
    const call = await openCall(t, { policy: { silencePromptMs: 20_000, silenceHangupMs: 8_000 } });
    const before = call.h.tts.sentTexts.length;
    t.mock.timers.tick(19_000);
    await drain();
    assert.equal(call.spokenSince(before), "", "not before the configured interval");
    t.mock.timers.tick(1_000);
    await drain();
    assert.match(call.spokenSince(before), /still there/i);
    call.flush();
    t.mock.timers.tick(8_000);
    await drain(200);
    const spoken = call.spokenSince(before);
    assert.equal(spoken.match(/still there/gi)?.length, 1, "exactly one prompt");
    assert.match(spoken, /end the call here/i);
    await finishAudio(call, t);
    assert.deepEqual(call.hangups, ["before_close"]);
    assert.equal(call.handle.state, "ended");
    assert.equal(call.h.persistence.records.length, 1);
  });

  test("the agent thinking (a slow model) is never counted as caller silence", async (t) => {
    const call = await openCall(t);
    call.h.llm.setDelay(30_000);
    call.h.llm.setNextReply("Here's what I found.");
    call.h.stt.speakUtterance("Can you check something for me?");
    await drain();
    const before = call.h.tts.sentTexts.length;
    t.mock.timers.tick(25_000);
    await drain();
    assert.doesNotMatch(call.spokenSince(before), /still there|end the call/i);
    assert.deepEqual(call.hangups, []);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });
});

/* ------------------------------------------------------------------ */
/* D. Repeated clarification                                            */
/* ------------------------------------------------------------------ */

describe("a repeated question exits the loop", () => {
  test("the same reply a third time becomes an alternative, and the call can then end", async (t) => {
    const call = await openCall(t);
    const q = "Could you tell me which branch you'd like to visit?";
    assert.match(await call.turn("Hmm", q), /which branch/);
    assert.match(await call.turn("What?", q), /which branch/);
    const third = await call.turn("I don't understand", q);
    assert.doesNotMatch(third, /which branch/, "never the same question a third time");
    assert.match(third, /call back|contact the team/i);
    assert.match(third, /anything else/i);
    await call.turn("No thanks");
    await finishAudio(call, t);
    assert.deepEqual(call.hangups, ["before_close"]);
  });

  test("a reply repeated fewer times than the limit is left alone", async (t) => {
    const call = await openCall(t);
    const q = "Could you spell that for me?";
    await call.turn("Dhanush", q);
    assert.match(await call.turn("D H A N U S H", q), /spell that/);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });
});

/* ------------------------------------------------------------------ */
/* I. Wants a person                                                    */
/* ------------------------------------------------------------------ */

describe("asking for a person", () => {
  test("no transfer is invented: an honest answer, and the call continues", async (t) => {
    const call = await openCall(t);
    const reply = await call.turn("Can I talk to a real person please");
    assert.match(reply, /can't transfer you to a person/i);
    assert.match(reply, /anything else/i);
    assert.equal(call.h.llm.calls.length, 0);
    assert.deepEqual(call.hangups, []);
    await call.turn("No, that's all");
    await finishAudio(call, t);
    assert.deepEqual(call.hangups, ["before_close"]);
  });
});

/* ------------------------------------------------------------------ */
/* E. Errors                                                            */
/* ------------------------------------------------------------------ */

describe("errors end the call safely, never silently", () => {
  test("one model failure: an apology and the call continues", async (t) => {
    const call = await openCall(t);
    call.h.llm.setNextError(new Error("model unavailable"));
    const reply = await call.turn("What are your hours?");
    assert.match(reply, /sorry/i);
    assert.deepEqual(call.hangups, []);
    assert.notEqual(call.handle.state, "ended");
    assert.match(await call.turn("Can you tell me your hours?", "We're open 9 to 6."), /9 to 6/);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });

  test("failures in a row end the call with an honest apology and one hang-up", async (t) => {
    const call = await openCall(t);
    call.h.llm.setNextError(new Error("model unavailable"));
    await call.turn("What are your hours?");
    call.h.llm.setNextError(new Error("model unavailable"));
    const before = call.h.tts.sentTexts.length;
    // A real question: a bare "Hello?" is answered without the model.
    await call.turn("Are you open on Sunday?");
    assert.match(call.spokenSince(before), /technical difficulties/i);
    await finishAudio(call, t);
    assert.deepEqual(call.hangups, ["before_close"]);
    assert.equal(call.handle.state, "ended");
    assert.equal(call.h.persistence.records.length, 1);
  });

  test("speech synthesis failing outright still ends the call (bounded), never leaves it open", async (t) => {
    const h = createHarness();
    const original = h.deps.connectTts;
    let ttsDown = false;
    h.deps.connectTts = async (...args) => {
      const conn = await original(...args);
      return {
        ...conn,
        sendText: (text: string) => {
          if (ttsDown) throw new Error("tts unavailable");
          conn.sendText(text);
        },
      };
    };
    const call = await openCall(t, { harness: h });
    ttsDown = true;
    await call.turn("What are your hours?", "We're open 9 to 6.");
    await call.turn("Are you open on Sunday?", "We're open 9 to 6.");
    t.mock.timers.tick(DEFAULT_CALL_LIFECYCLE_POLICY.closingAudioMaxWaitMs);
    await drain(200);
    assert.deepEqual(call.hangups, ["before_close"]);
    assert.equal(call.handle.state, "ended");
  });
});

/* ------------------------------------------------------------------ */
/* Ordering, duplicates and fallbacks                                   */
/* ------------------------------------------------------------------ */

describe("termination ordering and idempotency", () => {
  test("duplicate audio-completion signals and a late terminate still produce exactly one hang-up", async (t) => {
    const call = await openCall(t);
    await call.turn("Bye");
    call.flush();
    call.h.tts.emit({ type: "flushed" });
    call.h.tts.emit({ type: "flushed" });
    t.mock.timers.tick(1_000);
    await drain(200);
    // The provider's completed-call webhook arrives afterwards (duplicated).
    await terminateRuntimeSession(call.callId, "call ended: completed");
    await terminateRuntimeSession(call.callId, "call ended: completed");
    assert.deepEqual(call.hangups, ["before_close"]);
    assert.equal(call.h.persistence.records.length, 1, "transcript persisted exactly once");
  });

  test("audio completion that never arrives: hang up after the closing-audio deadline", async (t) => {
    const call = await openCall(t, { policy: { closingAudioMaxWaitMs: 6_000 } });
    await call.turn("Goodbye");
    t.mock.timers.tick(5_000);
    await drain(200);
    assert.deepEqual(call.hangups, [], "still within the deadline");
    t.mock.timers.tick(1_500);
    await drain(200);
    assert.deepEqual(call.hangups, ["before_close"]);
    assert.equal(call.handle.state, "ended");
  });

  test("a transient hang-up failure is retried once; the call still ends", async (t) => {
    let attempts = 0;
    const call = await openCall(t, {
      hangup: async () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error("Vobiz 503"), { status: 503 });
      },
    });
    await call.turn("Bye");
    await finishAudio(call, t);
    assert.equal(attempts, 2);
    assert.equal(call.handle.state, "ended");
  });

  test("a non-transient hang-up failure (4xx) is not retried; the stream close is the fallback", async (t) => {
    let attempts = 0;
    const call = await openCall(t, {
      hangup: async () => {
        attempts++;
        throw Object.assign(new Error("Vobiz 401"), { status: 401 });
      },
    });
    await call.turn("Bye");
    await finishAudio(call, t);
    assert.equal(attempts, 1);
    assert.equal(call.h.bridge.closed, true);
    assert.equal(call.handle.state, "ended");
  });
});

/* ------------------------------------------------------------------ */
/* F/G. Caller hangs up first; media connection lost                    */
/* ------------------------------------------------------------------ */

describe("the caller or the network ends the call first", () => {
  test("caller hangs up during the final message: no further speech, no hang-up request, transcript saved", async (t) => {
    const call = await openCall(t);
    await call.turn("Bye");
    const spokenAtHangup = call.h.tts.sentTexts.length;
    // Provider's completed-call webhook arrives while the farewell plays.
    await terminateRuntimeSession(call.callId, "call ended: completed");
    await finishAudio(call, t);
    assert.equal(call.h.tts.sentTexts.length, spokenAtHangup, "nothing else is spoken");
    assert.deepEqual(call.hangups, [], "the call is already over — no hang-up request");
    assert.equal(call.handle.state, "ended");
    assert.equal(call.h.persistence.records.length, 1);
  });

  test("the media connection drops mid-conversation, unconfirmed: cleaned up at once, one hang-up after the grace", async (t) => {
    const call = await openCall(t);
    await call.turn("What are your hours?", "We're open 9 to 6.");
    const before = call.h.tts.sentTexts.length;
    call.h.bridge.simulateProviderDisconnect("ws closed (1006)");
    await drain(200);
    assert.equal(call.handle.state, "ended", "the session stops immediately");
    assert.equal(call.h.persistence.records.length, 1);
    assert.deepEqual(call.hangups, [], "waits for the provider to confirm first");
    t.mock.timers.tick(DEFAULT_CALL_LIFECYCLE_POLICY.mediaCloseHangupGraceMs);
    await drain(200);
    assert.deepEqual(call.hangups, ["after_close"], "the live call is not left behind");
    assert.equal(call.spokenSince(before), "", "no goodbye into a dead connection");
  });

  test("normal caller hang-up, confirmed by the provider's webhook after the media close: no hang-up request", async (t) => {
    const call = await openCall(t);
    await call.turn("What are your hours?", "We're open 9 to 6.");
    call.h.bridge.simulateProviderDisconnect("provider stop event");
    await drain(200);
    await terminateRuntimeSession(call.callId, "call ended: completed");
    t.mock.timers.tick(DEFAULT_CALL_LIFECYCLE_POLICY.mediaCloseHangupGraceMs);
    await drain(200);
    assert.deepEqual(call.hangups, []);
    assert.equal(call.handle.state, "ended");
    assert.equal(call.h.persistence.records.length, 1, "transcript persisted once");
  });

  test("normal caller hang-up, webhook before the media close: no hang-up request", async (t) => {
    const call = await openCall(t);
    await call.turn("What are your hours?", "We're open 9 to 6.");
    await terminateRuntimeSession(call.callId, "call ended: completed");
    call.h.bridge.simulateProviderDisconnect("ws closed (1000)");
    t.mock.timers.tick(DEFAULT_CALL_LIFECYCLE_POLICY.mediaCloseHangupGraceMs);
    await drain(200);
    assert.deepEqual(call.hangups, []);
    assert.equal(call.h.persistence.records.length, 1);
  });

  for (const reason of ["provider stop event", "ws closed (1000)"]) {
    test(`"${reason}" with no call-ended webhook: one hang-up after the grace (never trusts the close alone)`, async (t) => {
      const call = await openCall(t);
      call.h.bridge.simulateProviderDisconnect(reason);
      await drain(200);
      t.mock.timers.tick(DEFAULT_CALL_LIFECYCLE_POLICY.mediaCloseHangupGraceMs);
      await drain(200);
      assert.deepEqual(call.hangups, ["after_close"]);
    });
  }

  test("the media connection drops during the farewell: still exactly one hang-up", async (t) => {
    const call = await openCall(t);
    await call.turn("Bye");
    call.h.bridge.simulateProviderDisconnect("ws closed (1000)");
    await finishAudio(call, t);
    t.mock.timers.tick(DEFAULT_CALL_LIFECYCLE_POLICY.mediaCloseHangupGraceMs);
    await drain(200);
    assert.equal(call.hangups.length, 1);
    assert.equal(call.handle.state, "ended");
    assert.equal(call.h.persistence.records.length, 1);
  });

  test("the media drops while the provider hang-up is in flight: still exactly one hang-up request", async (t) => {
    let release: () => void = () => {};
    const call = await openCall(t, {
      hangup: () => new Promise<void>((resolve) => (release = resolve)),
    });
    await call.turn("Bye");
    call.flush();
    t.mock.timers.tick(1_000);
    await drain();
    assert.equal(call.hangups.length, 1, "the post-farewell hang-up is in progress");
    call.h.bridge.simulateProviderDisconnect("ws closed (1000)");
    await drain();
    t.mock.timers.tick(DEFAULT_CALL_LIFECYCLE_POLICY.mediaCloseHangupGraceMs);
    await drain();
    release();
    await drain();
    assert.equal(call.hangups.length, 1, "the media-loss path reuses the same request");
    assert.equal(call.handle.state, "ended");
    assert.equal(call.h.persistence.records.length, 1);
  });

  test("the runtime closing the media bridge itself is never mistaken for a dropped connection", async (t) => {
    const call = await openCall(t);
    await terminateRuntimeSession(call.callId, "runtime_shutdown");
    t.mock.timers.tick(DEFAULT_CALL_LIFECYCLE_POLICY.mediaCloseHangupGraceMs);
    await drain(200);
    assert.equal(call.h.bridge.closeReason, "closed by application");
    assert.deepEqual(call.hangups, [], "no media-loss hang-up for our own close");
    assert.equal(call.h.persistence.records.length, 1);
  });

  test("a runtime-initiated close of the media bridge never triggers a second hang-up", async (t) => {
    const call = await openCall(t);
    await call.turn("Bye");
    await finishAudio(call, t);
    assert.deepEqual(call.hangups, ["before_close"]);
  });
});

describe("the runtime cannot start: the phone call is ended, not just the stream", () => {
  for (const which of ["stt", "tts"] as const) {
    test(`${which.toUpperCase()} fails to connect: one provider hang-up, session failed, transcript saved`, async (t) => {
      t.mock.timers.enable();
      const failure = new Error(`${which} unavailable`);
      const h = createHarness(
        which === "stt"
          ? { stt: { failConnectWith: failure } }
          : { tts: { failConnectWith: failure } },
      );
      const hangups: string[] = [];
      const startPromise = startRuntimeSession(
        {
          callId: `lifecycle-${crypto.randomUUID()}`,
          organizationId: "o",
          businessId: "b",
          agentConfigId: null,
          agentVersion: 1,
          instructions: "x",
          snapshotAgent: agent,
          businessName: "Smile Dental",
          bridge: h.bridge,
          requestProviderHangup: async () => {
            hangups.push(h.bridge.closed ? "after_close" : "before_close");
          },
        },
        h.deps,
      );
      // The STT-failure apology is spoken first; let its audio finish.
      for (let i = 0; i < 20; i++) {
        await drain();
        for (let k = 0; k < h.tts.sentTexts.length; k++) h.tts.emit({ type: "flushed" });
        t.mock.timers.tick(1_000);
      }
      const handle = await startPromise;
      assert.equal(handle.state, "failed");
      assert.deepEqual(hangups, ["before_close"]);
      assert.equal(h.bridge.closed, true);
      assert.equal(h.persistence.records.length, 1);
    });
  }
});

/* ------------------------------------------------------------------ */
/* H. Long calls                                                        */
/* ------------------------------------------------------------------ */

describe("maximum call length", () => {
  test("closes politely when the limit passes while waiting on the caller", async (t) => {
    const call = await openCall(t, {
      policy: { maxCallDurationMs: 5 * 60_000, silencePromptMs: 10 * 60_000 },
    });
    const before = call.h.tts.sentTexts.length;
    t.mock.timers.tick(5 * 60_000);
    await drain(200);
    assert.match(call.spokenSince(before), /time limit for this call/i);
    await finishAudio(call, t);
    assert.deepEqual(call.hangups, ["before_close"]);
  });

  test("never cuts off an in-flight turn: waits for it, then closes", async (t) => {
    const call = await openCall(t, {
      policy: { maxCallDurationMs: 5 * 60_000, silencePromptMs: 10 * 60_000 },
    });
    t.mock.timers.tick(5 * 60_000 - 1_000);
    call.h.llm.setDelay(4_000);
    // (Not a booking claim: nothing was booked, so one would never be spoken.)
    call.h.llm.setNextReply("We're open on Friday from 9 to 6.");
    call.h.stt.speakUtterance("Are you open on Friday?");
    await drain();
    t.mock.timers.tick(2_000); // limit passed while the model is still working
    await drain();
    assert.deepEqual(call.hangups, []);
    t.mock.timers.tick(2_000); // the turn completes and is spoken
    await drain(200);
    assert.match(call.h.tts.sentTexts.join(" "), /open on Friday/);
    call.flush();
    t.mock.timers.tick(2_000); // next re-check finds the call idle
    await drain(200);
    assert.match(call.h.tts.sentTexts.join(" "), /time limit for this call/i);
    await finishAudio(call, t);
    assert.deepEqual(call.hangups, ["before_close"]);
  });
});

/* ------------------------------------------------------------------ */
/* Policy unit tests                                                    */
/* ------------------------------------------------------------------ */

describe("unit: call lifecycle policy", () => {
  test("closing intents", () => {
    const c = (text: string, awaiting = false, hasNewRequest = false) =>
      classifyCallerClosingIntent(text, { awaitingAnythingElse: awaiting, hasNewRequest });
    assert.equal(c("Please hang up"), "hangup_request");
    assert.equal(c("No, that's all, thanks", true), "hangup_request");
    assert.equal(c("That's it."), "hangup_request");
    assert.equal(c("Goodbye"), "goodbye");
    assert.equal(c("No thanks", true), "nothing_else");
    assert.equal(c("I'm good, thanks", true), "nothing_else");
    assert.equal(c("Can I speak to a human"), "human_requested");
    for (const [text, awaiting] of [
      ["No thanks", false],
      ["Thank you", false],
      ["I'm good", false],
      ["Don't hang up please", false],
      ["my phone keeps disconnecting", false],
      ["You can go ahead and book it", false],
      ["Thanks, what time do you close?", true],
      ["That's all, but can I also book Friday", true],
      ["Yes", true],
    ] as const) {
      assert.equal(c(text, awaiting), null, text);
    }
    assert.equal(c("Bye", false, true), null, "a new request in the same turn is never a closing");
  });

  test("agent replies that ask 'anything else' or say goodbye", () => {
    assert.ok(agentAskedAnythingElse("Is there anything else I can help you with?"));
    assert.ok(agentAskedAnythingElse("Do you have any other questions?"));
    assert.ok(!agentAskedAnythingElse("Which date works for you?"));
    assert.ok(agentSaidGoodbye("Have a great day!"));
    assert.ok(agentSaidGoodbye("Thank you, goodbye."));
    assert.ok(!agentSaidGoodbye("Your appointment is booked."));
  });

  test("closing lines", () => {
    assert.match(closingMessageFor("please hang up", "X"), /^Of course\./);
    assert.equal(closingMessageFor("bye", "X"), CLOSING_MESSAGES.farewell("X"));
  });

  test("policy resolution: defaults, overrides, and safe minimums", () => {
    assert.deepEqual(resolveCallLifecyclePolicy(), DEFAULT_CALL_LIFECYCLE_POLICY);
    const p = resolveCallLifecyclePolicy({
      silencePromptMs: 100,
      repeatedReplyLimit: 1,
      maxCallDurationMs: 60_000,
      humanHandoffAvailable: true,
    });
    assert.equal(p.silencePromptMs, 5_000, "never an aggressive silence hang-up");
    assert.equal(p.repeatedReplyLimit, 2);
    assert.equal(p.maxCallDurationMs, 5 * 60_000);
    assert.equal(p.humanHandoffAvailable, true);
    assert.equal(resolveCallLifecyclePolicy({ maxCallDurationMs: 0 }).maxCallDurationMs, 0);
    assert.equal(
      resolveCallLifecyclePolicy({ silenceHangupMs: Number.NaN }).silenceHangupMs,
      10_000,
    );
  });

  test("lifecycle phases", () => {
    const base = { closing: false, terminating: false, audioPlaying: false };
    assert.equal(lifecyclePhaseFor("listening", base), "ACTIVE");
    assert.equal(lifecyclePhaseFor("thinking", base), "WAITING_FOR_TOOL");
    assert.equal(lifecyclePhaseFor("speaking", base), "WAITING_FOR_AUDIO");
    assert.equal(
      lifecyclePhaseFor("listening", { ...base, audioPlaying: true }),
      "WAITING_FOR_AUDIO",
    );
    assert.equal(lifecyclePhaseFor("speaking", { ...base, closing: true }), "CLOSING");
    assert.equal(lifecyclePhaseFor("listening", { ...base, terminating: true }), "TERMINATING");
    assert.equal(lifecyclePhaseFor("ended", base), "COMPLETED");
    assert.equal(lifecyclePhaseFor("failed", base), "FAILED");
  });

  test("transient hang-up errors", () => {
    assert.ok(isTransientHangupError(Object.assign(new Error(), { status: 503 })));
    assert.ok(isTransientHangupError(new Error("timeout")));
    assert.ok(!isTransientHangupError(Object.assign(new Error(), { status: 401 })));
  });
});
