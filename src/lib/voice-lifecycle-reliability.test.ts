import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  callOutcomeFor,
  claimsTransferOrCallback,
  mergeAppointmentState,
  emptyAppointmentState,
  startRuntimeSession,
  terminateRuntimeSession,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { callerClosingIntentAnyLanguage } from "./voice-call-outcomes.ts";
import { resolveCallLifecyclePolicy, type CallLifecyclePolicy } from "./call-lifecycle-policy.ts";
import { withCurrentCallSections, type AgentSnapshot } from "./agent-instructions.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Call lifecycle reliability: how a call ends (a caller's goodbye in any of
 * the supported languages, silence, a failed or hanging goodbye, the
 * provider's own call-ended event), what may still happen after it ends
 * (nothing), a slow turn's holding line, today's date for every call, and
 * the outcome recorded for the call. Real runtime through the deterministic
 * harness; timers are mocked; the provider hang-up is a counter.
 */

const agent: AgentSnapshot["agent"] = {
  agent_name: "Aria",
  persona: "professional",
  custom_personality: null,
  objectives: ["answer_questions"],
  capabilities: {},
  primary_language: "en-IN",
  extra_languages: [],
  multilingual: true,
  voice_id: "ritu",
  speaking_pace: 1,
  greetings: { "en-IN": "Hello, thanks for calling Smile Dental." },
  transfer_number: null,
  after_hours_behavior: "take_message",
};

async function drain(hops = 400) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

type Timers = {
  mock: {
    timers: { enable: (opts?: { apis: "setTimeout"[] }) => void; tick: (ms: number) => void };
  };
};

async function openCall(
  t: Timers,
  opts: {
    policy?: Partial<CallLifecyclePolicy>;
    input?: Partial<StartRuntimeSessionInput>;
    /** Keep the real clock (only setTimeout mocked): for anything that depends on today's date. */
    realClock?: boolean;
  } = {},
) {
  // Several calls in one test share the clock already mocked by the first.
  try {
    if (opts.realClock) t.mock.timers.enable({ apis: ["setTimeout"] });
    else t.mock.timers.enable();
  } catch (err) {
    if ((err as { code?: string }).code !== "ERR_INVALID_STATE") throw err;
  }
  const h: Harness = createHarness();
  const hangups: string[] = [];
  const callId = `reliability-${crypto.randomUUID()}`;
  const handle = await startRuntimeSession(
    {
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
      lifecyclePolicy: opts.policy ?? {},
      requestProviderHangup: async () => {
        hangups.push(h.bridge.closed ? "after_close" : "before_close");
      },
      ...opts.input,
    },
    h.deps,
  );
  const flush = () => {
    for (let i = 0; i < h.tts.sentTexts.length; i++) h.tts.emit({ type: "flushed" });
  };
  flush();
  const turn = async (said: string, reply?: string, language = "en-IN") => {
    flush();
    if (reply !== undefined) h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance(said, language);
    await drain();
    return h.tts.sentTexts.slice(before).join(" ");
  };
  /** The final message's audio finishes and the closing path runs to the end. */
  const finishAudio = async () => {
    flush();
    t.mock.timers.tick(1_000);
    await drain(200);
  };
  return { h, callId, handle, hangups, flush, turn, finishAudio };
}

/** Captures this module's structured logs (event names only) while `fn` runs. */
async function withLogs<T>(fn: () => Promise<T>): Promise<{ result: T; events: string[] }> {
  const events: string[] = [];
  const original = console.info;
  console.info = (first: unknown, ...rest: unknown[]) => {
    if (typeof first === "string") events.push(first);
    void rest;
  };
  try {
    return { result: await fn(), events };
  } finally {
    console.info = original;
  }
}

/* ------------------------------------------------------------------ */
/* The caller asks to end the call                                     */
/* ------------------------------------------------------------------ */

describe("a caller's request to end the call, in every supported way of saying it", () => {
  test("recognized in Telugu, romanized Telugu, Hindi and romanized Hindi; never a negation, a pause or a sentence", () => {
    for (const said of [
      "ఫోన్ పెట్టేయండి",
      "కాల్ కట్ చేయండి",
      "ఇక చాలు",
      "phone pettestanu",
      "call cut cheyyandi",
      "inka chaalu",
      "फ़ोन रख दीजिए",
      "कॉल काट दो",
      "बस इतना ही",
      "phone rakh do",
      "bas itna hi",
    ]) {
      assert.equal(
        callerClosingIntentAnyLanguage(said, { awaitingAnythingElse: false }),
        "hangup_request",
        said,
      );
    }
    for (const said of ["సరే ఉంటానండి", "ఉంటాను", "sare untanu", "बाय"]) {
      assert.equal(
        callerClosingIntentAnyLanguage(said, { awaitingAnythingElse: false }),
        "goodbye",
        said,
      );
    }
    for (const said of [
      "ఫోన్ పెట్టకండి",
      "phone pettakandi",
      "फोन मत रखना",
      "phone mat rakhna",
      "నేను లైన్‌లో ఉంటాను", // "I'll stay on the line"
      "",
      "   ",
      "हम्म",
    ]) {
      assert.equal(
        callerClosingIntentAnyLanguage(said, { awaitingAnythingElse: false }),
        null,
        JSON.stringify(said),
      );
    }
  });

  for (const [said, language] of [
    ["ఫోన్ పెట్టేయండి", "te-IN"],
    ["call cut cheyyandi", "te-IN"],
    ["फ़ोन रख दीजिए", "hi-IN"],
  ] as const) {
    test(`"${said}": a goodbye, then exactly one hang-up after its audio — no model round trip`, async (t) => {
      const call = await openCall(t);
      const llmCalls = call.h.llm.calls.length;
      const goodbye = await call.turn(said, undefined, language);
      assert.ok(goodbye.length > 0, "a goodbye is said");
      assert.equal(call.h.llm.calls.length, llmCalls, "no model call to say goodbye");
      assert.deepEqual(call.hangups, [], "never before the goodbye has played");
      await call.finishAudio();
      assert.deepEqual(call.hangups, ["before_close"]);
      assert.equal(call.handle.state, "ended");
      assert.equal(call.h.persistence.records.length, 1);
    });
  }

  test("'don't hang up' and an empty transcript never end the call", async (t) => {
    const call = await openCall(t);
    await call.turn("ఫోన్ పెట్టకండి", "సరే, నేను ఇక్కడే ఉన్నాను.", "te-IN");
    call.h.stt.emit({ type: "speech_start" });
    call.h.stt.emit({ type: "final_transcript", text: "", language: "en-IN" });
    await drain();
    await call.finishAudio();
    assert.deepEqual(call.hangups, []);
    assert.notEqual(call.handle.state, "ended");
    await terminateRuntimeSession(call.callId, "test cleanup");
  });
});

/* ------------------------------------------------------------------ */
/* Silence: check-in, final notice, goodbye — and resumed speech       */
/* ------------------------------------------------------------------ */

describe("silence recovery starts over whenever the caller speaks", () => {
  const policy = { silencePromptMs: 12_000, silenceFinalNoticeMs: 8_000, silenceHangupMs: 10_000 };

  test("speech after the check-in: the next silence gets a check-in again, not the final notice", async (t) => {
    const call = await openCall(t, { policy });
    t.mock.timers.tick(12_000);
    await drain();
    assert.match(call.h.tts.sentTexts.join(" "), /still there/i);
    await call.turn("Sorry, I'm here. What are your hours?", "We're open nine to six.");
    call.flush();
    const before = call.h.tts.sentTexts.length;
    t.mock.timers.tick(8_000);
    await drain();
    assert.equal(call.h.tts.sentTexts.length, before, "the stages restarted: nothing at 8 s");
    t.mock.timers.tick(4_000);
    await drain();
    const said = call.h.tts.sentTexts.slice(before).join(" ");
    assert.match(said, /still there/i, said);
    assert.doesNotMatch(said, /end the call/i, said);
    assert.deepEqual(call.hangups, []);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });

  test("speech after the final notice: the call goes on, no goodbye, no hang-up", async (t) => {
    const call = await openCall(t, { policy });
    t.mock.timers.tick(12_000);
    await drain();
    call.flush();
    t.mock.timers.tick(8_000);
    await drain();
    assert.match(call.h.tts.sentTexts.join(" "), /end the call shortly/i);
    await call.turn("Yes, yes, I'm here", "Great, how can I help?");
    call.flush();
    t.mock.timers.tick(10_000);
    await drain();
    assert.doesNotMatch(call.h.tts.sentTexts.join(" "), /end the call here/i);
    assert.deepEqual(call.hangups, []);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });

  test("the final notice can be turned off: check-in, then the goodbye (the earlier behaviour)", async (t) => {
    const call = await openCall(t, { policy: { ...policy, silenceFinalNoticeMs: 0 } });
    t.mock.timers.tick(12_000);
    await drain();
    call.flush();
    t.mock.timers.tick(10_000);
    await drain();
    const said = call.h.tts.sentTexts.join(" ");
    assert.doesNotMatch(said, /end the call shortly/i);
    assert.match(said, /end the call here/i);
    await call.finishAudio();
    assert.deepEqual(call.hangups, ["before_close"]);
    assert.equal(call.h.persistence.records[0]?.outcome, "silence_timeout");
  });

  test("policy floors: a final notice is never under 3 s; 0 turns it off", () => {
    assert.equal(
      resolveCallLifecyclePolicy({ silenceFinalNoticeMs: 100 }).silenceFinalNoticeMs,
      3_000,
    );
    assert.equal(resolveCallLifecyclePolicy({ silenceFinalNoticeMs: 0 }).silenceFinalNoticeMs, 0);
    assert.equal(resolveCallLifecyclePolicy({ holdingResponseMs: 100 }).holdingResponseMs, 1_500);
    assert.equal(resolveCallLifecyclePolicy({ holdingResponseMs: -1 }).holdingResponseMs, 0);
  });
});

/* ------------------------------------------------------------------ */
/* A slow turn: one holding line, cancelled when it isn't needed        */
/* ------------------------------------------------------------------ */

describe("a slow turn gets one holding line", () => {
  test("a reply faster than holdingResponseMs: no holding line", async (t) => {
    const call = await openCall(t);
    call.h.llm.setDelay(1_000);
    call.h.llm.setNextReply("We're open nine to six.");
    const before = call.h.tts.sentTexts.length;
    call.h.stt.speakUtterance("What are your hours?");
    await drain();
    t.mock.timers.tick(1_000);
    await drain();
    t.mock.timers.tick(5_000);
    await drain();
    const said = call.h.tts.sentTexts.slice(before).join(" ");
    assert.doesNotMatch(said, /One moment/, said);
    assert.match(said, /nine to six/, said);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });

  test("a slow reply: exactly one holding line at 3 s, then the answer", async (t) => {
    const call = await openCall(t);
    call.h.llm.setDelay(9_000);
    call.h.llm.setNextReply("We're open nine to six.");
    const before = call.h.tts.sentTexts.length;
    call.h.stt.speakUtterance("What are your hours?");
    await drain();
    t.mock.timers.tick(3_000);
    await drain();
    assert.deepEqual(call.h.tts.sentTexts.slice(before), ["One moment, please."]);
    t.mock.timers.tick(6_000);
    await drain();
    const said = call.h.tts.sentTexts.slice(before);
    assert.equal(said.filter((s) => /One moment/.test(s)).length, 1, "never twice");
    assert.match(said.join(" "), /nine to six/);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });

  test("the call ends while the turn is slow: no holding line into an ended call", async (t) => {
    const call = await openCall(t);
    call.h.llm.setDelay(9_000);
    call.h.stt.speakUtterance("What are your hours?");
    await drain();
    await terminateRuntimeSession(call.callId, "call ended: completed");
    const before = call.h.tts.sentTexts.length;
    t.mock.timers.tick(30_000);
    await drain();
    assert.equal(call.h.tts.sentTexts.length, before, "nothing said after the end");
    assert.equal(call.handle.state, "ended", "a late reply never revives it");
  });
});

/* ------------------------------------------------------------------ */
/* Ending reliably, whatever goes wrong                                */
/* ------------------------------------------------------------------ */

describe("a warranted hang-up always happens, exactly once", () => {
  test("the voice is gone and can't reconnect: no goodbye can be said, and the call still ends once", async (t) => {
    const call = await openCall(t);
    call.h.tts.emit({ type: "closed", code: 1011, reason: "test" });
    call.h.deps.connectTts = async () => {
      throw new Error("TTS unavailable");
    };
    await call.turn("Goodbye");
    t.mock.timers.tick(20_000);
    await drain(400);
    assert.equal(call.hangups.length, 1, "one hang-up request");
    assert.equal(call.handle.state, "ended");
    assert.equal(call.h.persistence.records.length, 1);
  });

  test("the voice reconnect hangs forever: the goodbye wait is bounded and the call still ends", async (t) => {
    const call = await openCall(t);
    call.h.tts.emit({ type: "closed", code: 1011, reason: "test" });
    call.h.deps.connectTts = () => new Promise(() => {});
    await call.turn("Goodbye");
    t.mock.timers.tick(20_000);
    await drain(400);
    t.mock.timers.tick(20_000);
    await drain(400);
    assert.equal(call.hangups.length, 1);
    assert.equal(call.handle.state, "ended");
  });

  test("the provider reports the call ended during the goodbye, twice: no hang-up request, one transcript", async (t) => {
    const call = await openCall(t);
    await call.turn("Goodbye");
    await terminateRuntimeSession(call.callId, "call ended: completed");
    await terminateRuntimeSession(call.callId, "call ended: completed");
    await call.finishAudio();
    t.mock.timers.tick(20_000);
    await drain();
    assert.deepEqual(call.hangups, [], "the caller is already gone");
    assert.equal(call.h.persistence.records.length, 1, "persisted exactly once");
    assert.equal(call.handle.state, "ended");
  });
});

describe("nothing happens after a call has ended", () => {
  test("a late model reply, a late transcript and every timer: no speech, no model call, no revival", async (t) => {
    const call = await openCall(t);
    call.h.llm.setDelay(5_000);
    call.h.llm.setNextReply("Here are our hours.");
    call.h.stt.speakUtterance("What are your hours?");
    await drain();
    await terminateRuntimeSession(call.callId, "call ended: completed");
    const spoken = call.h.tts.sentTexts.length;
    const llmCalls = call.h.llm.calls.length;
    t.mock.timers.tick(5_000); // the late reply resolves
    await drain();
    try {
      call.h.stt.emit({ type: "speech_start" });
      call.h.stt.emit({ type: "final_transcript", text: "hello?", language: "en-IN" });
    } catch {
      /* a closed recognizer may refuse events: that is also "nothing" */
    }
    await drain();
    t.mock.timers.tick(5 * 60_000); // silence, holding, recovery, max-duration timers
    await drain();
    assert.equal(call.h.tts.sentTexts.length, spoken, "no speech after the end");
    assert.equal(call.h.llm.calls.length, llmCalls, "no new model call");
    assert.deepEqual(call.hangups, [], "the provider already ended it");
    assert.equal(call.handle.state, "ended");
    assert.equal(call.h.persistence.records.length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* What is recorded for the call                                       */
/* ------------------------------------------------------------------ */

describe("call outcome and transcript persistence", () => {
  test("outcomes come from what happened, in priority order", () => {
    const base = {
      failed: false,
      reason: "call ended: completed",
      bookingUnresolved: false,
      bookedCount: 0,
      callerTurns: 2,
    };
    assert.equal(callOutcomeFor(base), "completed");
    assert.equal(callOutcomeFor({ ...base, bookedCount: 1 }), "booked");
    assert.equal(
      callOutcomeFor({ ...base, bookedCount: 1, bookingUnresolved: true }),
      "booking_unresolved",
    );
    assert.equal(callOutcomeFor({ ...base, reason: "caller_silence_timeout" }), "silence_timeout");
    assert.equal(callOutcomeFor({ ...base, callerTurns: 0 }), "no_conversation");
    assert.equal(callOutcomeFor({ ...base, failed: true }), "technical_failure");
    assert.equal(callOutcomeFor({ ...base, reason: "repeated_turn_errors" }), "technical_failure");
    assert.equal(callOutcomeFor({ ...base, reason: "stt_unavailable" }), "technical_failure");
    assert.equal(callOutcomeFor({ ...base, reason: "greeting_failed" }), "technical_failure");
  });

  test("a goodbye call records 'completed' with its transcript", async (t) => {
    const call = await openCall(t);
    await call.turn("Goodbye");
    await call.finishAudio();
    assert.equal(call.h.persistence.records[0]?.outcome, "completed");
  });

  test("a failed transcript save is logged as failed — never as saved", async (t) => {
    const call = await openCall(t);
    call.h.persistence.failNext(new Error("call_logs update failed (42501)"));
    const { events } = await withLogs(async () => {
      await terminateRuntimeSession(call.callId, "call ended: completed");
    });
    assert.ok(events.includes("voice_runtime:persist_transcript_failed"), events.join(","));
    assert.ok(!events.includes("voice_runtime:persist_transcript_succeeded"));
    assert.ok(events.includes("voice_runtime:call_outcome"));
  });

  test("the real call_logs write checks Supabase's error result and stores the outcome", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "voice-runtime.server.ts"),
      "utf8",
    );
    const start = src.indexOf("async function persistTranscriptToCallLogs(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    assert.match(body, /const \{ error \} = await supabaseAdmin/);
    assert.match(body, /outcome: record\.outcome/);
    assert.match(body, /if \(error\) throw new Error/);
  });
});

/* ------------------------------------------------------------------ */
/* Today's date, every call                                            */
/* ------------------------------------------------------------------ */

describe("the date a call runs with is the day of the call", () => {
  const published =
    "# PERSONA\nAria.\n\n# CURRENT DATE\nToday is 2026-10-01, Thursday, in Asia/Kolkata. Resolve any relative date against this exact date.\n\n# SAFETY\n- x";

  test("the published 'today' is replaced with the call's own day in the business's timezone", () => {
    const now = new Date("2026-10-30T20:00:00Z"); // 31 October in Kolkata
    const out = withCurrentCallSections(published, agent, undefined, {
      now,
      timezone: "Asia/Kolkata",
    });
    assert.match(out, /Today is Saturday, 2026-10-31, in Asia\/Kolkata/);
    assert.doesNotMatch(out, /2026-10-01/, "the publish-day date is gone");
    assert.match(out, /# PERSONA\nAria\./, "everything else is kept");
    assert.match(
      withCurrentCallSections(published, agent),
      /Today is 2026-10-01/,
      "no call date given: the published date is left as it is",
    );
  });

  test("a past date from the model never becomes the appointment day", () => {
    const today = "2026-10-31";
    const current = emptyAppointmentState();
    const stale = mergeAppointmentState(
      current,
      { preferredDate: "2026-10-02" },
      { preferredDate: "2026-11-01", today },
    );
    assert.equal(
      stale.preferredDate,
      "2026-11-01",
      "the caller's 'tomorrow' wins over a past model date",
    );
    const alone = mergeAppointmentState(
      current,
      { preferredDate: "2026-10-02", service: "Cleaning" },
      { today },
    );
    assert.equal(alone.preferredDate, null, "a past date alone is not accepted");
    const future = mergeAppointmentState(
      current,
      { preferredDate: "2026-11-05" },
      { preferredDate: "2026-11-01", today },
    );
    assert.equal(
      future.preferredDate,
      "2026-11-05",
      "a future model date still decides, as before",
    );
    const unknown = mergeAppointmentState(current, { preferredDate: "2026-10-02" }, {});
    assert.equal(unknown.preferredDate, "2026-10-02", "without a known 'today' nothing changes");
  });

  const day = (offset: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(
      new Date(Date.now() + offset * 86_400_000),
    );
  const dateMarker = (date: string) =>
    `<<<APPT_STATE:${JSON.stringify({
      service: "Cleaning",
      customer_name: null,
      phone: null,
      email: null,
      preferred_date: date,
      preferred_time: null,
      preferred_period: null,
      wants_next_available: false,
      checking_availability: false,
      ready_to_book: false,
    })}>>>`;
  /** One caller turn, the fake model's (mocked-timer) answer, and the date the runtime kept. */
  async function dateAfter(
    t: Timers,
    opts: { timezone: string | null; said: string; modelDate: string },
  ): Promise<{ known: string; events: string[] }> {
    // The timezone is injected (StartRuntimeSessionInput.businessTimezone):
    // no business-row lookup runs, so nothing waits on real I/O.
    const call = await openCall(t, {
      input: opts.timezone ? { businessTimezone: opts.timezone } : {},
      realClock: true,
    });
    const { events } = await withLogs(async () => {
      await call.turn(opts.said, `What time works?\n${dateMarker(opts.modelDate)}`);
      t.mock.timers.tick(100);
      await drain();
      await call.turn("Do you have parking?", `Yes.\n${dateMarker(opts.modelDate)}`);
      t.mock.timers.tick(100);
      await drain();
    });
    const known = (call.h.llm.calls.at(-1) ?? [])
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    await terminateRuntimeSession(call.callId, "test cleanup");
    return { known, events };
  }

  test("through the runtime: the model still on the publish day, the caller says 'tomorrow'", async (t) => {
    const { known, events } = await dateAfter(t, {
      timezone: "UTC",
      said: "Cleaning tomorrow please",
      modelDate: "2020-01-02",
    });
    assert.ok(events.includes("voice_runtime:past_date_rejected"), events.join(","));
    assert.match(known, new RegExp(`preferred date: ${day(1)}`), known);
    assert.doesNotMatch(known, /2020-01-02/);
  });

  test("an explicit 'tomorrow' wins over a different future date from the model", async (t) => {
    const { known, events } = await dateAfter(t, {
      timezone: "UTC",
      said: "Cleaning tomorrow please",
      modelDate: day(2),
    });
    assert.match(known, new RegExp(`preferred date: ${day(1)}`), known);
    assert.ok(events.includes("voice_runtime:date_disagreement_caller_wins"));
  });

  test("Telugu and Hindi explicit days win the same way", async (t) => {
    for (const said of ["రేపు cleaning కావాలి", "कल cleaning चाहिए"]) {
      const { known } = await dateAfter(t, { timezone: "UTC", said, modelDate: day(3) });
      assert.match(known, new RegExp(`preferred date: ${day(1)}`), `${said}: ${known}`);
    }
  });

  test("a weekday, a reminder, or an unknown timezone: the model's reading still stands", async (t) => {
    const weekday = await dateAfter(t, {
      timezone: "UTC",
      said: "Cleaning on Friday please",
      modelDate: day(9),
    });
    assert.match(
      weekday.known,
      new RegExp(`preferred date: ${day(9)}`),
      "this Friday or next is the model's call",
    );
    const reminder = await dateAfter(t, {
      timezone: "UTC",
      said: "Remind me tomorrow about my appointment",
      modelDate: day(4),
    });
    assert.match(
      reminder.known,
      new RegExp(`preferred date: ${day(4)}`),
      "a reminder's day is not the appointment day",
    );
    const noTimezone = await dateAfter(t, {
      timezone: null,
      said: "Cleaning tomorrow please",
      modelDate: day(2),
    });
    assert.match(
      noTimezone.known,
      new RegExp(`preferred date: ${day(2)}`),
      "without the call's timezone 'tomorrow' isn't certain",
    );
  });

  test("merge rule: an explicit caller day wins only when flagged; past dates never win", () => {
    const today = "2026-10-31";
    const current = emptyAppointmentState();
    const model = { preferredDate: "2026-11-03" };
    assert.equal(
      mergeAppointmentState(current, model, {
        preferredDate: "2026-11-01",
        today,
        callerDateExplicit: true,
      }).preferredDate,
      "2026-11-01",
    );
    assert.equal(
      mergeAppointmentState(current, model, { preferredDate: "2026-11-01", today }).preferredDate,
      "2026-11-03",
    );
  });
});

describe("termination and playback are logged as what they are", () => {
  test("a goodbye: playback completion marked estimated; termination says whether the provider confirmed the end", async (t) => {
    const call = await openCall(t);
    await call.turn("Goodbye");
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const original = console.info;
    console.info = (event: unknown, fields?: unknown) => {
      if (typeof event === "string")
        lines.push({ event, fields: (fields ?? {}) as Record<string, unknown> });
    };
    try {
      await call.finishAudio();
    } finally {
      console.info = original;
    }
    const playback = lines.find((l) => l.event === "voice_runtime:final_audio_finished");
    assert.equal(playback?.fields["estimated"], true);
    const ended = lines.find((l) => l.event === "voice_runtime:runtime_terminated");
    assert.equal(ended?.fields["hangup_requested"], true);
    assert.equal(ended?.fields["provider_confirmed_end"], false, "a request is not a confirmation");
  });
});

/* ------------------------------------------------------------------ */
/* No follow-up promised that nobody will keep                         */
/* ------------------------------------------------------------------ */

describe("no callback, follow-up or refund is promised without a workflow behind it", () => {
  test("follow-up claims are caught in English, Hindi and Telugu; a staff-confirmed booking is not", () => {
    for (const reply of [
      "Someone will follow up shortly.",
      "Our team will reach out to you tomorrow.",
      "We'll get back to you soon.",
      "We'll call you once it's sorted.",
      "हमारी टीम आपसे संपर्क करेगी।",
      "మేము మిమ్మల్ని సంప్రదిస్తాం.",
    ]) {
      assert.equal(claimsTransferOrCallback(reply), true, reply);
    }
    for (const reply of [
      "Your request is saved, and our team will confirm it with you shortly.",
      "Please try again in a little while.",
      "I can't arrange a callback on this line.",
    ]) {
      assert.equal(claimsTransferOrCallback(reply), false, reply);
    }
  });

  test("the calendar and payment fallbacks no longer promise a follow-up", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const runtime = readFileSync(join(dir, "voice-runtime.server.ts"), "utf8");
    for (const gone of [
      "Someone will follow up shortly",
      "offer to have someone call back",
      "have someone confirm the appointment and call them back",
    ]) {
      assert.ok(!runtime.includes(gone), gone);
    }
    for (const file of [
      "payment-voice-consumer.server.ts",
      "payment-whatsapp-consumer.server.ts",
    ]) {
      const src = readFileSync(join(dir, "payments", file), "utf8");
      assert.doesNotMatch(src, /We'll (?:follow up|contact you) shortly/, file);
      assert.match(src, /this booking isn't confirmed\. Please contact us/, file);
    }
  });
});
