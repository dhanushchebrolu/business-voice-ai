/**
 * Offline proof for the smoke-test scenarios (bench/smoke-scenarios.ts),
 * before any paid request:
 *  - every remediation scenario, replayed through the real state machine
 *    and the real tools (in-memory calendar, the scenario's own clock),
 *    yields exactly the steps and outcomes its checks expect — so a failed
 *    check in the paid run is the model's doing, not a bad scenario;
 *  - the evaluator catches what it is meant to catch;
 *  - the suite fits the harness's request and budget limits.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildTools } from "../src/agent/receptionist.ts";
import { InMemoryBookingBackend } from "../src/backend/in-memory.ts";
import {
  agentSaid,
  applyReading,
  newConversation,
  nextStep,
  type BusinessContext,
} from "../src/conversation/state.ts";
import { readUtterance } from "../src/conversation/understanding.ts";
import {
  ORIGINAL_SCENARIOS,
  REMEDIATION_SCENARIOS,
  SMOKE_HOURS,
  SMOKE_NOW_ISO,
  SMOKE_SERVICES,
  evaluateScenario,
  questionsIn,
  selectSuite,
  stepLabel,
  type ScenarioRun,
  type SmokeScenario,
} from "../bench/smoke-scenarios.ts";

/** The deterministic half of a call: what the state and tools do, whatever the model says. */
async function replay(sc: SmokeScenario) {
  const business: BusinessContext = {
    businessName: "Test Dental (smoke)",
    timeZone: "Asia/Kolkata",
    services: SMOKE_SERVICES,
    now: () => new Date(sc.nowIso ?? SMOKE_NOW_ISO),
  };
  const backend = new InMemoryBookingBackend({
    timeZoneOffset: "+05:30",
    openHours: sc.openHours ?? SMOKE_HOURS,
    callId: `smoke-${sc.name}`,
  });
  const state = newConversation({
    callId: `smoke-${sc.name}`,
    callerId: "+910000000000",
    primaryLanguage: "en-IN",
  });
  const tools = buildTools({ business, backend, state }, new Set());
  const opts = { toolCallId: "t" } as never;
  const steps: string[] = [];
  for (const turn of sc.turns) {
    applyReading(state, readUtterance(turn, { catalog: SMOKE_SERVICES }), business);
    const step = nextStep(state);
    steps.push(stepLabel(step as { kind: string }));
    if (step.kind === "check_availability") await tools.check_availability.execute({}, opts);
    if (step.kind === "book") await tools.book_appointment.execute({}, opts);
    agentSaid(state, nextStep(state), { interrupted: false }); // the reply after any tool
  }
  return { state, backend, steps };
}

describe("smoke suites", () => {
  test("the original suite is unchanged (names and turns)", () => {
    assert.deepEqual(
      ORIGINAL_SCENARIOS.map((s) => [s.name, s.turns.length]),
      [
        ["1-telugu-conversation", 3],
        ["2-english-availability", 3],
        ["3-hindi-booking", 7],
        ["4-code-mixed-ambiguity", 3],
        ["5-failure-recovery", 2],
      ],
    );
  });
  test("--suite: default original; remediation by name; anything else refused", () => {
    assert.deepEqual(selectSuite(["node", "x"]), { ok: true, name: "original" });
    assert.deepEqual(selectSuite(["node", "x", "--suite", "remediation"]), {
      ok: true,
      name: "remediation",
    });
    for (const bad of [["--suite"], ["--suite", "all"], ["--suite", "Remediation"]])
      assert.equal(selectSuite(["node", "x", ...bad]).ok, false);
  });
  test("the remediation suite covers every requested area", () => {
    const covers = REMEDIATION_SCENARIOS.flatMap((s) => s.covers ?? []).join(" | ");
    for (const want of [
      /Telugu repu/,
      /Hindi kal/,
      /English today/,
      /English tomorrow/,
      /ambiguous date/,
      /either of two slots/,
      /which slot is free/,
      /empty availability/,
      /unavailable slot/,
      /Telugu goodbye/,
      /Hindi goodbye/,
      /English goodbye/,
      /no repeated question/,
      /booking confirmation/,
      /duplicate-booking prevention/,
    ])
      assert.match(covers, want);
  });
  test("fits the harness limits: <= 60 chat requests and well under ₹50 even at worst case", () => {
    // One request per caller turn, plus one per tool continuation.
    const planned = REMEDIATION_SCENARIOS.reduce(
      (n, s) =>
        n +
        s.turns.length +
        (s.expect?.steps ?? []).filter((x) => x === "check_availability" || x === "book").length,
      0,
    );
    assert.ok(planned <= 60, `planned ${planned} requests`);
    // The harness's own worst case per request: 4,000 output tokens + ~5,000 input tokens.
    const worstPerRequest = (5000 * 15e-6 + 4000 * 60e-6) * 1.18;
    assert.ok(
      planned * worstPerRequest < 50,
      `worst case ₹${(planned * worstPerRequest).toFixed(2)}`,
    );
  });
});

describe("remediation scenarios: the deterministic side matches every expectation", () => {
  for (const sc of REMEDIATION_SCENARIOS) {
    test(sc.name, async () => {
      const { state, backend, steps } = await replay(sc);
      const e = sc.expect!;
      assert.deepEqual(steps, e.steps);
      if (e.date !== undefined) assert.equal(state.date?.value, e.date);
      if (e.offered !== undefined)
        assert.deepEqual(
          state.booking.offered.map((o) => o.hhmm),
          e.offered,
        );
      if (e.bookingStatus !== undefined) assert.equal(state.booking.status, e.bookingStatus);
      if (e.bookings !== undefined) assert.equal(backend.bookings.size, e.bookings);
      if (e.closed !== undefined) assert.equal(state.closing.closed, e.closed);
      assert.ok(backend.calls.book <= 1, "never two booking attempts");
    });
  }
});

describe("evaluator", () => {
  const sc = REMEDIATION_SCENARIOS.find((s) => s.name.startsWith("R2"))!;
  const good: ScenarioRun = {
    steps: ["clarify:time", "check_availability", "close:not_booked"],
    transcript: [
      { caller: sc.turns[0]!, agent: "4 PM ఆ 5 PM ఆ?" },
      { caller: sc.turns[1]!, agent: "4 PM ఖాళీగా లేదు. 5 PM ఖాళీగా ఉంది. అది సరిపోతుందా?" },
      { caller: sc.turns[2]!, agent: "ఫోన్ చేసినందుకు ధన్యవాదాలు. నమస్కారం!" },
    ],
    date: "2026-11-03",
    offered: ["17:00"],
    bookingStatus: "slots_offered",
    bookings: 0,
    backendBookCalls: 0,
    closed: true,
  };
  const failed = (run: ScenarioRun) =>
    evaluateScenario(sc, run)
      .filter((c) => !c.pass)
      .map((c) => c.name);

  test("a correct run passes every check", () => {
    assert.deepEqual(failed(good), []);
  });
  test("the smoke-test bug (same clarification twice) is caught twice over", () => {
    const run = {
      ...good,
      steps: ["clarify:time", "clarify:time", "close:not_booked"],
      transcript: [
        good.transcript[0]!,
        { caller: sc.turns[1]!, agent: "4 PM ఆ 5 PM ఆ?" },
        good.transcript[2]!,
      ],
    };
    const f = failed(run);
    assert.ok(f.includes("turn 1: no repeated question"));
    assert.ok(f.includes("turn 1: clarification not repeated"));
    assert.ok(f.includes("turn 1: step check_availability"));
  });
  test("a question in the goodbye, a silent turn, a free claim for 4 PM and a second booking are caught", () => {
    const run = {
      ...good,
      transcript: [
        good.transcript[0]!,
        { caller: sc.turns[1]!, agent: "4 PM is free." },
        { caller: sc.turns[2]!, agent: "Anything else?" },
      ],
      bookings: 2,
      backendBookCalls: 2,
    };
    const f = failed(run);
    assert.ok(f.includes("turn 2: goodbye asks nothing"));
    assert.ok(f.some((x) => x.startsWith("turn 1: does not say")));
    assert.ok(
      f.some((x) => x.startsWith("turn 1: says")),
      "5 PM was never mentioned",
    );
    assert.ok(f.includes("at most one booking (duplicate prevention)"));
    const silent = failed({
      ...good,
      transcript: [good.transcript[0]!, { caller: "x", agent: " " }, good.transcript[2]!],
    });
    assert.ok(silent.includes("turn 1: agent spoke"));
  });
  test("an unfinished run (stopped early) is a failed check, not a pass", () => {
    assert.ok(
      failed({ ...good, transcript: good.transcript.slice(0, 1) }).includes("all turns completed"),
    );
  });
  test("questionsIn normalises and splits", () => {
    assert.deepEqual(questionsIn("Okay. Which day?  4 PM,  or 5 PM?"), [
      "which day?",
      "4 pm or 5 pm?",
    ]);
  });
});
