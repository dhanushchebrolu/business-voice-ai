/**
 * Phase 2.19 guard fix (second smoke test, scenario R3): the availability
 * guard dropped the truthful "4 PM is not available" because it matched the
 * word "available" and treated any unoffered time as invented availability.
 * The guard now checks availability claims in both directions against what
 * the calendar actually returned: "free" only for offered times, "not free"
 * only for times the calendar showed as taken. Every state below is produced
 * by the real check_availability / book_appointment tools, not hand-built.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { initializeLogger, voice } from "@livekit/agents";
import {
  ReceptionistAgent,
  buildTools,
  fallbackLanguage,
  type GuardReport,
} from "../src/agent/receptionist.ts";
import type { AvailabilityResult, BookingBackend } from "../src/backend/types.ts";
import { ReplyGuard, clocksIn } from "../src/conversation/guard.ts";
import {
  applyReading,
  newConversation,
  type BusinessContext,
  type ConversationState,
} from "../src/conversation/state.ts";
import { readUtterance, type ServiceRow } from "../src/conversation/understanding.ts";

initializeLogger({ pretty: false, level: "error" });

const SERVICES: ServiceRow[] = [
  { id: "svc-cleaning", name: "Cleaning", aliases: ["క్లీనింగ్", "क्लीनिंग"], durationMinutes: 30 },
];
const NOW = new Date("2026-11-02T04:30:00Z"); // Monday 10:00 IST
const ctx: BusinessContext = {
  businessName: "Smile Dental",
  timeZone: "Asia/Kolkata",
  services: SERVICES,
  now: () => NOW,
};
const slot = (date: string, hhmm: string) => {
  const start = new Date(`${date}T${hhmm}:00+05:30`);
  return {
    startIso: start.toISOString(),
    endIso: new Date(start.getTime() + 1_800_000).toISOString(),
  };
};
const calendar = (result: AvailabilityResult): BookingBackend => ({
  checkAvailability: async () => result,
  book: async () => ({ ok: false, error: "slot_taken", retryable: false, message: "taken" }),
});

/** A call where the caller asked `request`, then the real tool asked `result`. */
async function afterCheck(
  request: string,
  result: AvailabilityResult | null,
): Promise<ConversationState> {
  const s = newConversation({ callId: "c1", callerId: "+919876543210", primaryLanguage: "en-IN" });
  applyReading(s, readUtterance(request, { catalog: SERVICES }), ctx);
  if (result) {
    const tools = buildTools({ business: ctx, backend: calendar(result), state: s }, new Set());
    await tools.check_availability.execute({}, { toolCallId: "t" } as never);
  }
  return s;
}
function guardOf(s: ConversationState) {
  const g = new ReplyGuard(s, { knownPrices: [] });
  return {
    g,
    keeps: (sentence: string) =>
      assert.equal(g.check(sentence), sentence, `should keep: ${sentence}`),
    drops: (sentence: string, rule: string) => {
      const before = g.removed.length;
      assert.equal(g.check(sentence), null, `should drop: ${sentence}`);
      assert.equal(g.removed.length, before + 1);
      const r = g.removed.at(-1)!;
      assert.equal(r.rule, rule, `${sentence}: ${r.reason}`);
      assert.equal(r.sentence, sentence, "the exact removed text is recorded");
      assert.ok(r.reason.length > 10, "a reason is recorded");
    },
  };
}
const TUE = "2026-11-03";

describe("guard: the R3 regression (requested time is taken)", () => {
  test("'Sorry, 4 PM is not available.' is kept when the calendar did not return 4 PM", async () => {
    const s = await afterCheck("I need a cleaning today at 4 PM", {
      ok: true,
      slots: [slot("2026-11-02", "11:00"), slot("2026-11-02", "17:00")],
    });
    assert.deepEqual(s.booking.unavailable, ["16:00"]);
    const { keeps, drops } = guardOf(s);
    keeps("Sorry, 4 PM is not available.");
    keeps("4 PM is unavailable, but we have 11 AM or 5 PM.");
    keeps("4 PM is already taken; 11 AM and 5 PM are free.");
    drops("4 PM is free.", "unoffered_availability");
    drops("6 PM is not available.", "unverified_unavailability");
    drops("11 AM is not available.", "unverified_unavailability"); // contradicts the calendar
    drops("We have a slot at 2 PM.", "unoffered_availability");
  });
});

describe("guard: available / unavailable / partially available / empty calendars", () => {
  test("available: the requested time is free", async () => {
    const s = await afterCheck("cleaning tomorrow at 4 PM", {
      ok: true,
      slots: [slot(TUE, "16:00")],
    });
    const { keeps, drops } = guardOf(s);
    keeps("Good news, 4 PM tomorrow is available.");
    drops("4 PM is not available.", "unverified_unavailability");
    drops("5 PM is also free.", "unoffered_availability");
  });

  test("partially available: of 4 or 5, only 5 is free", async () => {
    const s = await afterCheck("cleaning tomorrow at 4 or 5, either", {
      ok: true,
      slots: [slot(TUE, "17:00")],
    });
    assert.deepEqual(s.booking.unavailable, ["16:00"]);
    const { keeps, drops } = guardOf(s);
    keeps("4 PM is taken, but 5 PM is free.");
    keeps("4 PM available లేదు, 5 PM free గా ఉంది.");
    drops("4 PM and 5 PM are both free.", "unoffered_availability");
    drops("5 PM is not available.", "unverified_unavailability");
    drops("11 AM, 4 PM are free.", "unoffered_availability"); // no named time escapes the check
  });

  test("empty: nothing free for the request", async () => {
    const s = await afterCheck("cleaning tomorrow at 4 or 5, either", { ok: true, slots: [] });
    assert.equal(s.booking.status, "no_availability");
    const { keeps, drops } = guardOf(s);
    keeps("Sorry, nothing is free at 4 or 5 PM tomorrow.");
    keeps("There are no slots available tomorrow evening.");
    drops("5 PM is free.", "unoffered_availability");
    drops("6 PM is not available either.", "unverified_unavailability");
  });

  test("empty for a time period: 'nothing is free' needs no named time", async () => {
    const s = await afterCheck("cleaning tomorrow morning", { ok: true, slots: [] });
    const { keeps, drops } = guardOf(s);
    keeps("Sorry, nothing is available tomorrow morning.");
    drops("10 AM is not available.", "unverified_unavailability"); // never asked, never checked
  });

  test("no calendar answer yet: neither 'free' nor 'not free' may be claimed", async () => {
    const s = await afterCheck("cleaning tomorrow at 4 PM", null);
    const { keeps, drops } = guardOf(s);
    drops("4 PM is not available.", "unverified_unavailability");
    drops("Sorry, nothing is free tomorrow.", "unverified_unavailability");
    drops("4 PM is free.", "unoffered_availability");
    keeps("Let me check whether 4 PM is free?"); // a question about the caller's own time
    // (A second question in the same reply is a different rule: use a fresh reply.)
    guardOf(s).keeps("Which time slot suits you?");
  });

  test("a failed calendar check proves nothing either way", async () => {
    const s = await afterCheck("cleaning tomorrow at 4 PM", {
      ok: false,
      error: "calendar_unreachable",
      retryable: true,
    });
    assert.deepEqual(s.booking.unavailable, []);
    const { drops } = guardOf(s);
    drops("4 PM is not available.", "unverified_unavailability");
    drops("4 PM is free.", "unoffered_availability");
  });

  test("a malformed calendar answer proves nothing either way", async () => {
    const s = await afterCheck("cleaning tomorrow at 4 PM", { ok: true, slots: null } as never);
    assert.equal(s.booking.status, "failed");
    guardOf(s).drops("4 PM is not available.", "unverified_unavailability");
  });

  test("evidence goes stale: changing the day clears what the calendar said", async () => {
    const s = await afterCheck("cleaning tomorrow at 4 PM", {
      ok: true,
      slots: [slot(TUE, "17:00")],
    });
    assert.deepEqual(s.booking.unavailable, ["16:00"]);
    applyReading(s, readUtterance("actually make it Friday", { catalog: SERVICES }), ctx);
    assert.deepEqual(s.booking.unavailable, []);
    guardOf(s).drops("4 PM is not available.", "unverified_unavailability");
  });

  test("a slot lost at booking time (backend slot_taken) may be reported as taken", async () => {
    const s = await afterCheck("cleaning tomorrow at 4 PM", {
      ok: true,
      slots: [slot(TUE, "16:00")],
    });
    // Through the read-back to a real (losing) booking attempt.
    for (const t of ["yes", "my name is Ravi"])
      applyReading(s, readUtterance(t, { catalog: SERVICES }), ctx);
    s.phone!.provenance = "confirmed";
    s.booking.status = "awaiting_final_confirmation";
    for (const k of ["service", "date", "time", "customerName"] as const)
      s[k]!.provenance = "confirmed";
    const tools = buildTools(
      { business: ctx, backend: calendar({ ok: true, slots: [] }), state: s },
      new Set(),
    );
    assert.match(
      String(await tools.book_appointment.execute({}, { toolCallId: "b" } as never)),
      /^SLOT_TAKEN/,
    );
    const { keeps } = guardOf(s);
    keeps("Sorry, 4 PM was just taken by someone else.");
  });
});

describe("guard: Hindi and Telugu times are verified too", () => {
  test("clock forms: AM/PM, बजे, గంటలకు, with the period word deciding AM/PM", () => {
    assert.deepEqual(clocksIn("शाम 4 बजे खाली है"), [["16:00"]]);
    assert.deepEqual(clocksIn("सुबह 11 बजे"), [["11:00"]]);
    assert.deepEqual(clocksIn("సాయంత్రం 4 గంటలకు ఖాళీ లేదు"), [["16:00"]]);
    assert.deepEqual(clocksIn("5 PM కి ఖాళీగా ఉంది"), [["17:00"]]);
    assert.deepEqual(clocksIn("4 बजे"), [["04:00", "16:00"]], "no period word: both readings");
  });

  test("Hindi: 4 PM taken, 5 PM free", async () => {
    const s = await afterCheck("कल शाम 4 या 5 बजे, कोई भी, क्लीनिंग", {
      ok: true,
      slots: [slot(TUE, "17:00")],
    });
    const { keeps, drops } = guardOf(s);
    keeps("माफ़ कीजिए, शाम 4 बजे खाली नहीं है।");
    keeps("शाम 5 बजे खाली है।");
    keeps("शाम 4 बजे उपलब्ध नहीं है, लेकिन 5 बजे खाली है।");
    drops("शाम 4 बजे खाली है।", "unoffered_availability");
    drops("शाम 5 बजे खाली नहीं है।", "unverified_unavailability");
    drops("शाम 6 बजे खाली है।", "unoffered_availability");
  });

  test("Telugu: 4 PM taken, 5 PM free", async () => {
    const s = await afterCheck("రేపు సాయంత్రం 4 లేదా 5, ఏదైనా పర్వాలేదు, క్లీనింగ్", {
      ok: true,
      slots: [slot(TUE, "17:00")],
    });
    const { keeps, drops } = guardOf(s);
    keeps("సాయంత్రం 4 గంటలకు ఖాళీ లేదు.");
    keeps("సాయంత్రం 5 గంటలకు ఖాళీగా ఉంది.");
    keeps("4 PM ఖాళీ లేదు, కానీ 5 PM ఖాళీగా ఉంది.");
    drops("సాయంత్రం 4 గంటలకు ఖాళీగా ఉంది.", "unoffered_availability");
    drops("సాయంత్రం 5 గంటలకు ఖాళీ లేదు.", "unverified_unavailability");
  });
});

/* ------------------------------------------------------------------ reports and language */

const sessions: voice.AgentSession[] = [];
after(async () => {
  for (const s of sessions) await s.close();
});

async function scripted(turns: voice.testing.FakeLLMResponse[], backend: BookingBackend) {
  const state = newConversation({
    callId: "c1",
    callerId: "+919876543210",
    primaryLanguage: "en-IN",
  });
  const reports: GuardReport[] = [];
  const removedArgs: string[] = [];
  const agent = new ReceptionistAgent({
    business: ctx,
    backend,
    state,
    onGuard: (removed, report) => {
      removedArgs.push(...removed.map((r) => r.sentence));
      reports.push(report);
    },
  });
  const session = new voice.AgentSession({ llm: new voice.testing.FakeLLM(turns) });
  sessions.push(session);
  await session.start({ agent });
  const run = async (userInput: string) => {
    const r = await session.run({ userInput }).wait();
    return r.events
      .filter((e) => e.type === "message")
      .map((e) => (e as { item: { textContent?: string } }).item.textContent ?? "")
      .join(" ")
      .trim();
  };
  return { state, reports, removedArgs, run };
}
const toolOut = (s: string) => JSON.stringify(s);

describe("guard reports: exact removed text, rule, reason, original and modified reply", () => {
  test("R3 end to end: the truthful 'not available' line is spoken; no intervention", async () => {
    const c = await scripted(
      [
        {
          input: "I need a cleaning today at 4 PM",
          toolCalls: [{ name: "check_availability", args: {} }],
        },
        {
          input: toolOut("OFFER: 4 PM is not free. Free times: 11 AM, 5 PM. Ask which one."),
          content: "Sorry, 4 PM is not available. We have 11 AM or 5 PM. Which one works for you?",
        },
      ],
      calendar({ ok: true, slots: [slot("2026-11-02", "11:00"), slot("2026-11-02", "17:00")] }),
    );
    const said = await c.run("I need a cleaning today at 4 PM");
    assert.equal(
      said,
      "Sorry, 4 PM is not available. We have 11 AM or 5 PM. Which one works for you?",
    );
    assert.deepEqual(c.reports, []);
  });

  test("a partly invented reply: the report holds every detail", async () => {
    const c = await scripted(
      [
        {
          input: "I need a cleaning today at 4 PM",
          toolCalls: [{ name: "check_availability", args: {} }],
        },
        {
          input: toolOut("OFFER: 4 PM is not free. Free times: 11 AM, 5 PM. Ask which one."),
          content: "Sorry, 4 PM is not available. 6 PM is free too. Which one works for you?",
        },
      ],
      calendar({ ok: true, slots: [slot("2026-11-02", "11:00"), slot("2026-11-02", "17:00")] }),
    );
    const said = await c.run("I need a cleaning today at 4 PM");
    assert.equal(said, "Sorry, 4 PM is not available. Which one works for you?");
    assert.equal(c.reports.length, 1);
    const r = c.reports[0]!;
    assert.equal(r.step, "offer_slots");
    assert.equal(
      r.original,
      "Sorry, 4 PM is not available. 6 PM is free too. Which one works for you?",
    );
    assert.equal(r.modified.trim(), said);
    assert.deepEqual(
      r.removed.map((x) => [x.rule, x.sentence.trim()]),
      [["unoffered_availability", "6 PM is free too."]],
    );
    assert.match(r.removed[0]!.reason, /6 PM as available.*offered only: 11 AM, 5 PM/);
    assert.equal(r.fallback, null);
    assert.deepEqual(r.languages, { caller: "en-IN", response: "en-IN", spoken: "en-IN" });
    assert.deepEqual(
      c.removedArgs.map((x) => x.trim()),
      ["6 PM is free too."],
    );
  });
});

describe("guard interventions never silently change the reply language", () => {
  test("fallbackLanguage follows the model's reply script, else the caller's language", () => {
    assert.equal(fallbackLanguage("సాయంత్రం 4 గంటలకు ఖాళీగా ఉంది.", "en-IN"), "te-IN");
    assert.equal(fallbackLanguage("शाम 4 बजे खाली है।", "te-IN"), "hi-IN");
    assert.equal(fallbackLanguage("4 PM is free.", "te-IN"), "en-IN");
    assert.equal(fallbackLanguage("4:00 ?!", "hi-IN"), "hi-IN");
  });

  for (const [label, caller, reply, expected] of [
    [
      "Telugu reply fully removed",
      "రేపు సాయంత్రం 4 గంటలకు క్లీనింగ్",
      "సాయంత్రం 4 గంటలకు ఖాళీగా ఉంది.",
      "క్యాలెండర్ చూస్తున్నాను.",
    ],
    [
      "Hindi reply fully removed",
      "कल शाम 4 बजे क्लीनिंग",
      "शाम 4 बजे खाली है।",
      "मैं कैलेंडर देख रही हूँ।",
    ],
    [
      "English reply fully removed",
      "cleaning tomorrow at 4 PM",
      "4 PM is free.",
      "Let me check the calendar.",
    ],
  ] as const) {
    test(`${label}: the fallback is in the reply's language`, async () => {
      const c = await scripted(
        [{ input: caller, content: reply }],
        calendar({ ok: true, slots: [] }),
      );
      const said = await c.run(caller);
      assert.equal(said, expected);
      const r = c.reports[0]!;
      assert.equal(r.fallback, expected);
      assert.equal(r.languages.response, r.languages.spoken, "same language before and after");
    });
  }

  test("model replied in English to a Telugu caller: the fallback stays English, and the report shows it", async () => {
    const caller = "రేపు సాయంత్రం 4 గంటలకు క్లీనింగ్";
    const c = await scripted(
      [{ input: caller, content: "4 PM is free." }],
      calendar({ ok: true, slots: [] }),
    );
    assert.equal(await c.run(caller), "Let me check the calendar.");
    assert.deepEqual(c.reports[0]!.languages, {
      caller: "te-IN",
      response: "en-IN",
      spoken: "en-IN",
    });
  });

  test("partial removal keeps the reply's language (Hindi stays Hindi)", async () => {
    const caller = "कल शाम 4 या 5 बजे, कोई भी, क्लीनिंग";
    const c = await scripted(
      [
        { input: caller, toolCalls: [{ name: "check_availability", args: {} }] },
        {
          input: toolOut("OFFER: 4 PM is not free. Free times: 5 PM. Ask which one."),
          content: "शाम 4 बजे खाली नहीं है। शाम 6 बजे खाली है। क्या 5 बजे ठीक रहेगा?",
        },
      ],
      calendar({ ok: true, slots: [slot(TUE, "17:00")] }),
    );
    const said = await c.run(caller);
    assert.equal(said, "शाम 4 बजे खाली नहीं है। क्या 5 बजे ठीक रहेगा?");
    const r = c.reports[0]!;
    assert.deepEqual(
      r.removed.map((x) => x.sentence.trim()),
      ["शाम 6 बजे खाली है।"],
    );
    assert.deepEqual(r.languages, { caller: "hi-IN", response: "hi-IN", spoken: "hi-IN" });
  });
});
