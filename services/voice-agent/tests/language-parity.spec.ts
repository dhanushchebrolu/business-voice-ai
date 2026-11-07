/**
 * G2: the LiveKit agent speaks the production runtime's 11 languages
 * (src/lib/voice-languages.ts VOICE_LANGUAGES), resolves the caller's
 * language by the production rules (nextCallLanguage), keeps it stable, and
 * never answers a supported language in English or an unsupported one
 * silently. Sample sentences are the production runtime's own lines in each
 * language (no new translations are made for tests either).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyReading,
  newConversation,
  nextStep,
  type BusinessContext,
  type ConversationState,
} from "../src/conversation/state.ts";
import { readUtterance, type LanguageCode } from "../src/conversation/understanding.ts";
import { PHRASES } from "../src/conversation/guard.ts";
import { asLanguage } from "../src/agent/call.ts";
import { directive, fallbackLanguage } from "../src/agent/receptionist.ts";
import { VOICE_LANGUAGES } from "../../../src/lib/voice-languages.ts";
import { MISSING_DETAIL_QUESTION } from "../../../src/lib/voice-intent-lexicon.ts";

const ctx: BusinessContext = {
  businessName: "Smile Dental",
  timeZone: "Asia/Kolkata",
  services: [{ id: "svc-cleaning", name: "Teeth Cleaning", durationMinutes: 30 }],
  now: () => new Date("2026-11-07T04:30:00Z"),
};
const CODES = VOICE_LANGUAGES.map((l) => l.code) as LanguageCode[];
/** A real sentence in each language: the production runtime's own "what time?" question. */
const SENTENCE: Record<LanguageCode, string> = Object.fromEntries(
  CODES.map((c) => [
    c,
    c === "en-IN"
      ? "What time would you like to come in tomorrow?"
      : MISSING_DETAIL_QUESTION[c as Exclude<LanguageCode, "en-IN">].time,
  ]),
) as Record<LanguageCode, string>;

function call(primary: LanguageCode = "en-IN"): ConversationState {
  return newConversation({ callId: "c1", callerId: "+919876543210", primaryLanguage: primary });
}
function say(s: ConversationState, text: string, stt: string | null) {
  applyReading(s, readUtterance(text, { catalog: ctx.services, sttLanguage: stt }), ctx);
  return nextStep(s);
}

describe("G2: the 11 production languages", () => {
  test("the agent's language list is exactly the production list", () => {
    assert.deepEqual(CODES, [
      "en-IN",
      "hi-IN",
      "bn-IN",
      "ta-IN",
      "te-IN",
      "gu-IN",
      "kn-IN",
      "ml-IN",
      "mr-IN",
      "pa-IN",
      "od-IN",
    ]);
  });
  for (const code of CODES) {
    test(`${code}: a sentence in it becomes the call language; replies are asked for in it`, () => {
      const s = call("en-IN");
      // Sarvam's label for the utterance (Marathi shares Devanagari with Hindi: the label decides).
      say(s, SENTENCE[code], code);
      assert.equal(s.language.current, code);
      const name = VOICE_LANGUAGES.find((l) => l.code === code)!.name;
      assert.match(directive(nextStep(s), s, ctx), new RegExp(`Reply in ${name}\\b`));
    });
    test(`${code}: every fixed line exists and is not English (except en-IN)`, () => {
      const p = PHRASES[code];
      for (const [k, v] of Object.entries(p)) assert.ok(v && v.trim(), `${code}.${k}`);
      if (code !== "en-IN") assert.notEqual(p.service, PHRASES["en-IN"].service);
      assert.equal(fallbackLanguage(p.service, "en-IN"), code === "mr-IN" ? "hi-IN" : code);
    });
    test(`${code}: a configured primary language is kept, never mapped to English`, () => {
      assert.equal(asLanguage(code), code);
    });
  }
  test("a configured language outside the list is an explicit English fallback", () => {
    assert.equal(asLanguage("ur-IN"), "en-IN");
    assert.equal(asLanguage(null), "en-IN");
  });
});

describe("G2: the call language stays stable", () => {
  test("Telugu established; 'ok', 'yes', a name or 'Cleaning' never switch it to English", () => {
    const s = call();
    say(s, "రేపు మధ్యాహ్నం ఏం స్లాట్స్ అవైలబిలిటీ చెప్పండి.", "te-IN");
    assert.equal(s.language.current, "te-IN");
    for (const filler of ["ok", "yes", "Cleaning", "Mm-hmm Sei", "Dhanush"]) {
      say(s, filler, "en-IN");
      assert.equal(s.language.current, "te-IN", filler);
    }
  });
  test("a real English sentence does switch; Telugu words switch back", () => {
    const s = call();
    say(s, "రేపు మధ్యాహ్నం ఏం స్లాట్స్ అవైలబిలిటీ చెప్పండి.", "te-IN");
    say(s, "Could you please tell me the price for cleaning?", "en-IN");
    assert.equal(s.language.current, "en-IN");
    say(s, "పళ్ళు క్లీన్ చేసుకోవాలి అనుకుంటున్నాను.", "te-IN");
    assert.equal(s.language.current, "te-IN");
  });
  test("Telugu-English code-mixing in Telugu script stays Telugu", () => {
    const s = call();
    say(s, "1:30 PM కి ఒక స్లాట్ బుక్ చెయ్యి నాకు.", "te-IN");
    assert.equal(s.language.current, "te-IN");
    say(s, "appointment book చేయాలి రేపు", "en-IN");
    assert.equal(s.language.current, "te-IN");
  });
  test("romanized Telugu labelled English is still Telugu", () => {
    const s = call();
    say(s, "Appointment book cheyali anukuntunnanu repu", "en-IN");
    assert.equal(s.language.current, "te-IN");
  });
  test("the first meaningful sentence sets the language; a 'Hello' opener does not", () => {
    const s = call("en-IN");
    say(s, "Hello", "en-IN");
    assert.equal(s.language.established, null);
    say(s, "नमस्ते, मुझे कल अपॉइंटमेंट चाहिए", "hi-IN");
    assert.equal(s.language.current, "hi-IN");
  });
});

describe("G2: a language the agent cannot speak", () => {
  test("is never answered silently in English: the caller is told which languages it speaks", () => {
    const s = call("te-IN");
    // Urdu in its own script: not one of the 11, no Indian script, no romanized markers.
    say(s, "مجھے کل اپائنٹمنٹ چاہیے", "ur-IN");
    assert.equal(s.language.current, "te-IN", "the call keeps its language");
    assert.equal(s.language.unsupportedHeard, "ur-IN");
    const d = directive(nextStep(s), s, ctx);
    assert.match(d, /cannot speak/);
    assert.match(
      d,
      /Telugu.*English, Hindi, Bengali, Tamil, Telugu, Gujarati, Kannada, Malayalam, Marathi, Punjabi, Odia/s,
    );
    s.language.unsupportedExplained = true;
    assert.doesNotMatch(directive(nextStep(s), s, ctx), /cannot speak/, "said once");
  });
  test("a short unsupported-label filler is not treated as another language", () => {
    const s = call("te-IN");
    say(s, "ok", "ur-IN");
    assert.equal(s.language.unsupportedHeard, null);
  });
});

describe("G2: yes / no in every language reach the state", () => {
  for (const [said, expected] of [
    ["ஆம்", "affirm"],
    ["இல்லை", "deny"],
    ["হ্যাঁ", "affirm"],
    ["না", "deny"],
    ["होय", "affirm"],
    ["ના", "deny"],
    ["అవును", "affirm"],
    ["नहीं", "deny"],
  ] as const) {
    test(`${said} -> ${expected}`, () => {
      const r = readUtterance(said, { catalog: [] });
      assert.equal(r.affirm, expected === "affirm");
      assert.equal(r.deny, expected === "deny");
    });
  }
});
