/**
 * Guard hardening: availability claims that name a time in words. Before
 * this, the guard only recognised digit times ("4 PM", "4 बजे"), so with 5 PM
 * on offer, "चार बजे खाली है" / "four PM is free" / "నాలుగు గంటలకు ఖాళీగా ఉంది"
 * passed unchecked. Times are now recognised as digits, number words
 * (English, Hindi, Telugu, script and romanized), Hindi/Telugu fractions and
 * named times, with AM/PM taken from the unit or the period word.
 * States come from the real check_availability tool against stub calendars.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildTools } from "../src/agent/receptionist.ts";
import type { AvailabilityResult, BookingBackend } from "../src/backend/types.ts";
import { ReplyGuard, clocksIn } from "../src/conversation/guard.ts";
import {
  applyReading,
  newConversation,
  type BusinessContext,
  type ConversationState,
} from "../src/conversation/state.ts";
import { readUtterance, type ServiceRow } from "../src/conversation/understanding.ts";

const SERVICES: ServiceRow[] = [
  { id: "svc-cleaning", name: "Cleaning", aliases: ["క్లీనింగ్", "क्लीनिंग"], durationMinutes: 30 },
];
const ctx: BusinessContext = {
  businessName: "Smile Dental",
  timeZone: "Asia/Kolkata",
  services: SERVICES,
  now: () => new Date("2026-11-02T04:30:00Z"), // Monday 10:00 IST
};
const slot = (hhmm: string) => {
  const start = new Date(`2026-11-03T${hhmm}:00+05:30`);
  return {
    startIso: start.toISOString(),
    endIso: new Date(start.getTime() + 1_800_000).toISOString(),
  };
};
async function afterCheck(request: string, result: AvailabilityResult | null) {
  const s = newConversation({ callId: "c1", callerId: "+919876543210", primaryLanguage: "en-IN" });
  applyReading(s, readUtterance(request, { catalog: SERVICES }), ctx);
  if (result) {
    const backend: BookingBackend = {
      checkAvailability: async () => result,
      book: async () => {
        throw new Error("not used");
      },
    };
    await buildTools({ business: ctx, backend, state: s }, new Set()).check_availability.execute(
      {},
      { toolCallId: "t" } as never,
    );
  }
  return s;
}
const verdict = (s: ConversationState, sentence: string) => {
  const g = new ReplyGuard(s, { knownPrices: [800] });
  const kept = g.check(sentence);
  return kept === null ? g.removed[0]!.rule : "kept";
};

describe("spoken times: recognition", () => {
  const cases: Array<[string, string[][]]> = [
    // English
    ["four PM is free", [["16:00"]]],
    ["four thirty PM", [["16:30"]]],
    ["half past four in the evening", [["16:30"]]],
    ["five in the evening", [["17:00"]]],
    ["eleven in the morning", [["11:00"]]],
    ["four o'clock", [["04:00", "16:00"]]],
    ["free at 5", [["05:00", "17:00"]]],
    ["12 noon", [["12:00"]]],
    ["midnight", [["00:00"]]],
    // Hindi (script, romanized, fractions, native digits)
    ["चार बजे खाली है", [["04:00", "16:00"]]],
    ["शाम चार बजे", [["16:00"]]],
    ["सुबह ग्यारह बजे", [["11:00"]]],
    ["शाम साढ़े चार बजे", [["16:30"]]],
    ["शाम सवा पांच बजे", [["17:15"]]],
    ["शाम पौने पांच बजे", [["16:45"]]],
    ["दोपहर ढाई बजे", [["14:30"]]],
    ["दोपहर डेढ़ बजे", [["13:30"]]],
    ["shaam char baje khali hai", [["16:00"]]],
    ["शाम ४ बजे", [["16:00"]]],
    // Telugu (script, romanized, న్నర, కి)
    ["సాయంత్రం నాలుగు గంటలకు", [["16:00"]]],
    ["సాయంత్రం నాలుగున్నర గంటలకు", [["16:30"]]],
    ["ఉదయం పదకొండు గంటలకు", [["11:00"]]],
    ["sayantram aidu gantalaku", [["17:00"]]],
    ["సాయంత్రం 4 కి ఖాళీ ఉంది", [["16:00"]]],
    ["సాయంత్రం ౪ గంటలకు", [["16:00"]]],
    // Code-mixed
    ["4 PM కి slot free గా ఉంది", [["16:00"]]],
    ["kal evening paanch baje available hai", [["17:00"]]],
    ["repu sayantram naalugu gantalaku free ga undi", [["16:00"]]],
  ];
  for (const [text, want] of cases) test(text, () => assert.deepEqual(clocksIn(text), want));

  test("numbers that are not times are ignored", () => {
    for (const t of [
      "ek minute",
      "do you want it",
      "yes that one",
      "2 slots are free",
      "only 1 slot left",
      "Cleaning costs ₹800",
      "please hold for 5 minutes",
    ])
      assert.deepEqual(clocksIn(t), [], t);
  });

  test("AM/PM: the unit beats the period word; a period word anywhere in the sentence decides; neither keeps both", () => {
    assert.deepEqual(clocksIn("in the morning? No, four PM"), [["16:00"]]);
    assert.deepEqual(clocksIn("चार बजे", "कल शाम चार बजे खाली है"), [["16:00"]]);
    assert.deepEqual(clocksIn("నాలుగు గంటలకు"), [["04:00", "16:00"]]);
    // Both period words present: genuinely ambiguous -> both readings...
    assert.deepEqual(clocksIn("morning or evening, four o'clock"), [["04:00", "16:00"]]);
    // ...unless the time carries its own period ("four in the evening").
    assert.deepEqual(clocksIn("not in the morning, four in the evening"), [["16:00"]]);
    assert.deepEqual(clocksIn("not in the evening, eleven in the morning"), [["11:00"]]);
  });
});

describe("spoken times: invented availability stays blocked (5 PM offered, 4 PM taken)", () => {
  const offered5 = () =>
    afterCheck("cleaning tomorrow at 4 or 5, either", { ok: true, slots: [slot("17:00")] });

  for (const s of [
    "four PM is free.",
    "Four o'clock is available.",
    "We have a slot at half past four.",
    "शाम चार बजे खाली है।",
    "शाम साढ़े चार बजे उपलब्ध है।",
    "shaam char baje khali hai.",
    "సాయంత్రం నాలుగు గంటలకు ఖాళీగా ఉంది.",
    "naalugu gantalaku free ga undi.",
    "సాయంత్రం 4 కి ఖాళీ ఉంది.",
    "We are free at 4.",
    "six in the evening is free.",
    "शाम छह बजे खाली है।",
  ])
    test(`blocked: ${s}`, async () => {
      assert.equal(verdict(await offered5(), s), "unoffered_availability");
    });

  for (const s of [
    "five PM is free.",
    "Five o'clock is available.",
    "शाम पांच बजे खाली है।",
    "shaam paanch baje khali hai.",
    "సాయంత్రం ఐదు గంటలకు ఖాళీగా ఉంది.",
    "aidu gantalaku free ga undi.",
    "We have 2 slots free, at five PM.",
  ])
    test(`allowed: ${s}`, async () => {
      assert.equal(verdict(await offered5(), s), "kept");
    });
});

describe("spoken times: 'not free' needs calendar evidence", () => {
  test("with evidence (4 PM taken): accepted in every language", async () => {
    const s = await afterCheck("cleaning tomorrow at 4 or 5, either", {
      ok: true,
      slots: [slot("17:00")],
    });
    for (const t of [
      "Sorry, four PM is not available.",
      "शाम चार बजे खाली नहीं है।",
      "shaam char baje khali nahi hai.",
      "సాయంత్రం నాలుగు గంటలకు ఖాళీ లేదు.",
      "naalugu gantalaku free ga ledu.",
      "4 PM available లేదు, five PM free గా ఉంది.",
      "शाम चार बजे उपलब्ध नहीं है, लेकिन पांच बजे खाली है।",
    ])
      assert.equal(verdict(s, t), "kept", t);
  });

  test("contradicting the calendar or never checked: refused", async () => {
    const s = await afterCheck("cleaning tomorrow at 4 or 5, either", {
      ok: true,
      slots: [slot("17:00")],
    });
    for (const t of [
      "five PM is not available.", // offered
      "शाम पांच बजे खाली नहीं है।", // offered
      "సాయంత్రం ఆరు గంటలకు ఖాళీ లేదు.", // 6 PM never asked about
      "six in the evening is fully booked.",
    ])
      assert.equal(verdict(s, t), "unverified_unavailability", t);
  });

  test("before any calendar answer, a 'not free' in words is refused", async () => {
    const s = await afterCheck("cleaning tomorrow at 4 PM", null);
    for (const t of [
      "four PM is not available.",
      "शाम चार बजे खाली नहीं है।",
      "నాలుగు గంటలకు ఖాళీ లేదు.",
    ])
      assert.equal(verdict(s, t), "unverified_unavailability", t);
  });

  test("empty calendar for the caller's times: 'not free' in words is accepted, 'free' is not", async () => {
    const s = await afterCheck("cleaning tomorrow at 4 or 5, either", { ok: true, slots: [] });
    assert.equal(verdict(s, "Neither four nor five PM is free."), "kept");
    assert.equal(verdict(s, "शाम चार और पांच बजे कुछ खाली नहीं है।"), "kept");
    assert.equal(verdict(s, "five PM is free."), "unoffered_availability");
  });
});
