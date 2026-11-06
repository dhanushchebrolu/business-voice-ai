/**
 * Date/time understanding regressions found by the live Sarvam STT run
 * (speech-live-2-stt). Each bug is pinned with the real transcript that
 * exposed it, then with the neighbouring forms the fix must also cover.
 *
 *  1. minutes lost: "चार बजकर तीस मिनट" / "నాలుగు గంటల ముప్పై నిమిషాలకి" -> 16:00
 *  2. "11:00 AM" read as midnight (the digit joiner made it "11 00 AM")
 *  3. "15 November" read as the time 15:00
 *  4. weekdays written phonetically in Indic script ("मंडे", "ఫ్రైడే") unknown
 *  5. "eleven a.m." not read (punctuated AM)
 *
 * Business clock: Tuesday 3 November 2026, 10:00 Asia/Kolkata.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initializeLogger } from "@livekit/agents";
import { buildTools } from "../src/agent/receptionist.ts";
import { InMemoryBookingBackend } from "../src/backend/in-memory.ts";
import type { BookingBackend } from "../src/backend/types.ts";
import { findCalendarDates, findClocks } from "../src/conversation/datetime.ts";
import {
  agentSaid,
  applyReading,
  newConversation,
  nextStep,
  requestProblem,
  type BusinessContext,
  type ConversationState,
} from "../src/conversation/state.ts";
import {
  readDate,
  readTime,
  readUtterance,
  type ServiceRow,
  type TimeSpec,
} from "../src/conversation/understanding.ts";

initializeLogger({ pretty: false, level: "error" });

const SERVICES: ServiceRow[] = [
  { id: "svc-cleaning", name: "Cleaning", aliases: ["క్లీనింగ్", "क्लीनिंग"], durationMinutes: 30 },
];
const ctx: BusinessContext = {
  businessName: "Smile Dental",
  timeZone: "Asia/Kolkata",
  services: SERVICES,
  now: () => new Date("2026-11-03T04:30:00Z"), // Tuesday 3 Nov 2026, 10:00 IST
};

const read = (t: string) => readUtterance(t, { catalog: SERVICES });
const exact = (hhmm: string): TimeSpec => ({ kind: "exact", hhmm });
function time(t: string) {
  const r = read(t);
  return r.time
    ? { spec: r.time.spec, certainty: r.time.certainty, alt: r.time.alternatives }
    : { spec: null, unclear: r.timeUnclear };
}
function call(): ConversationState {
  return newConversation({ callId: "c1", callerId: "+919876543210", primaryLanguage: "en-IN" });
}
function say(s: ConversationState, text: string) {
  applyReading(s, read(text), ctx);
  return nextStep(s);
}
const spoken = (s: ConversationState) => agentSaid(s, nextStep(s), { interrupted: false });
/** "ढ़" as one code point (U+095D) and as ढ + nukta (U+0922 U+093C): STT emits both. */
const precomposed = (t: string) => t.replaceAll("ढ़", "ढ़");
const decomposed = (t: string) => t.replaceAll("ढ़", "ढ़");

/* ------------------------------------------------------------------ */

describe("bug 1: spoken minutes are kept", () => {
  test("live transcripts: Hindi बजकर…मिनट and Telugu గంటల…నిమిషాలకి in the evening -> 16:30", () => {
    for (const t of [
      "मुझे कल evening चार बजकर तीस मिनट पर cleaning appointment चाहिए",
      "मुझे कल evening चार बजकर तीस मिनट पर clean appointment चाहिए।",
      "నాకు రేపు ఈవెనింగ్ నాలుగు గంటల ముప్పై నిమిషాలకి క్లీనింగ్ అపాయింట్మెంట్ కావాలి.",
      "నాకు రేపు evening నాలుగు గంటల ముప్పై నిమిషాలకు cleaning appointment కావాలి.",
    ]) {
      assert.deepEqual(time(t), { spec: exact("16:30"), certainty: "explicit", alt: [] }, t);
    }
  });

  test("the period decides AM/PM; without one the clinic reading is inferred and the other kept", () => {
    assert.deepEqual(time("सुबह चार बजकर तीस मिनट").spec, exact("04:30"));
    assert.deepEqual(time("चार बजकर तीस मिनट पर"), {
      spec: exact("16:30"),
      certainty: "inferred",
      alt: [exact("04:30")],
    });
    assert.deepEqual(time("दस बजकर पंद्रह मिनट सुबह").spec, exact("10:15"));
    assert.deepEqual(time("4 बजकर 45 मिनट शाम को").spec, exact("16:45"));
    assert.deepEqual(time("सुबह 9 बज कर 5 मिनट").spec, exact("09:05"));
    assert.deepEqual(time("char baj kar tees minute shaam").spec, exact("16:30"));
    assert.deepEqual(time("సాయంత్రం 4 గంటల 30 నిమిషాలకు").spec, exact("16:30"));
    assert.deepEqual(time("ఉదయం పది గంటల ఇరవై ఐదు నిమిషాలకు").spec, exact("10:25"));
  });

  test("fractions: साढ़े/सवा/पौने/डेढ़/ढाई and Telugu -న్నర/-ంపావు/-ముప్పావు", () => {
    const cases: Array<[string, string]> = [
      ["मुझे कल शाम साढ़े चार बजे क्लीनिंग करवानी है।", "16:30"],
      ["शाम सवा पांच बजे", "17:15"],
      ["शाम पौने पांच बजे", "16:45"],
      ["दोपहर पौने एक बजे", "12:45"],
      ["दोपहर डेढ़ बजे", "13:30"],
      ["दोपहर ढाई बजे", "14:30"],
      ["kal shaam saadhe chaar baje", "16:30"],
      ["నాకు రేపు సాయంత్రం నాలుగున్నర గంటలకు క్లీనింగ్", "16:30"],
      ["సాయంత్రం ఐదున్నరకు", "17:30"],
      ["ఉదయం పదిన్నర గంటలకు", "10:30"],
      ["సాయంత్రం నాలుగుంపావుకు", "16:15"],
      ["సాయంత్రం నాలుగుమ్ముప్పావుకు", "16:45"],
      ["repu saayantram naalugunnara gantalaku", "16:30"],
    ];
    for (const [t, want] of cases) assert.deepEqual(time(t).spec, exact(want), t);
  });

  test("साढ़े reads the same in both Unicode encodings of ढ़", () => {
    const t = "मुझे कल शाम साढ़े चार बजे क्लीनिंग करवानी है।";
    assert.deepEqual(time(precomposed(t)).spec, exact("16:30"));
    assert.deepEqual(time(decomposed(t)).spec, exact("16:30"));
  });

  test("English: digits and words with minutes", () => {
    const cases: Array<[string, string]> = [
      ["I would like to book a cleaning tomorrow at 4:30 PM.", "16:30"],
      ["I would like to book a cleaning tomorrow at 4:30 p.m.", "16:30"],
      ["at four thirty pm", "16:30"],
      ["half past four in the evening", "16:30"],
      ["quarter past ten in the morning", "10:15"],
      ["quarter to five pm", "16:45"],
      ["ten oh five am", "10:05"],
      ["eleven forty-five am", "11:45"],
      ["నాకు రేపు సాయంత్రం 4.30 గంటలకు cleaning", "16:30"],
    ];
    for (const [t, want] of cases) assert.deepEqual(time(t).spec, exact(want), t);
  });
});

describe("bug 2: '11:00 AM' is 11 in the morning, never midnight", () => {
  test("live transcripts", () => {
    assert.deepEqual(time("Is 11:00 AM available on Monday?"), {
      spec: exact("11:00"),
      certainty: "explicit",
      alt: [],
    });
    assert.deepEqual(time("సోమవారం ఉదయం 11:00 AM-కు ఖాళీ ఉందా?").spec, exact("11:00"));
  });

  test("the transcript text keeps the clock (the digit joiner no longer splits it)", () => {
    assert.equal(read("Is 11:00 AM available?").text, "Is 11:00 AM available?");
    assert.equal(read("at 4.30 pm").text, "at 4:30 pm");
  });

  test("12-hour and 24-hour clocks, noon and midnight", () => {
    const cases: Array<[string, string, string]> = [
      ["11:00 PM", "23:00", "explicit"],
      ["12:00 AM", "00:00", "explicit"],
      ["12:00 PM", "12:00", "explicit"],
      ["12:30 am", "00:30", "explicit"],
      ["00:00", "00:00", "explicit"],
      ["at 16:30", "16:30", "explicit"],
      ["at 09:30", "09:30", "explicit"],
      ["at 10:15", "10:15", "inferred"],
      ["12 noon", "12:00", "explicit"],
      ["12 midnight", "00:00", "explicit"],
      ["at midnight", "00:00", "explicit"],
      ["रात 12 बजे", "00:00", "explicit"],
      ["12:30 at night", "00:30", "explicit"],
      ["रात 2 बजे", "02:00", "explicit"],
      ["रात 9 बजे", "21:00", "explicit"],
    ];
    for (const [t, want, certainty] of cases) {
      const r = time(t);
      assert.deepEqual(
        [r.spec, "certainty" in r ? r.certainty : null],
        [exact(want), certainty],
        t,
      );
    }
  });

  test("a bare 12 is still a question (noon or midnight)", () => {
    assert.deepEqual(time("at 12"), {
      spec: exact("12:00"),
      certainty: "uncertain",
      alt: [exact("00:00")],
    });
  });

  test("phone numbers are still digits, not clocks", () => {
    const r = read("my number is 98480 12345");
    assert.equal(r.phoneDigits, "9848012345");
    assert.equal(r.time, null);
  });
});

describe("bug 3: a day of the month is a date, not a time", () => {
  test("live transcripts: no time, a calendar date, the weekday kept as a cross-check", () => {
    for (const t of [
      "Can I come on Friday the 15th of November?",
      "Can I come on Friday, the 15th of November?",
      "क्या मैं शुक्रवार पंद्रह नवंबर को आ सकता हूँ",
      "क्या मैं फ्राइडे पंद्रह नवंबर को आ सकता हूँ",
      "क्या मैं Friday 15 November को आ सकता हूँ?",
      "నేను శుక్రవారం నవంబర్ పదిహేనో తేదీన రావచ్చా?",
      "నేను ఫ్రైడే నవంబర్ పదిహేనున రావచ్చా?",
      "నేను Friday November 15న రావచ్చా?",
    ]) {
      const r = read(t);
      assert.equal(r.time, null, t);
      assert.deepEqual(r.date?.value, { kind: "calendar", day: 15, month: 11, year: null }, t);
      assert.deepEqual(r.date?.crossCheck, [{ kind: "weekday", weekday: 5, qualifier: null }], t);
    }
  });

  test("forms: day-month, month-day, ordinals, year, day only", () => {
    const cases: Array<[string, { day: number; month: number | null; year: number | null }]> = [
      ["15 November", { day: 15, month: 11, year: null }],
      ["November 15th", { day: 15, month: 11, year: null }],
      ["Nov 15", { day: 15, month: 11, year: null }],
      ["on the twenty-first of December", { day: 21, month: 12, year: null }],
      ["15 November 2027", { day: 15, month: 11, year: 2027 }],
      ["15 नवंबर को", { day: 15, month: 11, year: null }],
      ["नवम्बर पंद्रह", { day: 15, month: 11, year: null }],
      ["నవంబర్ 15న", { day: 15, month: 11, year: null }],
      ["డిసెంబర్ ఇరవై ఐదో తేదీ", { day: 25, month: 12, year: null }],
      ["on the 20th", { day: 20, month: null, year: null }],
      ["20 तारीख को", { day: 20, month: null, year: null }],
      ["20 తేదీన", { day: 20, month: null, year: null }],
    ];
    for (const [t, want] of cases) {
      const r = read(t);
      assert.deepEqual(r.date?.value, { kind: "calendar", ...want }, t);
      assert.equal(r.time, null, t);
    }
  });

  test("a date and a time together are both read", () => {
    const r = read("15 November at 4:30 PM");
    assert.deepEqual(r.date?.value, { kind: "calendar", day: 15, month: 11, year: null });
    assert.deepEqual(r.time?.spec, exact("16:30"));
    const h = read("पंद्रह नवंबर शाम चार बजे");
    assert.deepEqual(h.time?.spec, exact("16:00"));
    const m = read("4 May at 5 pm");
    assert.deepEqual(m.date?.value, { kind: "calendar", day: 4, month: 5, year: null });
    assert.deepEqual(m.time?.spec, exact("17:00"));
  });

  test("not dates: 'may' the verb, a time with a month-like word nearby", () => {
    assert.equal(read("I may come at 5 pm").date, null);
    assert.deepEqual(read("I may come at 5 pm").time?.spec, exact("17:00"));
  });

  test("a bare 13..23 with no clock marker could be a day: asked, not assumed", () => {
    assert.equal(time("15 को").certainty, "uncertain");
    assert.equal(time("15 बजे").certainty, "explicit");
  });

  test("impossible dates are reported, never resolved", () => {
    for (const t of ["the 31st of February", "31 नवंबर", "30 February 2027", "45 November"]) {
      const r = read(t);
      assert.equal(r.date, null, t);
      assert.ok(r.dateUnclear, t);
    }
  });
});

describe("bug 4: weekdays written phonetically in Indic script", () => {
  test("live transcripts", () => {
    assert.deepEqual(read("क्या मंडे को ग्यारह बजे का स्लॉट फ्री है").date?.value, {
      kind: "weekday",
      weekday: 1,
      qualifier: null,
    });
    assert.deepEqual(read("మండే పదకొండు గంటలకు కుకీస్ స్లాట్ ఫ్రీ ఉందా?").date?.value, {
      kind: "weekday",
      weekday: 1,
      qualifier: null,
    });
  });

  test("every day, both scripts, with and without zero-width joiners", () => {
    const cases: Array<[string, number]> = [
      ["संडे", 0],
      ["సండే", 0],
      ["मंडे", 1],
      ["ट्यूज़डे", 2],
      [decomposed("ट्यूज़डे").replaceAll("ज़", "ज़"), 2],
      ["ట్యూస్\u200cడే", 2],
      ["వెడ్నెస్డే", 3],
      ["वेडनेसडे", 3],
      ["थर्सडे", 4],
      ["థర్స్డే", 4],
      ["फ्राइडे", 5],
      ["ఫ్రైడే", 5],
      ["सैटरडे", 6],
      ["శాటర్డే", 6],
    ];
    for (const [t, wd] of cases) {
      const d = readDate(t);
      assert.equal(d?.value.kind === "weekday" && d.value.weekday, wd, t);
    }
  });

  test("next / this / last, in each language", () => {
    assert.deepEqual(readDate("अगले मंडे")?.value, {
      kind: "weekday",
      weekday: 1,
      qualifier: "next",
    });
    assert.deepEqual(readDate("నెక్స్ట్ ఫ్రైడే")?.value, {
      kind: "weekday",
      weekday: 5,
      qualifier: "next",
    });
    assert.deepEqual(readDate("this Friday")?.value, {
      kind: "weekday",
      weekday: 5,
      qualifier: "this",
    });
    // "is" opens a question in English; it is not "this".
    assert.deepEqual(readDate("Is Monday free?")?.value, {
      kind: "weekday",
      weekday: 1,
      qualifier: null,
    });
    const last = read("last Monday");
    assert.equal(last.date, null);
    assert.ok(last.dateUnclear);
  });

  test("two weekdays: a negated one is dropped, otherwise the caller chooses", () => {
    assert.deepEqual(readDate("मंडे नहीं, ट्यूज़डे")?.value, {
      kind: "weekday",
      weekday: 2,
      qualifier: null,
    });
    assert.deepEqual(readDate("not Monday, Tuesday")?.value, {
      kind: "weekday",
      weekday: 2,
      qualifier: null,
    });
    assert.deepEqual(readDate("సోమవారం కాదు, మంగళవారం")?.value, {
      kind: "weekday",
      weekday: 2,
      qualifier: null,
    });
    const either = read("Monday or Tuesday");
    assert.equal(either.date?.certainty, "uncertain");
    const s = call();
    const step = say(s, "cleaning Monday or Tuesday at 4 PM");
    assert.equal(step.kind, "clarify");
    assert.equal(step.kind === "clarify" && step.slot, "date");
  });

  test("today's weekday said bare is today or a week on: asked", () => {
    const s = call();
    say(s, "cleaning ట్యూస్డే 4 PM");
    assert.equal(s.date?.provenance, "uncertain");
    assert.deepEqual(
      [s.date?.value, ...(s.date?.alternatives ?? [])],
      ["2026-11-03", "2026-11-10"],
    );
  });
});

describe("bug 5: punctuated AM/PM", () => {
  test("live transcript: 'eleven a.m.'", () => {
    assert.deepEqual(time("Is eleven a.m. available on Monday?"), {
      spec: exact("11:00"),
      certainty: "explicit",
      alt: [],
    });
  });

  test("spellings of AM/PM", () => {
    const cases: Array<[string, string]> = [
      ["eleven A.M.", "11:00"],
      ["at 11 a. m.", "11:00"],
      ["four p.m.", "16:00"],
      ["at 4 P.M.", "16:00"],
      ["4pm", "16:00"],
      ["11AM", "11:00"],
      ["ग्यारह बजे एएम", "11:00"],
      ["4 बजे पीएम", "16:00"],
      ["11 ఏఎం", "11:00"],
    ];
    for (const [t, want] of cases) assert.deepEqual(time(t).spec, exact(want), t);
  });

  test("'am' only counts next to a clock: 'I am free at 4' is not 4 AM", () => {
    assert.deepEqual(time("I am free at 4"), {
      spec: exact("16:00"),
      certainty: "inferred",
      alt: [exact("04:00")],
    });
  });
});

describe("malformed and contradictory times are never guessed", () => {
  test("reported as unclear", () => {
    for (const t of [
      "at 16:30 AM",
      "13 PM",
      "at 4:75",
      "at 25:00",
      "8 am in the evening",
      "10 pm in the morning",
      "शाम 9 बजे एएम",
      "4:5 PM",
      "at 4:75 or 5 pm",
      "25:00 or 26:00, whichever",
    ]) {
      const r = read(t);
      assert.equal(r.time, null, t);
      assert.ok(r.timeUnclear, t);
    }
  });

  test("an unclear new time removes the old one and any chosen slot", () => {
    const s = call();
    say(s, "cleaning tomorrow at 4 PM");
    s.booking.offered = [{ hhmm: "16:00", startIso: "2026-11-04T10:30:00.000Z" }];
    s.booking.status = "slots_offered";
    const step = say(s, "actually make it 16:30 AM");
    assert.equal(s.time, null);
    assert.equal(s.booking.status, "none");
    assert.deepEqual(s.booking.offered, []);
    assert.deepEqual(step, { kind: "ask", slot: "time" });
  });

  test("quantities are not clocks", () => {
    for (const t of [
      "it costs 20 rupees",
      "in 20 minutes",
      "₹500",
      "for 2 people",
      "ek minute",
      "२ घंटे लगेंगे",
    ]) {
      assert.equal(read(t).time, null, t);
      assert.equal(read(t).timeUnclear, null, t);
    }
    assert.deepEqual(findClocks("in 4.5 hours"), []);
  });

  test("negation keeps the time the caller wants", () => {
    assert.deepEqual(time("not 4:30, 5:30 PM").spec, exact("17:30"));
    assert.deepEqual(time("4:30 नहीं, शाम 5 बजे").spec, exact("17:00"));
    assert.deepEqual(time("సాయంత్రం 4:30 కాదు, 5:30").spec, exact("17:30"));
    assert.deepEqual(time("साढ़े चार नहीं, शाम पांच बजे").spec, exact("17:00"));
  });

  test("two times: still a choice for the caller", () => {
    assert.deepEqual(time("2 or 3 PM"), {
      spec: exact("14:00"),
      certainty: "uncertain",
      alt: [exact("15:00")],
    });
    assert.deepEqual(time("4:30 or 5 pm, whichever is free").spec, {
      kind: "anyOf",
      hhmms: ["16:30", "17:00"],
    });
  });
});

describe("dates resolve in the business calendar and are clarified when they disagree", () => {
  test("15 November -> 2026-11-15; matching weekday confirms it", () => {
    const s = call();
    say(s, "cleaning on 15 November at 4 PM");
    assert.deepEqual([s.date?.value, s.date?.provenance], ["2026-11-15", "explicit"]);
    const t = call();
    say(t, "cleaning on Sunday 15 November at 4 PM");
    assert.deepEqual([t.date?.value, t.date?.provenance], ["2026-11-15", "explicit"]);
  });

  test("'Friday 15 November' (the 15th is a Sunday): asked, with the nearest Friday", () => {
    for (const t of [
      "Can I come on Friday the 15th of November? cleaning",
      "क्या मैं फ्राइडे पंद्रह नवंबर को आ सकता हूँ? क्लीनिंग",
      "నేను ఫ్రైడే నవంబర్ పదిహేనున రావచ్చా? క్లీనింగ్",
    ]) {
      const s = call();
      const step = say(s, t);
      assert.equal(s.date?.provenance, "uncertain", t);
      assert.deepEqual(
        [s.date?.value, ...(s.date?.alternatives ?? [])],
        ["2026-11-15", "2026-11-13"],
        t,
      );
      assert.deepEqual(step, {
        kind: "clarify",
        slot: "date",
        options: ["Sunday 15 November 2026", "Friday 13 November 2026"],
      });
    }
  });

  test("relative day and weekday: agreeing is settled, disagreeing is asked", () => {
    const s = call();
    say(s, "cleaning tomorrow Wednesday 4 PM");
    assert.deepEqual([s.date?.value, s.date?.provenance], ["2026-11-04", "explicit"]);
    const t = call();
    say(t, "cleaning tomorrow Friday 4 PM");
    assert.equal(t.date?.provenance, "uncertain");
    assert.deepEqual(
      [t.date?.value, ...(t.date?.alternatives ?? [])],
      ["2026-11-04", "2026-11-06"],
    );
  });

  test("a weekday with a day of the month settles today's-weekday ambiguity", () => {
    const s = call();
    say(s, "cleaning Tuesday the 10th 4 PM");
    assert.deepEqual([s.date?.value, s.date?.provenance], ["2026-11-10", "explicit"]);
  });

  test("a day that has passed this year: next year's is asked, then accepted on yes", () => {
    const s = call();
    const step = say(s, "cleaning on 1 November at 4 PM");
    assert.deepEqual([s.date?.value, s.date?.provenance], ["2027-11-01", "uncertain"]);
    assert.deepEqual(step, { kind: "clarify", slot: "date", options: ["Monday 1 November 2027"] });
    spoken(s);
    say(s, "yes");
    assert.equal(s.date?.provenance, "explicit");
  });

  test("a plain yes does not pick between two dates", () => {
    const s = call();
    say(s, "cleaning Monday or Tuesday at 4 PM");
    spoken(s);
    say(s, "yes");
    assert.equal(s.date?.provenance, "uncertain");
  });

  test("an explicit past date is never kept", () => {
    const s = call();
    const step = say(s, "cleaning on 15 November 2025 at 4 PM");
    assert.equal(s.date, null);
    assert.deepEqual(step, { kind: "ask", slot: "date" });
  });

  test("the 2nd, said on the 3rd, is next month's 2nd", () => {
    const s = call();
    say(s, "cleaning on the 2nd at 4 PM");
    assert.deepEqual([s.date?.value, s.date?.provenance], ["2026-12-02", "inferred"]);
  });

  test("an impossible date while answering the date question clears the old day", () => {
    const s = call();
    say(s, "cleaning tomorrow at 4 PM");
    s.lastQuestion = "date";
    say(s, "the 31st of February");
    assert.equal(s.date, null);
  });

  test("an unrelated past mention does not wipe a good date", () => {
    const s = call();
    say(s, "cleaning tomorrow at 4 PM");
    say(s, "I came here last Monday too");
    assert.equal(s.date?.value, "2026-11-04");
  });

  test("the live code-mixed appointment request becomes tomorrow 16:30", () => {
    const s = call();
    say(s, "मुझे कल evening चार बजकर तीस मिनट पर cleaning appointment चाहिए");
    assert.equal(s.date?.value, "2026-11-04");
    assert.deepEqual(s.time?.value, exact("16:30"));
    assert.equal(s.time?.provenance, "explicit");
  });
});

describe("no wrong date or time reaches the calendar", () => {
  test("requestProblem rejects unreal or past dates and invalid clocks", () => {
    assert.equal(requestProblem("2026-11-04", exact("16:30"), ctx), null);
    assert.match(requestProblem("2026-11-02", exact("16:30"), ctx)!, /passed/);
    assert.match(requestProblem("2027-02-30", exact("16:30"), ctx)!, /not a real date/);
    assert.match(requestProblem("2026-13-01", exact("16:30"), ctx)!, /not a real date/);
    assert.match(requestProblem("2026-11-04", exact("24:00"), ctx)!, /not a valid/);
    assert.match(requestProblem("2026-11-04", exact("16:60"), ctx)!, /not a valid/);
    assert.match(
      requestProblem("2026-11-04", { kind: "anyOf", hhmms: ["16:00", "4pm"] }, ctx)!,
      /not a valid/,
    );
    assert.equal(requestProblem("2026-11-04", { kind: "period", period: "evening" }, ctx), null);
  });

  test("check_availability refuses a past date without calling the backend", async () => {
    const s = call();
    say(s, "cleaning tomorrow at 4 PM");
    s.date = { ...s.date!, value: "2026-11-01" };
    let calls = 0;
    const backend: BookingBackend = {
      checkAvailability: async () => (calls++, { ok: true, slots: [] }),
      book: async () => {
        throw new Error("no booking");
      },
    };
    const tools = buildTools({ business: ctx, backend, state: s }, new Set());
    const r = String(await tools.check_availability.execute({}, { toolCallId: "t" } as never));
    assert.match(r, /^NOT_READY: the date has already passed/);
    assert.equal(calls, 0);
  });

  test("the Hindi live request books the 16:30 slot, not 16:00", async () => {
    const s = call();
    say(s, "मुझे कल evening चार बजकर तीस मिनट पर cleaning appointment चाहिए");
    const backend = new InMemoryBookingBackend({
      timeZoneOffset: "+05:30",
      openHours: ["16:00", "16:30", "17:00"],
      callId: "c1",
    });
    const tools = buildTools({ business: ctx, backend, state: s }, new Set());
    const r = String(await tools.check_availability.execute({}, { toolCallId: "t" } as never));
    assert.match(r, /^AVAILABLE: 4:30 PM is free/);
    assert.deepEqual(
      s.booking.offered.map((o) => o.hhmm),
      ["16:30"],
    );
  });

  test("an uncertain date never reaches the calendar", async () => {
    const s = call();
    say(s, "Can I come on Friday the 15th of November for a cleaning at 4 PM?");
    const tools = buildTools(
      {
        business: ctx,
        backend: {
          checkAvailability: async () => {
            throw new Error("must not be called");
          },
          book: async () => {
            throw new Error("must not be called");
          },
        },
        state: s,
      },
      new Set(),
    );
    const r = String(await tools.check_availability.execute({}, { toolCallId: "t" } as never));
    assert.match(r, /^NOT_READY/);
  });
});

describe("internals", () => {
  test("date spans are found once, with positions", () => {
    const d = findCalendarDates("come on 15 November at 4");
    assert.equal(d.length, 1);
    assert.equal(d[0]!.raw, "15 November");
    assert.equal(readTime("come on 15 November at 4")?.evidence, "4");
  });
});
