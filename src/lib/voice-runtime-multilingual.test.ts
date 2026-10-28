import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveResponseLanguage,
  responseLanguageInstruction,
  startRuntimeSession,
  terminateRuntimeSession,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { ProviderError } from "./sarvam.server.ts";
import { createHarness } from "./telephony/voice-runtime-test-harness.ts";
import { FALLBACK_MESSAGES } from "./voice-fallback-messages.ts";
import { VOICE_LANGUAGES } from "./voice-languages.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ChatMessage } from "./sarvam.server.ts";

/**
 * Automatic multilingual calls, end to end through the real runtime with
 * fake STT/LLM/TTS (see telephony/voice-runtime-test-harness.ts): the
 * caller's detected language → the LLM's reply language → the TTS voice
 * language, with no per-agent setting involved, and the fixed fallback lines
 * spoken in that same language.
 */

const agent: AgentSnapshot["agent"] = {
  agent_name: "Aria",
  persona: "professional",
  custom_personality: null,
  objectives: ["answer_questions"],
  capabilities: {},
  primary_language: "en-IN",
  extra_languages: [],
  // The column default every existing agent has; it must not matter.
  multilingual: false,
  voice_id: "ritu",
  speaking_pace: 1,
  greetings: { "en-IN": "Hello, thanks for calling Test Business." },
  transfer_number: null,
  after_hours_behavior: "take_message",
};

function input(
  callId: string,
  bridge: StartRuntimeSessionInput["bridge"],
  agentOverrides: Partial<AgentSnapshot["agent"]> = {},
): StartRuntimeSessionInput {
  return {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: "00000000-0000-0000-0000-000000000002",
    agentVersion: 3,
    instructions: "You are Aria, a helpful receptionist for Test Business.",
    snapshotAgent: { ...agent, ...agentOverrides },
    businessName: "Test Business",
    bridge,
    businessCountry: "IN",
  };
}

async function drain(hops = 28) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

function newCallId(): string {
  return `multilingual-call-${crypto.randomUUID()}`;
}

type Harness = ReturnType<typeof createHarness>;

/** The per-turn language note the runtime sent with an LLM request. */
function languageNote(messages: ChatMessage[] | undefined): string | undefined {
  return messages?.find(
    (m) => m.role === "system" && m.content.startsWith("Reply to the caller's next"),
  )?.content;
}

/** The reply language the most recent LLM request was pinned to. */
function lastNoteLanguage(h: Harness): string | undefined {
  return /\(([a-z]{2}-IN)\)/.exec(languageNote(h.llm.calls.at(-1)) ?? "")?.[1];
}

/** The language the TTS voice was most recently (re)connected with. */
function voiceLanguage(h: Harness): string | undefined {
  return h.tts.connectCalls.at(-1)?.language;
}

/** One caller turn, with an optional STT language detection. */
async function say(
  h: Harness,
  text: string,
  language?: string,
  languageConfidence?: number,
  reply = "ok",
) {
  h.llm.setNextReply(reply);
  h.stt.emit({
    type: "final_transcript",
    text,
    ...(language === undefined ? {} : { language }),
    ...(languageConfidence === undefined ? {} : { languageConfidence }),
  });
  await drain();
}

describe("resolveResponseLanguage / responseLanguageInstruction (pure)", () => {
  test("the realtime STT's or-IN resolves to the TTS/LLM code od-IN", () => {
    assert.equal(resolveResponseLanguage("or-IN", "en-IN"), "od-IN");
  });

  test("a stored primary language is normalized, and an unusable one falls back to English", () => {
    assert.equal(resolveResponseLanguage(null, "or-IN"), "od-IN");
    assert.equal(resolveResponseLanguage(null, "zz-ZZ"), "en-IN");
    assert.equal(resolveResponseLanguage("ur-IN", "zz-ZZ"), "en-IN");
  });

  test("the per-turn instruction names the language and its code", () => {
    assert.match(responseLanguageInstruction("od-IN"), /Odia \(od-IN\)/);
    assert.match(responseLanguageInstruction("en-IN"), /English \(en-IN\)/);
  });
});

describe("every agent is multilingual, with no setting", () => {
  test("all 11 languages: a caller's first reliable sentence sets both the LLM language and the TTS voice", async () => {
    for (const { code } of VOICE_LANGUAGES) {
      const h = createHarness();
      const callId = newCallId();
      const primary = code === "en-IN" ? "hi-IN" : "en-IN";
      await startRuntimeSession(
        input(callId, h.bridge, { primary_language: primary, greetings: { [primary]: "Hi." } }),
        h.deps,
      );
      await say(h, "a full question here", code, 0.9);
      assert.equal(lastNoteLanguage(h), code, code);
      assert.equal(voiceLanguage(h), code, code);
      await terminateRuntimeSession(callId, "test cleanup");
    }
  });

  test("multilingual=false and a legacy extra_languages list neither disable nor restrict switching", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(
      input(callId, h.bridge, { multilingual: false, extra_languages: ["hi-IN"] }),
      h.deps,
    );
    await say(h, "எனக்கு ஒரு அப்பாயிண்ட்மெண்ட் வேண்டும்", "ta-IN", 0.93);
    assert.equal(lastNoteLanguage(h), "ta-IN");
    assert.equal(voiceLanguage(h), "ta-IN");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a snapshot with no language fields at all (old published version) still switches", async () => {
    const h = createHarness();
    const callId = newCallId();
    const legacy: Partial<AgentSnapshot["agent"]> = { ...agent };
    delete legacy.multilingual;
    delete legacy.extra_languages;
    await startRuntimeSession(
      { ...input(callId, h.bridge), snapshotAgent: legacy as AgentSnapshot["agent"] },
      h.deps,
    );
    await say(h, "मुझे कल का अपॉइंटमेंट चाहिए", "hi-IN", 0.95);
    assert.equal(voiceLanguage(h), "hi-IN");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("before the caller's language is known, replies use the primary language", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(
      input(callId, h.bridge, { primary_language: "kn-IN", greetings: { "kn-IN": "ನಮಸ್ಕಾರ." } }),
      h.deps,
    );
    assert.equal(voiceLanguage(h), "kn-IN");
    await say(h, "mmm what time", "hi-IN", 0.3);
    assert.equal(lastNoteLanguage(h), "kn-IN");
    assert.equal(h.tts.connectCalls.length, 1);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("following the caller through a call", () => {
  test("Telugu → Hindi → English: LLM and TTS follow on every turn", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);

    await say(h, "నాకు రేపు అపాయింట్మెంట్ కావాలి", "te-IN", 0.94);
    assert.equal(lastNoteLanguage(h), "te-IN");
    assert.equal(voiceLanguage(h), "te-IN");

    await say(h, "मुझे कल सुबह आना है", "hi-IN", 0.92);
    assert.equal(lastNoteLanguage(h), "hi-IN");
    assert.equal(voiceLanguage(h), "hi-IN");

    await say(h, "actually can we carry on in this", "en-IN", 0.97);
    assert.equal(lastNoteLanguage(h), "en-IN");
    assert.equal(voiceLanguage(h), "en-IN");

    assert.deepEqual(
      h.tts.connectCalls.map((c) => c.language),
      ["en-IN", "te-IN", "hi-IN", "en-IN"],
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("an explicit request switches even though it was said in another language", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    await say(h, "what are your opening hours today", "en-IN", 0.98);
    assert.equal(voiceLanguage(h), "en-IN");
    await say(h, "Can you speak Telugu please", "en-IN", 0.98);
    assert.equal(lastNoteLanguage(h), "te-IN");
    assert.equal(voiceLanguage(h), "te-IN");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("unreliable, one-word and one-off detections never make the call oscillate", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    await say(h, "నాకు అపాయింట్మెంట్ కావాలి", "te-IN", 0.95);
    assert.equal(voiceLanguage(h), "te-IN");
    const connectsAfterTelugu = h.tts.connectCalls.length;
    const callsBefore = h.llm.calls.length;

    // Noise a real Telugu caller produces: a short English "ok", a low-
    // confidence Hindi guess, a one-word Hindi-sounding filler, and a single
    // medium-confidence English sentence — each interleaved with Telugu.
    await say(h, "ok", "en-IN", 0.95);
    await say(h, "సరే అలాగే చేయండి", "te-IN", 0.9);
    await say(h, "kal subah", "hi-IN", 0.4);
    await say(h, "haan", "hi-IN", 0.75);
    await say(h, "the doctor name please", "en-IN", 0.7);
    await say(h, "సమయం ఎంత", "te-IN", 0.88);

    assert.equal(h.tts.connectCalls.length, connectsAfterTelugu, "no reconnects");
    for (const call of h.llm.calls.slice(callsBefore)) {
      assert.match(languageNote(call) ?? "", /\(te-IN\)/);
    }
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a sustained change at medium confidence is followed on its second consecutive turn", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    await say(h, "నాకు అపాయింట్మెంట్ కావాలి", "te-IN", 0.95);
    await say(h, "can you tell me the price", "en-IN", 0.7);
    assert.equal(lastNoteLanguage(h), "te-IN", "one medium-confidence turn is not enough");
    await say(h, "and how long does it take", "en-IN", 0.72);
    assert.equal(lastNoteLanguage(h), "en-IN");
    assert.equal(voiceLanguage(h), "en-IN");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("switching language keeps the conversation history and the appointment details", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    await say(
      h,
      "I would like to book a teeth cleaning",
      "en-IN",
      0.97,
      'Sure. What\'s your name?\n<<<APPT_STATE:{"service":"teeth cleaning","customer_name":"Ravi","phone":null,"preferred_date":null,"preferred_time":null,"ready_to_book":false}>>>',
    );
    await say(h, "मुझे कल सुबह आना है", "hi-IN", 0.93);

    const hindiTurn = h.llm.calls.at(-1) ?? [];
    assert.equal(lastNoteLanguage(h), "hi-IN");
    assert.equal(voiceLanguage(h), "hi-IN");
    const known = hindiTurn.find(
      (m) => m.role === "system" && m.content.includes("CURRENT APPOINTMENT STATE"),
    );
    assert.ok(known, "the appointment state is still given to the model");
    assert.match(known.content, /teeth cleaning/);
    assert.match(known.content, /Ravi/);
    assert.ok(
      hindiTurn.some((m) => m.role === "user" && m.content.includes("teeth cleaning")),
      "earlier turns are still in the conversation",
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("an agent stored with the legacy or-IN primary language connects TTS with od-IN", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(
      input(callId, h.bridge, { primary_language: "or-IN", greetings: { "or-IN": "ନମସ୍କାର" } }),
      h.deps,
    );
    assert.equal(h.tts.connectCalls[0]?.language, "od-IN");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("with no greeting saved for the primary language, the default greeting is in that language", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(
      input(callId, h.bridge, { primary_language: "ta-IN", greetings: {} }),
      h.deps,
    );
    // TTS receives the greeting sentence by sentence.
    assert.equal(
      h.tts.sentTexts.join(" "),
      FALLBACK_MESSAGES["ta-IN"].defaultGreeting("Test Business"),
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("if the voice can't switch language, the next reply is asked for in the language it still speaks", async () => {
    const h = createHarness();
    const connectTts = h.deps.connectTts;
    let connects = 0;
    h.deps.connectTts = async (opts) => {
      connects += 1;
      if (connects > 1) throw new Error("simulated TTS reconnect failure");
      return connectTts(opts);
    };
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    const tamilReply = "சரி, நான் உதவுகிறேன்.";
    await say(h, "எனக்கு ஒரு அப்பாயிண்ட்மெண்ட் வேண்டும்", "ta-IN", 0.9, tamilReply);

    // The Tamil reply is never read out by the English voice; an honest
    // English retry line is spoken — and recorded — instead.
    const spoken = h.tts.sentTexts.join(" ");
    assert.doesNotMatch(spoken, /சரி/);
    assert.ok(spoken.includes(FALLBACK_MESSAGES["en-IN"].toolTurnRetry("")), spoken);

    await say(h, "and the price?");
    assert.equal(lastNoteLanguage(h), "en-IN");
    await terminateRuntimeSession(callId, "test cleanup");
    const record = h.persistence.records.at(-1);
    assert.ok(record, "expected the call transcript to be saved");
    const transcript = record.turns.map((t) => t.text);
    assert.ok(!transcript.includes(tamilReply), "the unspoken reply is not in the transcript");
  });
});

describe("acknowledgements and corrective requests on a live call", () => {
  test("a Telugu call stays in Telugu through 'ok', 'okay', 'thank you' and 'yes yes' — replies spoken and recorded in Telugu", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    await say(h, "నాకు రేపు అపాయింట్మెంట్ కావాలి", "te-IN", 0.95, "సరే, ఏ సమయం కావాలి?");
    const connectsAfterTelugu = h.tts.connectCalls.length;
    const callsBefore = h.llm.calls.length;

    const replies = ["సరే.", "అలాగే.", "ధన్యవాదాలు.", "తప్పకుండా."];
    for (const [i, text] of ["ok", "okay", "thank you", "yes yes"].entries()) {
      await say(h, text, "en-IN", 0.99, replies[i]);
    }

    assert.equal(h.tts.connectCalls.length, connectsAfterTelugu, "the voice never switched");
    assert.equal(voiceLanguage(h), "te-IN");
    for (const call of h.llm.calls.slice(callsBefore)) {
      assert.match(languageNote(call) ?? "", /\(te-IN\)/);
    }
    const spoken = h.tts.sentTexts.join(" ");
    for (const reply of replies) assert.ok(spoken.includes(reply), `spoken: ${reply}`);
    await terminateRuntimeSession(callId, "test cleanup");
    const record = h.persistence.records.at(-1);
    assert.ok(record, "expected the call transcript to be saved");
    const recorded = record.turns.filter((t) => t.role === "assistant").map((t) => t.text);
    for (const reply of replies) assert.ok(recorded.includes(reply), `recorded: ${reply}`);
  });

  test("'No, speak English' on a Hindi call switches to English — the reply is spoken in the English voice and recorded", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    await say(h, "मुझे कल सुबह का अपॉइंटमेंट चाहिए", "hi-IN", 0.95, "ठीक है, किस समय?");
    assert.equal(voiceLanguage(h), "hi-IN");

    // Sarvam would label this Hindi-accented sentence as Hindi or English;
    // either way the request decides.
    await say(h, "No, speak English", "hi-IN", 0.8, "Of course. What time works for you?");
    assert.equal(lastNoteLanguage(h), "en-IN");
    assert.equal(voiceLanguage(h), "en-IN");
    assert.ok(
      h.tts.sentTexts.join(" ").includes("Of course. What time works for you?"),
      JSON.stringify(h.tts.sentTexts),
    );
    await terminateRuntimeSession(callId, "test cleanup");
    const recorded = h.persistence.records.at(-1)?.turns.map((t) => t.text) ?? [];
    assert.ok(recorded.includes("Of course. What time works for you?"));
  });

  test("'I can't speak Hindi' does not switch a call to Hindi", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    await say(h, "I can't speak Hindi, sorry", "en-IN", 0.97);
    assert.equal(lastNoteLanguage(h), "en-IN");
    assert.equal(h.tts.connectCalls.length, 1);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("a language the voice can't reach is not retried every turn", () => {
  test("a caller who keeps speaking it gets real answers in the voice's language after one retry line", async () => {
    const h = createHarness();
    const connectTts = h.deps.connectTts;
    let connects = 0;
    h.deps.connectTts = async (opts) => {
      connects += 1;
      if (connects > 1) throw new Error("simulated TTS reconnect failure");
      return connectTts(opts);
    };
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    for (let turn = 0; turn < 3; turn++) {
      await say(
        h,
        `தயவு செய்து விலை சொல்லுங்கள் ${turn}`,
        "ta-IN",
        0.95,
        `The price is ${500 + turn * 100} rupees.`,
      );
      await drain(40); // the failed reconnect adds a few async hops
    }
    assert.equal(connects, 2, "one failed switch attempt, never repeated");
    const retry = FALLBACK_MESSAGES["en-IN"].toolTurnRetry("");
    assert.equal(
      h.tts.sentTexts.join(" ").split(retry).length - 1,
      1,
      "the retry line is said once",
    );
    for (const call of h.llm.calls.slice(1)) {
      assert.match(languageNote(call) ?? "", /\(en-IN\)/);
    }
    assert.equal(
      // Distinct replies, so the runtime's repeated-reply guard stays out of it.
      h.tts.sentTexts.filter((t) => /The price is \d+ rupees/.test(t)).length,
      2,
      `the later turns are answered: ${JSON.stringify(h.tts.sentTexts)}`,
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("fallback lines follow the call's language", () => {
  test("an LLM provider error on a Hindi call is apologised for in Hindi", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    h.llm.setNextError(new ProviderError("upstream overloaded", 503));
    h.stt.emit({
      type: "final_transcript",
      text: "मुझे अपॉइंटमेंट चाहिए",
      language: "hi-IN",
      languageConfidence: 0.97,
    });
    await drain(40);
    assert.ok(
      h.tts.sentTexts.join(" ").includes(FALLBACK_MESSAGES["hi-IN"].providerTrouble("")),
      JSON.stringify(h.tts.sentTexts),
    );
    assert.equal(voiceLanguage(h), "hi-IN");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("an English call keeps the original English apology", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    h.llm.setNextError(new ProviderError("upstream overloaded", 503));
    h.stt.emit({
      type: "final_transcript",
      text: "what are your opening hours on sunday",
      language: "en-IN",
    });
    await drain(40);
    assert.ok(
      h.tts.sentTexts.join(" ").includes("I'm sorry, I'm having trouble understanding right now."),
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("an English-only call over several turns: English throughout, one TTS connection", async () => {
    const h = createHarness();
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    for (const text of ["what are your hours", "and on sunday", "thanks for the help"]) {
      await say(h, text, "en-IN", 0.99, "Sure.");
    }
    assert.equal(h.tts.connectCalls.length, 1);
    for (const call of h.llm.calls) assert.match(languageNote(call) ?? "", /\(en-IN\)/);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

/**
 * Records every text sent to TTS together with the language of the voice
 * connection that actually carried it — so a test can assert what the caller
 * heard AND which voice said it, not just that some connection existed.
 */
function trackVoices(h: Harness): { voice: string; text: string }[] {
  const spoken: { voice: string; text: string }[] = [];
  const connect = h.deps.connectTts;
  h.deps.connectTts = async (opts) => {
    const session = await connect(opts);
    return {
      ...session,
      sendText(text: string) {
        spoken.push({ voice: opts.language, text });
        session.sendText(text);
      },
    };
  };
  return spoken;
}

/** Reports every chunk sent so far as finished playing, as Sarvam would — the silence timer only arms once the agent has finished speaking. */
function finishPlayback(h: Harness): void {
  for (let i = 0; i < h.tts.sentTexts.length; i++) h.tts.emit({ type: "flushed" });
}

/** Everything one voice said, joined (TTS receives a reply sentence by sentence). */
function saidBy(spoken: { voice: string; text: string }[], voice: string): string {
  return spoken
    .filter((s) => s.voice === voice)
    .map((s) => s.text)
    .join(" ");
}

const hindiTurn = (h: Harness, reply = "ठीक है।") =>
  say(h, "मुझे कल सुबह का अपॉइंटमेंट चाहिए", "hi-IN", 0.95, reply);

describe("fixed lines are spoken in the active voice's language", () => {
  test("silence prompt, then the silence hang-up, in Hindi on the Hindi voice", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const spoken = trackVoices(h);
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    await hindiTurn(h);
    finishPlayback(h);
    await drain(40);

    t.mock.timers.tick(12_000); // silencePromptMs
    await drain(40);
    const prompt = FALLBACK_MESSAGES["hi-IN"].silencePrompt("");
    assert.ok(saidBy(spoken, "hi-IN").includes(prompt), JSON.stringify(spoken));
    finishPlayback(h);
    await drain(40);

    t.mock.timers.tick(10_000); // silenceHangupMs
    await drain(40);
    t.mock.timers.tick(30_000); // let the goodbye's playout wait finish
    await drain(40);
    const hangup = FALLBACK_MESSAGES["hi-IN"].silenceHangup("");
    assert.ok(saidBy(spoken, "hi-IN").includes(hangup), JSON.stringify(spoken));
    assert.doesNotMatch(saidBy(spoken, "hi-IN"), /Are you still there|I haven't heard anything/);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("the payment-wait fallback is in Telugu on the Telugu voice", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const spoken = trackVoices(h);
    const deps = {
      ...h.deps,
      resolveAvailableTools: async () => [
        { name: "request_payment", description: "d", input_schema: { type: "object" as const } },
      ],
      executeTool: async () => ({ content: JSON.stringify({ success: true }) }),
      generateReplyWithTools: async () => ({
        reply: "చెల్లింపు లింక్ పంపించాం.",
        toolCalls: [{ name: "request_payment", input: {}, isError: false }],
      }),
    };
    const callId = newCallId();
    const handle = await startRuntimeSession(input(callId, h.bridge), deps);
    await say(h, "నేను ఇప్పుడు చెల్లించవచ్చా దయచేసి చెప్పండి", "te-IN", 0.95);
    assert.equal(handle.state, "waiting_on_payment");

    t.mock.timers.tick(90_000); // PAYMENT_WAIT_TIMEOUT_MS
    await drain(40);
    const line = FALLBACK_MESSAGES["te-IN"].paymentWait("");
    assert.ok(saidBy(spoken, "te-IN").includes(line), JSON.stringify(spoken));
    assert.doesNotMatch(saidBy(spoken, "te-IN"), /haven't received confirmation/);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("an English call keeps the English silence prompt", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const spoken = trackVoices(h);
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    await say(h, "what are your opening hours", "en-IN", 0.98, "We open at nine.");
    finishPlayback(h);
    await drain(40);
    t.mock.timers.tick(12_000);
    await drain(40);
    assert.ok(
      saidBy(spoken, "en-IN").includes(
        "Are you still there? I can stay on the line if you need a moment.",
      ),
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("the time-limit goodbye is in the call's language", async (t) => {
    t.mock.timers.enable();
    const h = createHarness();
    const spoken = trackVoices(h);
    const callId = newCallId();
    await startRuntimeSession(
      { ...input(callId, h.bridge), lifecyclePolicy: { maxCallDurationMs: 5 * 60_000 } },
      h.deps,
    );
    await say(h, "నాకు రేపు అపాయింట్మెంట్ కావాలి", "te-IN", 0.95, "సరే.");
    t.mock.timers.tick(5 * 60_000);
    await drain(40);
    const goodbye = FALLBACK_MESSAGES["te-IN"].maxDuration("Test Business");
    assert.ok(saidBy(spoken, "te-IN").includes(goodbye), JSON.stringify(spoken));
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("asking for a person on a Hindi call: the 'no transfer' line is in Hindi", async () => {
    const h = createHarness();
    const spoken = trackVoices(h);
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    await hindiTurn(h);
    await say(h, "can I talk to a real person please", "hi-IN", 0.9);
    const line = FALLBACK_MESSAGES["hi-IN"].humanUnavailable("");
    assert.ok(saidBy(spoken, "hi-IN").includes(line), JSON.stringify(spoken));
    assert.doesNotMatch(saidBy(spoken, "hi-IN"), /can't transfer you/);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a booking acknowledgement on a Hindi call is the Hindi 'got it', never 'Got it — 3 PM.'", async () => {
    const h = createHarness();
    const spoken = trackVoices(h);
    const callId = newCallId();
    await startRuntimeSession(
      input(callId, h.bridge, { capabilities: { calendar_book: true, calendar_read: true } }),
      h.deps,
    );
    await hindiTurn(h);
    await say(h, "kal 3 pm ko teeth cleaning book karo", "hi-IN", 0.9);
    const hindi = saidBy(spoken, "hi-IN");
    assert.ok(hindi.includes(FALLBACK_MESSAGES["hi-IN"].gotIt("")), JSON.stringify(spoken));
    assert.doesNotMatch(hindi, /Got it/);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("an English booking acknowledgement is unchanged", async () => {
    const h = createHarness();
    const spoken = trackVoices(h);
    const callId = newCallId();
    await startRuntimeSession(
      input(callId, h.bridge, { capabilities: { calendar_book: true, calendar_read: true } }),
      h.deps,
    );
    await say(h, "I want to book a teeth cleaning", "en-IN", 0.98);
    await say(h, "tomorrow at 3 pm please", "en-IN", 0.98);
    assert.match(saidBy(spoken, "en-IN"), /Got it — tomorrow at 3 PM\./);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a reply in a script the active voice can't read is never sent to it", async () => {
    const h = createHarness();
    const spoken = trackVoices(h);
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    await say(h, "எனக்கு நாளை ஒரு அப்பாயிண்ட்மெண்ட் வேண்டும்", "ta-IN", 0.95, "சரி.");
    // The model ignores its Tamil language note and answers in Hindi.
    await say(h, "விலை என்ன சொல்லுங்கள்", "ta-IN", 0.95, "कीमत पाँच सौ रुपये है।");

    assert.doesNotMatch(saidBy(spoken, "ta-IN"), /कीमत/);
    const retry = FALLBACK_MESSAGES["ta-IN"].toolTurnRetry("");
    assert.ok(saidBy(spoken, "ta-IN").includes(retry), JSON.stringify(spoken));
    await terminateRuntimeSession(callId, "test cleanup");
    const recorded = h.persistence.records.at(-1)?.turns.map((turn) => turn.text) ?? [];
    assert.ok(!recorded.includes("कीमत पाँच सौ रुपये है।"), "the unspoken text is not recorded");
    assert.ok(recorded.includes(retry), "the line actually said is recorded");
  });

  test("a failed switch: the retry line is said by the voice that is actually connected", async () => {
    const h = createHarness();
    const spoken = trackVoices(h);
    const connectTts = h.deps.connectTts;
    let connects = 0;
    h.deps.connectTts = async (opts) => {
      connects += 1;
      if (connects > 1) throw new Error("simulated TTS reconnect failure");
      return connectTts(opts);
    };
    const callId = newCallId();
    await startRuntimeSession(input(callId, h.bridge), h.deps);
    await say(h, "எனக்கு ஒரு அப்பாயிண்ட்மெண்ட் வேண்டும்", "ta-IN", 0.9, "சரி, உதவுகிறேன்.");
    assert.deepEqual([...new Set(spoken.map((s) => s.voice))], ["en-IN"]);
    assert.ok(
      saidBy(spoken, "en-IN").includes(FALLBACK_MESSAGES["en-IN"].toolTurnRetry("")),
      JSON.stringify(spoken),
    );
    assert.doesNotMatch(saidBy(spoken, "en-IN"), /உதவுகிறேன்/);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});
