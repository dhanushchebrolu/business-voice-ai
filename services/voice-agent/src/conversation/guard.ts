/**
 * Last line of defence between the model and the caller's ear. The model is
 * prompted with the state, but prompts are not guarantees; these checks are.
 * Each spoken sentence is checked against the state and dropped if it:
 *   - claims a booking succeeded before the backend confirmed it;
 *   - says a time is free that the calendar did not offer, or says a time is
 *     NOT free when the calendar never said so (availability claims are
 *     checked clause by clause, in both directions, against calendar results);
 *   - quotes a price the backend did not provide;
 *   - is a second question in the same reply (one question at a time);
 *   - asks anything at all while saying goodbye (noQuestions).
 */
import { asciiDigits, MISSING_DETAIL_QUESTION } from "../../../../src/lib/voice-intent-lexicon.ts";
import { callOutcomeLine } from "../../../../src/lib/voice-call-outcomes.ts";
import { localizedFallback } from "../../../../src/lib/voice-fallback-messages.ts";
import { VOICE_LANGUAGE_CODES } from "../../../../src/lib/voice-languages.ts";
import { spokenTime, type ConversationState } from "./state.ts";
import { NUMBER_WORDS, type LanguageCode } from "./understanding.ts";

const BOOKED_CLAIM =
  /\b(?:(?:is|has been|have been|got|been|are)\s+(?:booked|confirmed|scheduled|reserved)|booking is (?:done|confirmed|complete)|i(?:'ve| have) (?:booked|scheduled|confirmed)|you(?:'re| are) (?:all )?(?:set|booked))\b|बुक\s*(?:हो\s*गया|हो\s*गई|कर\s*दिया|कर\s*दी)|कन्फर्म\s*(?:हो\s*गया|कर\s*दिया)|बुक\s*हो\s*चुका|బుక్\s*(?:అయింది|చేశాను|చేసాను|అయిపోయింది)|కన్ఫర్మ్\s*(?:అయింది|చేశాను)|నమోదు\s*చేశాను/i;
/**
 * An assertion that something is free, without naming a time ("it is free",
 * "खाली है", "ఖాళీగా ఉంది"). "Let me check the free times" style lines name no
 * time and are only blocked when they assert availability like this.
 */
const ASSERTS_FREE =
  /\b(?:available|free|open)\b|खाली\s*है|उपलब्ध\s*है|ఖాళీగా\s*ఉంది|అందుబాటులో\s*ఉంది|\bkh?aa?li\s+(?:hai|undi)\b|\bfree\s*ga\s+undi\b/i;
/** Words that make a clause with a named time an availability claim (either way). */
const AVAILABLE_CLAIM =
  /\b(?:available|unavailable|free|open)\b|खाली|उपलब्ध|ఖాళీ|అందుబాటు|\bkh?aa?li\b|\bupalabdh\b/i;
/**
 * The clause says something is NOT free. Bound to availability words, so a
 * bare "no," at the start of "No, 5 PM is free" does not flip it.
 */
const NOT_FREE =
  /\b(?:not|isn'?t|aren'?t|no\s+longer)\s+(?:\w+\s+){0,2}?(?:free|available|open)\b|\bunavailable\b|\b(?:already\s+)?(?:taken|occupied)\b|\bfully\s+booked\b|\bbooked\s+up\b|\bno\s+(?:free\s+)?(?:slots?|times?|openings?|availability)\b|\bnothing\s+(?:is\s+)?(?:free|available|open)\b|\bnone\s+(?:of\s+them\s+)?(?:is|are)\s+(?:free|available)\b|\bneither\b[^.?!।]*\bnor\b[^.?!।]*\b(?:free|available|open)\b|(?:खाली|उपलब्ध|available|free)\s*नहीं|नहीं\s*(?:है\s*)?(?:खाली|उपलब्ध)|भरा\s*(?:हुआ\s*)?है|भर\s*गया|(?:ఖాళీ(?:గా)?|అందుబాటులో|available|free(?:\s*గా)?)\s*(?:లేదు|లేవు|లేను)|ఏదీ\s*ఖాళీ|\b(?:kh?aa?li|available|free|upalabdh)\s+(?:nahi|nahin|nai)\b|\b(?:kh?aa?li|available|free)\s*(?:ga\s+)?(?:ledu|levu)\b|\bbhara\s+(?:hua\s+)?hai\b/i;
/**
 * Fragments carry their own polarity: "4 PM is taken, but 5 PM is free",
 * "4 PM available లేదు, 5 PM free గా ఉంది". A fragment that names a time but
 * no claim ("11 AM" in "11 AM, 4 PM are free") takes the polarity of the
 * nearest claim fragment, so no named time escapes the check.
 */
const FRAGMENT = /[,;]|\s(?:but|however|whereas|though)\s|लेकिन|मगर|परंतु|\sपर\s|కానీ|అయితే/i;
/**
 * "We have a slot at 2 PM", "स्लॉट 2 बजे", "2 PM కి స్లాట్ ఉంది": availability
 * claims without the words free/available. Checked only when a clock time is
 * named, so "which slot suits you?" is never touched.
 */
const SLOT_CLAIM = /\bslots?\b|\bwe\s+have\b|\bopenings?\b|स्लॉट|స్లాట్/i;
const PRICE =
  /(?:₹|rs\.?|inr|rupees?|रुपये|रुपए|రూపాయలు)\s*([\d,]+)|([\d,]+)\s*(?:₹|rs\.?|rupees?|रुपये|रुपए|రూపాయలు)/i;
const PM_CONTEXT =
  /evening|afternoon|night|शाम|दोपहर|रात|सायं|సాయంత్రం|మధ్యాహ్నం|రాత్రి|\bshaa?m\b|\bdopa?har\b|\braat\b|\bsaa?yantram\b|\bmadhyaa?h?nam\b|\bra+tri\b/i;
const AM_CONTEXT =
  /morning|सुबह|सवेरे|ఉదయం|పొద్దున|\bsubah\b|\bsavere\b|\budayam\b|\bpodd?h?una\b/i;

/*
 * Spoken clock times, in every form the agent may say them:
 *   digits       4 PM, 4:30 p.m., 16:00, ४ बजे, ౪ గంటలకు (native digits are normalised)
 *   words        four PM, four o'clock, four thirty PM, half past four,
 *                चार बजे, char baje, నాలుగు గంటలకు, naalugu gantalaku
 *   fractions    साढ़े चार (4:30), सवा चार (4:15), पौने पांच (4:45), डेढ़ (1:30),
 *                ढाई (2:30), నాలుగున్నర (4:30)
 *   named        noon, midnight
 * A number counts as a time only next to a time unit (AM/PM, o'clock, बजे,
 * గంటలకు, "in the evening"), so "ek minute" or "do you" never do.
 */
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HOUR_WORD = Object.keys(NUMBER_WORDS)
  .sort((a, b) => b.length - a.length)
  .map(esc)
  .join("|");
const NUM = String.raw`\d{1,2}(?::\d{2})?|` + HOUR_WORD;
const UNIT = String.raw`a\.?m\.?|p\.?m\.?|o'?\s?clock|बजे|baje|గంటలకు|గంటకు|గంటకి|గంటల|gantala?ku|gantaki|in\s+the\s+(?:morning|afternoon|evening|night)`;
const MINUTE_WORD = String.raw`fifteen|thirty|forty[\s-]?five`;
const FRACTION = String.raw`साढ़े|सवा|पौने|saa?dhe|sava|paune`;
const SPOKEN_TIME = new RegExp(
  String.raw`(?<![\p{L}\p{M}\d])(?:` +
    String.raw`(?<halfWord>डेढ़|ढाई|dedh|dhai)\s*(?:बजे|baje)` +
    `|half\\s+past\\s+(?<pastNum>${NUM})(?:\\s*(?<pastUnit>${UNIT}))?` +
    `|(?:(?<fraction>${FRACTION})\\s*)?(?<num>${NUM})(?<nara>న్నర)?(?:\\s+(?<minuteWord>${MINUTE_WORD}))?\\s*(?<unit>${UNIT})` +
    // "at 4", "from 5" (no unit): still a time.
    `|(?:at|from|by|till|until|around)\\s+(?<prepNum>${NUM})` +
    // Telugu "4 కి" / "5 కు" (digits only: a number word + కి is too loose).
    String.raw`|(?<teNum>\d{1,2}(?::\d{2})?)\s*(?:కి|కు)` +
    String.raw`|(?<named>noon|midnight))` +
    String.raw`(?![\p{L}\p{M}])`,
  "giu",
);

function hourOf(token: string): { h: number; m: number } | null {
  const d = /^(\d{1,2})(?::(\d{2}))?$/.exec(token);
  if (d) return { h: Number(d[1]), m: Number(d[2] ?? 0) };
  const w = NUMBER_WORDS[token] ?? NUMBER_WORDS[token.toLowerCase()];
  return w ? { h: w, m: 0 } : null;
}

export function splitSentences(text: string): string[] {
  return text.match(/[^.!?।\n]+[.!?।\n]*/g)?.map((s) => s) ?? [];
}

const hhmmOf = (h: number, m: number) =>
  `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/**
 * Every clock time named in a sentence, each with its possible readings:
 * AM/PM (or "in the evening") given -> one reading; otherwise the period word
 * anywhere in `context` (शाम, సాయంత్రం, morning...) decides; with neither,
 * both readings are kept (04:00 and 16:00), and the guard accepts the
 * mention if either reading is allowed.
 */
export function clocksIn(sentence: string, context: string = sentence): string[][] {
  const text = asciiDigits(sentence);
  const ctx = asciiDigits(context);
  const pmContext = PM_CONTEXT.test(ctx);
  const amContext = AM_CONTEXT.test(ctx);
  const out: string[][] = [];
  for (const m of text.matchAll(SPOKEN_TIME)) {
    const {
      halfWord,
      pastNum,
      pastUnit,
      fraction,
      num,
      nara,
      minuteWord,
      unit,
      named,
      prepNum,
      teNum,
    } = m.groups!;
    if (named) {
      out.push([named.toLowerCase() === "noon" ? "12:00" : "00:00"]);
      continue;
    }
    let h: number;
    let min: number;
    let u = (unit ?? pastUnit ?? "").toLowerCase();
    if (halfWord) {
      h = /डेढ़|dedh/i.test(halfWord) ? 1 : 2;
      min = 30;
    } else {
      const base = hourOf(pastNum ?? num ?? prepNum ?? teNum ?? "");
      if (!base) continue;
      h = base.h;
      min = base.m;
      if (pastNum || nara) min = 30;
      if (minuteWord) min = /fifteen/i.test(minuteWord) ? 15 : /thirty/i.test(minuteWord) ? 30 : 45;
      if (fraction) {
        if (/साढ़े|saa?dhe/i.test(fraction)) min = 30;
        else if (/सवा|sava/i.test(fraction)) min = 15;
        else {
          // पौने पांच = quarter to five
          h = h === 1 ? 12 : h - 1;
          min = 45;
        }
      }
    }
    if (h > 23 || min > 59) continue;
    if (/^in\s+the\s+(?:afternoon|evening|night)/.test(u)) u = "pm";
    else if (/^in\s+the\s+morning/.test(u)) u = "am";
    if (/^[ap]\.?m/.test(u)) {
      const pm = u.startsWith("p");
      out.push([hhmmOf(pm ? (h < 12 ? h + 12 : 12) : h === 12 ? 0 : h, min)]);
    } else if (h >= 13) {
      out.push([hhmmOf(h, min)]);
    } else if (pmContext && !amContext) {
      out.push([hhmmOf(h < 12 ? h + 12 : 12, min)]);
    } else if (amContext && !pmContext) {
      out.push([hhmmOf(h === 12 ? 0 : h, min)]);
    } else {
      out.push([...new Set([hhmmOf(h === 12 ? 0 : h, min), hhmmOf(h < 12 ? h + 12 : 12, min)])]);
    }
  }
  return out;
}

export type GuardRule =
  | "premature_booking_claim"
  | "unoffered_availability"
  | "unverified_unavailability"
  | "unbacked_price"
  | "second_question"
  | "question_on_close";

export interface GuardRemoval {
  /** The exact text removed. */
  sentence: string;
  rule: GuardRule;
  /** Why, in terms of the call state (times, statuses); never secrets. */
  reason: string;
}

export interface GuardResult {
  text: string;
  removed: GuardRemoval[];
}

const show = (t: string) => spokenTime(t);
const showAll = (ts: Iterable<string>) => [...ts].map(show).join(", ") || "none";

/** Checks one reply sentence by sentence, so it can run on a token stream. */
export class ReplyGuard {
  readonly removed: GuardRemoval[] = [];
  private questions = 0;
  private readonly s: ConversationState;
  private readonly facts: { knownPrices: number[]; noQuestions?: boolean };
  constructor(s: ConversationState, facts: { knownPrices: number[]; noQuestions?: boolean }) {
    this.s = s;
    this.facts = facts;
  }

  private drop(sentence: string, rule: GuardRule, reason: string): null {
    this.removed.push({ sentence, rule, reason });
    return null;
  }

  /** The caller's own requested times (a question may name them before any check). */
  private requested(): Set<string> {
    const out = new Set<string>();
    const t = this.s.time;
    if (!t) return out;
    for (const v of [t.value, ...t.alternatives]) {
      if (v.kind === "exact") out.add(v.hhmm);
      if (v.kind === "anyOf") v.hhmms.forEach((h) => out.add(h));
    }
    return out;
  }

  /**
   * Availability, clause by clause. A clause that says a time IS free may only
   * name offered times; one that says a time is NOT free may only name times
   * the calendar showed as not free. Without a time, "it's free" needs an
   * offer and "nothing is free" needs a calendar answer.
   */
  private availability(sentence: string): { rule: GuardRule; reason: string } | null {
    const s = this.s;
    const offered = new Set(s.booking.offered.map((o) => o.hhmm));
    const notFree = new Set(s.booking.unavailable);
    // "Nothing free" for exactly what was asked also covers the caller's own times.
    if (s.booking.status === "no_availability") this.requested().forEach((h) => notFree.add(h));
    const question = /[?？]/.test(sentence);
    const asked = question ? this.requested() : new Set<string>();
    type Polarity = "free" | "not_free" | null;
    const fragments = sentence.split(FRAGMENT).map((text) => {
      const negative = NOT_FREE.test(text);
      const positive = !negative && (AVAILABLE_CLAIM.test(text) || SLOT_CLAIM.test(text));
      return {
        text,
        times: clocksIn(text, sentence),
        polarity: (negative ? "not_free" : positive ? "free" : null) as Polarity,
      };
    });
    if (!fragments.some((f) => f.polarity)) return null; // no availability claim at all
    const ok = (readings: string[], allowed: Set<string>) =>
      readings.some((r) => allowed.has(r) || asked.has(r));
    fragments.forEach((f, i) => {
      if (f.polarity || !f.times.length) return;
      const after = fragments.slice(i + 1).find((x) => x.polarity);
      const before = fragments
        .slice(0, i)
        .reverse()
        .find((x) => x.polarity);
      f.polarity = (after ?? before)!.polarity;
    });
    for (const f of fragments) {
      if (f.polarity === "not_free") {
        const bad = f.times.find((r) => !ok(r, notFree));
        if (bad)
          return {
            rule: "unverified_unavailability",
            reason: `says ${show(bad[0]!)} is not free, but the calendar did not show it as taken (not free per calendar: ${showAll(notFree)}; offered: ${showAll(offered)})`,
          };
        if (!f.times.length && !notFree.size && s.booking.status !== "no_availability")
          return {
            rule: "unverified_unavailability",
            reason: `says nothing is free, but no calendar result says so (booking status: ${s.booking.status})`,
          };
      } else if (f.polarity === "free") {
        const bad = f.times.find((r) => !ok(r, offered));
        if (bad)
          return {
            rule: "unoffered_availability",
            reason: `names ${show(bad[0]!)} as available, but the calendar offered only: ${showAll(offered)}`,
          };
        if (!f.times.length && !offered.size && ASSERTS_FREE.test(f.text) && !question)
          return {
            rule: "unoffered_availability",
            reason: `claims availability before the calendar offered anything (booking status: ${s.booking.status})`,
          };
      }
    }
    return null;
  }

  /** The sentence to speak, or null when it must not be spoken. */
  check(sentence: string): string | null {
    const s = this.s;
    if (BOOKED_CLAIM.test(sentence) && s.booking.status !== "confirmed") {
      return this.drop(
        sentence,
        "premature_booking_claim",
        `claims the booking is done, but the backend has not confirmed it (booking status: ${s.booking.status})`,
      );
    }
    const availability = this.availability(sentence);
    if (availability) return this.drop(sentence, availability.rule, availability.reason);
    const price = sentence.match(PRICE);
    if (price) {
      const n = Number((price[1] ?? price[2] ?? "").replace(/,/g, ""));
      if (!this.facts.knownPrices.includes(n)) {
        return this.drop(
          sentence,
          "unbacked_price",
          `quotes ₹${n}, which no price tool returned (known: ${this.facts.knownPrices.map((x) => `₹${x}`).join(", ") || "none"})`,
        );
      }
    }
    if (/[?？]/.test(sentence)) {
      if (this.facts.noQuestions) {
        return this.drop(
          sentence,
          "question_on_close",
          "the caller is finishing; a goodbye asks nothing",
        );
      }
      this.questions++;
      if (this.questions > 1) {
        return this.drop(sentence, "second_question", "only one question per reply");
      }
    }
    return sentence;
  }
}

export function guardReply(
  text: string,
  s: ConversationState,
  facts: { knownPrices: number[] },
): GuardResult {
  const g = new ReplyGuard(s, facts);
  const kept = splitSentences(text)
    .map((x) => g.check(x))
    .filter((x): x is string => x !== null);
  return { text: kept.join("").trim(), removed: g.removed };
}

/* ------------------------------------------------------------------ */
/* Fixed phrases (used when a guarded reply would otherwise be empty)  */
/* ------------------------------------------------------------------ */

type Phrases = Record<
  | "intent"
  | "service"
  | "date"
  | "time"
  | "customerName"
  | "phone"
  | "notYetBooked"
  | "checking"
  | "bookingFailed"
  | "slotTaken"
  | "goodbye"
  | "noneFree",
  string
>;

/** The last sentence of a production line ("Hello, thanks for calling X. How can I help?" -> "How can I help?"). */
function lastSentence(text: string): string {
  const parts = text.match(/[^.!?।]+[.!?।]+/g) ?? [text];
  return (parts[parts.length - 1] ?? text).trim();
}

/**
 * The fixed lines for the languages beyond English, Hindi and Telugu, taken
 * from the production runtime's own localized tables (never translated
 * here): the missing-detail questions (voice-intent-lexicon.ts), the
 * booking outcome lines (voice-call-outcomes.ts) and the fixed call lines
 * (voice-fallback-messages.ts).
 */
function productionPhrases(language: Exclude<LanguageCode, "en-IN">): Phrases {
  const q = MISSING_DETAIL_QUESTION[language];
  const line = (key: Parameters<typeof callOutcomeLine>[1]) => callOutcomeLine(language, key) ?? "";
  return {
    intent: lastSentence(localizedFallback("defaultGreeting", language, "")),
    service: q.service,
    date: q.date,
    time: q.time,
    customerName: q.name,
    phone: q.phone,
    notYetBooked: line("notBookedYet"),
    checking: localizedFallback("checkingNow", language),
    bookingFailed: line("bookingFailed"),
    slotTaken: line("bookingSlotTaken"),
    goodbye: lastSentence(localizedFallback("farewell", language, "")),
    noneFree: line("slotUnavailableNoneThatDay"),
  };
}

const CORE_PHRASES: Record<"en-IN" | "hi-IN" | "te-IN", Phrases> = {
  "en-IN": {
    intent: "How can I help you today?",
    service: "Which service would you like to book?",
    date: "Which day would you like to come in?",
    time: "What time would suit you?",
    customerName: "May I have your name, please?",
    phone: "What is the best phone number to reach you?",
    notYetBooked: "I haven't booked it yet.",
    checking: "Let me check the calendar.",
    bookingFailed: "I couldn't complete the booking just now, so nothing has been booked yet.",
    slotTaken: "That time was just taken, so it isn't booked.",
    goodbye: "Thank you for calling. Goodbye!",
    noneFree: "Nothing is free at that time. Which other day or time would suit you?",
  },
  "hi-IN": {
    intent: "मैं आपकी क्या मदद कर सकती हूँ?",
    service: "आप कौन सी सर्विस बुक करना चाहेंगे?",
    date: "आप किस दिन आना चाहेंगे?",
    time: "आपको कौन सा समय ठीक रहेगा?",
    customerName: "आपका नाम क्या है?",
    phone: "आपसे संपर्क के लिए कौन सा नंबर सही रहेगा?",
    notYetBooked: "अभी तक बुकिंग नहीं हुई है।",
    checking: "मैं कैलेंडर देख रही हूँ।",
    bookingFailed: "अभी बुकिंग पूरी नहीं हो पाई, इसलिए कुछ भी बुक नहीं हुआ है।",
    slotTaken: "वह समय अभी किसी और ने ले लिया, इसलिए बुक नहीं हुआ।",
    goodbye: "कॉल करने के लिए धन्यवाद। नमस्ते!",
    noneFree: "उस समय कुछ खाली नहीं है। कोई और दिन या समय बताइए?",
  },
  "te-IN": {
    intent: "నేను మీకు ఎలా సహాయం చేయగలను?",
    service: "మీరు ఏ సర్వీస్ బుక్ చేయాలనుకుంటున్నారు?",
    date: "మీరు ఏ రోజు రావాలనుకుంటున్నారు?",
    time: "మీకు ఏ సమయం సరిపోతుంది?",
    customerName: "మీ పేరు చెప్తారా?",
    phone: "మిమ్మల్ని సంప్రదించడానికి ఏ నంబర్ సరైనది?",
    notYetBooked: "ఇంకా బుక్ చేయలేదు.",
    checking: "క్యాలెండర్ చూస్తున్నాను.",
    bookingFailed: "ఇప్పుడు బుకింగ్ పూర్తి కాలేదు, కాబట్టి ఇంకా ఏదీ బుక్ కాలేదు.",
    slotTaken: "ఆ సమయం ఇప్పుడే వేరొకరు తీసుకున్నారు, కాబట్టి బుక్ కాలేదు.",
    goodbye: "ఫోన్ చేసినందుకు ధన్యవాదాలు. నమస్కారం!",
    noneFree: "ఆ సమయంలో ఏదీ ఖాళీగా లేదు. వేరే రోజు లేదా సమయం చెప్తారా?",
  },
};

/** Fixed lines in every supported language: hand-written for en/hi/te, production lines for the rest. */
export const PHRASES: Record<LanguageCode, Phrases> = Object.fromEntries(
  VOICE_LANGUAGE_CODES.map((code) => [
    code,
    code === "en-IN" || code === "hi-IN" || code === "te-IN"
      ? CORE_PHRASES[code]
      : productionPhrases(code),
  ]),
) as Record<LanguageCode, Phrases>;

export function slotList(s: ConversationState): string {
  return s.booking.offered.map((o) => spokenTime(o.hhmm)).join(", ");
}
