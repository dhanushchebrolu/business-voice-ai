import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  VOICE_LANGUAGES,
  RELIABLE_LANGUAGE_CONFIDENCE,
  STRONG_LANGUAGE_CONFIDENCE,
  type CallLanguageState,
  isSupportedVoiceLanguage,
  nextCallLanguage,
  normalizeVoiceLanguageCode,
  requestedLanguageFromText,
  parseLanguageConfidence,
  resolvePrimaryLanguage,
  sttRealtimeLanguageCode,
  voiceCanSpeakText,
  voiceLanguageName,
} from "./voice-languages.ts";
import { FALLBACK_MESSAGES, localizedFallback } from "./voice-fallback-messages.ts";
import { CLOSING_MESSAGES } from "./call-lifecycle-policy.ts";
import { LANGUAGES } from "./voices.ts";
import { SUPPORTED_VOICE_LANGUAGES } from "./agent-instructions.ts";

describe("VOICE_LANGUAGES — the 11 languages every stage supports (checked against Sarvam's docs)", () => {
  test("exactly the bulbul:v3 / sarvam-105b language set", () => {
    assert.deepEqual(VOICE_LANGUAGES.map((l) => l.code).sort(), [
      "bn-IN",
      "en-IN",
      "gu-IN",
      "hi-IN",
      "kn-IN",
      "ml-IN",
      "mr-IN",
      "od-IN",
      "pa-IN",
      "ta-IN",
      "te-IN",
    ]);
  });

  test("every realtime STT code is in saaras:v3-realtime's documented enum", () => {
    const sttRealtimeEnum = new Set([
      "en-IN",
      "hi-IN",
      "bn-IN",
      "kn-IN",
      "ml-IN",
      "mr-IN",
      "or-IN",
      "pa-IN",
      "ta-IN",
      "te-IN",
      "gu-IN",
    ]);
    for (const l of VOICE_LANGUAGES) assert.ok(sttRealtimeEnum.has(l.sttRealtimeCode), l.code);
  });

  test("Odia is od-IN for TTS/LLM and or-IN for realtime STT", () => {
    assert.equal(sttRealtimeLanguageCode("od-IN"), "or-IN");
    assert.equal(sttRealtimeLanguageCode("hi-IN"), "hi-IN");
    assert.equal(sttRealtimeLanguageCode("ur-IN"), null);
  });

  test("the dashboard list and the prompt list are both derived from the registry", () => {
    assert.deepEqual(
      LANGUAGES.map((l) => l.code),
      VOICE_LANGUAGES.map((l) => l.code),
    );
    assert.deepEqual(
      SUPPORTED_VOICE_LANGUAGES.map((l) => l.code),
      VOICE_LANGUAGES.map((l) => l.code),
    );
  });
});

describe("normalizeVoiceLanguageCode", () => {
  test("maps every spelling of a supported language to its canonical code", () => {
    assert.equal(normalizeVoiceLanguageCode("or-IN"), "od-IN");
    assert.equal(normalizeVoiceLanguageCode("od-IN"), "od-IN");
    assert.equal(normalizeVoiceLanguageCode("OD_in"), "od-IN");
    assert.equal(normalizeVoiceLanguageCode(" hi-IN "), "hi-IN");
    assert.equal(normalizeVoiceLanguageCode("ta"), "ta-IN");
    assert.equal(normalizeVoiceLanguageCode("or"), "od-IN");
  });

  test("rejects anything outside the supported set", () => {
    for (const value of ["ur-IN", "as-IN", "en-US", "fr-FR", "auto", "unknown", "", null, 42]) {
      assert.equal(normalizeVoiceLanguageCode(value), null, String(value));
    }
  });

  test("isSupportedVoiceLanguage only accepts canonical codes", () => {
    assert.equal(isSupportedVoiceLanguage("od-IN"), true);
    assert.equal(isSupportedVoiceLanguage("or-IN"), false);
  });

  test("resolvePrimaryLanguage never returns a code bulbul:v3 would reject", () => {
    assert.equal(resolvePrimaryLanguage("or-IN"), "od-IN");
    assert.equal(resolvePrimaryLanguage("xx-YY"), "en-IN");
    assert.equal(resolvePrimaryLanguage(undefined), "en-IN");
  });

  test("voiceLanguageName", () => {
    assert.equal(voiceLanguageName("od-IN"), "Odia");
    assert.equal(voiceLanguageName("or-IN"), "Odia");
    assert.equal(voiceLanguageName("ur-IN"), "ur-IN");
  });
});

describe("parseLanguageConfidence — Sarvam sends a string-typed float", () => {
  test("parses valid probabilities", () => {
    assert.equal(parseLanguageConfidence("0.87"), 0.87);
    assert.equal(parseLanguageConfidence(0), 0);
    assert.equal(parseLanguageConfidence("1"), 1);
  });

  test("drops anything that isn't a 0–1 probability", () => {
    for (const value of ["abc", "", "1.01", -0.2, null, undefined, NaN]) {
      assert.equal(parseLanguageConfidence(value), undefined, String(value));
    }
  });
});

describe("localized fallback lines", () => {
  test("every supported language has every line, non-empty", () => {
    for (const lang of VOICE_LANGUAGES) {
      const table = FALLBACK_MESSAGES[lang.code];
      assert.ok(table, lang.code);
      for (const [key, line] of Object.entries(table)) {
        assert.ok(line("Acme Clinic").trim().length > 0, `${lang.code}.${key}`);
      }
    }
  });

  test("non-English lines are written in the language's own script, not English", () => {
    for (const lang of VOICE_LANGUAGES) {
      if (lang.code === "en-IN") continue;
      for (const [key, line] of Object.entries(FALLBACK_MESSAGES[lang.code])) {
        // At least one letter from a script other than Latin.
        assert.match(line(""), /(?!\p{Script=Latin})\p{L}/u, `${lang.code}.${key}`);
      }
    }
  });

  test("the business name is spoken in every greeting and farewell", () => {
    for (const lang of VOICE_LANGUAGES) {
      assert.ok(localizedFallback("farewell", lang.code, "Acme Clinic").includes("Acme Clinic"));
      assert.ok(
        localizedFallback("defaultGreeting", lang.code, "Acme Clinic").includes("Acme Clinic"),
      );
    }
  });

  test("English lines are unchanged from the runtime's existing wording", () => {
    assert.equal(localizedFallback("silenceHangup", "en-IN"), CLOSING_MESSAGES.silence);
    assert.equal(localizedFallback("repeatedErrors", "en-IN"), CLOSING_MESSAGES.repeatedErrors);
    assert.equal(localizedFallback("farewell", "en-IN", "Acme"), CLOSING_MESSAGES.farewell("Acme"));
  });

  test("the realtime Odia spelling and unsupported codes resolve sensibly", () => {
    assert.equal(
      localizedFallback("silencePrompt", "or-IN"),
      FALLBACK_MESSAGES["od-IN"].silencePrompt(""),
    );
    assert.equal(
      localizedFallback("silencePrompt", "ur-IN"),
      FALLBACK_MESSAGES["en-IN"].silencePrompt(""),
    );
  });
});

describe("nextCallLanguage — automatic, stable call language", () => {
  const none = { current: null, pending: null } as const;
  const telugu = { current: "te-IN", pending: null } as const;

  test("the first reliable detection is adopted at once (a caller who opens in Telugu gets Telugu)", () => {
    const r = nextCallLanguage(none, {
      text: "నాకు అపాయింట్మెంట్ కావాలి",
      language: "te-IN",
      confidence: 0.7,
    });
    assert.deepEqual(r, { state: { current: "te-IN", pending: null }, decision: "adopted" });
  });

  test("Odia's realtime code is normalized before anything else", () => {
    const r = nextCallLanguage(none, { text: "ମୋତେ ଦରକାର", language: "or-IN", confidence: 0.9 });
    assert.equal(r.state.current, "od-IN");
  });

  test("below the reliability threshold nothing changes, and a pending switch is dropped", () => {
    const r = nextCallLanguage(
      { current: "te-IN", pending: "en-IN" },
      {
        text: "can you tell me",
        language: "en-IN",
        confidence: RELIABLE_LANGUAGE_CONFIDENCE - 0.01,
      },
    );
    assert.deepEqual(r, {
      state: { current: "te-IN", pending: null },
      decision: "ignored_unreliable",
    });
  });

  test("a strong detection of a real sentence switches immediately", () => {
    const r = nextCallLanguage(telugu, {
      text: "मुझे कल सुबह आना है",
      language: "hi-IN",
      confidence: STRONG_LANGUAGE_CONFIDENCE,
    });
    assert.equal(r.state.current, "hi-IN");
  });

  test("a medium-confidence change needs a second consecutive turn", () => {
    const first = nextCallLanguage(telugu, {
      text: "what is the price",
      language: "en-IN",
      confidence: 0.7,
    });
    assert.deepEqual(first, { state: { current: "te-IN", pending: "en-IN" }, decision: "pending" });
    const second = nextCallLanguage(first.state, {
      text: "and the timing",
      language: "en-IN",
      confidence: 0.7,
    });
    assert.equal(second.state.current, "en-IN");
  });

  test("returning to the current language cancels a pending switch", () => {
    const r = nextCallLanguage(
      { current: "te-IN", pending: "en-IN" },
      { text: "సరే చెప్పండి", language: "te-IN", confidence: 0.9 },
    );
    assert.deepEqual(r, { state: { current: "te-IN", pending: null }, decision: "unchanged" });
  });

  test("acknowledgements never switch an established call, however confidently detected", () => {
    for (const text of ["haan", "ok", "okay", "yes yes", "thank you", "haan ji", "ok ok"]) {
      for (const confidence of [0.75, 0.99]) {
        const r = nextCallLanguage(telugu, { text, language: "en-IN", confidence });
        assert.deepEqual(
          r,
          { state: telugu, decision: "ignored_short" },
          `${JSON.stringify(text)} @ ${confidence}`,
        );
      }
    }
  });

  test("consecutive acknowledgements can't add up to a switch", () => {
    let state: CallLanguageState = telugu;
    for (const text of ["ok", "okay", "thank you", "yes yes"]) {
      state = nextCallLanguage(state, { text, language: "en-IN", confidence: 0.99 }).state;
    }
    assert.deepEqual(state, telugu);
  });

  test("an acknowledgement between two sentences neither completes nor cancels a pending switch", () => {
    const first = nextCallLanguage(telugu, {
      text: "what is the price",
      language: "en-IN",
      confidence: 0.7,
    });
    assert.equal(first.state.pending, "en-IN");
    const ack = nextCallLanguage(first.state, { text: "ok", language: "en-IN", confidence: 0.99 });
    assert.deepEqual(ack.state, first.state, "unchanged by the acknowledgement");
    const second = nextCallLanguage(ack.state, {
      text: "and how long does it take",
      language: "en-IN",
      confidence: 0.7,
    });
    assert.equal(second.state.current, "en-IN");
  });

  test("the call's FIRST language can still come from a short, strongly detected reply", () => {
    assert.equal(
      nextCallLanguage(none, { text: "నమస్కారం", language: "te-IN", confidence: 0.95 }).state
        .current,
      "te-IN",
    );
    assert.equal(
      nextCallLanguage(none, { text: "ok", language: "en-IN", confidence: 0.7 }).decision,
      "ignored_short",
    );
  });

  test("no detection, or a language outside the 11, keeps the current language", () => {
    assert.equal(nextCallLanguage(telugu, { text: "hello there" }).decision, "no_detection");
    const urdu = nextCallLanguage(telugu, {
      text: "mujhe chahiye",
      language: "ur-IN",
      confidence: 0.95,
    });
    assert.equal(urdu.decision, "ignored_unsupported");
    assert.equal(urdu.state.current, "te-IN");
  });

  test("a detection without a confidence score is trusted as strong (pinned or legacy STT)", () => {
    assert.equal(
      nextCallLanguage(telugu, { text: "Hindi mein samjhaiye zara", language: "hi-IN" }).state
        .current,
      "hi-IN",
    );
  });

  test("an explicit request wins over the detected language", () => {
    const r = nextCallLanguage(telugu, {
      text: "Can you speak English please",
      language: "te-IN",
      confidence: 0.9,
    });
    assert.deepEqual(r, { state: { current: "en-IN", pending: null }, decision: "requested" });
  });
});

describe("requestedLanguageFromText", () => {
  const cases: [string, string | null][] = [
    ["Can you speak Telugu?", "te-IN"],
    ["Hindi mein baat karo", "hi-IN"],
    ["switch back to English please", "en-IN"],
    ["Telugu lo matladandi", "te-IN"],
    ["తెలుగులో మాట్లాడండి", "te-IN"],
    ["हिंदी में बात करो", "hi-IN"],
    ["Tamil la pesunga", "ta-IN"],
    ["Kannada alli maatadi", "kn-IN"],
    ["Please continue in Marathi", "mr-IN"],
    ["in Odia please", "od-IN"],
    ["ଓଡ଼ିଆରେ କୁହନ୍ତୁ", "od-IN"],
    ["Bangla te kotha bolun", "bn-IN"],
    // A leading "No," / "Nahi," is a correction, not a refusal of the
    // language named after it; a negation only rules out the language it
    // actually negates.
    ["No, speak English.", "en-IN"],
    ["No no, in English please", "en-IN"],
    ["Nahi, English mein bolo", "en-IN"],
    ["No, Telugu lo matladandi", "te-IN"],
    ["Speak English, not Hindi", "en-IN"],
    ["Not Hindi, speak English", "en-IN"],
    ["Don't speak Hindi, speak English", "en-IN"],
    ["I don't understand Hindi, can you talk in English", "en-IN"],
    ["বাংলাতে কথা বলুন না", "bn-IN"],
    ["Hindi mein bolo na", "hi-IN"],
    ["I do not understand Tamil", null],
    ["Hindi samajh nahi aata", null],
    ["మీరు తెలుగు రాదు", null],
    ["मुझे हिंदी नहीं आती", null],
    ["আমি বাংলা জানি না", null],
    ["No English please", null],
    // A language used as a description is not a request to speak it.
    ["Can I talk to someone about Hindi tuition?", null],
    ["I want to talk about Telugu movies", null],
    ["Is there a Tamil speaking doctor, can you check", null],
    ["Can you speak Hindi?", "hi-IN"],
    ["Please speak in Hindi", "hi-IN"],
    ["Can we talk in Tamil about the booking", "ta-IN"],
    ["Tell me about the Hindi movie", null],
    ["I watched a Tamil film", null],
    ["Hindi or English, either is fine, speak", null],
    ["I can't speak Hindi", null],
    ["Mujhe Hindi nahi aati", null],
    ["Is the dentist Bengali?", null],
    ["what are your hours", null],
    // A language named in the caller's own script: the production call's
    // "Hindi lo matladadava?" ("will you speak Hindi?") and its Telugu-script
    // form, Telugu asked for in Devanagari, and back to English.
    ["Hindi lo matladadava?", "hi-IN"],
    ["హిందీలో మాట్లాడతావా?", "hi-IN"],
    ["तेलुगु में बात कीजिए", "te-IN"],
    ["English lo matladandi", "en-IN"],
    ["ఇంగ్లీష్‌లో మాట్లాడండి", "en-IN"], // with the zero-width joiner Telugu keyboards add
    ["अंग्रेज़ी में बोलिए", "en-IN"],
    ["इंग्लिश में बात करो", "en-IN"],
    ["ಹಿಂದಿಯಲ್ಲಿ ಮಾತನಾಡಿ", "hi-IN"],
    ["இந்தியில் பேசுங்க", "hi-IN"],
    ["హిందీ వద్దు, తెలుగులో మాట్లాడండి", "te-IN"],
    ["నాకు హిందీ రాదు", null],
    ["నేను హిందీ సినిమా చూశాను", null],
    // Words that merely begin like a language name: இந்தியா ("India"),
    // ಹಿಂದಿನ ("previous").
    ["இந்தியா பற்றி பேசுங்க", null],
    ["ಹಿಂದಿನ ಬಗ್ಗೆ ಮಾತನಾಡಿ", null],
  ];
  for (const [text, expected] of cases) {
    test(`${JSON.stringify(text)} → ${expected}`, () => {
      assert.equal(requestedLanguageFromText(text), expected);
    });
  }
});

describe("voiceCanSpeakText — nothing is sent to a voice that can't read it", () => {
  test("each voice reads its own script, plus Latin (English words in code-mixed speech)", () => {
    const own: Record<string, string> = {
      "hi-IN": "नमस्ते",
      "mr-IN": "नमस्कार",
      "bn-IN": "নমস্কার",
      "ta-IN": "வணக்கம்",
      "te-IN": "నమస్కారం",
      "gu-IN": "નમસ્તે",
      "kn-IN": "ನಮಸ್ಕಾರ",
      "ml-IN": "നമസ്കാരം",
      "pa-IN": "ਸਤ ਸ੍ਰੀ ਅਕਾਲ",
      "od-IN": "ନମସ୍କାର",
    };
    for (const [code, text] of Object.entries(own)) {
      assert.equal(voiceCanSpeakText(`${text} 3 PM ₹500।`, code), true, code);
    }
    assert.equal(voiceCanSpeakText("Your appointment is at 3 PM.", "en-IN"), true);
  });

  test("another Indian script is rejected, and the English voice takes Latin only", () => {
    assert.equal(voiceCanSpeakText("வணக்கம்", "te-IN"), false);
    assert.equal(voiceCanSpeakText("नमस्ते", "bn-IN"), false);
    assert.equal(voiceCanSpeakText("नमस्ते", "en-IN"), false);
    // Odia's realtime code resolves to the same voice.
    assert.equal(voiceCanSpeakText("ନମସ୍କାର", "or-IN"), true);
  });

  test("every fixed line passes for its own language's voice", () => {
    for (const { code } of VOICE_LANGUAGES) {
      for (const [key, line] of Object.entries(FALLBACK_MESSAGES[code])) {
        assert.equal(voiceCanSpeakText(line("Test Business"), code), true, `${code}.${key}`);
      }
    }
  });
});
