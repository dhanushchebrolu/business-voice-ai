/**
 * The caller's booking intents in every supported language — the
 * non-English counterpart of the English regexes in voice-runtime.server.ts
 * (AVAILABILITY_KEYWORDS, RELATIVE_DATE_PATTERNS, extractExplicitTime,
 * the CALLER_ID_* patterns).
 *
 * Those English patterns are the runtime's deterministic backstop for the
 * model's own appointment-state block, which real calls showed is not
 * reliably emitted. With English-only patterns a Telugu or Hindi caller had
 * no backstop at all: "ఈరోజు ఏ టైం స్లాట్స్ అందుబాటులో ఉన్నాయి?" never
 * reached the calendar, and "అవును" to "shall I use the number you're
 * calling from?" was never read as consent, so the booking could never
 * complete. Only ever adds signals — the English patterns still run first.
 *
 * Matching rules: words in a space-separated script (Devanagari, Bengali,
 * Gujarati, Gurmukhi, Odia, Latin) match as whole words; in the
 * agglutinative Dravidian scripts (Telugu, Tamil, Kannada, Malayalam) a
 * term matches at the start of a word, so "ఈరోజుకి" and "నాళైక்கு" count.
 */
import type { VoiceLanguageCode } from "./voice-languages.ts";

type NonEnglish = Exclude<VoiceLanguageCode, "en-IN">;

const LETTER = String.raw`[\p{L}\p{M}]`;
const DRAVIDIAN = /[ఀ-෿]/u;

/** One alternation of terms, each anchored as a whole word (or a word start, in Dravidian scripts). */
function terms(list: string[]): RegExp {
  const parts = list.map((t) =>
    DRAVIDIAN.test(t) ? `(?<!${LETTER})${t}` : `(?<!${LETTER})${t}(?!${LETTER})`,
  );
  return new RegExp(parts.join("|"), "iu");
}

/** The zero of each Indian script's digits; each block is ten consecutive code points. */
const DIGIT_ZEROS = [0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66];

/** Native digits (०-९, ౦-౯, …) as ASCII, so "४ बजे" reads like "4 बजे". */
export function asciiDigits(text: string): string {
  return text.replace(/[०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯]/g, (d) => {
    const code = d.codePointAt(0)!;
    const zero = DIGIT_ZEROS.find((z) => code >= z && code <= z + 9)!;
    return String(code - zero);
  });
}

/** Single digits said as words — English, Telugu and Hindi, in script and romanized. */
const DIGIT_WORDS = new Map<string, string>(
  (
    [
      ["0", ["zero", "oh", "o", "సున్నా", "sunna", "शून्य", "ज़ीरो", "जीरो", "shunya"]],
      ["1", ["one", "ఒకటి", "okati", "एक", "ek"]],
      ["2", ["two", "రెండు", "rendu", "दो", "do"]],
      ["3", ["three", "మూడు", "moodu", "mudu", "तीन", "teen", "tin"]],
      ["4", ["four", "నాలుగు", "naalugu", "nalugu", "चार", "char", "chaar"]],
      ["5", ["five", "ఐదు", "aidu", "पांच", "पाँच", "paanch", "panch"]],
      ["6", ["six", "ఆరు", "aaru", "छह", "छः", "छे", "chhe", "che"]],
      ["7", ["seven", "ఏడు", "edu", "सात", "saat"]],
      ["8", ["eight", "ఎనిమిది", "enimidi", "आठ", "aath"]],
      ["9", ["nine", "తొమ్మిది", "tommidi", "नौ", "nau"]],
    ] as const
  ).flatMap(([digit, words]) => words.map((w) => [w.toLowerCase(), digit] as const)),
);
/** "double nine" / "triple seven", as Indian English speakers read numbers out. */
const REPEAT_WORDS = new Map<string, number>([
  ["double", 2],
  ["triple", 3],
]);
/** Fewer consecutive digit tokens than this is ordinary speech ("one moment", "two people"), never a number read out. */
const MIN_SPOKEN_DIGIT_RUN = 3;

/**
 * A number read out digit by digit, turned into numerals: "nine eight four
 * eight zero" → "9 8 4 8 0", "double nine" → "9 9", "తొమ్మిది ఎనిమిది
 * నాలుగు" → "9 8 4", and numerals already in the text kept as they are.
 * Only a run of MIN_SPOKEN_DIGIT_RUN or more digit tokens is converted, so
 * "one moment" or "for two people" is left untouched.
 */
export function spokenDigitsToNumerals(text: string): string {
  const tokens = asciiDigits(text).split(/(\s+|[,.;:!?।-]+)/);
  const out: string[] = [];
  let run: string[] = [];
  let runTokens: string[] = [];
  let digitTokens = 0;
  const flush = () => {
    if (digitTokens >= MIN_SPOKEN_DIGIT_RUN) {
      // Keep the separator that followed the number ("… 5 and").
      const trailing = runTokens.length && /^\s+$/.test(runTokens.at(-1)!) ? " " : "";
      out.push(run.join(" ") + trailing);
    } else {
      out.push(runTokens.join(""));
    }
    run = [];
    runTokens = [];
    digitTokens = 0;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const word = token.toLowerCase();
    if (/^\s+$|^[,.;:!?।-]+$/.test(token) || token === "") {
      if (runTokens.length) runTokens.push(token);
      else out.push(token);
      continue;
    }
    const repeat = REPEAT_WORDS.get(word);
    const next = tokens.slice(i + 1).find((t) => t.trim() && !/^[,.;:!?।-]+$/.test(t));
    const nextDigit = next
      ? (DIGIT_WORDS.get(next.toLowerCase()) ?? (/^\d$/.test(next) ? next : null))
      : null;
    if (repeat && nextDigit) {
      run.push(...Array(repeat - 1).fill(nextDigit));
      runTokens.push(token);
      digitTokens += repeat - 1;
      continue;
    }
    const digit = DIGIT_WORDS.get(word) ?? (/^\d+$/.test(token) ? token : null);
    if (digit !== null) {
      run.push(digit);
      runTokens.push(token);
      digitTokens += digit.length;
      continue;
    }
    if (runTokens.length) flush();
    out.push(token);
  }
  if (runTokens.length) flush();
  return out.join("");
}

/* ------------------------------------------------------------------ */
/* Availability                                                         */
/* ------------------------------------------------------------------ */

/**
 * "Is anything free / available / what slots" — the loanwords callers use
 * in every language ("slot", "available" in each script) and each
 * language's own words for free/available. These only ever appear in a
 * request about the calendar on a receptionist line, so no question shape
 * is required (unlike English "free", which needs one).
 */
const AVAILABILITY_TERMS = terms([
  // loanwords
  "స్లాట్",
  "స్లాట్స్",
  "अवेलेबल",
  "अवेलेबल",
  "स्लॉट",
  "स्लाट",
  "ஸ்லாட்",
  "ಸ್ಲಾಟ್",
  "സ്ലോട്ട്",
  "স্লট",
  "સ્લોટ",
  "ਸਲਾਟ",
  "ସ୍ଲଟ",
  "అవైలబుల్",
  "అవేలబుల్",
  "அவைலபிள்",
  "ಅವೈಲಬಲ್",
  "അവൈലബിൾ",
  "অ্যাভেইলেবল",
  "એવેલેબલ",
  "ਅਵੇਲੇਬਲ",
  "ଆଭେଲେବଲ",
  // free / available / vacant
  "అందుబాటు",
  "ఖాళీ",
  "ఖాళి",
  "उपलब्ध",
  "खाली",
  "ख़ाली",
  "கிடைக்கும்",
  "காலி",
  "ಲಭ್ಯ",
  "ಖಾಲಿ",
  "ലഭ്യ",
  "ഒഴിവ്",
  "ফাঁকা",
  "খালি",
  "পাওয়া যাবে",
  "रिकामा",
  "रिकामी",
  "रिकामे",
  "ઉપલબ્ધ",
  "ખાલી",
  "ਉਪਲਬਧ",
  "ਖਾਲੀ",
  "ਖ਼ਾਲੀ",
  "ଉପଲବ୍ଧ",
  "ଖାଲି",
  // romanized
  "khali",
  "khaali",
  "upalabdh",
  "andubatulo",
  "andubatu",
]);

/** The English loanwords, written in Latin script inside an Indian-language sentence. */
const LATIN_AVAILABILITY_LOANWORD = /\b(?:slots?|available|availability|timings?)\b/i;
/** Letters of any Indian script. */
const INDIC_LETTER = /[ऀ-෿]/u;
/** "Tell me / let me know" in romanized Hindi and Telugu, where the whole sentence is Latin. */
const ROMANIZED_TELL_ME = /\b(?:batao|bataiye|bataye|cheppandi|cheppu|chepandi)\b/i;

/**
 * The caller is asking what's open, in any supported language (English
 * phrasing is the runtime's own patterns): the words for free/available in
 * each script, or the English loanwords inside an Indian-language sentence
 * ("मुझे आज के available slots बताइए।", "slots unnaya cheppandi").
 */
export function availabilityRequestedAnyLanguage(text: string): boolean {
  if (AVAILABILITY_TERMS.test(text)) return true;
  return (
    LATIN_AVAILABILITY_LOANWORD.test(text) &&
    (INDIC_LETTER.test(text) || ROMANIZED_TELL_ME.test(text))
  );
}

/* ------------------------------------------------------------------ */
/* Today / tomorrow                                                     */
/* ------------------------------------------------------------------ */

const TODAY_TERMS = terms([
  "ఈరోజు",
  "ఈ రోజు",
  "ఇవాళ",
  "ఇవ్వాళ",
  "ఇవాళే",
  "आज",
  "இன்று",
  "இன்னைக்கு",
  "இன்றைக்கு",
  "ಇಂದು",
  "ಇವತ್ತು",
  "ഇന്ന്",
  "ഇന്നു",
  "আজ",
  "আজকে",
  "આજે",
  "આજ",
  "ਅੱਜ",
  "ଆଜି",
  "aaj",
  "ivvala",
  "ivala",
  "eeroju",
  "ee roju",
  "indru",
  "innaiku",
  "ivattu",
  "aaji",
]);

/**
 * Hindi/Urdu "कल", Bengali "কাল" and Gujarati "કાલે" also mean
 * "yesterday"; on a booking line, about an appointment, it is tomorrow.
 */
const TOMORROW_TERMS = terms([
  "రేపు",
  "రేపటి",
  "कल",
  "நாளை",
  "நாளைக்கு",
  "ನಾಳೆ",
  "നാളെ",
  "আগামীকাল",
  "কাল",
  "उद्या",
  "આવતીકાલે",
  "કાલે",
  "ਕੱਲ੍ਹ",
  "ਕੱਲ",
  "ਭਲਕੇ",
  "ଆସନ୍ତାକାଲି",
  "କାଲି",
  "kal",
  "repu",
  "naalai",
  "nalai",
  "naale",
  "udya",
]);

/** "today"/"tomorrow" said in any supported language, or null. */
export function relativeDateAnyLanguage(text: string): "today" | "tomorrow" | null {
  const negated = negatedRelativeDates(text);
  if (TOMORROW_TERMS.test(text) && !negated.has("tomorrow")) return "tomorrow";
  if (TODAY_TERMS.test(text) && !negated.has("today")) return "today";
  return null;
}

/**
 * "today"/"tomorrow" the caller rules out in the same breath: "not
 * tomorrow, today", "कल नहीं, आज", "రేపు కాదు, ఈరోజు", "kal nahi aaj".
 * Without this, "tomorrow" — checked first — won even when negated.
 */
export function negatedRelativeDates(text: string): Set<"today" | "tomorrow"> {
  const out = new Set<"today" | "tomorrow">();
  // A bare "no" is not a negator here: "no, tomorrow is fine" (often
  // transcribed without the comma) is a correction TO tomorrow. Nor is
  // "not until tomorrow", which means tomorrow.
  const english =
    /\b(?:not(?!\s+until\b)|don'?t\s+want|instead\s+of)\s+(?:\w+\s+){0,2}?(tomorrow|today)\b|\b(tomorrow|today)\s+(?:is\s+)?not\b/gi;
  for (const m of text.matchAll(english))
    out.add((m[1] ?? m[2])!.toLowerCase() as "today" | "tomorrow");
  if (
    /(?:कल)\s*(?:नहीं|नही|मत)|\bkal\s+(?:nahi|nahin|mat)\b|(?:రేపు|రేపటి)\s*(?:కాదు|వద్దు)|\brepu\s+(?:kaadu|vaddu)\b/iu.test(
      text,
    )
  ) {
    out.add("tomorrow");
  }
  if (
    /(?:आज)\s*(?:नहीं|नही|मत)|\baaj\s+(?:nahi|nahin|mat)\b|(?:ఈరోజు|ఈ\s+రోజు|ఇవాళ)\s*(?:కాదు|వద్దు)|\b(?:ivvala|eeroju)\s+(?:kaadu|vaddu)\b/iu.test(
      text,
    )
  ) {
    out.add("today");
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Time of day and clock times                                          */
/* ------------------------------------------------------------------ */

const PERIODS: ["morning" | "afternoon" | "evening", RegExp][] = [
  [
    "evening",
    terms([
      "సాయంత్రం",
      "शाम",
      "மாலை",
      "ಸಂಜೆ",
      "വൈകുന്നേരം",
      "വൈകിട്ട്",
      "সন্ধ্যা",
      "সন্ধে",
      "संध्याकाळ",
      "સાંજે",
      "સાંજ",
      "ਸ਼ਾਮ",
      "ਸ਼ਾਮੀਂ",
      "ସନ୍ଧ୍ୟା",
      "shaam",
      "sham",
      "sayantram",
      "saayantram",
    ]),
  ],
  [
    "afternoon",
    terms([
      "మధ్యాహ్నం",
      "दोपहर",
      "மதியம்",
      "ಮಧ್ಯಾಹ್ನ",
      "ഉച്ച",
      "দুপুর",
      "বিকেল",
      "दुपार",
      "બપોરે",
      "બપોર",
      "ਦੁਪਹਿਰ",
      "ମଧ୍ୟାହ୍ନ",
      "ଅପରାହ୍ନ",
      "dopahar",
      "dopehar",
      "madhyanam",
    ]),
  ],
  [
    "morning",
    terms([
      "ఉదయం",
      "పొద్దున",
      "పొద్దున్న",
      "सुबह",
      "காலை",
      "ಬೆಳಿಗ್ಗೆ",
      "ಬೆಳಗ್ಗೆ",
      "രാവിലെ",
      "সকাল",
      "সকালে",
      "सकाळ",
      "सकाळी",
      "સવારે",
      "સવાર",
      "ਸਵੇਰ",
      "ਸਵੇਰੇ",
      "ସକାଳ",
      "subah",
      "subha",
      "udayam",
      "poddunna",
    ]),
  ],
];

/** "In the evening" (etc.) in any supported language, or null. */
export function periodAnyLanguage(text: string): "morning" | "afternoon" | "evening" | null {
  return PERIODS.find(([, re]) => re.test(text))?.[0] ?? null;
}

/** Number words for the hours callers say, in Hindi and Telugu (both scripts and romanized). */
const HOUR_WORDS: [number, string[]][] = [
  [1, ["एक", "ek", "ఒకటి", "ఒంటి", "okati", "onti"]],
  [2, ["दो", "do", "రెండు", "rendu"]],
  [3, ["तीन", "teen", "tin", "మూడు", "moodu", "mudu"]],
  [4, ["चार", "char", "chaar", "నాలుగు", "naalugu", "nalugu"]],
  [5, ["पांच", "पाँच", "paanch", "panch", "ఐదు", "aidu"]],
  [6, ["छह", "छः", "छे", "chhe", "che", "ఆరు", "aaru"]],
  [7, ["सात", "saat", "ఏడు", "edu"]],
  [8, ["आठ", "aath", "ఎనిమిది", "enimidi"]],
  [9, ["नौ", "nau", "తొమ్మిది", "tommidi"]],
  [10, ["दस", "das", "పది", "padi"]],
  [11, ["ग्यारह", "gyarah", "gyaarah", "పదకొండు", "padakondu"]],
  [12, ["बारह", "barah", "baarah", "పన్నెండు", "pannendu"]],
];
const HOUR_WORD_VALUE = new Map(
  HOUR_WORDS.flatMap(([n, words]) => words.map((w) => [w.toLowerCase(), n] as const)),
);
/** Telugu "at N" as one word: నాలుగింటికి, మూడింటికి, ఒంటిగంటకు. */
const TELUGU_AT_HOUR: [number, string][] = [
  [1, "ఒంటిగంట"],
  [2, "రెండింటి"],
  [3, "మూడింటి"],
  [4, "నాలుగింటి"],
  [5, "ఐదింటి"],
  [6, "ఆరింటి"],
  [7, "ఏడింటి"],
  [8, "ఎనిమిదింటి"],
  [9, "తొమ్మిదింటి"],
  [10, "పదింటి"],
  [11, "పదకొండింటి"],
  [12, "పన్నెండింటి"],
];

/** "o'clock" after an hour, in each language: "4 బజే", "4 గంటలకు", "4 மணிக்கு", … */
const HOUR_MARKER = String.raw`(?:बजे|बजकर|बज|గంటలకు|గంటకు|గంటలకి|గంటల|గంట|மணிக்கு|மணி|ಗಂಟೆಗೆ|ಗಂಟೆ|മണിക്ക്|മണി|টায়|টার|টা|वाजता|वाजे|વાગ્યે|વાગે|ਵਜੇ|ଟାରେ|ଟା|baje|bajke|gantalaku|gantalaki|gantaki|ganta|manikku|mani|gantege|vajta)`;
const HOUR_TOKEN = String.raw`(\d{1,2})(?::(\d{2}))?|([\p{L}\p{M}]+)`;
const CLOCK_TIME = new RegExp(
  String.raw`(?<![\p{L}\p{M}\d])(?:(साढ़े|साढे|sadhe|saadhe)\s*)?(?:${HOUR_TOKEN})\s*${HOUR_MARKER}`,
  "iu",
);

/**
 * A clock time said in any supported language — "शाम चार बजे", "4 గంటలకు",
 * "సాయంత్రం నాలుగింటికి", "साढ़े तीन बजे" — as 24-hour "HH:mm". Without an
 * am/pm word the hour is read like the English bare-time rule: 1–6 is the
 * afternoon; a morning/afternoon/evening word in the same sentence decides
 * when present. Null when no hour with an "o'clock" marker is said.
 */
export function explicitTimeAnyLanguage(text: string): string | null {
  const said = asciiDigits(text);
  let hour: number | null = null;
  let minute = 0;
  const match = CLOCK_TIME.exec(said);
  if (match) {
    const [, half, digits, minutes, word] = match;
    if (digits) hour = Number(digits);
    else if (word) hour = HOUR_WORD_VALUE.get(word.toLowerCase()) ?? null;
    if (minutes) minute = Number(minutes);
    else if (half) minute = 30;
  }
  if (hour === null) {
    const telugu = TELUGU_AT_HOUR.find(([, stem]) => said.includes(stem));
    if (telugu) hour = telugu[0];
  }
  if (hour === null || hour < 0 || hour > 23 || minute > 59) return null;
  if (hour <= 12) {
    const period = periodAnyLanguage(said);
    if ((period === "evening" || period === "afternoon") && hour < 12) hour += 12;
    else if (period === null && hour >= 1 && hour <= 6) hour += 12;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* The caller's phone number                                            */
/* ------------------------------------------------------------------ */

/** "Number" (a phone number) in each script. */
const NUMBER_WORD = terms([
  "నంబర్",
  "నెంబర్",
  "నంబరు",
  "नंबर",
  "नम्बर",
  "நம்பர்",
  "எண்",
  "ನಂಬರ್",
  "ಸಂಖ್ಯೆ",
  "നമ്പർ",
  "নম্বর",
  "નંબર",
  "ਨੰਬਰ",
  "ନମ୍ବର",
]);

/** A reply that asks the caller something about a phone number, in any non-English language. */
export function asksAboutPhoneNumberAnyLanguage(reply: string): boolean {
  return NUMBER_WORD.test(reply) && /[?？]/.test(reply);
}

/** "This same number" / "a different number", in the caller's own words. */
const SAME_NUMBER = terms([
  "ఇదే నంబర్",
  "ఇదే నెంబర్",
  "ఈ నంబర్",
  "ఈ నెంబర్",
  "అదే నంబర్",
  "इसी नंबर",
  "यही नंबर",
  "इस नंबर",
  "इसी पर",
  "यही वाला",
  "same number",
  "isi number",
  "yahi number",
  "ide number",
  "ee number",
]);
const DIFFERENT_NUMBER = terms([
  "వేరే నంబర్",
  "వేరే నెంబర్",
  "ఇంకో నంబర్",
  "दूसरा नंबर",
  "दूसरे नंबर",
  "अलग नंबर",
  "dusra number",
  "doosra number",
  "vere number",
]);

/**
 * The caller's answer to "shall I use the number you're calling from?" in a
 * language other than English, or null when it isn't one: a short yes/no
 * (confirmationAnswerAnyLanguage), or "this same number" / "a different
 * number" in their words. "Different" wins, as in English. A yes/no
 * followed by a politeness word ("అవును అండి", "हाँ जी बिल्कुल") is read
 * from its first word.
 */
export function callerIdAnswerAnyLanguage(
  text: string,
  yesNo: (text: string) => "yes" | "no" | null,
): "accept" | "different" | null {
  if (DIFFERENT_NUMBER.test(text)) return "different";
  const firstWord = text.trim().split(/[\s,.!?।]+/)[0] ?? "";
  const answer = yesNo(text) ?? (firstWord ? yesNo(firstWord) : null);
  if (answer === "no") return "different";
  if (answer === "yes" || SAME_NUMBER.test(text)) return "accept";
  return null;
}

/** "Shall I use the number you're calling from?" in each language — the runtime's own question, so the answer is read as consent. */
export const CALLER_ID_QUESTION_BY_LANGUAGE: Record<NonEnglish, string> = {
  "hi-IN": "जिस नंबर से आप कॉल कर रहे हैं, क्या वही नंबर इस्तेमाल कर लूँ?",
  "te-IN": "మీరు కాల్ చేస్తున్న ఈ నంబర్‌నే వాడమంటారా?",
  "ta-IN": "நீங்கள் அழைக்கும் இந்த எண்ணையே பயன்படுத்தலாமா?",
  "kn-IN": "ನೀವು ಕರೆ ಮಾಡುತ್ತಿರುವ ಇದೇ ನಂಬರನ್ನು ಬಳಸಲೇ?",
  "ml-IN": "നിങ്ങൾ വിളിക്കുന്ന ഈ നമ്പർ തന്നെ ഉപയോഗിക്കട്ടെ?",
  "bn-IN": "আপনি যে নম্বর থেকে ফোন করছেন, সেটাই ব্যবহার করব?",
  "mr-IN": "तुम्ही ज्या नंबरवरून कॉल करत आहात, तोच नंबर वापरू का?",
  "gu-IN": "તમે જે નંબર પરથી કૉલ કરી રહ્યા છો, એ જ નંબર વાપરું?",
  "pa-IN": "ਕੀ ਮੈਂ ਉਹੀ ਨੰਬਰ ਵਰਤਾਂ ਜਿਸ ਤੋਂ ਤੁਸੀਂ ਕਾਲ ਕਰ ਰਹੇ ਹੋ?",
  "od-IN": "ଆପଣ ଯେଉଁ ନମ୍ବରରୁ କଲ୍ କରୁଛନ୍ତି, ସେହି ନମ୍ବର ବ୍ୟବହାର କରିବି କି?",
};

/** "Is that right?" after a number is read back, in every supported language. */
export const IS_THAT_RIGHT: Record<VoiceLanguageCode, string> = {
  "en-IN": "Is that right?",
  "hi-IN": "सही है?",
  "te-IN": "సరేనా?",
  "ta-IN": "சரியா?",
  "kn-IN": "ಸರಿಯೇ?",
  "ml-IN": "ശരിയാണോ?",
  "bn-IN": "ঠিক আছে?",
  "mr-IN": "बरोबर आहे का?",
  "gu-IN": "બરાબર છે?",
  "pa-IN": "ਠੀਕ ਹੈ?",
  "od-IN": "ଠିକ୍ ଅଛି କି?",
};

/**
 * Asked when the caller points at "the second one" but the agent's last
 * reply named no list it could mean, so nothing is guessed.
 */
export const WHICH_ONE_QUESTION: Record<VoiceLanguageCode, string> = {
  "en-IN": "Sorry, which one did you mean?",
  "hi-IN": "माफ़ कीजिए, आप कौन सा कह रहे हैं?",
  "te-IN": "క్షమించండి, మీరు ఏది అంటున్నారు?",
  "ta-IN": "மன்னிக்கவும், நீங்கள் எதைச் சொல்கிறீர்கள்?",
  "kn-IN": "ಕ್ಷಮಿಸಿ, ನೀವು ಯಾವುದನ್ನು ಹೇಳುತ್ತಿದ್ದೀರಿ?",
  "ml-IN": "ക്ഷമിക്കണം, നിങ്ങൾ ഏതാണ് ഉദ്ദേശിച്ചത്?",
  "bn-IN": "দুঃখিত, আপনি কোনটার কথা বলছেন?",
  "mr-IN": "माफ करा, तुम्ही कोणतं म्हणताय?",
  "gu-IN": "માફ કરશો, તમે કયું કહો છો?",
  "pa-IN": "ਮਾਫ਼ ਕਰਨਾ, ਤੁਸੀਂ ਕਿਹੜਾ ਕਹਿ ਰਹੇ ਹੋ?",
  "od-IN": "କ୍ଷମା କରିବେ, ଆପଣ କେଉଁଟି କହୁଛନ୍ତି?",
};

/**
 * Ordinals as a choice among options — never the bare word, which usually
 * means something else ("first tell me the price", "पहले फीस बताइए",
 * "ముందు చెప్పండి"): English "the/<ordinal> one/option/time/slot/service",
 * Telugu "-ది" forms ("రెండోది") or the ordinal before an option word, Hindi
 * and romanized with "वाला"/"wala" or an option word.
 */
const OPTION_NOUN_EN = String.raw`(?:one|option|time|slot|service)`;
const OPTION_NOUN_TE = "(?:సర్వీస్|టైమ్|టైం|ఆప్షన్|స్లాట్)";
const OPTION_NOUN_HI = "(?:वाला|वाली|वाले|सर्विस|टाइम|स्लॉट|ऑप्शन)";
const OPTION_NOUN_ROMAN = String.raw`(?:wala|wali|wale|one|option|time|slot)`;
function ordinal(
  en: string,
  teOne: string,
  teAdj: string,
  hi: string,
  roman: string,
  teRomanOne?: string,
): RegExp {
  return new RegExp(
    [
      // Romanized Telugu "rendodi" ("the second one") stands alone, like రెండోది.
      ...(teRomanOne ? [String.raw`\b${teRomanOne}\b`] : []),
      String.raw`\bthe\s+${en}\b`,
      String.raw`\b${en}\s+${OPTION_NOUN_EN}\b`,
      `(?<![\\p{L}\\p{M}])${teOne}`,
      `(?<![\\p{L}\\p{M}])${teAdj}\\s*${OPTION_NOUN_TE}`,
      `(?<![\\p{L}\\p{M}])${hi}\\s+${OPTION_NOUN_HI}`,
      String.raw`\b${roman}\s+${OPTION_NOUN_ROMAN}\b`,
    ].join("|"),
    "iu",
  );
}
const ORDINALS: [number, RegExp][] = [
  [
    1,
    ordinal(
      "(?:first|1st)",
      "మొదటిది",
      "మొదటి",
      "(?:पहला|पहली)",
      "(?:pehla|pehli|modati)",
      "(?:modatidi|modatidhi)",
    ),
  ],
  [
    2,
    ordinal(
      "(?:second|2nd)",
      "రెండోది",
      "(?:రెండో|రెండవ)",
      "(?:दूसरा|दूसरी)",
      "(?:dusra|doosra|dusri|rendo)",
      "(?:rendodi|rendodhi|rendavadi)",
    ),
  ],
  [
    3,
    ordinal(
      "(?:third|3rd)",
      "మూడోది",
      "(?:మూడో|మూడవ)",
      "(?:तीसरा|तीसरी)",
      "(?:teesra|tisra|teesri|moodo)",
      "(?:moododi|mooddodi|mudodi)",
    ),
  ],
  [
    4,
    ordinal(
      "(?:fourth|4th)",
      "నాలుగోది",
      "(?:నాలుగో|నాలుగవ)",
      "(?:चौथा|चौथी)",
      "(?:chautha|chauthi)",
    ),
  ],
  [
    5,
    ordinal(
      "(?:fifth|5th)",
      "ఐదోది",
      "(?:ఐదో|ఐదవ)",
      "(?:पांचवा|पाँचवाँ|पांचवी)",
      "(?:paanchva|paanchvi)",
    ),
  ],
];
const LAST = new RegExp(
  String.raw`\bthe\s+last\b|\blast\s+${OPTION_NOUN_EN}\b|(?<![\p{L}\p{M}])చివరిది|(?<![\p{L}\p{M}])(?:आखिरी|आख़िरी)\s+${OPTION_NOUN_HI}|\b(?:aakhri|akhri)\s+${OPTION_NOUN_ROMAN}\b`,
  "iu",
);
const EARLIER = new RegExp(
  String.raw`\b(?:the\s+)?(?:earlier|earliest|sooner)(?:\s+${OPTION_NOUN_EN})?\b|(?<![\p{L}\p{M}])ముందుది|(?<![\p{L}\p{M}])(?:पहले|जल्दी)\s+(?:वाला|वाली)|\b(?:pehle|jaldi)\s+(?:wala|wali)\b`,
  "iu",
);
const LATER = new RegExp(
  String.raw`\b(?:the\s+)?(?:later|latest)(?:\s+${OPTION_NOUN_EN})?\b|(?<![\p{L}\p{M}])తర్వాతది|(?<![\p{L}\p{M}])(?:बाद|लेट)\s+(?:वाला|वाली)|\b(?:baad|late)\s+(?:wala|wali)\b`,
  "iu",
);

/**
 * The caller is changing something already said — "change it to
 * tomorrow", "actually, cleaning instead", "not that one, the second one",
 * "రేపటికి మార్చండి", "అది కాదు", "badulu", "कल कर दीजिए, आज नहीं", "badal
 * do". On such a turn the caller's own words are the new value, over any
 * older value the model's state block still repeats.
 */
const CORRECTION = new RegExp(
  [
    String.raw`\b(?:actually|instead|rather|change\s+(?:it|that|the\s+\w+)|make\s+it|switch\s+(?:it|to)|not\s+that(?:\s+one)?|i\s+(?:meant|said)|correction|wrong\s+(?:one|time|day|date))\b`,
    "మార్చ|బదులు|కాదు",
    String.raw`\b(?:kaadu|kadu|ma+rch(?:andi|u|i|esi|eyandi|eyi)|badulu|vaddu)\b`,
    "बदल|की\\s+जगह|बल्कि|असल\\s+में|वो\\s+नहीं|नहीं",
    String.raw`\b(?:badal\w*|ki\s+jagah|balki|asal\s+mein|nahi|nahin)\b`,
  ].join("|"),
  "iu",
);

export function isCorrection(text: string): boolean {
  return CORRECTION.test(text);
}

/**
 * Which of the options the agent just read out the caller is pointing at:
 * a position ("the second one", "రెండోది", "दूसरा वाला"), the last one, or —
 * for times — the earlier or later one. Null when the turn is not a short
 * reference (more than six words is a sentence about something else, where
 * "first" or "later" mean what they usually mean).
 */
export function optionReference(
  text: string,
): { position: number } | "last" | "earlier" | "later" | null {
  if (text.trim().split(/\s+/).length > 6) return null;
  const ordinal = ORDINALS.find(([, re]) => re.test(text));
  if (ordinal) return { position: ordinal[0] };
  if (LAST.test(text)) return "last";
  if (EARLIER.test(text)) return "earlier";
  if (LATER.test(text)) return "later";
  return null;
}

/**
 * A phone number as it is read back on a call: the ten national digits one
 * by one, in two groups of five ("9 8 4 8 0, 1 2 3 4 5"), so the voice
 * says each digit instead of a large number. Other lengths are read digit
 * by digit without grouping.
 */
export function spokenPhoneDigits(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const national = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  const spaced = (s: string) => s.split("").join(" ");
  return national.length === 10
    ? `${spaced(national.slice(0, 5))}, ${spaced(national.slice(5))}`
    : spaced(national);
}

/** The one detail still missing before a booking can be summarized. */
export type MissingDetail = "service" | "name" | "date" | "time" | "phone";

/**
 * One short question for each missing detail, in each language — the
 * non-English counterpart of nextMissingDetailQuestion. Asked instead of a
 * general "nothing is booked yet, tell me the remaining details", so the
 * caller is asked only for what is actually missing.
 */
export const MISSING_DETAIL_QUESTION: Record<NonEnglish, Record<MissingDetail, string>> = {
  "hi-IN": {
    service: "आपको कौन सी सर्विस चाहिए?",
    name: "अपॉइंटमेंट किसके नाम पर बुक करूँ?",
    date: "आप किस दिन आना चाहेंगे?",
    time: "आपको कितने बजे का समय चाहिए?",
    phone: "आपका फ़ोन नंबर क्या है?",
  },
  "te-IN": {
    service: "మీకు ఏ సర్వీస్ కావాలి?",
    name: "అపాయింట్‌మెంట్ ఎవరి పేరు మీద బుక్ చేయాలి?",
    date: "ఏ రోజు రావాలనుకుంటున్నారు?",
    time: "ఎన్ని గంటలకు రావాలనుకుంటున్నారు?",
    phone: "మీ ఫోన్ నంబర్ చెప్తారా?",
  },
  "ta-IN": {
    service: "உங்களுக்கு எந்த சர்வீஸ் வேண்டும்?",
    name: "அப்பாயின்ட்மென்ட் யாருடைய பெயரில் புக் செய்யட்டும்?",
    date: "எந்த நாள் வர விரும்புகிறீர்கள்?",
    time: "எத்தனை மணிக்கு வர விரும்புகிறீர்கள்?",
    phone: "உங்கள் போன் நம்பர் என்ன?",
  },
  "kn-IN": {
    service: "ನಿಮಗೆ ಯಾವ ಸರ್ವೀಸ್ ಬೇಕು?",
    name: "ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಯಾರ ಹೆಸರಿನಲ್ಲಿ ಬುಕ್ ಮಾಡಲಿ?",
    date: "ಯಾವ ದಿನ ಬರಲು ಬಯಸುತ್ತೀರಿ?",
    time: "ಎಷ್ಟು ಗಂಟೆಗೆ ಬರಲು ಬಯಸುತ್ತೀರಿ?",
    phone: "ನಿಮ್ಮ ಫೋನ್ ನಂಬರ್ ಯಾವುದು?",
  },
  "ml-IN": {
    service: "നിങ്ങൾക്ക് ഏത് സർവീസ് ആണ് വേണ്ടത്?",
    name: "അപ്പോയിന്റ്മെന്റ് ആരുടെ പേരിൽ ബുക്ക് ചെയ്യണം?",
    date: "ഏത് ദിവസം വരാനാണ് ആഗ്രഹിക്കുന്നത്?",
    time: "എത്ര മണിക്ക് വരാനാണ് ആഗ്രഹിക്കുന്നത്?",
    phone: "നിങ്ങളുടെ ഫോൺ നമ്പർ എന്താണ്?",
  },
  "bn-IN": {
    service: "আপনার কোন সার্ভিসটা দরকার?",
    name: "অ্যাপয়েন্টমেন্টটা কার নামে করব?",
    date: "আপনি কোন দিন আসতে চান?",
    time: "কটার সময় আসতে চান?",
    phone: "আপনার ফোন নম্বরটা কত?",
  },
  "mr-IN": {
    service: "तुम्हाला कोणती सेवा हवी आहे?",
    name: "अपॉइंटमेंट कोणाच्या नावावर करू?",
    date: "तुम्हाला कोणत्या दिवशी यायचे आहे?",
    time: "तुम्हाला किती वाजताची वेळ हवी आहे?",
    phone: "तुमचा फोन नंबर काय आहे?",
  },
  "gu-IN": {
    service: "તમને કઈ સર્વિસ જોઈએ છે?",
    name: "અપોઇન્ટમેન્ટ કોના નામે બુક કરું?",
    date: "તમે કયા દિવસે આવવા માંગો છો?",
    time: "તમે કેટલા વાગ્યે આવવા માંગો છો?",
    phone: "તમારો ફોન નંબર શું છે?",
  },
  "pa-IN": {
    service: "ਤੁਹਾਨੂੰ ਕਿਹੜੀ ਸਰਵਿਸ ਚਾਹੀਦੀ ਹੈ?",
    name: "ਅਪੌਇੰਟਮੈਂਟ ਕਿਸ ਦੇ ਨਾਮ 'ਤੇ ਬੁੱਕ ਕਰਾਂ?",
    date: "ਤੁਸੀਂ ਕਿਹੜੇ ਦਿਨ ਆਉਣਾ ਚਾਹੁੰਦੇ ਹੋ?",
    time: "ਤੁਸੀਂ ਕਿੰਨੇ ਵਜੇ ਆਉਣਾ ਚਾਹੁੰਦੇ ਹੋ?",
    phone: "ਤੁਹਾਡਾ ਫ਼ੋਨ ਨੰਬਰ ਕੀ ਹੈ?",
  },
  "od-IN": {
    service: "ଆପଣଙ୍କୁ କେଉଁ ସର୍ଭିସ୍ ଦରକାର?",
    name: "ଆପଏଣ୍ଟମେଣ୍ଟ କାହା ନାମରେ ବୁକ୍ କରିବି?",
    date: "ଆପଣ କେଉଁ ଦିନ ଆସିବାକୁ ଚାହାଁନ୍ତି?",
    time: "ଆପଣ କେତେବେଳେ ଆସିବାକୁ ଚାହାଁନ୍ତି?",
    phone: "ଆପଣଙ୍କ ଫୋନ୍ ନମ୍ବର କେତେ?",
  },
};

/* ------------------------------------------------------------------ */
/* Pre-deployment audit: rejections, names, protected tokens, claims   */
/* ------------------------------------------------------------------ */

/** Case-insensitive Unicode alternation of strings and regexes. */
function anyOf(...parts: (string | RegExp)[]): RegExp {
  return new RegExp(parts.map((p) => (typeof p === "string" ? p : p.source)).join("|"), "iu");
}

/** A Telugu/Devanagari word bounded by non-letters of those scripts. */
function bounded(word: string): string {
  return `(?<![\\u0C00-\\u0C7F\\u0900-\\u097F])(?:${word})(?![\\u0C00-\\u0C7F\\u0900-\\u097F])`;
}

/**
 * Splits text into sentences without touching what is inside them: a
 * sentence ends at . ! ? । only when followed by whitespace or the end, so
 * an email ("clinic@example.com"), a URL, a decimal price ("₹1,499.50") or a
 * time ("6.30") is never cut, and "Dr. Rao" stays whole. Each piece keeps
 * its trailing whitespace, so pieces.join("") === text.
 */
export function splitSentences(text: string): string[] {
  const pieces: string[] = [];
  const end = /[.!?।]+(?=\s|$)/gu;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = end.exec(text))) {
    if (m[0] === ".") {
      const before = text.slice(start, m.index);
      // Titles and single initials: "Dr. Rao", "A. Kumar".
      if (/(?:^|[\s(])(?:Dr|Mr|Mrs|Ms|Mx|St|Prof|Sr|Jr|[A-Z])$/.test(before)) continue;
    }
    let next = m.index + m[0].length;
    while (next < text.length && /\s/u.test(text[next]!)) next++;
    pieces.push(text.slice(start, next));
    start = next;
  }
  if (start < text.length) pieces.push(text.slice(start));
  return pieces;
}

/** "This number" / "the number I'm calling from", in Telugu, Hindi, romanized and English. */
const THIS_NUMBER =
  "(?:(?:ఇదే|ఈ|అదే|ఆ)\\s*(?:ఫోన్\\s*)?(?:నెంబర్|నంబర్|నెంబరు|నంబరు)|(?:కాల్|ఫోన్)\\s*(?:చేసిన|చేస్తున్న|చేసే)[^.?!,]{0,12}(?:నెంబర్|నంబర్|నెంబరు|నంబరు)|(?:यही|इसी|वही|उसी|यह|ये|इस|उस)\\s*(?:फ़ोन\\s*|फोन\\s*)?(?:नंबर|नम्बर)|\\b(?:ide|ee|ade|aa|idhe|adhe|same|this|that|yahi|isi|wahi|usi|ye|yeh|is)\\s+(?:phone\\s+)?(?:number|nambar|nembar)\\b|\\bcall\\s+(?:chesina|chestunna|chesthunna)\\s+(?:phone\\s+)?(?:number|nambar)\\b)";

/**
 * The caller rejects the calling number itself, the negation bound to the
 * number phrase: after it in Telugu/Hindi word order ("ఈ నెంబర్ కాదు",
 * "same number kaadu", "यह नंबर नहीं", "इस नंबर पर नहीं"), before it in
 * English ("not this number", "don't use that number"). A leading "కాదు,
 * ఇదే నెంబర్ వాడండి" ("no — use this one") is a correction toward it.
 */
export const CALLER_ID_REJECTED = anyOf(
  `${THIS_NUMBER}[\\s,]*(?:కి|కు|ను|నే|తో|पर|पे|से)?[\\s,]*(?:${bounded("కాదు")}|${bounded("కాదండి")}|వద్దు|వాడకండి|వాడొద్దు|యూస్\\s*చేయకండి|${bounded("नहीं")}|${bounded("मत")})`,
  `${THIS_NUMBER}[\\s,]*(?:ki|ku|nu|ne|to|pe|par|se)?[\\s,]*\\b(?:kaadu|kadu|kaadandi|vaddu|vadhu|vaadakandi|vadakandi|use\\s+cheyyakandi|use\\s+cheyakandi|nahi|nahin|mat)\\b`,
  // "number" is required: "not that one" picks among slots or services.
  /\b(?:not|never)\s+(?:the\s+)?(?:this|that|same|my|the)\s+(?:same\s+)?(?:phone\s+)?number\b/,
  /\b(?:don'?t|do\s+not|never)\s+use\s+(?:this|that|the\s+same|my|the)\s+(?:same\s+)?(?:phone\s+)?number\b/,
);

/** A negator inside a name answer ("రవి కాదు", "Ravi kaadu", "Ravi nahi", "not Ravi"). */
const NAME_NEGATOR =
  /^(?:కాదు|కాదండి|కాదండీ|కాను|नहीं|नही|ना|kaadu|kadu|kaadandi|kadandi|kaanu|nahi|nahin|nai|not|no|isn't|isnt)$/iu;
/** Politeness/copula that ends a name ("andi", "అండి", "hai", "है"). */
const NAME_TERMINATOR = /^(?:andi|andee|ani|hai|hu|hoon|ji|అండి|అండీ|అని|है|हूँ|हूं|जी)$/iu;
/** Words that are never (part of) a name: refusals, verbs, fillers, question words. */
const NAME_FILLER =
  /^(?:చెప్ప[\p{L}\p{M}]*|చెబు[\p{L}\p{M}]*|కదా|కదండి|ఎందుకు|ఏంటి|ఏమిటి|తెలుసు|తెలీదు|తెలియదు|ముందే|ఇందాక|ఇంతకుముందే|ఇప్పుడే|ఏమో|అవసరం|వద్దు|ఉంది|అదే|నేను|మీకు|cheppa\w*|chepp\w*|cheptha\w*|kada|kadha|enduku|endhuku|enti|emiti|telusu|teliyadu|teledu|mundhe|munde|indaka|emo|avasaram|vaddu|undi|ade|nenu|meeku|बता[\p{L}\p{M}]*|बोला|बोल[\p{L}\p{M}]*|क्यों|क्या|पहले|अभी|ज़रूरत|जरूरत|मत|वही|मैं|आपको|bata\w*|bola|bol\w*|kyu|kyun|kyon|kya|pehle|pahle|abhi|zaroorat|jarurat|mat|wahi|main|aapko|why|what|already|told|tell|said|wait|sorry|hello|ok|okay|yes|it|it's|its|is|haan|ha|avunu|అవును|హా|हाँ|हां)$/iu;

function titleCaseName(words: string[]): string {
  return words
    .map((w) => (/^[a-z]/i.test(w) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

const stripWord = (raw: string) => raw.replace(/^[^\p{L}]+|[^\p{L}\p{M}]+$/gu, "");

/** Up to three name words from the start of `raws`; null when the first word is not a name. */
function nameWords(raws: string[]): { words: string[]; rest: string[] } | null {
  const words: string[] = [];
  let i = 0;
  for (; i < raws.length; i++) {
    const raw = raws[i]!;
    const word = stripWord(raw);
    if (!word || /\d/.test(raw)) break;
    if (NAME_TERMINATOR.test(word) || NAME_NEGATOR.test(word)) break;
    if (NAME_FILLER.test(word)) {
      if (!words.length) return null;
      break;
    }
    words.push(word);
    if (/[,.;!?।]$/u.test(raw) || words.length === 3) {
      i++;
      break;
    }
  }
  return words.length ? { words, rest: raws.slice(i) } : null;
}

export interface NameIntroduction {
  /** The name the caller gave (after any correction), or null when not confident. */
  name: string | null;
  /** A name the caller said is NOT theirs ("నా పేరు రవి కాదు" → "రవి"). */
  rejected: string | null;
}

/**
 * "My name is X" in Telugu, Hindi (script or romanized) and English, with a
 * negated correction: "నా పేరు రవి కాదు, రాజు", "mera naam Ravi nahi, Raju",
 * "my name is not Ravi, it is Raju" → "Raju" (rejected "Ravi"). A refusal or
 * filler ("నా పేరు చెప్పాను కదా", "mera naam nahi bataunga") gives no name.
 * Null when the turn has no introduction at all. The caller's script is kept.
 */
export function parseNameIntroduction(text: string): NameIntroduction | null {
  const intros: RegExp[] = [
    /నా\s*పేరు\s+(.+)/u,
    /\b(?:naa|na|naku)\s+peru\s+(.+)/iu,
    /मेरा\s*नाम\s+(.+)/u,
    /\bmera\s+naam\s+(.+)/iu,
    /\bmy\s+name(?:\s+is|'s|\s+isn'?t)\s+(.+)/iu,
  ];
  for (const re of intros) {
    const m = re.exec(text);
    if (!m?.[1]) continue;
    // "my name isn't X" — the negation is in the intro itself.
    const negatedIntro = /isn'?t\s+$/i.test(text.slice(0, m.index + m[0].length - m[1].length));
    let raws = m[1].split(/\s+/).filter(Boolean);
    let leadingNegation = negatedIntro;
    if (!leadingNegation && raws.length && NAME_NEGATOR.test(stripWord(raws[0]!))) {
      // "my name is not Ravi" (English negator first) vs "mera naam nahi
      // bataunga" (a refusal): a name must follow for the former.
      if (!/^(?:not|isn't|isnt)$/i.test(stripWord(raws[0]!))) return { name: null, rejected: null };
      leadingNegation = true;
      raws = raws.slice(1);
    }
    const first = nameWords(raws);
    if (!first) return { name: null, rejected: null };
    if (leadingNegation) {
      // "not Ravi, it is Raju" / "isn't Ravi, it's Raju" / "not Ravi but Raju".
      const after = first.rest.filter(
        (w) => !/^(?:it|it's|its|is|but|but,|rather)$/i.test(stripWord(w) || w),
      );
      const corrected = nameWords(after);
      return {
        name: corrected ? titleCaseName(corrected.words) : null,
        rejected: titleCaseName(first.words),
      };
    }
    const next = first.rest.length ? stripWord(first.rest[0]!) : "";
    if (NAME_NEGATOR.test(next)) {
      const corrected = nameWords(first.rest.slice(1));
      return {
        name: corrected ? titleCaseName(corrected.words) : null,
        rejected: titleCaseName(first.words),
      };
    }
    return { name: titleCaseName(first.words), rejected: null };
  }
  return null;
}

/** Clauses of one sentence, split at commas/semicolons (not inside "₹1,499") and "but". */
function splitClauses(sentence: string): string[] {
  return sentence.split(/(?<!\d),|,(?!\d)|;|\s[—–-]\s|\s+(?:but|కానీ|लेकिन|lekin|kaani)\s+/u);
}

const MESSAGE_CHANNEL = anyOf(
  /\b(?:sms|texts?|message|whats\s?app|e-?mail|confirmation)\b/,
  /\bto\s+your\s+(?:phone|mobile|number|inbox)\b/,
  "మెసేజ్",
  "మెసేజి",
  "ఎస్ఎంఎస్",
  "ఎస్.ఎం.ఎస్",
  "వాట్సాప్",
  "ఈమెయిల్",
  "ఇమెయిల్",
  "కన్ఫర్మేషన్",
  "నిర్ధారణ",
  "సందేశ",
  "संदेश",
  "मैसेज",
  "एसएमएस",
  "व्हाट्सएप",
  "ईमेल",
  "कन्फर्मेशन",
  "पुष्टि",
  /\b(?:sandesam|sandesh)\b/,
);

/** Delivery TO THE CALLER, done or promised ("sent", "we'll text you", "పంపిస్తాము", "मिल जाएगा"). */
const MESSAGE_DELIVERY = anyOf(
  /\b(?:sent|texted|emailed|messaged|whats\s?app(?:ed)?\s+you|on\s+(?:its|the)\s+way)\b/,
  /\b(?:i|we|i'?ll|we'?ll|i\s+will|we\s+will|i\s+am|we\s+are|i'm|we're|i'?ve|we'?ve|let\s+me|shall)\s+(?:\w+\s+){0,2}?(?:send|sending|text|texting|message|messaging|email|emailing|whats\s?app|forward|share|sharing)\b/,
  /\b(?:send|text|message|email|whats\s?app|forward)\s+(?:it\s+|them\s+|this\s+|that\s+)?(?:to\s+)?you\b/,
  /\byou(?:'ll|\s+will|\s+should|\s+shall|\s+would)?\s+(?:also\s+|soon\s+|shortly\s+)?(?:get|receive|be\s+getting|be\s+receiving)\b/,
  /\byou(?:'ll|\s+will)\s+(?:be\s+)?(?:sent|texted|notified)\b/,
  "పంపి(?:ంచ)?(?:స్తా|స్తాము|స్తాను|స్తాం|ంచాము|ంచాను|ంచాం|నాము|నాను|ాము|ాను|ాం)",
  "పంపాము",
  "పంపాను",
  "పంపాం",
  "పంపుతా",
  "పంపిస్తున్నా",
  "వస్తుంది",
  "వచ్చింది",
  "వస్తాయి",
  "అందుతుంది",
  "అందుతాయి",
  "తెలియజేస్తా",
  "తెలియజేశా",
  "తెలియజేసా",
  /\b(?:pampistam\w*|pampistanu|pampisthanu|pampisthamu|pampinchamu|pampinchanu|pampamu|pampanu|vastundi|vasthundi|vachindi|andutundi|teliyajestam\w*)\b/,
  "भेज\\s*(?:दिया|दी|दिए|देंगे|देंगी|दूँगा|दूंगा|दूँगी|रहे|रही|रहा|चुके|गया|गई|जाएगा|जाएगी|ा|ी|े\\s*(?:हैं|है))",
  "भेजेंगे",
  "भेजूँगा",
  "भेजूंगा",
  "मिल\\s*जाए(?:गा|गी|ंगे)",
  "मिलेगा",
  "मिलेगी",
  "मिलेंगे",
  "आ\\s*जाए(?:गा|गी)",
  "आएगा",
  "आएगी",
  /\b(?:bhej\s+(?:diya|di|denge|dunga|rahe|chuke)|bhejenge|bhejunga|mil\s+jayega|mil\s+jaayega|milega|milegi|aa\s+jayega|aayega|aayegi)\b/,
);

/** The caller is told how to reach the business ("send us…", "మాకు…", "हमें…") — not a delivery claim. */
const DELIVERY_INSTRUCTION = anyOf(
  /\b(?:send|text|message|email|whats\s?app|write|contact|reach|call)\s+(?:us|the\s+(?:clinic|office|business|salon|team))\b/,
  /\b(?:you\s+can|feel\s+free\s+to|please)\s+(?:also\s+)?(?:send|text|message|email|whats\s?app)\b/,
  bounded("మాకు"),
  /\bmaaku\b/,
  bounded("हमें"),
  bounded("हमको"),
  /\b(?:hume|humein|hamein|humko)\b/,
);

/** A negation bound to the delivery ("can't send", "SMS రాదు", "పంపలేను", "नहीं भेज"). */
const DELIVERY_NEGATED = anyOf(
  /\b(?:not|never|can'?t|cannot|won'?t|isn'?t|wasn'?t|haven'?t|hasn'?t|unable|don'?t|didn'?t|no\s+(?:sms|text|message|email|whatsapp))\b/,
  "పంపలే",
  "పంపడం\\s*లేదు",
  "పంపను",
  "పంపము",
  "రాదు",
  "రావు",
  "అందదు",
  "(?:వస్తుంది|వచ్చింది|పంపించ\\S*|పంప\\S*)\\s*లేదు",
  "తెలియజేయలే",
  /\b(?:pampalen\w*|pampadam\s+ledu|radu|raadu|andadu)\b/,
  "नहीं\\s*(?:भेज|मिल|आ)",
  "(?:भेज|मिल|आ)\\S*\\s*नहीं",
  `${bounded("न")}\\s*(?:भेज|मिल)`,
  /\b(?:nahi|nahin)\s+(?:bhej|mil|aa)\w*/,
);

function claimsDelivery(clause: string): boolean {
  return (
    MESSAGE_CHANNEL.test(clause) &&
    MESSAGE_DELIVERY.test(clause) &&
    !DELIVERY_NEGATED.test(clause) &&
    !DELIVERY_INSTRUCTION.test(clause)
  );
}

/**
 * Removes every sentence telling the caller a message (SMS, WhatsApp, text,
 * email, "a confirmation") was or will be sent to them: the voice runtime
 * holds no verified delivery state, so such a sentence is unsupported.
 * Judged clause by clause, so an unrelated "లేదు" elsewhere never hides a
 * claim, while a negated delivery ("I can't send a text") and contact
 * instructions ("send us a WhatsApp at …", an email address) are kept.
 * Kept text is returned byte-for-byte.
 */
export function removeMessageSentClaims(reply: string): { reply: string; removed: number } {
  const sentences = splitSentences(reply);
  let removed = 0;
  const kept = sentences.filter((sentence) => {
    const claim = splitClauses(sentence).some(claimsDelivery);
    if (claim) removed++;
    return !claim;
  });
  return { reply: removed ? kept.join("").trim() : reply, removed };
}

/**
 * An English "yes" that pauses or hedges ("yes, one second", "yes, hold
 * on", "sure, let me think", "yes but actually") — never consent to book.
 * (Telugu and Hindi hesitation is already read by
 * callerBookingIntentAnyLanguage.)
 */
export const BOOKING_HESITATION =
  /\b(?:but|however|wait|hold\s+on|hang\s+on|one\s+(?:sec|second|minute|moment)|just\s+a\s+(?:sec|second|minute|moment)|give\s+me\s+a\s+(?:sec|second|minute|moment)|let\s+me\s+(?:think|check|see)|not\s+sure|maybe|actually)\b/i;
