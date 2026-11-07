/**
 * Deterministic reading of one caller utterance (English, Hindi, Telugu and
 * mixes of them). It never decides anything on its own: every value it
 * returns carries how sure it is, and the conversation state decides what
 * becomes a fact.
 *
 * Reused from the production runtime (src/lib/voice-intent-lexicon.ts, a
 * pure module): name introductions, relative dates, correction markers,
 * spoken digits. Dates and clock times are read by datetime.ts, because the
 * production lexicon (a) only parses non-English times and (b) reads
 * "मध्यरात्रि 12 बजे" (midnight) as 12:00 (noon) — see tests/understanding.spec.ts.
 */
import {
  asciiDigits,
  explicitTimeAnyLanguage,
  isCorrection as lexiconIsCorrection,
  parseNameIntroduction,
  periodAnyLanguage,
  spokenDigitsToNumerals,
} from "../../../../src/lib/voice-intent-lexicon.ts";
import {
  normalizeVoiceLanguageCode,
  textLanguageEvidence,
  type VoiceLanguageCode,
} from "../../../../src/lib/voice-languages.ts";
import { resolveServiceFromText } from "../../../../src/lib/service-matching.ts";
import {
  callerClosingIntentAnyLanguage,
  confirmationAnswerAnyLanguage,
} from "../../../../src/lib/voice-call-outcomes.ts";
import {
  calendarSpans,
  canonicalTimeText,
  FLEXIBLE,
  readDateDetailed,
  readTimeDetailed,
} from "./datetime.ts";

/** The production runtime's 11 voice languages (src/lib/voice-languages.ts). */
export type LanguageCode = VoiceLanguageCode;
export type Certainty = "explicit" | "inferred" | "uncertain";

/** A time the caller asked for. `after`/`before` are constraints, not a slot. */
export type TimeSpec =
  | { kind: "exact"; hhmm: string }
  | { kind: "after"; hhmm: string }
  | { kind: "before"; hhmm: string }
  | { kind: "period"; period: "morning" | "afternoon" | "evening" }
  /**
   * Any of these times is acceptable to the caller ("4 or 5, whichever is
   * free"; "4 or 5 lo edaina"). Not a choice the agent makes: the calendar
   * is checked for each, and the caller picks among the free ones.
   */
  | { kind: "anyOf"; hhmms: string[] };

export interface TimeReading {
  spec: TimeSpec;
  certainty: Certainty;
  /** Other readings the caller could have meant (e.g. 00:00 vs 12:00). */
  alternatives: TimeSpec[];
  evidence: string;
}

export type Intent =
  "book" | "reschedule" | "cancel" | "availability" | "price" | "services" | "question";

/**
 * A day the caller named, resolved to a date in the business's time zone by
 * the state (state.ts resolveDateCandidates), never by the model.
 *  - relative: today / tomorrow / day after tomorrow;
 *  - weekday: with "next"/"this" when the caller said so ("next Monday",
 *    "agle somvar", "vacche somavaram"; "this Monday", "is somvar", "ee somavaram");
 *  - calendar: a day of the month ("15 November", "पंद्रह नवंबर", "నవంబర్ పదిహేనో తేదీన");
 *  - either: the caller named two days in one breath ("today or tomorrow",
 *    "Monday or Tuesday") and neither was taken back: a choice for the
 *    caller, never for us.
 */
export type SimpleDateExpr =
  | { kind: "relative"; days: 0 | 1 | 2 }
  | { kind: "weekday"; weekday: number; qualifier?: "next" | "this" | null }
  /**
   * A day of the month: "15 November" (month 11), "the 15th" / "15 तारीख"
   * (month null: the next 15th), with the year only when the caller said it.
   */
  | { kind: "calendar"; day: number; month: number | null; year: number | null };
export type DateExpr = SimpleDateExpr | { kind: "either"; options: SimpleDateExpr[] };

export interface ServiceRow {
  id: string;
  name: string;
  /** Spoken forms in other scripts / colloquial names. */
  aliases?: string[];
  priceInr?: number | null;
  durationMinutes: number;
}

export interface Reading {
  text: string;
  /** The transcript as STT produced it (language evidence works on the original script). */
  rawText: string;
  /** STT's own language label for this utterance, when it gave one. */
  sttLanguage: string | null;
  language: LanguageCode | null;
  /** A transcript that carries no content (noise, filler, an empty final). */
  noise: boolean;
  affirm: boolean;
  deny: boolean;
  correction: boolean;
  intent: Intent | null;
  time: TimeReading | null;
  date: {
    value: DateExpr;
    certainty: Certainty;
    evidence: string;
    /**
     * Other day words said with it ("Friday" in "Friday 15 November",
     * "tomorrow" in "tomorrow, the 4th"): the state checks they name the
     * same day and asks when they do not.
     */
    crossCheck?: SimpleDateExpr[];
  } | null;
  /** The caller tried to give a time that cannot be trusted ("16:30 AM", "4:75"); why. */
  timeUnclear: string | null;
  /** The caller tried to give a date that cannot be used ("31 February", "last Monday"); why. */
  dateUnclear: string | null;
  services: ServiceRow[];
  /**
   * How the service was found (logged as this enum only, never the words):
   * exact = a configured name or alias said verbatim; fuzzy = the
   * production matcher (src/lib/service-matching.ts) found one service;
   * ambiguous = several fit equally (the caller is asked which); none.
   */
  serviceMatch: ServiceMatchKind;
  name: string | null;
  phoneDigits: string | null;
  /** "which one is free?", "ఏది free gaa undi?", "कौन सा खाली है?": a question for the calendar. */
  asksAvailability: boolean;
  /** The caller leaves a pending choice to the calendar: "either", "you tell me", "మీ ఇష్టం". */
  defers: boolean;
  /**
   * The caller is wrapping up: "okay, thanks", "that's all", "I'll think
   * about it", "बस इतना ही", "ధన్యవాదాలు", "అంతే". Only a signal: the state
   * decides whether the call can close (nothing pending) or must ask first.
   */
  closing: boolean;
}

/* ------------------------------------------------------------------ */
/* Small vocabularies                                                  */
/* ------------------------------------------------------------------ */

/** Hour words (1..12) in English, Hindi and Telugu, script and romanized. Shared with the reply guard. */
export const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  // Hindi (Devanagari and romanized)
  एक: 1,
  दो: 2,
  तीन: 3,
  चार: 4,
  पांच: 5,
  पाँच: 5,
  छह: 6,
  छः: 6,
  सात: 7,
  आठ: 8,
  नौ: 9,
  दस: 10,
  ग्यारह: 11,
  बारह: 12,
  ek: 1,
  do: 2,
  teen: 3,
  char: 4,
  chaar: 4,
  paanch: 5,
  panch: 5,
  chhe: 6,
  saat: 7,
  aath: 8,
  nau: 9,
  das: 10,
  gyarah: 11,
  barah: 12,
  // Telugu (script and romanized)
  ఒకటి: 1,
  ఒంటి: 1,
  రెండు: 2,
  మూడు: 3,
  నాలుగు: 4,
  ఐదు: 5,
  ఆరు: 6,
  ఏడు: 7,
  ఎనిమిది: 8,
  తొమ్మిది: 9,
  పది: 10,
  పదకొండు: 11,
  పన్నెండు: 12,
  okati: 1,
  rendu: 2,
  moodu: 3,
  mudu: 3,
  naalugu: 4,
  nalugu: 4,
  aidu: 5,
  aaru: 6,
  edu: 7,
  enimidi: 8,
  tommidi: 9,
  padi: 10,
  padakondu: 11,
  pannendu: 12,
};

const AFFIRM =
  /^(?:yes|yeah|yep|yup|ok|okay|sure|correct|right|fine|done|confirm(?:ed)?|go ahead|haan?|ha|han|ji|haan\s*ji|theek\s*hai|thik\s*hai|हाँ|हां|हा|जी|हाँ\s*जी|ठीक\s*है|ठीक|బాగుంది|సరే|అవును|ఆ|హా|ఓకే|అలాగే|sare|avunu|alage)(?:\s+(?:yes|ji|जी|please|sir|madam|అండి|andi|haan|हाँ|sure))*[\s.!,।]*$/i;
/** "yes, this number" / "हाँ जी, इसी नंबर पर": a yes that opens a longer answer. */
const AFFIRM_LEAD =
  /^(?:yes|yeah|ok|okay|sure|correct|haan?|haan\s*ji|हाँ|हां|हाँ\s*जी|जी\s*हाँ|जी|ठीक\s*है|అవును|సరే|హా|ఓకే)(?=[\s,.!।]|$)/i;
const DENY =
  /^(?:no|nope|nah|not\s+(?:that|this|right|correct)|wrong|nahin?|nahi|नहीं|नही|ना|गलत|కాదు|వద్దు|లేదు|kaadu|kadu|vaddu|ledu)\b|^(?:नहीं|नही|కాదు|వద్దు|లేదు)/i;
const DENY_ANYWHERE = /\bnot\b.*\b(?:am|pm|o'?clock)\b|\bno,|नहीं,|కాదు,/i;
const CORRECTION =
  /\bactually\b|\binstead\b|\bchange\b|\bmake it\b|\bswitch\b|\bnot\s+\d|\brather\b|बल्कि|बदल|ఇంకా\s*కాదు|మార్చు|బదులు/i;

const INTENTS: Array<[Intent, RegExp]> = [
  ["cancel", /\bcancel\b|रद्द|कैंसल|క్యాన్సిల్|రద్దు/i],
  [
    "reschedule",
    /\breschedule\b|\bmove (?:my|the) appointment\b|\bchange (?:my|the) (?:appointment|booking|time)\b|रीशेड्यूल|समय बदल|టైం మార్చ|రీషెడ్యూల్/i,
  ],
  [
    "price",
    /\bprice\b|\bcost\b|\bhow much\b|\bcharges?\b|\bfees?\b|कितना|कितने|कीमत|दाम|फीस|ధర|ఎంత|ఫీజు|kitna|kitne|keemat|entha/i,
  ],
  [
    "services",
    /\bwhat services\b|\bwhich services\b|\bdo you (?:do|offer|have)\b|कौन सी सेवा|क्या सेवाएं|ఏ సర్వీసులు|ఏమి సేవలు/i,
  ],
  ["availability", /\bavailable\b|\bfree slots?\b|\bslots?\b|खाली|स्लॉट|ఖాళీ|స్లాట్/i],
  ["book", /\bbook\b|\bappointment\b|\bschedule\b|बुक|अपॉइंटमेंट|అపాయింట్మెంట్|బుక్/i],
];

/** The caller leaves the choice to us / the calendar ("either", "you tell me", "मीరే చెప్పండి"). */
const DEFERS = new RegExp(
  [
    FLEXIBLE.source,
    String.raw`\byou\s+(?:tell|choose|decide|pick)\b|\bany(?:thing)?\s+(?:works|is\s+fine)\b|\bdoesn'?t\s+matter\b|\bno\s+preference\b`,
    String.raw`आप\s*(?:ही\s*)?(?:बता|बताइए|बताओ)|फ़?फर्क\s*नहीं|\baap\s+(?:hi\s+)?bata|\bfarak\s+nahi`,
    String.raw`మీరే\s*చెప్పండి|మీరు\s*చెప్పండి|మీ\s*ఇష్టం|\bmeere\s+cheppandi\b|\bmee\s+ishtam\b`,
  ].join("|"),
  "i",
);

/** The caller asks what is free: only the calendar can answer. */
const ASKS_AVAILABILITY =
  /\b(?:free|available|availability|open|vacant)\b|ఖాళీ|అందుబాటు|खाली|उपलब्ध|\bkh?aa?li\b|\bkaali\b/i;

/**
 * Wrapping-up expressions (en/hi/te, script and romanized). A signal only:
 * the state ignores it when the same utterance carries a new request.
 */
const CLOSING = new RegExp(
  [
    // English
    String.raw`\bthank(?:s|\s*you|\s*u)\b|\bthx\b|\bthat'?s\s+(?:all|it)\b|\bthat\s+is\s+all\b`,
    String.raw`\bnothing\s+(?:else|more)\b|\b(?:good\s*)?bye\b|\bi'?(?:ll|\s+will)\s+think\b|\blet\s+me\s+think\b`,
    String.raw`\bi'?(?:ll|\s+will)\s+(?:call|get)\s+(?:you\s+)?back\b|\bcall\s+(?:you\s+)?later\b|\ball\s+good\b`,
    // Hindi
    String.raw`धन्यवाद|शुक्रिया|थैंक्स|थैंक\s*यू|बस\s*इतना|और\s*कुछ\s*नहीं|बाद\s*में\s*(?:बता|कॉल|फोन|फ़ोन)|सोच\s*(?:कर|के)\s*बता|अलविदा`,
    String.raw`\bdhanya?vaa?d\b|\bshukriya\b|\bbas\s+itna\b|\baur\s+kuch\s+nahi?n?\b|\bbaad\s+(?:mein|me)\s+(?:bata|call|phone)|\bsoch\s+(?:kar|ke)\s+bata`,
    // Telugu
    String.raw`ధన్యవాదాలు|ధన్యవాదం|ధన్యవాదము|థాంక్స్|థ్యాంక్స్|థాంక్యూ|అంతే|ఇంకేమీ\s*(?:లేదు|వద్దు)|ఇంకా\s*ఏమీ\s*(?:లేదు|వద్దు)`,
    String.raw`తర్వాత\s*(?:చెప్తా|చెబుతా|ఫోన్\s*చేస్తా|కాల్\s*చేస్తా)|ఆలోచించి\s*(?:చెప్తా|చెబుతా)`,
    String.raw`\bdhanyavaa?daa?lu\b|\banthe\b|\binkemi\s+(?:ledu|vaddu)\b|\btarvata\s+(?:chep|call|phone)|\balochinchi\s+chep`,
  ].join("|"),
  "i",
);

const NOISE =
  /^(?:\[[^\]]*\]|\(?(?:noise|inaudible|music|static|background)\)?|h+m+|u+h+m*|a+h+|e+r+m*|\.+|…+|अं+|हम्म+|ఆఁ+)[\s.!?,]*$/i;

/* ------------------------------------------------------------------ */
/* Time and date (datetime.ts)                                         */
/* ------------------------------------------------------------------ */

/** The time the caller asked for, or null (also null when it was unclear: see readTimeDetailed). */
export function readTime(text: string): TimeReading | null {
  return readTimeDetailed(text).reading;
}

/** The day the caller named, or null (also null when it was unclear: see readDateDetailed). */
export function readDate(text: string): Reading["date"] {
  return readDateDetailed(text).date;
}

/* ------------------------------------------------------------------ */
/* The whole utterance                                                 */
/* ------------------------------------------------------------------ */

/** Stands in for the ":" of a clock while digit runs are joined (never in a transcript). */
const CLOCK_COLON = "\uE000";

/**
 * Native digits as ASCII and numbers read out digit by digit joined, but a
 * clock keeps its shape: the lexicon's digit-run joiner splits on ":" and
 * ".", which turned "11:00 AM" into "11 00 AM" and "4:30" into "4 30".
 */
function normalize(text: string): string {
  const shielded = asciiDigits(text).replace(
    /(?<![\d:.])(\d{1,2})[:.](\d{2})(?![\d:.]\d)/g,
    `$1${CLOCK_COLON}$2`,
  );
  return spokenDigitsToNumerals(shielded).replaceAll(CLOCK_COLON, ":").replace(/\s+/g, " ").trim();
}

export type ServiceMatchKind = "exact" | "fuzzy" | "ambiguous" | "none";

/**
 * The services the caller named. A configured name or alias said verbatim
 * wins (with negation handling); otherwise the production runtime's matcher
 * (src/lib/service-matching.ts: stems, synonyms, Indian-script loanwords)
 * resolves natural phrasing ("clean my teeth", "టీత్ క్లీనింగ్", "root
 * canal") onto the business's own rows. It never invents a service; a tie
 * returns every tied row so the caller is asked which one.
 *
 * `fuzzy: false` limits matching to verbatim names (used once a service is
 * settled, so a passing mention of another treatment never replaces it).
 */
export function resolveServices(
  text: string,
  catalog: ServiceRow[],
  opts: { fuzzy?: boolean } = {},
): { rows: ServiceRow[]; kind: ServiceMatchKind } {
  const exact = matchServices(text, catalog);
  if (exact.length) return { rows: exact, kind: "exact" };
  if (opts.fuzzy === false || !catalog.length) return { rows: [], kind: "none" };
  const byId = new Map(catalog.map((s) => [s.id, s]));
  const result = resolveServiceFromText(
    catalog.map((s) => ({ id: s.id, name: s.name, duration_minutes: s.durationMinutes })),
    text,
  );
  if (result.kind === "match") {
    const row = byId.get(result.row.id);
    return row ? { rows: [row], kind: "fuzzy" } : { rows: [], kind: "none" };
  }
  if (result.kind === "ambiguous") {
    const rows = result.candidates.map((c) => byId.get(c.id)).filter((r): r is ServiceRow => !!r);
    return rows.length > 1 ? { rows, kind: "ambiguous" } : { rows: [], kind: "none" };
  }
  return { rows: [], kind: "none" };
}

export function matchServices(text: string, catalog: ServiceRow[]): ServiceRow[] {
  const lower = text.toLowerCase();
  const hits = catalog
    .map((s) => {
      const idx = Math.min(
        ...[s.name, ...(s.aliases ?? [])]
          .map((n) => (n ? lower.indexOf(n.toLowerCase()) : -1))
          .filter((i) => i >= 0),
      );
      return { s, idx };
    })
    .filter((h) => Number.isFinite(h.idx));
  if (hits.length < 2) return hits.map((h) => h.s);
  // "not cleaning, root canal" / "क्लीनिंग नहीं, रूट कैनाल": drop the negated one
  // (English negation precedes the word, Hindi/Telugu negation follows it).
  const negated = new Set<ServiceRow>();
  for (const m of lower.matchAll(/\bnot\b/g)) {
    const next = hits.filter((h) => h.idx > m.index!).sort((a, b) => a.idx - b.idx)[0];
    if (next) negated.add(next.s);
  }
  for (const m of lower.matchAll(/नहीं|नही|కాదు|వద్దు/g)) {
    const prev = hits.filter((h) => h.idx < m.index!).sort((a, b) => b.idx - a.idx)[0];
    if (prev) negated.add(prev.s);
  }
  const kept = hits.filter((h) => !negated.has(h.s));
  return (kept.length ? kept : hits).sort((a, b) => a.idx - b.idx).map((h) => h.s);
}

/**
 * The language a piece of text is in: its script or romanized markers
 * (the production rule, src/lib/voice-languages.ts textLanguageEvidence),
 * then STT's own label, then English for Latin text. Null when nothing
 * shows a language. Used for the caller's words and for the model's reply.
 */
export function detectLanguage(text: string, sttLanguage: string | null): LanguageCode | null {
  const evidence = textLanguageEvidence(text, sttLanguage ?? undefined);
  if (evidence) return evidence.code;
  const labelled = normalizeVoiceLanguageCode(sttLanguage);
  if (labelled) return labelled;
  if (/[a-z]/i.test(text)) return "en-IN";
  return null;
}

export function readUtterance(
  rawText: string,
  opts: {
    catalog: ServiceRow[];
    sttLanguage?: string | null;
    /** Natural-language service matching (default on); see resolveServices. */
    fuzzyServices?: boolean;
  },
): Reading {
  const text = normalize(rawText);
  const noise = text.length === 0 || NOISE.test(text);
  const language = noise ? null : detectLanguage(rawText, opts.sttLanguage ?? null);
  if (noise) {
    return {
      text,
      rawText,
      sttLanguage: opts.sttLanguage ?? null,
      language,
      noise,
      affirm: false,
      deny: false,
      correction: false,
      intent: null,
      time: null,
      date: null,
      timeUnclear: null,
      dateUnclear: null,
      services: [],
      serviceMatch: "none",
      name: null,
      phoneDigits: null,
      asksAvailability: false,
      defers: false,
      closing: false,
    };
  }
  // A short yes/no in any of the 11 languages (production lexicon), on top
  // of the English/Hindi/Telugu patterns below.
  const anyLanguageAnswer = confirmationAnswerAnyLanguage(rawText);
  const affirm =
    anyLanguageAnswer === "yes" ||
    AFFIRM.test(text) ||
    (AFFIRM_LEAD.test(text) &&
      !CORRECTION.test(text) &&
      !/\b(?:not|but)\b|नहीं|కాదు|లేదు|मगर|लेकिन/i.test(text));
  const notADenial =
    /^(?:no (?:problem|worries|issue)|koi baat nahi|कोई बात नहीं|పర్వాలేదు|parvaledu)\b/i.test(
      text,
    );
  const deny =
    !affirm &&
    !notADenial &&
    (anyLanguageAnswer === "no" || DENY.test(text) || DENY_ANYWHERE.test(text));
  const correction =
    CORRECTION.test(text) || lexiconIsCorrection(text) || (deny && text.split(/\s+/).length > 1);
  const intent = INTENTS.find(([, re]) => re.test(text))?.[0] ?? null;
  // A spoken phone number is digits, not a clock time. A day of the month
  // ("15 November") is a date, never a clock.
  const dateRead = readDateDetailed(text);
  const timeRead = /\d{7,}/.test(text.replace(/[\s-]/g, ""))
    ? { reading: null, unclear: null }
    : readTimeDetailed(text, calendarSpans(canonicalTimeText(text)));
  // Other languages: the production lexicon's clock and period readers
  // ("4 மணிக்கு", "সন্ধ্যায়"), used only when the reader above found nothing.
  const anyLanguageTime =
    timeRead.reading || timeRead.unclear || /\d{7,}/.test(text.replace(/[\s-]/g, ""))
      ? null
      : explicitTimeAnyLanguage(rawText);
  const anyLanguagePeriod =
    timeRead.reading || timeRead.unclear || anyLanguageTime ? null : periodAnyLanguage(rawText);
  const time: TimeReading | null =
    timeRead.reading ??
    (anyLanguageTime
      ? {
          spec: { kind: "exact", hhmm: anyLanguageTime },
          certainty: "explicit",
          alternatives: [],
          evidence: rawText,
        }
      : anyLanguagePeriod
        ? {
            spec: { kind: "period", period: anyLanguagePeriod },
            certainty: "explicit",
            alternatives: [],
            evidence: rawText,
          }
        : null);
  const date = dateRead.date;
  const intro = parseNameIntroduction(text);
  // Fuzzy matching runs on the raw transcript (Indian-script loanwords) and
  // is allowed while the service is open or when the caller corrects it.
  const serviceRead = resolveServices(rawText, opts.catalog, {
    fuzzy: opts.fuzzyServices !== false || correction,
  });
  const digits = text.replace(/[^\d]/g, "");
  const phoneDigits = digits.length >= 10 ? digits.slice(-10) : null;
  return {
    text,
    rawText,
    sttLanguage: opts.sttLanguage ?? null,
    language,
    noise,
    affirm,
    deny,
    correction,
    intent,
    time,
    date,
    timeUnclear: time ? null : timeRead.unclear,
    dateUnclear: date ? null : dateRead.unclear,
    services: serviceRead.rows,
    serviceMatch: serviceRead.kind,
    name: intro && !intro.rejected ? intro.name : null,
    phoneDigits,
    asksAvailability: ASKS_AVAILABILITY.test(text),
    defers: DEFERS.test(text),
    closing:
      CLOSING.test(text) ||
      callerClosingIntentAnyLanguage(rawText, { awaitingAnythingElse: false }) !== null,
  };
}
