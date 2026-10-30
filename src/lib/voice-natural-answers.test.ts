import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractCallerName,
  parseCallerIntentFromText,
  phoneNumberFragment,
  startRuntimeSession,
  terminateRuntimeSession,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import { resolveServiceFromText, type ServiceRow } from "./service-matching.ts";
import { spokenDigitsToNumerals } from "./voice-intent-lexicon.ts";
import { localizedFallback } from "./voice-fallback-messages.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";

/**
 * Natural answers on a phone line: one-word and short replies, names said
 * in Telugu and Hindi, treatments described in the caller's own words,
 * numbers read out digit by digit or in pieces, "at 4", "when are you
 * free" — and a call that keeps working when a provider connection drops.
 * Unit tests run the real parsing and matching functions; the runtime tests
 * drive the real voice runtime with fake STT/TTS/model (no provider is
 * called, so none of these is an end-to-end provider test).
 */

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

describe("the caller's name, however it is said", () => {
  test("one word, a sentence, a full name — in English", () => {
    for (const [said, name] of [
      ["Dhanush", "Dhanush"],
      ["Dhanush.", "Dhanush"],
      ["I'm Dhanush", "Dhanush"],
      ["My name is Dhanush", "Dhanush"],
      ["Dhanush Chebrolu", "Dhanush Chebrolu"],
    ] as const) {
      assert.equal(extractCallerName(said, true), name, said);
    }
  });

  test("Telugu, Hindi and romanized: kept in the script it was said in", () => {
    for (const [said, asked, name] of [
      ["నా పేరు ధనుష్", false, "ధనుష్"],
      ["ధనుష్", true, "ధనుష్"],
      ["ధనుష్ చెబ్రోలు", true, "ధనుష్ చెబ్రోలు"],
      ["मेरा नाम धनुष है", false, "धनुष"],
      ["naa peru Dhanush", false, "Dhanush"],
      ["mera naam Dhanush hai", false, "Dhanush"],
      ["నా పేరు ధనుష్ అండి", false, "ధనుష్"],
    ] as const) {
      assert.equal(extractCallerName(said, asked), name, said);
    }
  });

  test("answers about something else are never taken as a name", () => {
    for (const said of [
      "అవును",
      "సరే",
      "ఈరోజు సాయంత్రం",
      "4 గంటలకు",
      "క్లీనింగ్",
      "బుక్ చేయండి",
      "हाँ",
      "कल सुबह",
      "Teeth cleaning",
      "Yes",
      "Today at 4",
    ]) {
      assert.equal(extractCallerName(said, true), null, said);
    }
    // A bare Indian-script word is a name only when the name was asked for.
    assert.equal(extractCallerName("ధనుష్", false), null);
  });
});

/* ------------------------------------------------------------------ */
/* Services                                                            */
/* ------------------------------------------------------------------ */

/** Schema-shaped rows (services: id, name, duration_minutes), as one business configures them. */
const CATALOGUE: ServiceRow[] = [
  { id: "svc-ct", name: "Cleaning Teeth", duration_minutes: 30 },
  { id: "svc-rc", name: "Root Canal Treatment", duration_minutes: 60 },
  { id: "svc-tw", name: "Teeth Whitening", duration_minutes: 45 },
  { id: "svc-co", name: "Consultation", duration_minutes: 15 },
];
/** Another tenant's catalogue — never passed in for this business's calls. */
const OTHER_TENANT: ServiceRow[] = [{ id: "svc-x", name: "Hair Cut", duration_minutes: 30 }];

describe("services resolved from the business's own catalogue", () => {
  test("word order, synonyms, descriptions, Telugu, Hindi and code-mixed", () => {
    for (const said of [
      "Cleaning Teeth",
      "Teeth cleaning",
      "Dental cleaning",
      "I want to get my teeth cleaned",
      "Cleaning teeth kavali",
      "నాకు పళ్ళు క్లీన్ చేయించాలి",
      "పళ్ళు క్లీనింగ్",
      "दांत साफ करवाने हैं",
      "मुझे क्लीनिंग करवानी है",
    ]) {
      const match = resolveServiceFromText(CATALOGUE, said);
      assert.equal(match.kind, "match", said);
      assert.equal(match.kind === "match" && match.row.id, "svc-ct", said);
    }
  });

  test("the real id and canonical name are returned, never the caller's wording", () => {
    const match = resolveServiceFromText(CATALOGUE, "root canal please");
    assert.ok(match.kind === "match");
    assert.equal(match.row.id, "svc-rc");
    assert.equal(match.row.name, "Root Canal Treatment");
  });

  test("too vague, absent, empty, or another tenant's: nothing is invented", () => {
    // "teeth" alone could be cleaning or whitening — never guessed.
    assert.notEqual(resolveServiceFromText(CATALOGUE, "teeth").kind, "match");
    assert.equal(resolveServiceFromText(CATALOGUE, "I need a checkup").kind, "none");
    assert.equal(resolveServiceFromText([], "teeth cleaning").kind, "none");
    // Only the business's own rows are ever searched.
    assert.equal(resolveServiceFromText(CATALOGUE, "hair cut").kind, "none");
    assert.equal(resolveServiceFromText(OTHER_TENANT, "teeth cleaning").kind, "none");
  });
});

/* ------------------------------------------------------------------ */
/* Numbers, times and availability                                     */
/* ------------------------------------------------------------------ */

describe("numbers read out, times and 'when are you free'", () => {
  test("digit words in English, Telugu and Hindi become numerals; ordinary speech does not", () => {
    assert.equal(spokenDigitsToNumerals("nine eight four eight zero"), "9 8 4 8 0");
    assert.equal(spokenDigitsToNumerals("double nine eight"), "9 9 8");
    assert.equal(spokenDigitsToNumerals("తొమ్మిది ఎనిమిది నాలుగు"), "9 8 4");
    assert.equal(spokenDigitsToNumerals("नौ आठ चार"), "9 8 4");
    assert.equal(spokenDigitsToNumerals("one moment please"), "one moment please");
    assert.equal(spokenDigitsToNumerals("for two people"), "for two people");
    assert.equal(
      parseCallerIntentFromText("my number is nine eight four eight zero one two three four five")
        .phone,
      "9848012345",
    );
  });

  test("a piece of a number is a fragment; a full number or other words are not", () => {
    assert.deepEqual(phoneNumberFragment("98480"), { digits: "98480", restart: false });
    assert.deepEqual(phoneNumberFragment("nine eight four"), { digits: "984", restart: false });
    assert.deepEqual(phoneNumberFragment("no, 98481"), { digits: "98481", restart: true });
    assert.equal(phoneNumberFragment("98480 12345"), null, "a full number is not a fragment");
    assert.equal(phoneNumberFragment("today at 4"), null);
    assert.equal(phoneNumberFragment("I have 2 kids and 3 dogs"), null);
  });

  test("'at 4' and 'o'clock' are times; a bare number is not", () => {
    const time = (said: string) => parseCallerIntentFromText(said).explicitTime;
    assert.equal(time("tomorrow at 4"), "16:00");
    assert.equal(time("around 5 o'clock"), "17:00");
    assert.equal(time("at 9 in the morning"), "09:00");
    assert.equal(time("at 7 in the evening"), "19:00");
    assert.equal(time("at 11"), "11:00");
    assert.equal(time("I have 4 kids"), null);
    assert.equal(time("at 4 people"), null);
  });

  test("availability asked for in natural ways", () => {
    for (const said of [
      "What slots are available?",
      "Tell me when you're free",
      "When are you free tomorrow",
      "Show me the slots for today",
    ]) {
      assert.equal(parseCallerIntentFromText(said).availabilityRequested, true, said);
    }
    assert.equal(parseCallerIntentFromText("When do you close?").availabilityRequested, false);
  });
});

/* ------------------------------------------------------------------ */
/* Through the real runtime                                            */
/* ------------------------------------------------------------------ */

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
  greetings: { "en-IN": "Hello, thanks for calling Smile Dental. How can I help you today?" },
  transfer_number: null,
  after_hours_behavior: "take_message",
};

async function drain(hops = 300) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

async function openCall(opts: { callerNumber?: string | null } = {}) {
  const h: Harness = createHarness();
  const callId = `natural-${crypto.randomUUID()}`;
  const input: StartRuntimeSessionInput = {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: "00000000-0000-0000-0000-000000000002",
    agentVersion: 3,
    instructions: "You are Aria, a helpful receptionist for Smile Dental.",
    snapshotAgent: agent,
    businessName: "Smile Dental",
    bridge: h.bridge,
    businessCountry: "IN",
    callerNumber: opts.callerNumber === undefined ? "+919876543210" : opts.callerNumber,
    services: CATALOGUE,
  };
  await startRuntimeSession(input, h.deps);
  await drain();
  let flushed = 0;
  const turn = async (said: string, reply: string, language = "en-IN") => {
    while (flushed < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      flushed++;
    }
    h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "final_transcript", text: said, language, languageConfidence: 0.95 });
    await drain();
    return h.tts.sentTexts.slice(before).join(" ");
  };
  /** The appointment state the runtime hands the model as ground truth on its latest request. */
  const knownState = () =>
    (h.llm.calls.at(-1) ?? [])
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
  return { h, callId, turn, knownState };
}

describe("short answers through the runtime", () => {
  test("a one-word Telugu name after the agent asks for it is kept, not asked again", async () => {
    const { callId, turn, knownState } = await openCall();
    await turn("నాకు అపాయింట్మెంట్ కావాలి", "తప్పకుండా. మీ పేరు చెప్తారా?", "te-IN");
    await turn("ధనుష్", "ధన్యవాదాలు.", "te-IN");
    await turn("ఏ టైం బాగుంటుంది?", "సరే.", "te-IN");
    assert.match(knownState(), /customer name: ధనుష్/);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a phone number read out in pieces is collected once, repeats ignored", async () => {
    const { callId, turn, knownState } = await openCall();
    await turn("I'd like to book a cleaning", "Sure. What's your phone number?");
    const first = await turn("98480", "ignored");
    assert.ok(first.includes(localizedFallback("gotIt", "en-IN")), first);
    await turn("98480", "ignored"); // the same piece again: not more digits
    await turn("12345", "Thanks.");
    await turn("And what times are open?", "Let me see.");
    assert.match(knownState(), /phone: \+919848012345/);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("a provider connection dropping mid-call", () => {
  test("STT closing mid-call is reopened, and the caller is heard again", async () => {
    const { h, callId, turn } = await openCall();
    assert.equal(h.stt.connectCalls.length, 1);
    h.stt.emit({ type: "closed", code: 1011, reason: "server error" });
    await drain();
    assert.equal(h.stt.connectCalls.length, 2, "reconnected");
    assert.equal(h.stt.connectCalls[1]!.language, "auto");
    const reply = await turn("Do you have parking?", "Yes, right outside.");
    assert.match(reply, /right outside/);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a close the provider would repeat ends the call honestly instead of in silence", async () => {
    const { h, callId } = await openCall();
    const before = h.tts.sentTexts.length;
    h.stt.emit({ type: "closed", code: 4001, reason: "auth failed" });
    await drain();
    assert.equal(h.stt.connectCalls.length, 1, "no pointless reconnect");
    const said = h.tts.sentTexts.slice(before).join(" ");
    assert.ok(said.includes(localizedFallback("providerTrouble", "en-IN")), said);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("the voice closing mid-call is reopened before the next reply", async () => {
    const { h, callId, turn } = await openCall();
    const connects = h.tts.connectCalls.length;
    h.tts.emit({ type: "closed", code: 1006, reason: "idle" });
    const reply = await turn("What are your hours?", "We're open nine to six.");
    assert.equal(h.tts.connectCalls.length, connects + 1, "the voice was reopened");
    assert.match(reply, /nine to six/);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a late close from the replaced STT socket never drops the new one", async () => {
    const { h, callId, turn } = await openCall();
    const firstSocketEvents = h.stt.connectCalls[0]!.onEvent;
    h.stt.emit({ type: "closed", code: 1011, reason: "server error" });
    await drain();
    assert.equal(h.stt.connectCalls.length, 2);
    // The old socket reports its close again, late.
    firstSocketEvents({ type: "closed", code: 1006, reason: "late" });
    await drain();
    assert.equal(h.stt.connectCalls.length, 2, "no reconnect for a stale close");
    const reply = await turn("Do you have parking?", "Yes, right outside.");
    assert.match(reply, /right outside/, "the new recognizer still works");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("two closes at once start one reconnect", async () => {
    const { h, callId } = await openCall();
    h.stt.emit({ type: "closed", code: 1011, reason: "a" });
    h.stt.emit({ type: "closed", code: 1011, reason: "b" });
    await drain();
    assert.equal(h.stt.connectCalls.length, 2);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("reconnects are bounded: the third drop ends the call honestly", async () => {
    const { h, callId } = await openCall();
    for (let i = 0; i < 2; i++) {
      h.stt.emit({ type: "closed", code: 1011, reason: "server error" });
      await drain();
    }
    assert.equal(h.stt.connectCalls.length, 3, "two reconnects");
    const before = h.tts.sentTexts.length;
    h.stt.emit({ type: "closed", code: 1011, reason: "server error" });
    await drain();
    assert.equal(h.stt.connectCalls.length, 3, "no third reconnect");
    const said = h.tts.sentTexts.slice(before).join(" ");
    assert.ok(said.includes(localizedFallback("providerTrouble", "en-IN")), said);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a language switch that opens a new voice also clears a pending reconnect", async () => {
    const { h, callId, turn } = await openCall();
    const connects = h.tts.connectCalls.length;
    h.tts.emit({ type: "closed", code: 1006, reason: "idle" });
    await turn("నాకు అపాయింట్మెంట్ కావాలి", "తప్పకుండా, ఏ రోజు?", "te-IN");
    assert.equal(h.tts.connectCalls.length, connects + 1, "one new voice, not two");
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("a number read out in pieces is confirmed before it is used", () => {
  test("without caller ID: pieces are collected, read back digit by digit, and kept on yes", async () => {
    const { callId, turn, knownState } = await openCall({ callerNumber: null });
    await turn("I'd like a cleaning", "Sure. What's your phone number?");
    await turn("98480", "ignored");
    const readBack = await turn("12345", "ignored");
    assert.match(readBack, /9 8 4 8 0, 1 2 3 4 5\. Is that right\?/, readBack);
    await turn("Yes", "Great. What day suits you?");
    assert.match(knownState(), /phone: \+919848012345/);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a 'no' to the read-back clears the number and asks for it again", async () => {
    const { callId, turn, knownState } = await openCall({ callerNumber: null });
    await turn("I'd like a cleaning", "Sure. What's your phone number?");
    await turn("98480", "ignored");
    await turn("12345", "ignored");
    const reask = await turn("No, that's wrong", "ignored");
    assert.match(reask, /phone number/i, reask);
    await turn("98481 12345", "Thanks.");
    await turn("What times are open?", "Let me see.");
    assert.match(knownState(), /phone: \+919848112345/);
    assert.doesNotMatch(knownState(), /9848012345/, "the rejected number is gone");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("Telugu pieces are read back with the Telugu question", async () => {
    const { callId, turn } = await openCall({ callerNumber: null });
    await turn("నాకు అపాయింట్మెంట్ కావాలి", "సరే. మీ ఫోన్ నంబర్ చెప్తారా?", "te-IN");
    await turn("98480", "ignored", "te-IN");
    const readBack = await turn("12345", "ignored", "te-IN");
    assert.match(readBack, /9 8 4 8 0, 1 2 3 4 5\. సరేనా\?/, readBack);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("no false positives", () => {
  test("greetings and thanks in Telugu or Hindi are not names", () => {
    for (const said of ["హలో", "ధన్యవాదాలు", "నమస్కారం", "नमस्ते", "धन्यवाद", "क्या"]) {
      assert.equal(extractCallerName(said, true), null, said);
    }
  });

  test("'साफ़' means cleaning only about teeth", () => {
    assert.equal(resolveServiceFromText(CATALOGUE, "साफ साफ बताइए").kind, "none");
    const teeth = resolveServiceFromText(CATALOGUE, "दांत साफ करवाने हैं");
    assert.equal(teeth.kind === "match" && teeth.row.id, "svc-ct");
  });
});
