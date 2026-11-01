/**
 * Last line of defence between the model and the caller's ear. The model is
 * prompted with the state, but prompts are not guarantees; these checks are.
 * Each spoken sentence is checked against the state and dropped if it:
 *   - claims a booking succeeded before the backend confirmed it;
 *   - says a time is free that the calendar did not offer;
 *   - quotes a price the backend did not provide;
 *   - is a second question in the same reply (one question at a time).
 */
import { spokenTime, type ConversationState } from "./state.ts";
import type { LanguageCode } from "./understanding.ts";

const BOOKED_CLAIM =
  /\b(?:(?:is|has been|have been|got|been|are)\s+(?:booked|confirmed|scheduled|reserved)|booking is (?:done|confirmed|complete)|i(?:'ve| have) (?:booked|scheduled|confirmed)|you(?:'re| are) (?:all )?(?:set|booked))\b|बुक\s*(?:हो\s*गया|हो\s*गई|कर\s*दिया|कर\s*दी)|कन्फर्म\s*(?:हो\s*गया|कर\s*दिया)|बुक\s*हो\s*चुका|బుక్\s*(?:అయింది|చేశాను|చేసాను|అయిపోయింది)|కన్ఫర్మ్\s*(?:అయింది|చేశాను)|నమోదు\s*చేశాను/i;
const AVAILABLE_CLAIM =
  /\b(?:available|free|open)\b|खाली\s*है|उपलब्ध\s*है|ఖాళీగా\s*ఉంది|అందుబాటులో\s*ఉంది/i;
const PRICE =
  /(?:₹|rs\.?|inr|rupees?|रुपये|रुपए|రూపాయలు)\s*([\d,]+)|([\d,]+)\s*(?:₹|rs\.?|rupees?|रुपये|रुपए|రూపాయలు)/i;
const CLOCK = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/gi;

export function splitSentences(text: string): string[] {
  return text.match(/[^.!?।\n]+[.!?।\n]*/g)?.map((s) => s) ?? [];
}

function clocksIn(sentence: string): string[] {
  const out: string[] = [];
  for (const m of sentence.matchAll(CLOCK)) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    const pm = /p/i.test(m[3]!);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    out.push(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
  }
  return out;
}

export interface GuardResult {
  text: string;
  removed: Array<{
    sentence: string;
    rule:
      "premature_booking_claim" | "unoffered_availability" | "unbacked_price" | "second_question";
  }>;
}

/** Checks one reply sentence by sentence, so it can run on a token stream. */
export class ReplyGuard {
  readonly removed: GuardResult["removed"] = [];
  private questions = 0;
  private readonly s: ConversationState;
  private readonly facts: { knownPrices: number[] };
  constructor(s: ConversationState, facts: { knownPrices: number[] }) {
    this.s = s;
    this.facts = facts;
  }

  /** The sentence to speak, or null when it must not be spoken. */
  check(sentence: string): string | null {
    const s = this.s;
    if (BOOKED_CLAIM.test(sentence) && s.booking.status !== "confirmed") {
      this.removed.push({ sentence, rule: "premature_booking_claim" });
      return null;
    }
    if (AVAILABLE_CLAIM.test(sentence)) {
      const offered = new Set(s.booking.offered.map((o) => o.hhmm));
      const named = clocksIn(sentence);
      if (named.length ? named.some((t) => !offered.has(t)) : offered.size === 0) {
        this.removed.push({ sentence, rule: "unoffered_availability" });
        return null;
      }
    }
    const price = sentence.match(PRICE);
    if (price) {
      const n = Number((price[1] ?? price[2] ?? "").replace(/,/g, ""));
      if (!this.facts.knownPrices.includes(n)) {
        this.removed.push({ sentence, rule: "unbacked_price" });
        return null;
      }
    }
    if (/[?？]/.test(sentence)) {
      this.questions++;
      if (this.questions > 1) {
        this.removed.push({ sentence, rule: "second_question" });
        return null;
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
  | "slotTaken",
  string
>;

export const PHRASES: Record<LanguageCode, Phrases> = {
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
  },
};

export function slotList(s: ConversationState): string {
  return s.booking.offered.map((o) => spokenTime(o.hhmm)).join(", ");
}
