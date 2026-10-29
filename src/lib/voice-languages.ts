/**
 * The single registry of languages the voice agent supports end to end.
 *
 * A language is listed here only when every stage of the call can handle it,
 * checked against Sarvam's own documentation (2026-10-28):
 *   - STT, saaras:v3-realtime (/speech-to-text-realtime/ws): 23 languages
 *     plus "auto" — a superset of this list.
 *   - LLM, sarvam-105b / sarvam-105b-conversations: 11 languages (10 Indian
 *     + English) — exactly this list.
 *   - TTS, bulbul:v3: the same 11 language codes — exactly this list.
 * STT can therefore recognise languages (Urdu, Assamese, Nepali, …) the rest
 * of the pipeline cannot answer in; those are never a response language (see
 * resolveResponseLanguage in voice-runtime.server.ts).
 *
 * ODIA HAS TWO CODES. The realtime STT endpoint's language enum spells Odia
 * `or-IN` (and reports it that way in `transcript.final.language`), while
 * bulbul:v3 TTS, the LLM model list and the legacy STT endpoint use `od-IN` —
 * `or-IN` is not in the TTS enum at all. `code` below is the canonical
 * (TTS/LLM, and stored-config) code; `sttRealtimeCode` is what the realtime
 * STT endpoint uses. Always pass anything read from Sarvam or a saved config
 * through normalizeVoiceLanguageCode before comparing it.
 */
export interface VoiceLanguage {
  /** Canonical code: stored in agent_configs, sent to the LLM and to bulbul:v3. */
  code: string;
  /** English name, used in prompts and logs. */
  name: string;
  /** The language's own name, in its own script, for the dashboard. */
  native: string;
  /** The code saaras:v3-realtime uses for this language. */
  sttRealtimeCode: string;
}

export const VOICE_LANGUAGES = [
  { code: "en-IN", name: "English", native: "English", sttRealtimeCode: "en-IN" },
  { code: "hi-IN", name: "Hindi", native: "हिन्दी", sttRealtimeCode: "hi-IN" },
  { code: "bn-IN", name: "Bengali", native: "বাংলা", sttRealtimeCode: "bn-IN" },
  { code: "ta-IN", name: "Tamil", native: "தமிழ்", sttRealtimeCode: "ta-IN" },
  { code: "te-IN", name: "Telugu", native: "తెలుగు", sttRealtimeCode: "te-IN" },
  { code: "gu-IN", name: "Gujarati", native: "ગુજરાતી", sttRealtimeCode: "gu-IN" },
  { code: "kn-IN", name: "Kannada", native: "ಕನ್ನಡ", sttRealtimeCode: "kn-IN" },
  { code: "ml-IN", name: "Malayalam", native: "മലയാളം", sttRealtimeCode: "ml-IN" },
  { code: "mr-IN", name: "Marathi", native: "मराठी", sttRealtimeCode: "mr-IN" },
  { code: "pa-IN", name: "Punjabi", native: "ਪੰਜਾਬੀ", sttRealtimeCode: "pa-IN" },
  { code: "od-IN", name: "Odia", native: "ଓଡ଼ିଆ", sttRealtimeCode: "or-IN" },
] as const satisfies readonly VoiceLanguage[];

export type VoiceLanguageCode = (typeof VOICE_LANGUAGES)[number]["code"];

export const DEFAULT_VOICE_LANGUAGE: VoiceLanguageCode = "en-IN";

/** Every canonical code, for input validation (e.g. a zod enum). */
export const VOICE_LANGUAGE_CODES = VOICE_LANGUAGES.map((l) => l.code) as [
  VoiceLanguageCode,
  ...VoiceLanguageCode[],
];

/**
 * Maps any spelling Sarvam or a stored config might use to the canonical
 * code: case-insensitive, trimmed, `_` or `-` separated, the realtime STT
 * spelling (`or-IN`), and a bare base code (`hi`, `or`, `od`). Returns null
 * for anything outside the supported set — including a real language STT
 * recognised but the pipeline can't answer in (e.g. `ur-IN`).
 */
export function normalizeVoiceLanguageCode(raw: unknown): VoiceLanguageCode | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace("_", "-").toLowerCase();
  if (!value) return null;
  const base = value.split("-")[0];
  const region = value.split("-")[1];
  if (region !== undefined && region !== "in") return null;
  for (const lang of VOICE_LANGUAGES) {
    const codes = [lang.code, lang.sttRealtimeCode].map((c) => c.toLowerCase());
    if (codes.some((c) => c === value || c.split("-")[0] === base)) return lang.code;
  }
  return null;
}

export function isSupportedVoiceLanguage(code: unknown): code is VoiceLanguageCode {
  return typeof code === "string" && VOICE_LANGUAGES.some((l) => l.code === code);
}

export function voiceLanguage(code: string): VoiceLanguage | undefined {
  const canonical = normalizeVoiceLanguageCode(code);
  return VOICE_LANGUAGES.find((l) => l.code === canonical);
}

/** The script each language is written in (English: Latin only). */
const NATIVE_SCRIPT: Record<VoiceLanguageCode, RegExp | null> = {
  "en-IN": null,
  "hi-IN": /\p{Script=Devanagari}/u,
  "mr-IN": /\p{Script=Devanagari}/u,
  "bn-IN": /\p{Script=Bengali}/u,
  "ta-IN": /\p{Script=Tamil}/u,
  "te-IN": /\p{Script=Telugu}/u,
  "gu-IN": /\p{Script=Gujarati}/u,
  "kn-IN": /\p{Script=Kannada}/u,
  "ml-IN": /\p{Script=Malayalam}/u,
  "pa-IN": /\p{Script=Gurmukhi}/u,
  "od-IN": /\p{Script=Oriya}/u,
};

/**
 * Whether a bulbul:v3 voice configured for `language` can read `text`: every
 * letter must be Latin (English words, which every Indian-language voice
 * reads in code-mixed speech) or in that language's own script. Tamil text
 * sent to a Telugu voice, or any Indian script sent to the English voice,
 * is not something the voice can say. Digits, punctuation and symbols (₹,
 * the danda) are not letters and always pass; so do vowel signs, which are
 * marks rather than letters.
 */
export function voiceCanSpeakText(text: string, language: string): boolean {
  const lang = voiceLanguage(language);
  if (!lang) return true;
  const native = NATIVE_SCRIPT[lang.code as VoiceLanguageCode];
  for (const ch of text) {
    if (!/\p{L}/u.test(ch) || /\p{Script=Latin}/u.test(ch)) continue;
    if (native && native.test(ch)) continue;
    return false;
  }
  return true;
}

/** English name for prompts and logs; the raw code when it isn't supported. */
export function voiceLanguageName(code: string): string {
  return voiceLanguage(code)?.name ?? code;
}

/** The code saaras:v3-realtime expects, or null when it isn't a supported language. */
export function sttRealtimeLanguageCode(code: string): string | null {
  return voiceLanguage(code)?.sttRealtimeCode ?? null;
}

/**
 * A stored primary_language as a usable canonical code: normalized, and the
 * platform default when it is missing or not supported (a hand-edited row,
 * a legacy `or-IN`), so TTS is never opened with a code bulbul:v3 rejects.
 */
export function resolvePrimaryLanguage(raw: unknown): VoiceLanguageCode {
  return normalizeVoiceLanguageCode(raw) ?? DEFAULT_VOICE_LANGUAGE;
}

/**
 * Parses Sarvam's `language_confidence` — documented as a string-typed float
 * in 0.0–1.0 — into a number, or undefined when absent or not a valid
 * probability.
 */
export function parseLanguageConfidence(raw: unknown): number | undefined {
  // Number("") is 0 — an empty string must read as "no confidence", not as
  // "certainly not this language".
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < 0 || value > 1) return undefined;
  return value;
}

/* ------------------------------------------------------------------ */
/* Automatic call language                                              */
/* ------------------------------------------------------------------ */

/**
 * Every call is multilingual: the agent answers in whichever of the 11
 * languages the caller is speaking, with no per-agent setting involved (the
 * legacy agent_configs `multilingual` / `extra_languages` columns are not
 * read). The configured primary language is only where a call starts — the
 * greeting, and every reply until the caller's language is known reliably.
 *
 * What counts as "known reliably" is decided here, so a call follows a real
 * change of language but never flips back and forth on a noisy detection:
 *
 *   1. The caller explicitly asks for a language ("Can you speak Telugu?",
 *      "Hindi mein baat karo") → switch at once. Sarvam would detect such a
 *      request in the language it is SAID in, not the one asked for.
 *   1b. The transcript's own words show the language — written in an Indian
 *      script, or romanized Telugu/Hindi (textLanguageEvidence) → that
 *      language: it sets the call's language from the first utterance and
 *      switches an established one on any real sentence, whatever
 *      confidence Sarvam gave its label. Sarvam labels code-mixed Indian
 *      speech "en-IN" at 0.5–0.6 on real calls, so its label alone left
 *      Telugu and Hindi callers answered in English.
 *   2. No detection, or one outside the 11 (Sarvam's STT recognises 23) →
 *      keep the current language.
 *   3. language_confidence below RELIABLE_LANGUAGE_CONFIDENCE → ignored.
 *   4. The first reliable detection of a real sentence → adopted at once,
 *      so a caller who opens in Telugu is answered in Telugu from their
 *      first turn. A short Latin-script opener ("Hello") never sets it.
 *   5. After that, only a real sentence (MIN_SWITCH_WORDS or more words) can
 *      change the language: immediately when the detection is STRONG,
 *      otherwise when the same language is detected reliably on two such
 *      sentences in a row. Acknowledgements and fillers ("ok", "okay",
 *      "thank you", "yes yes", "haan ji", a name) are exactly what code-mixed
 *      callers say in any language, however confidently Sarvam labels them,
 *      so once the call's language is known they are ignored entirely: they
 *      can't start, complete or cancel a switch.
 * A detection with no confidence attached (pinned language_code, legacy
 * payload shape) is treated as strong, as it always has been.
 */
export const RELIABLE_LANGUAGE_CONFIDENCE = 0.6;
export const STRONG_LANGUAGE_CONFIDENCE = 0.85;
/** Fewer words than this is an acknowledgement or filler, never evidence of a language change. */
export const MIN_SWITCH_WORDS = 3;

export interface CallLanguageState {
  /** The caller's language once established; null until then (replies use the primary language). */
  current: VoiceLanguageCode | null;
  /** A different language seen once reliably, awaiting confirmation (rule 5). */
  pending: VoiceLanguageCode | null;
}

export type CallLanguageDecision =
  | "requested"
  | "adopted"
  | "pending"
  | "unchanged"
  | "no_detection"
  | "ignored_unsupported"
  | "ignored_unreliable"
  | "ignored_short";

/**
 * Where a call-language decision's evidence came from: the caller's words
 * naming a language (`request`), the script the transcript is written in
 * (`script`), romanized Indian-language words (`romanized`), or Sarvam's
 * own detected-language label (`stt`).
 */
export type CallLanguageSource = "request" | "script" | "romanized" | "stt";

export function nextCallLanguage(
  state: CallLanguageState,
  turn: { text: string; language?: string | undefined; confidence?: number | undefined },
): { state: CallLanguageState; decision: CallLanguageDecision; source: CallLanguageSource | null } {
  const requested = requestedLanguageFromText(turn.text);
  if (requested) {
    return {
      state: { current: requested, pending: null },
      decision: "requested",
      source: "request",
    };
  }
  const short = wordCount(turn.text) < MIN_SWITCH_WORDS;

  // The transcript's own words, before Sarvam's label (rule 1b; see
  // textLanguageEvidence): Sarvam labels code-mixed and romanized Indian
  // speech "en-IN" at 0.5–0.6 confidence on real calls, which would leave a
  // Telugu caller answered in English for the whole call.
  const fromText = textLanguageEvidence(turn.text, turn.language, turn.confidence);
  if (fromText) {
    const { code, source } = fromText;
    if (code === state.current) {
      return { state: { ...state, pending: null }, decision: "unchanged", source };
    }
    // Words in the caller's own language are as strong as evidence gets: a
    // first utterance of any length sets the call's language, and a real
    // sentence switches an established one at once. A short reply ("సరే",
    // "ठीक है") still never moves an established language (rule 5).
    if (state.current !== null && short) return { state, decision: "ignored_short", source };
    return { state: { current: code, pending: null }, decision: "adopted", source };
  }

  if (!turn.language) return { state, decision: "no_detection", source: null };
  const code = normalizeVoiceLanguageCode(turn.language);
  if (!code) return { state, decision: "ignored_unsupported", source: "stt" };
  if (code === state.current) {
    return { state: { ...state, pending: null }, decision: "unchanged", source: "stt" };
  }

  const confidence = turn.confidence ?? 1;
  if (confidence < RELIABLE_LANGUAGE_CONFIDENCE) {
    return { state: { ...state, pending: null }, decision: "ignored_unreliable", source: "stt" };
  }
  const strong = confidence >= STRONG_LANGUAGE_CONFIDENCE;
  const adopt = {
    state: { current: code, pending: null },
    decision: "adopted" as const,
    source: "stt" as const,
  };
  const ignoredShort = { state, decision: "ignored_short" as const, source: "stt" as const };

  // The call's first language from Sarvam's label alone: any reliable
  // sentence. A short Latin-script reply ("Hello", "Hi", "ok") never sets
  // it, however confidently labelled — Indian callers open in English
  // whatever language they go on to speak, and a "Hello" that locked the
  // call to English is exactly how a Telugu caller was answered in English
  // throughout. Only a label with no words attached (a separate
  // language-detection event) can still set it when strong.
  if (state.current === null) {
    if (!short) return adopt;
    return turn.text.trim() === "" && strong ? adopt : ignoredShort;
  }

  // An established language: a short reply never moves it (rule 5) —
  // pending is left exactly as it was, so "ok" between two English
  // sentences neither completes nor cancels that confirmation.
  if (short) return ignoredShort;
  if (strong) return adopt;
  if (state.pending === code) return adopt;
  return { state: { ...state, pending: code }, decision: "pending", source: "stt" };
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
}

/** Each Indian script, and the supported language written in it (Devanagari: see textLanguageEvidence). */
const SCRIPT_LANGUAGES: { script: RegExp; code: VoiceLanguageCode }[] = [
  { script: /\p{Script=Devanagari}/u, code: "hi-IN" },
  { script: /\p{Script=Telugu}/u, code: "te-IN" },
  { script: /\p{Script=Tamil}/u, code: "ta-IN" },
  { script: /\p{Script=Kannada}/u, code: "kn-IN" },
  { script: /\p{Script=Malayalam}/u, code: "ml-IN" },
  { script: /\p{Script=Bengali}/u, code: "bn-IN" },
  { script: /\p{Script=Gujarati}/u, code: "gu-IN" },
  { script: /\p{Script=Gurmukhi}/u, code: "pa-IN" },
  { script: /\p{Script=Oriya}/u, code: "od-IN" },
];

/**
 * Romanized words that are distinctively Telugu or Hindi — verb forms,
 * pronouns and postpositions a caller uses in any sentence, none of them an
 * English word. Loanwords both languages share with English ("appointment",
 * "book", "time") are deliberately absent: they are the code-mixed part.
 */
const ROMANIZED_MARKERS: Partial<Record<VoiceLanguageCode, ReadonlySet<string>>> = {
  "te-IN": new Set([
    "cheyali",
    "cheyyali",
    "cheyandi",
    "cheyyandi",
    "cheyadaniki",
    "chesta",
    "chestanu",
    "chestara",
    "chesaru",
    "chesanu",
    "kavali",
    "kaavali",
    "kavalandi",
    "kavalante",
    "undi",
    "unnadi",
    "unnaya",
    "unnara",
    "unnaru",
    "unnanu",
    "ledu",
    "ledhu",
    "levu",
    "naaku",
    "naku",
    "meeku",
    "meeru",
    "miru",
    "nenu",
    "memu",
    "manam",
    "enti",
    "emiti",
    "ekkada",
    "eppudu",
    "enduku",
    "entha",
    "repu",
    "ivvala",
    "eeroju",
    "ninna",
    "gantalaki",
    "gantala",
    "ganta",
    "matladandi",
    "matladu",
    "cheppandi",
    "cheppu",
    "anukuntunna",
    "anukuntunnanu",
    "anukuntunnaru",
    "anukuntunnam",
    "kosam",
    "kooda",
    "kuda",
    "avunu",
    "kadu",
    "kaadu",
    "sare",
    "bagunnara",
    "vastanu",
    "vachi",
    "ippudu",
    "inka",
    "chala",
    "andi",
    "garu",
  ]),
  "hi-IN": new Set([
    "mujhe",
    "mujhko",
    "humein",
    "hume",
    "chahiye",
    "chahta",
    "chahti",
    "chahte",
    "karna",
    "karni",
    "karwana",
    "karvana",
    "karo",
    "kariye",
    "kijiye",
    "dijiye",
    "karenge",
    "karunga",
    "karungi",
    "hai",
    "hain",
    "hoon",
    "nahi",
    "nahin",
    "kya",
    "kyun",
    "kaise",
    "kitne",
    "kitna",
    "baje",
    "aaj",
    "kal",
    "parso",
    "abhi",
    "mera",
    "meri",
    "mere",
    "aapka",
    "aapki",
    "aapko",
    "aap",
    "liye",
    "theek",
    "thik",
    "accha",
    "achha",
    "batao",
    "bataiye",
    "sakta",
    "sakti",
    "sakte",
    "chaliye",
    "hoga",
    "hogi",
  ]),
};
/** At least this many marker words, making up at least this share of the utterance's words. */
const MIN_ROMANIZED_MARKERS = 2;
const MIN_ROMANIZED_SHARE = 0.3;
/** The share of an utterance's words that must be in one Indian script for the script to decide. */
const MIN_SCRIPT_SHARE = 0.3;

/**
 * The language the transcript's own words show, or null when they don't
 * settle it (then Sarvam's label decides, in nextCallLanguage):
 *
 *   1. Script. saaras:v3-realtime's default `transcribe` mode writes each
 *       language in its own script, so words in Telugu script are Telugu
 *       speech, whatever confidence Sarvam attached to its label. The
 *       script decides when at least MIN_SCRIPT_SHARE of the words are in
 *       it (English loanwords stay Latin in code-mixed speech:
 *       "appointment book చేయాలి"). Devanagari is Hindi or Marathi: Sarvam's
 *       label picks Marathi; anything else in Devanagari is answered in
 *       Hindi.
 *   2. Romanized Telugu or Hindi. Sarvam sometimes transcribes code-mixed
 *       speech in Latin script and labels it English ("Appointment book
 *       cheyali anukuntunnaru" came back en-IN at 0.6). Distinctive marker
 *       words decide it — MIN_ROMANIZED_MARKERS of them, at least
 *       MIN_ROMANIZED_SHARE of the words — unless Sarvam reliably labelled
 *       the utterance as another of the 11 languages, which it heard and these
 *       markers only guess at.
 */
export function textLanguageEvidence(
  text: string,
  sttLanguage?: string | undefined,
  sttConfidence?: number | undefined,
): { code: VoiceLanguageCode; source: "script" | "romanized" } | null {
  const words = text.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return null;
  const labelled = normalizeVoiceLanguageCode(sttLanguage);

  let best: { code: VoiceLanguageCode; count: number } | null = null;
  for (const { script, code } of SCRIPT_LANGUAGES) {
    const count = words.filter((w) => script.test(w)).length;
    if (count > 0 && (!best || count > best.count)) best = { code, count };
  }
  if (best && best.count / words.length >= MIN_SCRIPT_SHARE) {
    const code = best.code === "hi-IN" && labelled === "mr-IN" ? "mr-IN" : best.code;
    return { code, source: "script" };
  }

  const reliableIndianLabel =
    labelled !== null &&
    labelled !== "en-IN" &&
    (sttConfidence ?? 1) >= RELIABLE_LANGUAGE_CONFIDENCE;
  if (reliableIndianLabel) return null;
  const latin = words.map((w) => w.toLowerCase().replace(/[^a-z]/g, "")).filter(Boolean);
  let romanized: { code: VoiceLanguageCode; count: number } | null = null;
  for (const [code, markers] of Object.entries(ROMANIZED_MARKERS)) {
    const count = latin.filter((w) => markers.has(w)).length;
    if (!romanized || count > romanized.count)
      romanized = { code: code as VoiceLanguageCode, count };
  }
  return romanized &&
    romanized.count >= MIN_ROMANIZED_MARKERS &&
    romanized.count / words.length >= MIN_ROMANIZED_SHARE
    ? { code: romanized.code, source: "romanized" }
    : null;
}

/**
 * How each language is named in a request: English and romanized, and in
 * the scripts callers write it in — its own, and (for English, Hindi and
 * Telugu, and for every language in Telugu script and Devanagari) the
 * caller's: a Telugu caller asks "హిందీలో మాట్లాడతావా?", a Hindi one
 * "तेलुगु में बात करो". Native names are matched as substrings, so a
 * spelling that begins an unrelated common word is left out or given in
 * its "in <language>" form instead: Tamil இந்தி is the start of இந்தியா
 * ("India"), so இந்தியில்; Kannada ಹಿಂದಿ starts ಹಿಂದಿನ ("previous"), so
 * ಹಿಂದಿಯ (ಹಿಂದಿಯಲ್ಲಿ).
 */
const LANGUAGE_NAMES: Record<VoiceLanguageCode, { latin: string[]; native: string[] }> = {
  "en-IN": {
    latin: ["english", "inglish", "angrezi", "angreji"],
    native: [
      "अंग्रेज़ी",
      "अंग्रेजी",
      "इंग्लिश",
      "ఇంగ్లీష్",
      "ఇంగ్లిష్",
      "ఆంగ్లం",
      "ஆங்கில",
      "இங்கிலீஷ்",
      "ইংরেজি",
      "ইংলিশ",
      "અંગ્રેજી",
      "ઇંગ્લિશ",
      "ಇಂಗ್ಲಿಷ್",
      "ಇಂಗ್ಲೀಷ್",
      "ഇംഗ്ലീഷ്",
      "ਅੰਗਰੇਜ਼ੀ",
      "ਅੰਗਰੇਜੀ",
      "ਇੰਗਲਿਸ਼",
      "ଇଂରାଜୀ",
      "ଇଂଲିଶ",
    ],
  },
  "hi-IN": {
    latin: ["hindi"],
    native: [
      "हिंदी",
      "हिन्दी",
      "హిందీ",
      "ஹிந்தி",
      "இந்தியில்",
      "হিন্দি",
      "હિન્દી",
      "હિંદી",
      "ಹಿಂದಿಯ",
      "ഹിന്ദി",
      "ਹਿੰਦੀ",
      "ହିନ୍ଦୀ",
    ],
  },
  "bn-IN": { latin: ["bengali", "bangla"], native: ["বাংলা", "बंगाली", "बांग्ला", "బెంగాలీ"] },
  "ta-IN": { latin: ["tamil"], native: ["தமிழ்", "तमिल", "తమిళం", "తమిళ్"] },
  "te-IN": {
    latin: ["telugu"],
    native: [
      "తెలుగు",
      "तेलुगु",
      "तेलगू",
      "தெலுங்கு",
      "তেলুগু",
      "તેલુગુ",
      "ತೆಲುಗು",
      "തെലുങ്ക്",
      "ਤੇਲਗੂ",
      "ਤੇਲੁਗੂ",
      "ତେଲୁଗୁ",
    ],
  },
  "gu-IN": { latin: ["gujarati"], native: ["ગુજરાતી", "गुजराती", "గుజరాతీ"] },
  "kn-IN": { latin: ["kannada"], native: ["ಕನ್ನಡ", "कन्नड़", "कन्नड", "కన్నడ"] },
  "ml-IN": { latin: ["malayalam"], native: ["മലയാളം", "മലയാള", "मलयालम", "మలయాళం"] },
  "mr-IN": { latin: ["marathi"], native: ["मराठी", "మరాఠీ"] },
  "pa-IN": { latin: ["punjabi"], native: ["ਪੰਜਾਬੀ", "पंजाबी", "పంజాబీ"] },
  "od-IN": {
    latin: ["odia", "oriya"],
    native: ["ଓଡ଼ିଆ", "ଓଡିଆ", "ओड़िया", "ओडिया", "उड़िया", "ఒడియా", "ఒరియా"],
  },
};

/** Zero-width joiners Indic text often carries before a suffix ("ఇంగ్లీష్‌లో") — invisible, and never part of a name. */
const ZERO_WIDTH_JOINERS = /[‌‍]/g;

/**
 * A mention of a language is a request to use it when it comes with a verb
 * of speaking ("speak", "switch to", Hindi "baat karo"/"bolo", Telugu
 * "matladandi", Tamil "pesunga", and the same verbs in each script), or
 * with a postposition right after the name ("in Hindi", "Hindi mein",
 * "Telugu lo", "తెలుగులో", "हिंदी में").
 */
const REQUEST_VERB =
  /\b(?:speak|talk|switch|change|reply|respond|answer|continue|baat|bolo|boliye|bolna|bolun|matlad\w*|pes\w*|maatad\w*|samsari\w*|kotha)\b|बात|बोल|మాట్లాడ|பேச|ಮಾತನಾಡ|സംസാരി|বলুন|কথা|બોલ|વાત|ਬੋਲ|ਗੱਲ|କୁହ|କଥା/iu;
const LATIN_POSTPOSITION = String.raw`(?:mein|me|mai|lo|la|il|alli|ma|vich|madhe)\b`;
const NATIVE_POSTPOSITION = "(?:में|मध्ये|లో|ல|ಲ್ಲಿ|ൽ|তে|માં|ਵਿੱਚ|ਚ|ରେ)";
/**
 * Negation is scoped to the language it applies to, never to the whole
 * sentence — a leading "No," / "Nahi," is a correction ("No, speak
 * English"), not a refusal of the language named after it. A language is
 * negated when it is:
 *   - directly preceded by "not"/"no" ("Speak English, not Hindi");
 *   - the object of a negated verb ("I can't speak Hindi", "I don't
 *     understand Hindi");
 *   - followed within two words by a negator ("Hindi nahi aati", "తెలుగు
 *     రాదు", "தமிழ் தெரியாது").
 */
const NEGATED_VERB = String.raw`(?:can'?t|cannot|can\s+not|don'?t|do\s+not|won'?t|unable\s+to|not\s+able\s+to)\s+(?:speak|talk|understand|follow|know|read)\s+(?:in\s+)?`;
const LATIN_NEGATOR_AFTER = String.raw`(?:nahi|nahin|nai|vaddu|venda|raadu|teriyadhu|gottilla)\b`;
const NATIVE_NEGATOR_AFTER =
  "(?:नहीं|नाही|రాదు|వద్దు|தெரியாது|வேண்டாம்|ಬರಲ್ಲ|ಬೇಡ|അറിയില്ല|വേണ്ട|জানি না|નથી|ਨਹੀਂ|ନାହିଁ)";

/**
 * A language name used as a description rather than as the language to
 * speak: the topic of "about" ("talk to someone about Hindi tuition") or a
 * modifier of the noun after it ("Hindi tuition", "a Tamil speaking doctor",
 * "Telugu movie"). A request ("speak Hindi", "in Hindi", "Hindi mein")
 * never has that shape.
 */
const DESCRIBED_NOUN = String.raw`(?:tuition|tuitions|class|classes|lesson|lessons|course|courses|teacher|teachers|tutor|tutors|speaking|speaker|speakers|movie|movies|film|films|song|songs|book|books|news|newspaper|channel|channels|medium|school|subject|exam|translation|translator|doctor|staff)\b`;

function isDescriptiveMention(text: string, latin: string): boolean {
  return new RegExp(
    String.raw`\b(?:about|regarding)\s+(?:the\s+)?(?:${latin})\b|\b(?:${latin})\s+${DESCRIBED_NOUN}`,
    "iu",
  ).test(text);
}

function isNegated(text: string, latin: string, native: string): boolean {
  return (
    new RegExp(String.raw`\b(?:not|no)\s+(?:${latin})\b|${NEGATED_VERB}(?:${latin})\b`, "iu").test(
      text,
    ) ||
    new RegExp(String.raw`\b(?:${latin})\b(?:\s+\S+){0,2}?\s+${LATIN_NEGATOR_AFTER}`, "iu").test(
      text,
    ) ||
    new RegExp(String.raw`(?:${native})\S*(?:\s+\S+){0,2}?\s+${NATIVE_NEGATOR_AFTER}`, "u").test(
      text,
    )
  );
}

/**
 * The language the caller explicitly asked the agent to speak, or null —
 * only when exactly one supported language is named without being negated,
 * and that mention is a request: "I saw a Tamil film", "Hindi or English,
 * either is fine" and "I can't speak Hindi" never switch anything, while
 * "No, speak English", "Speak English, not Hindi" and "I don't understand
 * Hindi, can you talk in English" all ask for English.
 */
export function requestedLanguageFromText(said: string): VoiceLanguageCode | null {
  const text = said.replace(ZERO_WIDTH_JOINERS, "");
  const hasVerb = REQUEST_VERB.test(text);
  const matches = VOICE_LANGUAGES.map((l) => l.code).flatMap((code) => {
    const names = LANGUAGE_NAMES[code];
    // Language names contain no regex metacharacters, so they are joined as-is.
    const latin = names.latin.join("|");
    const native = names.native.join("|");
    const mentioned =
      new RegExp(String.raw`\b(?:${latin})\b`, "iu").test(text) ||
      names.native.some((n) => text.includes(n));
    if (!mentioned || isNegated(text, latin, native) || isDescriptiveMention(text, latin)) {
      return [];
    }
    const withPostposition =
      new RegExp(
        String.raw`\bin\s+(?:${latin})\b|\b(?:${latin})\s*${LATIN_POSTPOSITION}`,
        "iu",
      ).test(text) ||
      new RegExp(String.raw`(?:${native})\s*${NATIVE_POSTPOSITION}`, "u").test(text);
    return [{ code, requested: hasVerb || withPostposition }];
  });
  if (matches.length !== 1 || !matches[0]!.requested) return null;
  return matches[0]!.code;
}
