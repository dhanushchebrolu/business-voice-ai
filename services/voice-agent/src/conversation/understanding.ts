/**
 * Deterministic reading of one caller utterance (English, Hindi, Telugu and
 * mixes of them). It never decides anything on its own: every value it
 * returns carries how sure it is, and the conversation state decides what
 * becomes a fact.
 *
 * Reused from the production runtime (src/lib/voice-intent-lexicon.ts, a
 * pure module): name introductions, relative dates, correction markers,
 * spoken digits. Time-of-day parsing is new here because the production
 * lexicon (a) only parses non-English times and (b) reads "मध्यरात्रि 12
 * बजे" (midnight) as 12:00 (noon) — see test/understanding.test.ts.
 */
import {
  asciiDigits,
  isCorrection as lexiconIsCorrection,
  parseNameIntroduction,
  relativeDateAnyLanguage,
  spokenDigitsToNumerals,
} from "../../../../src/lib/voice-intent-lexicon.ts";

export type LanguageCode = "en-IN" | "hi-IN" | "te-IN";
export type Certainty = "explicit" | "inferred" | "uncertain";

/** A time the caller asked for. `after`/`before` are constraints, not a slot. */
export type TimeSpec =
  | { kind: "exact"; hhmm: string }
  | { kind: "after"; hhmm: string }
  | { kind: "before"; hhmm: string }
  | { kind: "period"; period: "morning" | "afternoon" | "evening" };

export interface TimeReading {
  spec: TimeSpec;
  certainty: Certainty;
  /** Other readings the caller could have meant (e.g. 00:00 vs 12:00). */
  alternatives: TimeSpec[];
  evidence: string;
}

export type Intent =
  "book" | "reschedule" | "cancel" | "availability" | "price" | "services" | "question";

/** A day the caller named, resolved to a date in the business's time zone by the state. */
export type DateExpr = { kind: "relative"; days: 0 | 1 | 2 } | { kind: "weekday"; weekday: number };

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
  language: LanguageCode | null;
  /** A transcript that carries no content (noise, filler, an empty final). */
  noise: boolean;
  affirm: boolean;
  deny: boolean;
  correction: boolean;
  intent: Intent | null;
  time: TimeReading | null;
  date: { value: DateExpr; certainty: Certainty; evidence: string } | null;
  services: ServiceRow[];
  name: string | null;
  phoneDigits: string | null;
}

/* ------------------------------------------------------------------ */
/* Small vocabularies                                                  */
/* ------------------------------------------------------------------ */

const NUMBER_WORDS: Record<string, number> = {
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

const AM_WORDS = /\b(?:am|a\.m\.?)(?=$|[\s,.!?])/i;
const PM_WORDS = /\b(?:pm|p\.m\.?)(?=$|[\s,.!?])/i;
const MIDNIGHT = /\bmidnight\b|मध्यरात्रि|आधी\s*रात|अर्धरात्रि|అర్ధరాత్రి|ardharatri|aadhi\s*raat/i;
const NOON = /\bnoon\b|\bmidday\b/i;
const MORNING = /\bmorning\b|सुबह|सवेरे|ఉదయం|పొద్దున|subah|udayam|poddhuna|poddun/i;
const AFTERNOON = /\bafternoon\b|दोपहर|మధ్యాహ్నం|dopahar|madhyahnam/i;
const EVENING = /\bevening\b|शाम|సాయంత్రం|shaam|sham\b|sayantram/i;
const NIGHT = /\bnight\b|रात|రాత్రి|raat\b|ratri/i;
const AFTER =
  /\bafter\b|\bpost\b|\bfrom\b|\bonwards\b|के\s*बाद|बाद\s*में|తర్వాత|తరువాత|నుండి|ke\s*baad|tarvata|taruvata/i;
const BEFORE = /\bbefore\b|\bby\b|से\s*पहले|ముందు|se\s*pehle|mundu/i;

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

const NOISE =
  /^(?:\[[^\]]*\]|\(?(?:noise|inaudible|music|static|background)\)?|h+m+|u+h+m*|a+h+|e+r+m*|\.+|…+|अं+|हम्म+|ఆఁ+)[\s.!?,]*$/i;

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function hhmm(h: number, m = 0): string {
  return `${pad(h)}:${pad(m)}`;
}

/** Hour (1..12) and minutes read from text: digits, or a number word. */
function readClock(
  text: string,
): Array<{ hour: number; minute: number; index: number; raw: string }> {
  const out: Array<{ hour: number; minute: number; index: number; raw: string }> = [];
  const digitRe = /(?<!\d)(\d{1,2})(?:[:.](\d{2}))?(?!\d)/g;
  for (let m: RegExpExecArray | null; (m = digitRe.exec(text));) {
    const hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    if (hour >= 0 && hour <= 23 && minute < 60)
      out.push({ hour, minute, index: m.index, raw: m[0] });
  }
  // A number word is a time only with a time marker ("four o'clock", "चार बजे",
  // "at four", "शाम चार"): "yes that one" and "ek minute" are not 1 o'clock.
  const timeContext =
    /o'?clock|\b(?:at|by|around|after|before)\s|\b(?:am|pm)\b|बजे|baje|గంటల|gantala|morning|afternoon|evening|night|सुबह|दोपहर|शाम|रात|ఉదయం|మధ్యాహ్నం|సాయంత్రం|రాత్రి|shaam|subah|dopahar/i.test(
      text,
    );
  if (!timeContext) return out.sort((a, b) => a.index - b.index);
  const wordRe = new RegExp(
    `(?:^|[\\s,])(${Object.keys(NUMBER_WORDS)
      .sort((a, b) => b.length - a.length)
      .join("|")})(?=$|[\\s,.?!।]|\\s*(?:बजे|baje|గంటల|gantala|o'?clock|pm|am))`,
    "giu",
  );
  for (let m: RegExpExecArray | null; (m = wordRe.exec(text));) {
    const word = m[1]!.toLowerCase();
    const hour = NUMBER_WORDS[word] ?? NUMBER_WORDS[m[1]!];
    if (hour) out.push({ hour, minute: 0, index: m.index + m[0].indexOf(m[1]!), raw: m[1]! });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** A bare hour with no AM/PM or period word: business-hours reading. */
function businessHoursReading(hour: number): { primary: number; alt: number | null } {
  if (hour >= 13) return { primary: hour, alt: null };
  if (hour === 12) return { primary: 12, alt: 0 }; // noon is the business reading, midnight the other
  if (hour >= 1 && hour <= 6) return { primary: hour + 12, alt: hour }; // "4" on a clinic call = 4 PM
  if (hour >= 7 && hour <= 11) return { primary: hour, alt: hour + 12 };
  return { primary: hour, alt: null };
}

export function readTime(text: string): TimeReading | null {
  const lower = text.toLowerCase();
  const clocks = readClock(text);
  const constraint: "after" | "before" | null = AFTER.test(text)
    ? "after"
    : BEFORE.test(text)
      ? "before"
      : null;

  if (clocks.length === 0) {
    if (MIDNIGHT.test(text))
      return {
        spec: { kind: "exact", hhmm: "00:00" },
        certainty: "explicit",
        alternatives: [],
        evidence: "midnight",
      };
    if (NOON.test(lower))
      return {
        spec: { kind: "exact", hhmm: "12:00" },
        certainty: "explicit",
        alternatives: [],
        evidence: "noon",
      };
    const period = MORNING.test(text)
      ? "morning"
      : AFTERNOON.test(text)
        ? "afternoon"
        : EVENING.test(text)
          ? "evening"
          : null;
    return period
      ? {
          spec: { kind: "period", period },
          certainty: "explicit",
          alternatives: [],
          evidence: period,
        }
      : null;
  }

  // "2 or 3 PM", "2 PM or 3 PM": two candidate times — never pick one.
  const orJoined =
    clocks.length >= 2 &&
    /\bor\b|या|లేదా|leda|ya\b/i.test(text.slice(clocks[0]!.index, clocks[1]!.index + 1));
  const isPm = PM_WORDS.test(text);
  const isAm = AM_WORDS.test(text);
  const periodHint = MIDNIGHT.test(text)
    ? "midnight"
    : NIGHT.test(text)
      ? "night"
      : EVENING.test(text)
        ? "evening"
        : AFTERNOON.test(text)
          ? "afternoon"
          : MORNING.test(text)
            ? "morning"
            : null;

  const resolve = (
    hour: number,
    minute: number,
  ): { hhmm: string; certainty: Certainty; alt: string | null } => {
    if (hour > 12) return { hhmm: hhmm(hour, minute), certainty: "explicit", alt: null };
    if (isPm)
      return { hhmm: hhmm(hour === 12 ? 12 : hour + 12, minute), certainty: "explicit", alt: null };
    if (isAm)
      return { hhmm: hhmm(hour === 12 ? 0 : hour, minute), certainty: "explicit", alt: null };
    if (periodHint === "midnight")
      return { hhmm: hhmm(hour === 12 ? 0 : hour, minute), certainty: "explicit", alt: null };
    if (periodHint === "morning")
      return { hhmm: hhmm(hour === 12 ? 12 : hour, minute), certainty: "explicit", alt: null };
    if (periodHint === "afternoon")
      return {
        hhmm: hhmm(hour === 12 ? 12 : hour < 6 ? hour + 12 : hour, minute),
        certainty: "explicit",
        alt: null,
      };
    if (periodHint === "evening")
      return { hhmm: hhmm(hour === 12 ? 12 : hour + 12, minute), certainty: "explicit", alt: null };
    if (periodHint === "night") {
      if (hour === 12) return { hhmm: "00:00", certainty: "explicit", alt: null };
      return { hhmm: hhmm(hour + 12, minute), certainty: "explicit", alt: null };
    }
    const r = businessHoursReading(hour);
    // 12 with nothing else is genuinely ambiguous: ask, don't infer.
    if (hour === 12)
      return { hhmm: hhmm(12, minute), certainty: "uncertain", alt: hhmm(0, minute) };
    return {
      hhmm: hhmm(r.primary, minute),
      certainty: "inferred",
      alt: r.alt === null ? null : hhmm(r.alt, minute),
    };
  };

  if (orJoined) {
    const a = resolve(clocks[0]!.hour, clocks[0]!.minute);
    const b = resolve(clocks[1]!.hour, clocks[1]!.minute);
    // "2 or 3 PM": the PM written once applies to both.
    return {
      spec: { kind: "exact", hhmm: a.hhmm },
      certainty: "uncertain",
      alternatives: [{ kind: "exact", hhmm: b.hhmm }],
      evidence: `${clocks[0]!.raw} or ${clocks[1]!.raw}`,
    };
  }

  // A negated time is the one the caller is taking back. English negation
  // precedes it ("3 PM, not 2"; "not 2 but 3"); Hindi and Telugu negation
  // follows it ("3 बजे नहीं, 4 बजे"; "3 కాదు 4"). A negation word that opens
  // the utterance ("नहीं, 4 बजे") negates the agent's proposal, not a time here.
  const negated = new Set<number>();
  for (const m of text.matchAll(/\bnot\b/gi)) {
    const next = clocks.find((c) => c.index > m.index!);
    if (next) negated.add(next.index);
  }
  for (const m of text.matchAll(/नहीं|नही|కాదు|వద్దు/g)) {
    if (m.index! === 0) continue;
    const prev = [...clocks].reverse().find((c) => c.index < m.index!);
    if (prev) negated.add(prev.index);
  }
  const kept = clocks.filter((c) => !negated.has(c.index));
  const chosen = (kept.length ? kept[kept.length - 1] : clocks[clocks.length - 1])!;
  const r = resolve(chosen.hour, chosen.minute);
  const spec: TimeSpec = constraint
    ? { kind: constraint, hhmm: r.hhmm }
    : { kind: "exact", hhmm: r.hhmm };
  const alternatives: TimeSpec[] = r.alt
    ? [constraint ? { kind: constraint, hhmm: r.alt } : { kind: "exact", hhmm: r.alt }]
    : [];
  return { spec, certainty: r.certainty, alternatives, evidence: chosen.raw };
}

/* ------------------------------------------------------------------ */
/* The whole utterance                                                 */
/* ------------------------------------------------------------------ */

function normalize(text: string): string {
  return spokenDigitsToNumerals(asciiDigits(text)).replace(/\s+/g, " ").trim();
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

export function detectLanguage(text: string, sttLanguage: string | null): LanguageCode | null {
  if (/[ఀ-౿]/.test(text)) return "te-IN";
  if (/[ऀ-ॿ]/.test(text)) return "hi-IN";
  const s = (sttLanguage ?? "").toLowerCase();
  if (s.startsWith("te")) return "te-IN";
  if (s.startsWith("hi")) return "hi-IN";
  if (/[a-z]/i.test(text)) return "en-IN";
  return null;
}

const WEEKDAYS: Array<[number, RegExp]> = [
  [0, /\bsunday\b|रविवार|इतवार|ఆదివారం|ravivar|itwar|aadivaram/i],
  [1, /\bmonday\b|सोमवार|సోమవారం|somvar|somavaram/i],
  [2, /\btuesday\b|मंगलवार|మంగళవారం|mangalvar|mangalavaram/i],
  [3, /\bwednesday\b|बुधवार|బుధవారం|budhvar|budhavaram/i],
  [4, /\bthursday\b|गुरुवार|बृहस्पतिवार|గురువారం|guruvar|guruvaram/i],
  [5, /\bfriday\b|शुक्रवार|శుక్రవారం|shukravar|sukravaram/i],
  [6, /\bsaturday\b|शनिवार|శనివారం|shanivar|sanivaram/i],
];

/** The day the caller named. Hindi "kal"/"परसों" each name two days (past and future): inferred. */
export function readDate(text: string): Reading["date"] {
  if (/\bday after tomorrow\b|ఎల్లుండి|ellundi/i.test(text)) {
    return {
      value: { kind: "relative", days: 2 },
      certainty: "explicit",
      evidence: "day after tomorrow",
    };
  }
  if (/परसों|parson/i.test(text)) {
    return { value: { kind: "relative", days: 2 }, certainty: "inferred", evidence: "parson" };
  }
  const english = /\btomorrow\b/i.test(text)
    ? "tomorrow"
    : /\btoday\b|\btonight\b/i.test(text)
      ? "today"
      : null;
  const rel = relativeDateAnyLanguage(text) ?? english;
  if (rel) {
    const kal = /(?:^|\s)(?:kal|कल)(?=$|\s|[,.?!।])/i.test(text);
    return {
      value: { kind: "relative", days: rel === "tomorrow" ? 1 : 0 },
      certainty: kal && rel === "tomorrow" ? "inferred" : "explicit",
      evidence: rel,
    };
  }
  const wd = WEEKDAYS.find(([, re]) => re.test(text));
  if (wd)
    return {
      value: { kind: "weekday", weekday: wd[0] },
      certainty: "explicit",
      evidence: `weekday ${wd[0]}`,
    };
  return null;
}

export function readUtterance(
  rawText: string,
  opts: { catalog: ServiceRow[]; sttLanguage?: string | null },
): Reading {
  const text = normalize(rawText);
  const noise = text.length === 0 || NOISE.test(text);
  const language = noise ? null : detectLanguage(rawText, opts.sttLanguage ?? null);
  if (noise) {
    return {
      text,
      language,
      noise,
      affirm: false,
      deny: false,
      correction: false,
      intent: null,
      time: null,
      date: null,
      services: [],
      name: null,
      phoneDigits: null,
    };
  }
  const affirm =
    AFFIRM.test(text) ||
    (AFFIRM_LEAD.test(text) &&
      !CORRECTION.test(text) &&
      !/\b(?:not|but)\b|नहीं|కాదు|లేదు|मगर|लेकिन/i.test(text));
  const notADenial =
    /^(?:no (?:problem|worries|issue)|koi baat nahi|कोई बात नहीं|పర్వాలేదు|parvaledu)\b/i.test(
      text,
    );
  const deny = !affirm && !notADenial && (DENY.test(text) || DENY_ANYWHERE.test(text));
  const correction =
    CORRECTION.test(text) || lexiconIsCorrection(text) || (deny && text.split(/\s+/).length > 1);
  const intent = INTENTS.find(([, re]) => re.test(text))?.[0] ?? null;
  // A spoken phone number is digits, not a clock time.
  const time = /\d{7,}/.test(text.replace(/[\s-]/g, "")) ? null : readTime(text);
  const date = readDate(text);
  const intro = parseNameIntroduction(text);
  const digits = text.replace(/[^\d]/g, "");
  const phoneDigits = digits.length >= 10 ? digits.slice(-10) : null;
  return {
    text,
    language,
    noise,
    affirm,
    deny,
    correction,
    intent,
    time,
    date,
    services: matchServices(text, opts.catalog),
    name: intro && !intro.rejected ? intro.name : null,
    phoneDigits,
  };
}
