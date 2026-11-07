/**
 * Phase 2.19 issue 1: relative dates. Every spoken day becomes a calendar
 * date in the business's time zone from the caller's words and the business
 * clock (state.ts resolveDateCandidates) — never from a model-generated date.
 * Genuinely ambiguous days are clarified; "tomorrow" is never silently today.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { initializeLogger, voice } from "@livekit/agents";
import { ReceptionistAgent } from "../src/agent/receptionist.ts";
import { InMemoryBookingBackend } from "../src/backend/in-memory.ts";
import type { BookingBackend } from "../src/backend/types.ts";
import {
  agentSaid,
  applyReading,
  newConversation,
  nextStep,
  resolveDateCandidates,
  stateSummary,
  type BusinessContext,
  type ConversationState,
} from "../src/conversation/state.ts";
import { readUtterance, type ServiceRow } from "../src/conversation/understanding.ts";

initializeLogger({ pretty: false, level: "error" });

const SERVICES: ServiceRow[] = [
  { id: "svc-cleaning", name: "Cleaning", aliases: ["క్లీనింగ్", "क्लीनिंग"], durationMinutes: 30 },
  { id: "svc-whitening", name: "Whitening", aliases: ["వైటెనింగ్"], durationMinutes: 45 },
];
/** The business clock at a given UTC instant (Asia/Kolkata = UTC+05:30 unless given). */
const at = (iso: string, timeZone = "Asia/Kolkata"): BusinessContext => ({
  businessName: "Smile Dental",
  timeZone,
  services: SERVICES,
  now: () => new Date(iso),
});
const MONDAY_10AM = at("2026-11-02T04:30:00Z"); // Monday 2 Nov 2026, 10:00 IST

function call(): ConversationState {
  return newConversation({ callId: "c1", callerId: "+919876543210", primaryLanguage: "en-IN" });
}
function say(s: ConversationState, text: string, ctx = MONDAY_10AM) {
  applyReading(s, readUtterance(text, { catalog: SERVICES }), ctx);
  return nextStep(s);
}
/** The date the caller's words resolve to, with its standing. */
function dateOf(text: string, ctx = MONDAY_10AM) {
  const s = call();
  say(s, text, ctx);
  return s.date
    ? { value: s.date.value, provenance: s.date.provenance, alternatives: s.date.alternatives }
    : null;
}

describe("dates: tomorrow in every language resolves to the business's tomorrow", () => {
  for (const [label, text, provenance] of [
    ["English", "cleaning tomorrow at 4 PM", "explicit"],
    ["Telugu script", "రేపు సాయంత్రం 4 గంటలకు క్లీనింగ్", "explicit"],
    ["Telugu romanized", "repu evening cleaning kavali", "explicit"],
    ["Telugu code-mixed", "repu 4 PM ki cleaning book cheyandi", "explicit"],
    ["Hindi script (kal: inferred)", "कल शाम चार बजे क्लीनिंग चाहिए", "inferred"],
    ["Hindi romanized (kal: inferred)", "kal shaam 4 baje cleaning", "inferred"],
    ["Hinglish", "kal evening 4 pm cleaning chahiye", "inferred"],
    ["English inside Telugu", "tomorrow morning క్లీనింగ్ కావాలి", "explicit"],
  ] as const) {
    test(`${label}: '${text}' -> 2026-11-03 (${provenance})`, () => {
      assert.deepEqual(dateOf(text), { value: "2026-11-03", provenance, alternatives: [] });
    });
  }

  test("today words -> today; 'day after tomorrow' / ఎల్లుండి -> +2", () => {
    for (const t of [
      "cleaning today",
      "आज क्लीनिंग",
      "ఈరోజు క్లీనింగ్",
      "aaj cleaning",
      "ivala cleaning",
    ])
      assert.equal(dateOf(t)?.value, "2026-11-02", t);
    for (const t of ["day after tomorrow", "ఎల్లుండి", "ellundi cleaning"])
      assert.equal(dateOf(t)?.value, "2026-11-04", t);
  });
});

describe("dates: tomorrow is never silently replaced by today", () => {
  test("a negated day is taken back, in every language", () => {
    assert.equal(dateOf("not tomorrow, today")?.value, "2026-11-02");
    assert.equal(dateOf("not today, tomorrow")?.value, "2026-11-03");
    assert.equal(dateOf("कल नहीं, आज")?.value, "2026-11-02");
    assert.equal(dateOf("aaj nahi kal")?.value, "2026-11-03");
    assert.equal(dateOf("రేపు కాదు, ఈరోజు")?.value, "2026-11-02");
  });

  test("two days in one breath are a choice for the caller, never picked", () => {
    for (const t of [
      "today or tomorrow, whichever",
      "aaj ya kal",
      "आज या कल",
      "ఈరోజు లేదా రేపు",
      "ivala leda repu",
    ]) {
      const d = dateOf(t);
      assert.equal(d?.provenance, "uncertain", t);
      assert.deepEqual([d!.value, ...d!.alternatives].sort(), ["2026-11-02", "2026-11-03"], t);
    }
    const s = call();
    const step = say(s, "cleaning today or tomorrow at 4 PM");
    assert.equal(step.kind, "clarify");
    assert.ok(step.kind === "clarify" && step.slot === "date");
    assert.match(JSON.stringify(step), /Monday 2 November.*Tuesday 3 November/);
    agentSaid(s, step, { interrupted: false });
    assert.equal(say(s, "tomorrow").kind, "check_availability");
    assert.equal(s.date?.value, "2026-11-03");
  });

  test("Hindi 'kal' in the past tense is yesterday: not a booking day", () => {
    assert.equal(dateOf("मैंने कल फोन किया था"), null);
    assert.equal(dateOf("maine kal call kiya tha"), null);
    // ... and does not override the day they do want.
    assert.equal(dateOf("kal call kiya tha, aaj cleaning chahiye")?.value, "2026-11-02");
    assert.equal(dateOf("मैंने कल फोन किया था, आज आना है")?.value, "2026-11-02");
  });

  test("a later correction to tomorrow replaces today, and is recorded", () => {
    const s = call();
    say(s, "cleaning today at 4 PM");
    say(s, "actually make it tomorrow");
    assert.equal(s.date?.value, "2026-11-03");
    assert.ok(s.changes.some((c) => c.slot === "date" && c.to === "2026-11-03"));
  });
});

describe("dates: time zone and calendar boundaries", () => {
  test("23:30 IST (18:00 UTC): tomorrow is the next IST day, not the next UTC day", () => {
    assert.equal(dateOf("tomorrow", at("2026-11-02T18:00:00Z"))?.value, "2026-11-03");
    assert.equal(dateOf("today", at("2026-11-02T18:00:00Z"))?.value, "2026-11-02");
  });

  test("00:30 IST (still the previous day in UTC): today is the new IST day", () => {
    assert.equal(dateOf("today", at("2026-11-02T19:00:00Z"))?.value, "2026-11-03");
  });

  test("just after midnight, 'tomorrow' / 'repu' / 'kal' has two readings and is clarified", () => {
    for (const t of ["tomorrow morning", "repu", "రేపు ఉదయం", "kal subah"]) {
      const d = dateOf(t, at("2026-11-02T19:00:00Z")); // 00:30 IST on 3 Nov
      assert.equal(d?.provenance, "uncertain", t);
      assert.equal(d?.value, "2026-11-04", t);
      assert.deepEqual(d?.alternatives, ["2026-11-03"], t);
    }
    // From 04:00 it is plain tomorrow again.
    assert.deepEqual(dateOf("tomorrow", at("2026-11-02T22:30:00Z")), {
      value: "2026-11-04",
      provenance: "explicit",
      alternatives: [],
    });
  });

  test("month, year and leap-day boundaries", () => {
    assert.equal(dateOf("tomorrow", at("2026-11-30T10:00:00Z"))?.value, "2026-12-01");
    assert.equal(dateOf("tomorrow", at("2026-12-31T10:00:00Z"))?.value, "2027-01-01");
    assert.equal(dateOf("tomorrow", at("2028-02-28T10:00:00Z"))?.value, "2028-02-29");
    assert.equal(dateOf("day after tomorrow", at("2027-02-27T10:00:00Z"))?.value, "2027-03-01");
  });

  test("the business's own time zone decides, whatever the server's", () => {
    // 2026-11-02 21:00 UTC is 01:00 Tuesday in Dubai (UTC+4) and 16:00 Monday in New York (UTC-5).
    const instant = "2026-11-02T21:00:00Z";
    assert.equal(dateOf("today", at(instant, "Asia/Dubai"))?.value, "2026-11-03");
    assert.equal(dateOf("today", at(instant, "America/New_York"))?.value, "2026-11-02");
    assert.equal(dateOf("tomorrow", at(instant, "America/New_York"))?.value, "2026-11-03");
  });
});

describe("dates: weekdays", () => {
  test("a weekday ahead resolves forward (en/hi/te)", () => {
    for (const t of ["on Friday", "शुक्रवार को", "శుక్రవారం", "shukravar ko"])
      assert.equal(dateOf(t)?.value, "2026-11-06", t);
  });
  test("today's own weekday, bare, has two readings (today / next week) and is clarified", () => {
    for (const t of ["Monday", "सोमवार", "సోమవారం"]) {
      const d = dateOf(t);
      assert.equal(d?.provenance, "uncertain", t);
      assert.deepEqual([d!.value, ...d!.alternatives], ["2026-11-02", "2026-11-09"], t);
    }
  });
  test("'next Monday' on a Monday is next week; 'this Monday' is today", () => {
    for (const t of ["next Monday", "अगले सोमवार", "agle somvar", "వచ్చే సోమవారం"])
      assert.deepEqual(
        dateOf(t),
        { value: "2026-11-09", provenance: "explicit", alternatives: [] },
        t,
      );
    for (const t of ["this Monday", "इस सोमवार", "ఈ సోమవారం"])
      assert.deepEqual(
        dateOf(t),
        { value: "2026-11-02", provenance: "explicit", alternatives: [] },
        t,
      );
  });
  test("resolveDateCandidates is deterministic", () => {
    const v = { kind: "relative", days: 1 } as const;
    assert.deepEqual(resolveDateCandidates(v, MONDAY_10AM), resolveDateCandidates(v, MONDAY_10AM));
  });
});

describe("dates: what the model is shown", () => {
  test("the call state names today and the resolved day in words; no raw objects", () => {
    const s = call();
    say(s, "repu evening cleaning kavali");
    const summary = stateSummary(s, MONDAY_10AM);
    assert.match(summary, /Today at the business: Monday 2 November, 10:00 \(Asia\/Kolkata\)/);
    assert.match(summary, /date: Tuesday 3 November \(tomorrow\) \[explicit\]/);
    assert.match(summary, /time: in the evening/);
    assert.ok(!summary.includes("[object Object]"));
  });
});

/* ------------------------------------------------------------------ model arguments are ignored */

const sessions: voice.AgentSession[] = [];
after(async () => {
  for (const s of sessions) await s.close();
});

describe("dates: model-generated tool arguments are never trusted", () => {
  test("check_availability with a wrong model date/time/service uses the call state", async () => {
    const queries: Array<Parameters<BookingBackend["checkAvailability"]>[0]> = [];
    const inner = new InMemoryBookingBackend({
      timeZoneOffset: "+05:30",
      openHours: ["10:00", "16:00", "17:00"],
      callId: "c1",
    });
    const backend: BookingBackend = {
      checkAvailability: (q) => (queries.push(q), inner.checkAvailability(q)),
      book: (r) => inner.book(r),
    };
    const state = call();
    const agent = new ReceptionistAgent({ business: MONDAY_10AM, backend, state });
    const session = new voice.AgentSession({
      llm: new voice.testing.FakeLLM([
        {
          input: "repu evening cleaning kavali, 4 or 5 lo edaina",
          content: "Let me check.",
          // What Sarvam sent in the smoke test: object-valued, model-made values.
          toolCalls: [
            {
              name: "check_availability",
              args: { service: "Whitening", date: "2026-11-02", time: "10 AM" },
            },
          ],
        },
      ]),
    });
    sessions.push(session);
    await session.start({ agent });
    await session.run({ userInput: "repu evening cleaning kavali, 4 or 5 lo edaina" }).wait();
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0], {
      serviceId: "svc-cleaning",
      date: "2026-11-03",
      durationMinutes: 30,
      notBefore: "16:00",
      notAfter: "17:00",
    });
    assert.deepEqual(
      state.booking.offered.map((o) => o.hhmm),
      ["16:00", "17:00"],
    );
  });
});
