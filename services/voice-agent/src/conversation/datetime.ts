/**
 * Dates and clock times in one caller utterance (English, Hindi, Telugu,
 * romanized and code-mixed). Reads only what the words establish:
 *
 *  - a clock time keeps its minutes in every spoken form: "4:30 PM", "11:00
 *    AM", "four thirty", "half past four", "चार बजकर तीस मिनट", "साढ़े चार",
 *    "నాలుగు గంటల ముప్పై నిమిషాలకి", "నాలుగున్నర";
 *  - AM/PM counts only when attached to a clock ("I am free at 4" is not 4 AM);
 *  - a day of the month is a date, never a clock ("15 November", "the 15th",
 *    "पंद्रह नवंबर", "నవంబర్ పదిహేనో తేదీన");
 *  - weekdays are read in every script, including English names written
 *    phonetically ("मंडे", "ఫ్రైడే");
 *  - anything contradictory or malformed ("16:30 AM", "4:75", "31 February")
 *    is reported as unclear instead of being guessed, so the state asks again.
 *
 * Calendar dates are resolved to YYYY-MM-DD only by the state
 * (state.ts resolveDateCandidates), with the business time zone and clock.
 */
import {
  negatedRelativeDates,
  relativeDateAnyLanguage,
} from "../../../../src/lib/voice-intent-lexicon.ts";
import {
  daysInMonth,
  HOUR_WORDS,
  monthOf,
  numberAt,
  ordinalAt,
  tokenize,
  type Token,
} from "./numbers.ts";
import type {
  Certainty,
  DateExpr,
  Reading,
  SimpleDateExpr,
  TimeReading,
  TimeSpec,
} from "./understanding.ts";

/* ------------------------------------------------------------------ */
/* Canonical text                                                      */
/* ------------------------------------------------------------------ */

/**
 * The text the date/time reader works on: zero-width joiners removed (Indic
 * transcripts carry them inconsistently) and AM/PM in one spelling, so
 * "a.m.", "A. M.", "AM-కు", "पीएम" and "ఏఎం" all read as "am"/"pm".
 */
export function canonicalTimeText(text: string): string {
  return (
    text
      // One encoding for nukta letters: "ढ़" arrives both precomposed and as ढ + ़.
      .normalize("NFC")
      .replace(/[\u200B-\u200D\uFEFF]/gu, "")
      .replace(
        /(?<![\p{L}\p{M}])([ap])\.\s?m\.?(?![\p{L}\p{M}])/giu,
        (_m, a: string) => `${a.toLowerCase()}m `,
      )
      .replace(/(?<![\p{L}\p{M}])(?:ए\.?\s?एम\.?|एएम)(?![\p{L}\p{M}])/gu, " am ")
      .replace(/(?<![\p{L}\p{M}])(?:पी\.?\s?एम\.?|पीएम)(?![\p{L}\p{M}])/gu, " pm ")
      .replace(/(?<![\p{L}\p{M}])(?:ఏ\.?\s?ఎం\.?|ఏఎం|ఎ\.?ఎం)/gu, " am ")
      .replace(/(?<![\p{L}\p{M}])(?:పీ\.?\s?ఎం\.?|పీఎం|పి\.?ఎం)/gu, " pm ")
      .replace(/(\d|\b)(am|pm)-(?=[\p{L}\p{M}])/giu, "$1$2 ")
      .replace(/\bo\s?'?\s?clock\b/giu, "o'clock")
      .replace(/[ \t]+/g, " ")
  );
}

/* ------------------------------------------------------------------ */
/* Vocabularies                                                        */
/* ------------------------------------------------------------------ */

/** The same pattern over NFC text (the canonical text is NFC). */
const nfc = (re: RegExp): RegExp => new RegExp(re.source.normalize("NFC"), re.flags);

/** "X or Y, whichever/either/any": the caller accepts any of them (not an ambiguity). */
export const FLEXIBLE =
  /\beither\b|\bany\b|\bwhichever\b|\bwhatever\b|ఏదైనా|ఏది\s*అయినా|\bedaina+\b|\bedi\s*ayina\b|कोई\s*भी|जो\s*भी|\bkoi\s*bhi\b|\bjo\s*bhi\b|\bkuch\s*bhi\b/i;

const MIDNIGHT = /\bmidnight\b|मध्यरात्रि|आधी\s*रात|अर्धरात्रि|అర్ధరాత్రి|ardharatri|aadhi\s*raat/i;
const NOON = /\bnoon\b|\bmidday\b/i;
const MORNING =
  /\bmorning\b|सुबह|सवेरे|मॉर्निंग|ఉదయం|పొద్దున|మార్నింగ్|subah|udayam|poddhuna|poddun/i;
const AFTERNOON = /\bafternoon\b|दोपहर|आफ्टरनून|మధ్యాహ్నం|ఆఫ్టర్నూన్|dopahar|madhyahnam/i;
const EVENING =
  /\bevening\b|शाम|ईवनिंग|इवनिंग|సాయంత్రం|ఈవెనింగ్|ఇవెనింగ్|shaam|sham\b|sayantram|saayantram/i;
const NIGHT = /\bnight\b|\btonight\b|रात|नाइट|రాత్రి|నైట్|raat\b|ratri/i;
const AFTER =
  /\bafter\b|\bpost\b|\bfrom\b|\bonwards\b|के\s*बाद|बाद\s*में|తర్వాత|తరువాత|నుండి|ke\s*baad|tarvata|taruvata/i;
const BEFORE = /\bbefore\b|\bby\b|से\s*पहले|ముందు|se\s*pehle|mundu/i;

/** Words that make a number word a clock hour ("four o'clock", "चार बजे", "at four", "शाम चार"). */
const TIME_CONTEXT =
  /o'clock|\b(?:at|by|around|after|before|till|until)\s|\b(?:am|pm)\b|बजे|बजकर|baje|bajkar|గంట|ganta|నిమిష|मिनट/i;
const PERIOD_CONTEXT = new RegExp(
  [MORNING, AFTERNOON, EVENING, NIGHT, MIDNIGHT, NOON].map((r) => r.source).join("|"),
  "i",
);

/** A clock-hour unit right after the number. */
function isHourUnit(tok: Token | undefined): boolean {
  if (!tok) return false;
  return (
    /^(?:o'clock|बजे|baje|bajey|गंटे)$/u.test(tok.l) ||
    /^(?:గంటలకు|గంటలకి|గంటకు|గంటకి|గంటల|గంట)$/u.test(tok.l) ||
    /^ganta(?:la)?(?:ku|ki)?$/.test(tok.l)
  );
}
/** "बजकर" / "బజ కర" / "bajkar": hours-and-minutes joiner (Hindi). */
function bajkarAt(tokens: Token[], k: number): number | null {
  const t = tokens[k]?.l;
  if (!t) return null;
  if (/^(?:बजकर|बजके|bajkar|bajke|baj-kar)$/u.test(t)) return k + 1;
  if (/^(?:बज|baj)$/u.test(t) && /^(?:कर|के|kar|ke)$/u.test(tokens[k + 1]?.l ?? "")) return k + 2;
  return null;
}
const MINUTE_UNIT = /^(?:मिनट|मिनिट|minutes?|mins?|నిమిష\S*|nimish\S*|nimsh\S*)$/u;
/** A number followed by one of these is a quantity, not a clock. */
const QUANTITY_UNIT = nfc(
  /^(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|people|persons?|members?|rupees?|rs|inr|lakh|lakhs|thousand|hundred|percent|मिनट|मिनिट|घंटे|घंटा|घंटों|दिन|हफ्ते|हफ़्ते|हफ्ता|महीने|महीना|लोग|साल|रुपये|रुपए|रुपया|सौ|हज़ार|हजार|लाख|प्रतिशत|ghante|ghanta|din|log|saal|rupaye|rupay|sau|hazaar|hazar)$/u,
);
const TE_QUANTITY_PREFIX =
  /^(?:నిమిష|రోజు|రోజుల|వార|నెల|సంవత్సర|రూపాయ|వంద|వేల|వేయి|లక్ష|మంది|శాతం|గంటలు|గంటల\s*పాటు)/u;
const CURRENCY_BEFORE = /^(?:₹|rs|inr|रु|రూ)$/u;

function isQuantityUnit(tok: Token | undefined): boolean {
  if (!tok) return false;
  return QUANTITY_UNIT.test(tok.l) || TE_QUANTITY_PREFIX.test(tok.l);
}

/* ------------------------------------------------------------------ */
/* Clocks                                                              */
/* ------------------------------------------------------------------ */

export interface Clock {
  hour: number;
  minute: number;
  start: number;
  end: number;
  raw: string;
  /** AM/PM attached to this clock. */
  meridiem: "am" | "pm" | null;
  /** Said with an hour unit, a colon or AM/PM (a clock for sure). */
  marked: boolean;
  /** Written 24-hour style with a leading zero ("09:30"). */
  zeroPadded: boolean;
  /** Why the expression cannot be a valid clock. */
  malformed: string | null;
}

const FRACTION_WORDS: Array<[RegExp, (h: number) => [number, number]]> = [
  [nfc(/^(?:साढ़े|साढे|साड़े|saadhe|sadhe|saade|sade|saarhe|sarhe)$/u), (h) => [h, 30]],
  [/^(?:सवा|sawa|sava|savaa|sawaa)$/u, (h) => [h, 15]],
  [/^(?:पौने|पोने|paune|pone)$/u, (h) => [h === 1 ? 12 : h - 1, 45]],
];
const DEDH = nfc(/^(?:डेढ़|डेढ|dedh|derh|dedth)$/u);
const DHAI = nfc(/^(?:ढाई|dhai|dhaai|dhaayi|adhai|adhaai)$/u);

/** Telugu suffix forms of an hour word: -నర (half past), -ంపావు (quarter past), -ముప్పావు (quarter to the next). */
function teluguFraction(suffix: string): { minute: number; rest: string } | null {
  let m = /^[ుి]?మ్ముప్పావు|^u?mmuppavu/u.exec(suffix);
  if (m) return { minute: 45, rest: suffix.slice(m[0].length) };
  m = /^[ుి]?న్నర|^[ui]?nnara/u.exec(suffix);
  if (m) return { minute: 30, rest: suffix.slice(m[0].length) };
  m = /^[ుి]?ం[పబ]ావు|^u?m[pb]aa?vu/u.exec(suffix);
  if (m) return { minute: 15, rest: suffix.slice(m[0].length) };
  return null;
}
/** Telugu "-ింటికి" / "-గంటకు" attached to an hour word ("నాలుగింటికి" = at four). */
const TE_HOUR_SUFFIX = /^(?:[ి]?ంటికి|[ు]?గంటకు|[ు]?గంటలకు|గంటకి|intiki|ntiki)$/u;
/** Suffixes a digit hour may carry ("4కి", "4కు", "4pm"). */
const DIGIT_HOUR_SUFFIX = /^(?:కి|కు|కీ|am|pm|baje|ki|ku|hrs|h)?$/u;

const AT_WORDS = /^(?:at|by|around|from|till|until|after|before|about|approx|approximately)$/;

function inSpans(spans: Array<[number, number]>, tok: Token): boolean {
  return spans.some(([a, b]) => tok.start < b && tok.end > a);
}

/** Every clock time named in `text` (canonical form). `skip` are spans already read as dates. */
export function findClocks(text: string, skip: Array<[number, number]> = []): Clock[] {
  const tokens = tokenize(text);
  const out: Clock[] = [];
  const contextual = TIME_CONTEXT.test(text) || PERIOD_CONTEXT.test(text);
  const meridiemAfter = (j: number): { mer: "am" | "pm" | null; end: number; marked: boolean } => {
    let k = j;
    let marked = false;
    while (k < tokens.length && isHourUnit(tokens[k])) {
      marked = true;
      k++;
    }
    const t = tokens[k]?.l;
    if (t === "am" || t === "pm") return { mer: t, end: k + 1, marked: true };
    return { mer: null, end: k, marked };
  };
  const push = (
    k0: number,
    kEnd: number,
    hour: number,
    minute: number,
    o: {
      mer?: "am" | "pm" | null;
      marked?: boolean;
      zeroPadded?: boolean;
      malformed?: string | null;
    } = {},
  ) => {
    const start = tokens[k0]!.start;
    const end = tokens[kEnd - 1]!.end;
    out.push({
      hour,
      minute,
      start,
      end,
      raw: text.slice(start, end),
      meridiem: o.mer ?? null,
      marked: o.marked ?? false,
      zeroPadded: o.zeroPadded ?? false,
      malformed:
        o.malformed ??
        (hour > 23 || minute > 59 ? `no such time: ${text.slice(start, end)}` : null),
    });
  };

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]!;
    if (inSpans(skip, tok)) continue;
    const prev = tokens[k - 1];

    // 1) Digital clock: "4:30", "11:00", "16.30", "4:30pm", "09:00".
    const dig = /^(\d+)[:.](\d+)([\p{L}\p{M}]*)$/u.exec(tok.t);
    if (dig) {
      const suffix = dig[3]!.toLowerCase();
      const hourDigits = dig[1]!;
      const minuteDigits = dig[2]!;
      let mer: "am" | "pm" | null = suffix === "am" || suffix === "pm" ? suffix : null;
      const after = meridiemAfter(k + 1);
      if (!mer && after.mer) mer = after.mer;
      const looksLikeClock =
        minuteDigits.length === 2 &&
        hourDigits.length <= 2 &&
        (tok.t.includes(":") || !isQuantityUnit(tokens[k + 1]));
      if (!looksLikeClock) {
        // "4:5 PM", "123:00": a time was attempted but is not readable.
        if (tok.t.includes(":") || mer || after.marked)
          push(k, Math.max(k + 1, after.end), 0, 0, { malformed: `unreadable clock: ${tok.t}` });
        continue;
      }
      if (prev && CURRENCY_BEFORE.test(prev.l)) continue;
      push(k, Math.max(k + 1, after.end), Number(hourDigits), Number(minuteDigits), {
        mer,
        marked: true,
        zeroPadded: hourDigits.length === 2 && hourDigits.startsWith("0"),
      });
      k = Math.max(k, after.end - 1);
      continue;
    }

    // 2) "half past four", "quarter past four", "quarter to five".
    if ((tok.l === "half" || tok.l === "quarter") && /^(?:past|to)$/.test(tokens[k + 1]?.l ?? "")) {
      const n = numberAt(tokens, k + 2);
      if (n && n.value >= 1 && n.value <= 12) {
        const to = tokens[k + 1]!.l === "to";
        if (tok.l === "half" && to) continue;
        const hour = to ? (n.value === 1 ? 12 : n.value - 1) : n.value;
        const minute = tok.l === "half" ? 30 : to ? 45 : 15;
        const after = meridiemAfter(n.next);
        push(k, after.end, hour, minute, { mer: after.mer, marked: true });
        k = after.end - 1;
        continue;
      }
    }

    // 3) Hindi fractions: साढ़े चार (4:30), सवा चार (4:15), पौने पांच (4:45); डेढ़ (1:30), ढाई (2:30).
    const fraction = FRACTION_WORDS.find(([re]) => re.test(tok.l));
    if (fraction) {
      const n = numberAt(tokens, k + 1);
      if (n && n.value >= 1 && n.value <= 12 && !isQuantityUnit(tokens[n.next])) {
        const [hour, minute] = fraction[1](n.value);
        const after = meridiemAfter(n.next);
        push(k, after.end, hour, minute, { mer: after.mer, marked: after.marked || contextual });
        k = after.end - 1;
        continue;
      }
    }
    if (DEDH.test(tok.l) || DHAI.test(tok.l)) {
      const after = meridiemAfter(k + 1);
      if (after.marked || (prev && PERIOD_CONTEXT.test(prev.t))) {
        push(k, after.end, DEDH.test(tok.l) ? 1 : 2, 30, { mer: after.mer, marked: true });
        k = after.end - 1;
      }
      continue;
    }

    // 4) A number: hours, hours + minutes, or a Telugu fraction form.
    const n = numberAt(tokens, k, true);
    if (!n) continue;
    if (prev && CURRENCY_BEFORE.test(prev.l)) {
      k = n.next - 1;
      continue;
    }
    const hourWordOk = !n.digits && (HOUR_WORDS[tok.l] !== undefined || n.suffix !== "");

    // 4a) Telugu "నాలుగున్నర" (4:30), "నాలుగుంపావు" (4:15), "నాలుగుమ్ముప్పావు" (4:45).
    if (!n.digits && n.suffix) {
      const f = teluguFraction(n.suffix);
      if (f && n.value >= 1 && n.value <= 12) {
        const after = meridiemAfter(n.next);
        push(k, after.end, n.value, f.minute, { mer: after.mer, marked: true });
        k = after.end - 1;
        continue;
      }
      if (TE_HOUR_SUFFIX.test(n.suffix) && n.value >= 1 && n.value <= 12) {
        const after = meridiemAfter(n.next);
        push(k, after.end, n.value, 0, { mer: after.mer, marked: true });
        k = after.end - 1;
        continue;
      }
      // Any other suffix ("పదిహేనో", "ఆరోగ్యం"): not a clock.
      k = n.next - 1;
      continue;
    }

    // 4b) Hindi "चार बजकर तीस मिनट".
    const bj = bajkarAt(tokens, n.next);
    if (bj !== null) {
      const m = numberAt(tokens, bj, true);
      if (m && !m.suffix) {
        let end = m.next;
        if (MINUTE_UNIT.test(tokens[end]?.l ?? "")) end++;
        const after = meridiemAfter(end);
        push(k, after.end, n.value, m.value, { mer: after.mer, marked: true });
        k = after.end - 1;
        continue;
      }
      const after = meridiemAfter(bj);
      push(k, Math.max(bj, after.end), n.value, 0, { mer: after.mer, marked: true });
      k = Math.max(bj, after.end) - 1;
      continue;
    }

    // 4c) Telugu "నాలుగు గంటల ముప్పై నిమిషాలకి" (hour, గంటల, minutes, నిమిషాలు).
    const unitTok = tokens[n.next];
    if (unitTok && /^(?:గంటల|గంట|gantala|ganta)$/u.test(unitTok.l)) {
      const m = numberAt(tokens, n.next + 1, true);
      if (m) {
        const minuteUnit =
          /^(?:నిమిష|nimish|nimsh)/u.test(m.suffix) ||
          /^(?:నిమిష|nimish|nimsh)/u.test(tokens[m.next]?.l ?? "");
        if (minuteUnit) {
          const end = /^(?:నిమిష|nimish|nimsh)/u.test(m.suffix) ? m.next : m.next + 1;
          const after = meridiemAfter(end);
          push(k, after.end, n.value, m.value, { mer: after.mer, marked: true });
          k = after.end - 1;
          continue;
        }
      }
    }

    // 4d) English "four thirty", "eleven fifteen", "4 30 pm", "ten oh five".
    const hourIsEnglishOrDigit = n.digits ? !n.suffix || n.suffix === "" : /^[a-z]+$/.test(tok.l);
    if (hourIsEnglishOrDigit && n.value >= 1 && n.value <= 12) {
      let m: { value: number; next: number } | null = null;
      const nt = tokens[n.next];
      if (nt && (nt.l === "o" || nt.l === "oh")) {
        const u = numberAt(tokens, n.next + 1);
        if (u && !u.digits && u.value >= 1 && u.value <= 9) m = { value: u.value, next: u.next };
      } else if (nt) {
        const mm = numberAt(tokens, n.next);
        const minuteOk =
          mm &&
          ((mm.digits && /^\d{2}$/.test(nt.t)) || (!mm.digits && /^[a-z-]+$/.test(nt.l))) &&
          mm.value >= 10 &&
          mm.value <= 59;
        if (mm && minuteOk) m = { value: mm.value, next: mm.next };
      }
      if (m && !isQuantityUnit(tokens[m.next])) {
        const after = meridiemAfter(m.next);
        const atBefore = prev && AT_WORDS.test(prev.l);
        // Digits "4 30" need AM/PM; words need AM/PM or a time context.
        if (after.mer || (!n.digits && (atBefore || contextual))) {
          push(k, after.end, n.value, m.value, { mer: after.mer, marked: true });
          k = after.end - 1;
          continue;
        }
      }
    }

    // 4e) A bare hour: digits, or a number word with a time marker.
    if (isQuantityUnit(tokens[n.next]) || MINUTE_UNIT.test(tokens[n.next]?.l ?? "")) {
      k = n.next - 1;
      continue;
    }
    if (n.digits) {
      if (!DIGIT_HOUR_SUFFIX.test(n.suffix) || tok.t.replace(/\D/g, "").length > 2) continue;
      let mer: "am" | "pm" | null = n.suffix === "am" || n.suffix === "pm" ? n.suffix : null;
      const after = meridiemAfter(n.next);
      if (!mer) mer = after.mer;
      push(k, Math.max(n.next, after.end), n.value, 0, {
        mer,
        marked: !!mer || after.marked || (n.suffix !== "" && n.suffix !== undefined),
      });
      k = Math.max(n.next, after.end) - 1;
      continue;
    }
    const after = meridiemAfter(n.next);
    if ((hourWordOk || after.marked) && (after.marked || after.mer || contextual)) {
      if (n.value < 1 || (n.value > 12 && !after.marked)) continue;
      push(k, after.end, n.value, 0, { mer: after.mer, marked: after.marked || !!after.mer });
      k = after.end - 1;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function hhmm(h: number, m = 0): string {
  return `${pad(h)}:${pad(m)}`;
}

type Period = "midnight" | "night" | "evening" | "afternoon" | "morning" | "noon" | null;

/** One clock to HH:MM, or why it cannot be read. */
function resolveClock(
  c: Clock,
  mer: "am" | "pm" | null,
  period: Period,
): { hhmm: string; certainty: Certainty; alt: string | null } | { bad: string } {
  const { hour, minute } = c;
  if (c.malformed) return { bad: c.malformed };
  if (hour > 23 || minute > 59) return { bad: `no such time: ${c.raw}` };
  if (mer) {
    // "16:30 AM", "13 PM": a 24-hour hour with AM/PM is not a time anyone can be held to.
    if (hour > 12) return { bad: `${c.raw}: a 24-hour time with ${mer.toUpperCase()}` };
    if (hour === 0 && mer === "pm") return { bad: `${c.raw} is not an afternoon time` };
    if (mer === "am" && (period === "evening" || period === "afternoon" || period === "noon"))
      return { bad: `AM said with ${period}` };
    if (mer === "am" && period === "night" && hour >= 6 && hour <= 11)
      return { bad: "AM said with night" };
    if (mer === "pm" && (period === "morning" || period === "midnight"))
      return { bad: `PM said with ${period}` };
    if (mer === "pm" && period === "night" && hour >= 1 && hour <= 5)
      return { bad: "PM said with night" };
    if (mer === "pm")
      return { hhmm: hhmm(hour === 12 ? 12 : hour + 12, minute), certainty: "explicit", alt: null };
    return { hhmm: hhmm(hour === 12 ? 0 : hour, minute), certainty: "explicit", alt: null };
  }
  if (hour >= 13 || hour === 0) {
    if (period === "morning" && hour >= 13) return { bad: `${c.raw} is not a morning time` };
    if (hour === 0 && (period === "evening" || period === "afternoon"))
      return { bad: `${c.raw} is not an ${period} time` };
    // "15" with no clock marker could be a day of the month: ask.
    if (!c.marked) return { hhmm: hhmm(hour, minute), certainty: "uncertain", alt: null };
    return { hhmm: hhmm(hour, minute), certainty: "explicit", alt: null };
  }
  // hour 1..12
  switch (period) {
    case "midnight":
      return { hhmm: hhmm(hour === 12 ? 0 : hour, minute), certainty: "explicit", alt: null };
    case "noon":
      if (hour !== 12) return { bad: `noon with ${c.raw}` };
      return { hhmm: hhmm(12, minute), certainty: "explicit", alt: null };
    case "morning":
      return { hhmm: hhmm(hour, minute), certainty: "explicit", alt: null };
    case "afternoon":
      return {
        hhmm: hhmm(hour === 12 ? 12 : hour < 6 ? hour + 12 : hour, minute),
        certainty: "explicit",
        alt: null,
      };
    case "evening":
      return { hhmm: hhmm(hour === 12 ? 12 : hour + 12, minute), certainty: "explicit", alt: null };
    case "night":
      // "रात 2 बजे" is 2 AM; "रात 9 बजे" is 9 PM; "रात 12" is midnight.
      if (hour === 12) return { hhmm: hhmm(0, minute), certainty: "explicit", alt: null };
      if (hour <= 4) return { hhmm: hhmm(hour, minute), certainty: "explicit", alt: null };
      return { hhmm: hhmm(hour + 12, minute), certainty: "explicit", alt: null };
    default:
      break;
  }
  if (c.zeroPadded) return { hhmm: hhmm(hour, minute), certainty: "explicit", alt: null };
  // 12 with nothing else is genuinely ambiguous: ask, don't infer.
  if (hour === 12) return { hhmm: hhmm(12, minute), certainty: "uncertain", alt: hhmm(0, minute) };
  // A bare hour on a business call (typical opening hours): 1..6 is afternoon, 7..11 morning (inferred, other reading kept).
  if (hour <= 6)
    return { hhmm: hhmm(hour + 12, minute), certainty: "inferred", alt: hhmm(hour, minute) };
  return { hhmm: hhmm(hour, minute), certainty: "inferred", alt: hhmm(hour + 12, minute) };
}

export interface TimeResult {
  reading: TimeReading | null;
  /** A time was attempted but cannot be trusted (malformed or contradictory). */
  unclear: string | null;
}

/** The clock time (or period) the caller asked for. `skip`: spans already read as dates. */
export function readTimeDetailed(rawText: string, skip: Array<[number, number]> = []): TimeResult {
  const text = canonicalTimeText(rawText);
  const spans = skip.length ? skip : calendarSpans(text);
  const clocks = findClocks(text, spans);
  const constraint: "after" | "before" | null = AFTER.test(text)
    ? "after"
    : BEFORE.test(text)
      ? "before"
      : null;
  const period: Period = MIDNIGHT.test(text)
    ? "midnight"
    : NOON.test(text)
      ? "noon"
      : NIGHT.test(text)
        ? "night"
        : EVENING.test(text)
          ? "evening"
          : AFTERNOON.test(text)
            ? "afternoon"
            : MORNING.test(text)
              ? "morning"
              : null;

  if (clocks.length === 0) {
    if (period === "midnight")
      return {
        reading: {
          spec: { kind: "exact", hhmm: "00:00" },
          certainty: "explicit",
          alternatives: [],
          evidence: "midnight",
        },
        unclear: null,
      };
    if (period === "noon")
      return {
        reading: {
          spec: { kind: "exact", hhmm: "12:00" },
          certainty: "explicit",
          alternatives: [],
          evidence: "noon",
        },
        unclear: null,
      };
    const p = MORNING.test(text)
      ? "morning"
      : AFTERNOON.test(text)
        ? "afternoon"
        : EVENING.test(text)
          ? "evening"
          : null;
    return {
      reading: p
        ? {
            spec: { kind: "period", period: p },
            certainty: "explicit",
            alternatives: [],
            evidence: p,
          }
        : null,
      unclear: null,
    };
  }

  // AM/PM written once for two times ("2 or 3 PM") applies to both.
  const mers = new Set(clocks.map((c) => c.meridiem).filter((m): m is "am" | "pm" => !!m));
  const shared = mers.size === 1 ? [...mers][0]! : null;
  const merOf = (c: Clock) => c.meridiem ?? shared;

  const orJoined =
    clocks.length >= 2 &&
    /\bor\b|या|లేదా|leda|\bya\b/i.test(text.slice(clocks[0]!.start, clocks[1]!.end));

  if (orJoined) {
    const a = resolveClock(clocks[0]!, merOf(clocks[0]!), period);
    const b = resolveClock(clocks[1]!, merOf(clocks[1]!), period);
    if ("bad" in a) return { reading: null, unclear: a.bad };
    if ("bad" in b) return { reading: null, unclear: b.bad };
    if (FLEXIBLE.test(text) && a.hhmm !== b.hhmm) {
      const doubtful = a.certainty === "uncertain" || b.certainty === "uncertain";
      return {
        reading: {
          spec: { kind: "anyOf", hhmms: [a.hhmm, b.hhmm].sort() },
          certainty: doubtful
            ? "uncertain"
            : a.certainty === "explicit" && b.certainty === "explicit"
              ? "explicit"
              : "inferred",
          alternatives: [],
          evidence: `${clocks[0]!.raw} or ${clocks[1]!.raw}, either`,
        },
        unclear: null,
      };
    }
    return {
      reading: {
        spec: { kind: "exact", hhmm: a.hhmm },
        certainty: "uncertain",
        alternatives: [{ kind: "exact", hhmm: b.hhmm }],
        evidence: `${clocks[0]!.raw} or ${clocks[1]!.raw}`,
      },
      unclear: null,
    };
  }

  // A negated time is the one the caller is taking back. English negation
  // precedes it ("3 PM, not 2"; "not 2 but 3"); Hindi and Telugu negation
  // follows it ("3 बजे नहीं, 4 बजे"; "3 కాదు 4"). A negation word that opens
  // the utterance ("नहीं, 4 बजे") negates the agent's proposal, not a time here.
  const negated = new Set<number>();
  for (const m of text.matchAll(/\bnot\b/gi)) {
    const next = clocks.find((c) => c.start > m.index!);
    if (next) negated.add(next.start);
  }
  for (const m of text.matchAll(/नहीं|नही|కాదు|వద్దు/g)) {
    if (m.index! === 0) continue;
    const prev = [...clocks].reverse().find((c) => c.end <= m.index!);
    if (prev) negated.add(prev.start);
  }
  const kept = clocks.filter((c) => !negated.has(c.start));
  // A malformed time the caller did not take back makes the whole reading unclear.
  const bad = kept.find((c) => c.malformed);
  if (bad) return { reading: null, unclear: bad.malformed };
  const chosen = (kept.length ? kept[kept.length - 1] : clocks[clocks.length - 1])!;
  const r = resolveClock(chosen, merOf(chosen), period);
  if ("bad" in r) return { reading: null, unclear: r.bad };
  const spec: TimeSpec = constraint
    ? { kind: constraint, hhmm: r.hhmm }
    : { kind: "exact", hhmm: r.hhmm };
  const alternatives: TimeSpec[] = r.alt
    ? [constraint ? { kind: constraint, hhmm: r.alt } : { kind: "exact", hhmm: r.alt }]
    : [];
  return {
    reading: { spec, certainty: r.certainty, alternatives, evidence: chosen.raw },
    unclear: null,
  };
}

/* ------------------------------------------------------------------ */
/* Calendar dates                                                      */
/* ------------------------------------------------------------------ */

export interface CalendarMention {
  day: number;
  month: number | null;
  year: number | null;
  start: number;
  end: number;
  raw: string;
  malformed: string | null;
}

const TARIKH = nfc(
  /^(?:तारीख|तारीख़|तारिख|tarikh|tareekh|tarik|tareek|tarikh|తేదీ\S*|తారీఖు\S*|tedi|thedi|tedee)$/u,
);
/** Suffixes a day number can carry: "15th", "15న", "పదిహేనో", "పదిహేనవ", "పదిహేనున". */
const DAY_SUFFIX = /^(?:st|nd|rd|th|[ిీుొోవన]{0,3}|[ుోొ]?వ?\s?తేదీ\S*)$/u;
const ORDINAL_SUFFIX = /^(?:st|nd|rd|th|[ోొ]|[ిు]?వ|.*తేదీ.*)$/u;
const NOT_DATE_AFTER = /^(?:am|pm|o'clock|बजे|baje|बजकर|గంట\S*|ganta\S*)$/u;

function yearAt(tokens: Token[], k: number): { year: number; next: number } | null {
  let j = k;
  if (tokens[j]?.t === ",") j++;
  const t = tokens[j];
  if (t && /^(?:19|20)\d{2}$/.test(t.t)) return { year: Number(t.t), next: j + 1 };
  return null;
}

function dayAt(tokens: Token[], k: number): { day: number; next: number; ordinal: boolean } | null {
  const o = ordinalAt(tokens, k);
  if (o) return { day: o.value, next: o.next, ordinal: true };
  const n = numberAt(tokens, k, true);
  if (!n) return null;
  const tok = tokens[k]!;
  if (n.digits && tok.t.replace(/\D/g, "").length > 2) return null;
  if (!DAY_SUFFIX.test(n.suffix)) return null;
  return { day: n.value, next: n.next, ordinal: ORDINAL_SUFFIX.test(n.suffix) };
}

/** Every day-of-month the caller named ("15 November", "November 15th", "पंद्रह नवंबर", "15 तारीख", "the 15th"). */
export function findCalendarDates(text: string): CalendarMention[] {
  const tokens = tokenize(text);
  const out: CalendarMention[] = [];
  const add = (
    k0: number,
    kEnd: number,
    day: number,
    month: number | null,
    year: number | null,
  ) => {
    const start = tokens[k0]!.start;
    const end = tokens[kEnd - 1]!.end;
    let malformed: string | null = null;
    if (day < 1 || day > 31) malformed = `no such day: ${text.slice(start, end)}`;
    else if (month && day > daysInMonth(month, year ?? 2000))
      malformed = `no such date: ${text.slice(start, end)}`;
    out.push({ day, month, year, start, end, raw: text.slice(start, end), malformed });
  };
  for (let k = 0; k < tokens.length; k++) {
    // MONTH [the] DAY [YEAR]: "November 15", "నవంబర్ పదిహేనో తేదీన", "नवंबर 15".
    const month = monthOf(tokens[k]);
    if (month) {
      let j = k + 1;
      if (tokens[j]?.l === "the") j++;
      const d = dayAt(tokens, j);
      if (d && !NOT_DATE_AFTER.test(tokens[d.next]?.l ?? "")) {
        let end = d.next;
        if (TARIKH.test(tokens[end]?.l ?? "")) end++;
        const y = yearAt(tokens, end);
        add(k, y ? y.next : end, d.day, month, y?.year ?? null);
        k = (y ? y.next : end) - 1;
        continue;
      }
      continue;
    }
    // DAY [of] MONTH [YEAR]: "15 November", "the 15th of November", "पंद्रह नवंबर".
    const d = dayAt(tokens, k);
    if (!d) continue;
    let j = d.next;
    if (tokens[j]?.l === "of") j++;
    const m = monthOf(tokens[j]);
    if (m && !NOT_DATE_AFTER.test(tokens[j + 1]?.l ?? "")) {
      const y = yearAt(tokens, j + 1);
      const k0 = tokens[k - 1]?.l === "the" ? k - 1 : k;
      add(k0, y ? y.next : j + 1, d.day, m, y?.year ?? null);
      k = (y ? y.next : j + 1) - 1;
      continue;
    }
    // DAY तारीख / తేదీ, "the 15th", "పదిహేనో తేదీ": a day of the month with no month.
    const tarikh = TARIKH.test(tokens[d.next]?.l ?? "");
    const theOrdinal = d.ordinal && /^(?:the|on)$/.test(tokens[k - 1]?.l ?? "");
    const suffixTedi = /తేదీ/u.test(tokens[k]!.t);
    if (tarikh || theOrdinal || suffixTedi) {
      const end = tarikh ? d.next + 1 : d.next;
      add(tokens[k - 1]?.l === "the" ? k - 1 : k, end, d.day, null, null);
      k = end - 1;
    }
  }
  return out;
}

export function calendarSpans(text: string): Array<[number, number]> {
  return findCalendarDates(text).map((d) => [d.start, d.end]);
}

/* ------------------------------------------------------------------ */
/* Weekdays and relative days                                          */
/* ------------------------------------------------------------------ */

const WEEKDAY_TERMS: Array<[number, string[]]> = [
  [
    0,
    [
      "sunday",
      "रविवार",
      "इतवार",
      "संडे",
      "ఆదివారం",
      "సండే",
      "ravivar",
      "itwar",
      "aadivaram",
      "adivaram",
    ],
  ],
  [1, ["monday", "सोमवार", "मंडे", "मन्डे", "సోమవారం", "మండే", "somvar", "somavaar", "somavaram"]],
  [
    2,
    [
      "tuesday",
      "मंगलवार",
      "ट्यूज़डे",
      "ट्यूजडे",
      "ट्यूसडे",
      "ट्यूस्डे",
      "మంగళవారం",
      "ట్యూస్డే",
      "ట్యూజ్డే",
      "mangalvar",
      "mangalavaram",
    ],
  ],
  [
    3,
    [
      "wednesday",
      "बुधवार",
      "वेडनेसडे",
      "वेडनसडे",
      "वेनसडे",
      "वेंसडे",
      "वेन्सडे",
      "బుధవారం",
      "వెడ్నెస్డే",
      "వెన్స్డే",
      "వెడ్నస్డే",
      "budhvar",
      "budhavaram",
    ],
  ],
  [
    4,
    [
      "thursday",
      "गुरुवार",
      "बृहस्पतिवार",
      "थर्सडे",
      "थर्स्डे",
      "గురువారం",
      "థర్స్డే",
      "థర్సడే",
      "guruvar",
      "guruvaram",
    ],
  ],
  [
    5,
    [
      "friday",
      "शुक्रवार",
      "फ्राइडे",
      "फ्रायडे",
      "फ्राईडे",
      "శుక్రవారం",
      "ఫ్రైడే",
      "ఫ్రయిడే",
      "shukravar",
      "sukravaram",
      "shukravaram",
    ],
  ],
  [
    6,
    [
      "saturday",
      "शनिवार",
      "सैटरडे",
      "सटरडे",
      "सेटरडे",
      "శనివారం",
      "శాటర్డే",
      "సాటర్డే",
      "shanivar",
      "sanivaram",
    ],
  ],
];
const WEEKDAY_RE = new RegExp(
  WEEKDAY_TERMS.flatMap(([, terms]) => terms)
    .sort((a, b) => b.length - a.length)
    .map((t) => (/^[a-z]+$/.test(t) ? `\\b${t}\\b` : `(?<![\\p{L}\\p{M}])${t.normalize("NFC")}`))
    .join("|"),
  "giu",
);
const WEEKDAY_BY_TERM = new Map(
  WEEKDAY_TERMS.flatMap(([n, terms]) => terms.map((t) => [t.normalize("NFC"), n] as const)),
);

const NEXT_WORD =
  /^(?:next|coming|अगले|अगला|अगली|agle|agla|agli|नेक्स्ट|వచ్చే|vacche|vachhe|vache|నెక్స్ట్)$/u;
const THIS_WORD = /^(?:this|इस|is|दिस|ఈ|ee|ది్స్|దిస్)$/u;
const LAST_WORD =
  /^(?:last|previous|past|पिछले|पिछला|pichle|pichhle|लास्ट|గత|పోయిన|poyina|lasta|లాస్ట్|gata)$/u;
const WEEK_WORD = /^(?:week|हफ्ते|हफ़्ते|सप्ताह|వారం|hafte)$/u;

interface WeekdayMention {
  weekday: number;
  qualifier: "next" | "this" | "last" | null;
  start: number;
  end: number;
}

function findWeekdays(text: string): WeekdayMention[] {
  const tokens = tokenize(text);
  const out: WeekdayMention[] = [];
  for (const m of text.matchAll(WEEKDAY_RE)) {
    const weekday = WEEKDAY_BY_TERM.get(m[0].toLowerCase()) ?? WEEKDAY_BY_TERM.get(m[0])!;
    const start = m.index!;
    let k = tokens.findIndex((t) => t.start >= start) - 1;
    if (k >= 0 && WEEK_WORD.test(tokens[k]!.l)) k--;
    let before = k >= 0 ? tokens[k]!.l : "";
    // Romanized "is"/"ee" qualify only a romanized Hindi/Telugu day ("is somvar"), never "is Monday free?".
    if ((before === "is" || before === "ee") && /^[a-z]+day$/i.test(m[0])) before = "";
    const qualifier = NEXT_WORD.test(before)
      ? "next"
      : LAST_WORD.test(before)
        ? "last"
        : THIS_WORD.test(before)
          ? "this"
          : null;
    out.push({ weekday, qualifier, start, end: start + m[0].length });
  }
  return out;
}

/** Drop mentions the caller took back: "not Monday", "Monday नहीं", "సోమవారం కాదు". */
function withoutNegated<T extends { start: number; end: number }>(text: string, items: T[]): T[] {
  if (items.length < 2) return items;
  const negated = new Set<T>();
  for (const m of text.matchAll(/\bnot\b|\binstead\s+of\b/gi)) {
    const next = items.find((c) => c.start > m.index!);
    if (next) negated.add(next);
  }
  for (const m of text.matchAll(/नहीं|नही|కాదు|వద్దు|\bnahi\b|\bkaadu\b/gi)) {
    const prev = [...items].reverse().find((c) => c.end <= m.index!);
    if (prev) negated.add(prev);
  }
  const kept = items.filter((c) => !negated.has(c));
  return kept.length ? kept : items;
}

const TODAY_WORDS =
  /\btoday\b|\btonight\b|आज|ఈరోజు|ఈ\s+రోజు|ఇవాళ|ఇవ్వాళ|\baaj\b|\biv+ala\b|\bee\s*roju\b/i;
/** Hindi "kal" is bounded by spaces/punctuation: "कल" inside another word is not a day. */
const KAL = /(?:^|[\s,.?!।])(?:कल|kal)(?=$|[\s,.?!।])/i;
const TOMORROW_WORDS = /\btomorrow\b|రేపు|రేపటి|\brepu\b/i;
/**
 * "कल ... था/किया/आया" — Hindi "kal" in the past tense is yesterday ("मैंने कल
 * फोन किया था"): not a day for the appointment.
 */
const KAL_PAST =
  /(?:कल|\bkal\b)[^,.?!।]{0,40}?(?:था|थी|थे|गया|गई|किया|की\s*थी|आया|आई|\btha\b|\bthi\b|\bgaya\b|\bgayi\b|\bkiya\b|\baaya\b|\baayi\b)/i;

type RelativeRead =
  { value: DateExpr; certainty: Certainty; evidence: string } | "yesterday" | null;

/**
 * Today / tomorrow / day after tomorrow. Hindi "kal"/"परसों" each name two
 * days (past and future): inferred, and a past-tense "kal" is not a booking
 * day at all. Two days named together ("today or tomorrow", "aaj ya kal")
 * are left for the caller to choose.
 */
function readRelative(text: string): RelativeRead {
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
  const negated = negatedRelativeDates(text);
  const kalSaid = KAL.test(text);
  const kalIsYesterday = kalSaid && KAL_PAST.test(text);
  const todaySaid = TODAY_WORDS.test(text) && !negated.has("today");
  const tomorrowSaid =
    !negated.has("tomorrow") && (TOMORROW_WORDS.test(text) || (kalSaid && !kalIsYesterday));
  if (todaySaid && tomorrowSaid) {
    return {
      value: {
        kind: "either",
        options: [
          { kind: "relative", days: 0 },
          { kind: "relative", days: 1 },
        ],
      },
      certainty: "uncertain",
      evidence: "today or tomorrow",
    };
  }
  if (kalIsYesterday && !TOMORROW_WORDS.test(text) && !todaySaid) return "yesterday";

  // English is not in the shared lexicon: honour the same negations here
  // ("not tomorrow, today" is today).
  const english =
    /\btomorrow\b/i.test(text) && !negated.has("tomorrow")
      ? "tomorrow"
      : /\btoday\b|\btonight\b/i.test(text) && !negated.has("today")
        ? "today"
        : null;
  let rel = relativeDateAnyLanguage(text) ?? english;
  // "मैंने कल फोन किया था, आज चाहिए": the shared lexicon checks "kal" first.
  if (rel === "tomorrow" && kalIsYesterday && !TOMORROW_WORDS.test(text))
    rel = todaySaid ? "today" : null;
  if (!rel) return null;
  const onlyKal = rel === "tomorrow" && kalSaid && !TOMORROW_WORDS.test(text);
  return {
    value: { kind: "relative", days: rel === "tomorrow" ? 1 : 0 },
    certainty: onlyKal ? "inferred" : "explicit",
    evidence: rel,
  };
}

export interface DateResult {
  date: Reading["date"];
  /** A date was attempted but cannot be used (malformed, or in the past). */
  unclear: string | null;
}

/**
 * The day the caller named, without deciding anything the words don't say.
 * An explicit calendar date wins over a weekday or relative day said with
 * it, which is kept as a cross-check: "Friday 15 November" when the 15th is
 * not a Friday is clarified, never silently resolved.
 */
export function readDateDetailed(rawText: string): DateResult {
  const text = canonicalTimeText(rawText);
  const relative = readRelative(text);
  const calendar = findCalendarDates(text);
  const malformed = calendar.find((c) => c.malformed);
  const goodCalendar = withoutNegated(
    text,
    calendar.filter((c) => !c.malformed),
  );
  const weekdaysAll = withoutNegated(text, findWeekdays(text));
  const pastWeekday = weekdaysAll.find((w) => w.qualifier === "last");
  const weekdays = weekdaysAll.filter((w) => w.qualifier !== "last");
  const distinctWeekdays = [...new Map(weekdays.map((w) => [w.weekday, w])).values()];
  const weekdayExpr = (w: WeekdayMention): SimpleDateExpr => ({
    kind: "weekday",
    weekday: w.weekday,
    qualifier: w.qualifier === "next" || w.qualifier === "this" ? w.qualifier : null,
  });
  const singleWeekday = distinctWeekdays.length === 1 ? weekdayExpr(distinctWeekdays[0]!) : null;
  const relSimple =
    relative && relative !== "yesterday" && relative.value.kind === "relative"
      ? relative.value
      : null;

  if (malformed && goodCalendar.length === 0) return { date: null, unclear: malformed.malformed };

  if (goodCalendar.length) {
    const exprs = [
      ...new Map(
        goodCalendar.map((c) => [
          `${c.day}-${c.month}-${c.year}`,
          { kind: "calendar", day: c.day, month: c.month, year: c.year } as SimpleDateExpr,
        ]),
      ).values(),
    ];
    if (exprs.length > 1) {
      return {
        date: {
          value: { kind: "either", options: exprs },
          certainty: "uncertain",
          evidence: goodCalendar.map((c) => c.raw).join(" or "),
        },
        unclear: null,
      };
    }
    const c = goodCalendar[goodCalendar.length - 1]!;
    const crossCheck: SimpleDateExpr[] = [];
    if (singleWeekday) crossCheck.push(singleWeekday);
    if (relSimple) crossCheck.push(relSimple);
    return {
      date: {
        value: exprs[0]!,
        certainty: c.month === null ? "inferred" : "explicit",
        evidence: c.raw,
        ...(crossCheck.length ? { crossCheck } : {}),
      },
      unclear: null,
    };
  }

  if (relative && relative !== "yesterday") {
    return {
      date: {
        ...relative,
        ...(singleWeekday && relative.value.kind === "relative"
          ? { crossCheck: [singleWeekday] }
          : {}),
      },
      unclear: null,
    };
  }
  if (relative === "yesterday" && !distinctWeekdays.length) return { date: null, unclear: null };

  if (distinctWeekdays.length > 1) {
    return {
      date: {
        value: { kind: "either", options: distinctWeekdays.map(weekdayExpr) },
        certainty: "uncertain",
        evidence: `weekdays ${distinctWeekdays.map((w) => w.weekday).join(" or ")}`,
      },
      unclear: null,
    };
  }
  if (singleWeekday && singleWeekday.kind === "weekday") {
    const q = singleWeekday.qualifier;
    return {
      date: {
        value: singleWeekday,
        certainty: "explicit",
        evidence: `${q ? `${q} ` : ""}weekday ${singleWeekday.weekday}`,
      },
      unclear: null,
    };
  }
  if (pastWeekday) return { date: null, unclear: "a past day (last …)" };
  return { date: null, unclear: null };
}
