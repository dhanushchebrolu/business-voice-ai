import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import {
  analyzeCall,
  ANALYSIS_MAX_ATTEMPTS,
  ANALYSIS_RETRY_AFTER_MS,
  sweepCallAnalyses,
  type AnalysisDeps,
} from "./call-analysis.server.ts";
import type { CallAnalysis } from "./call-analysis.ts";

type Row = Record<string, unknown>;
const ORG = "org_1";
const T0 = new Date("2026-11-25T10:00:00Z");

const TRANSCRIPT = [
  { role: "agent", text: "Hello, this is the clinic. Is this a good time?" },
  { role: "user", text: "Yes. Can I move my appointment to Friday?" },
  { role: "agent", text: "Of course." },
];

function world(calls: Row[] = [], events: Row[] = []) {
  const db = memorySupabase({
    tables: {
      call_logs: calls,
      call_analyses: [],
      sarvam_agent_events: events,
    },
    uniques: [{ table: "call_analyses", key: (r) => String(r["call_id"] ?? "") || null }],
  });
  return db;
}

const call = (over: Row = {}): Row => ({
  id: "c1",
  organization_id: ORG,
  direction: "outbound",
  status: "completed",
  duration_seconds: 60,
  transcript: TRANSCRIPT,
  final_agent_variables: {},
  campaign_id: "camp_1",
  campaign_contact_id: "cc_1",
  campaign_context_snapshot: { campaign_objective: "Remind patients of their appointment" },
  provider_metadata: { interaction_id: "int_1" },
  finalization_state: "done",
  started_at: "2026-11-25T09:00:00Z",
  ...over,
});

const aiReply = (over: Partial<CallAnalysis> = {}) =>
  JSON.stringify({
    summary: "Patient asked to move the appointment to Friday.",
    customer_said: ["wants Friday"],
    intent: "reschedule",
    outcome: "other",
    interest_level: "medium",
    sentiment: "neutral",
    response: "neutral",
    objections: ["Saturday is too busy"],
    questions: [],
    preferences: ["Friday"],
    price_sensitivity: null,
    competitors: [],
    purchase_intent: null,
    callback: { requested: false, when: null },
    follow_up_required: false,
    next_action: null,
    appointment: { outcome: "none", booking_id: null },
    extracted: {},
    language: "English",
    ...over,
  });

function ai(replies: (string | Error)[] | string) {
  const seen: { role: string; content: string }[][] = [];
  let i = 0;
  const deps: AnalysisDeps = {
    now: () => T0,
    ai: async (messages) => {
      seen.push(messages);
      const next = Array.isArray(replies) ? replies[Math.min(i++, replies.length - 1)]! : replies;
      if (next instanceof Error) throw next;
      return { text: next, model: "test-model" };
    },
  };
  return { deps, seen };
}
const rows = (db: ReturnType<typeof world>) => db.tables["call_analyses"]!;
const analysis = (db: ReturnType<typeof world>) => rows(db)[0]!["analysis"] as CallAnalysis;

describe("analysing one call", () => {
  test("a finished conversation is analysed from its transcript and stored once", async () => {
    const db = world([call()]);
    const { deps, seen } = ai(aiReply());
    const r = await analyzeCall(db.client, "c1", deps);
    assert.deepEqual(r, { state: "analyzed", status: "done", source: "ai" });
    assert.equal(rows(db).length, 1);
    const row = rows(db)[0]!;
    assert.equal(row["organization_id"], ORG);
    assert.equal(row["campaign_id"], "camp_1");
    assert.equal(row["model"], "test-model");
    assert.deepEqual(analysis(db).objections, ["Saturday is too busy"]);
    assert.equal(seen.length, 1);
    assert.match(seen[0]![1]!.content, /Remind patients of their appointment/);
  });

  test("running it again, or on a retried job, does not analyse twice or duplicate the row", async () => {
    const db = world([call()]);
    const { deps, seen } = ai(aiReply());
    await analyzeCall(db.client, "c1", deps);
    for (let i = 0; i < 3; i++)
      assert.deepEqual(await analyzeCall(db.client, "c1", deps), { state: "unchanged" });
    assert.equal(seen.length, 1, "the model is asked once");
    assert.equal(rows(db).length, 1);
  });

  test("two runs at once leave one analysis", async () => {
    const db = world([call()]);
    const { deps } = ai(aiReply());
    const [a, b] = await Promise.all([
      analyzeCall(db.client, "c1", deps),
      analyzeCall(db.client, "c1", deps),
    ]);
    assert.equal(rows(db).length, 1);
    assert.ok([a.state, b.state].includes("analyzed"));
  });

  test("what the booking tools did is taken from ClickAI's own log, not the model", async () => {
    const db = world(
      [call()],
      [
        {
          organization_id: ORG,
          interaction_id: "int_1",
          kind: "book_appointment",
          status: "ok",
          detail: { outcome: "confirmed", booking_id: "bk-7" },
          created_at: "2026-11-25T09:00:30Z",
        },
      ],
    );
    const { deps } = ai(aiReply({ appointment: { outcome: "none", booking_id: null } }));
    await analyzeCall(db.client, "c1", deps);
    assert.equal(analysis(db).outcome, "appointment_booked");
    assert.deepEqual(analysis(db).appointment, { outcome: "booked", booking_id: "bk-7" });
  });

  test("a moved or cancelled appointment is recorded with its booking", async () => {
    for (const [kind, outcome, expected] of [
      ["reschedule_appointment", "rescheduled", "appointment_rescheduled"],
      ["cancel_appointment", "cancelled", "appointment_cancelled"],
    ] as const) {
      const db = world(
        [call()],
        [
          {
            organization_id: ORG,
            interaction_id: "int_1",
            kind,
            status: "ok",
            detail: { booking_id: "bk-8", outcome },
            created_at: "2026-11-25T09:00:30Z",
          },
        ],
      );
      await analyzeCall(db.client, "c1", ai(aiReply()).deps);
      assert.equal(analysis(db).outcome, expected);
      assert.equal(analysis(db).appointment.booking_id, "bk-8");
    }
  });

  test("another customer's events never leak into a call's facts", async () => {
    const db = world(
      [call()],
      [
        {
          organization_id: "org_other",
          interaction_id: "int_1",
          kind: "book_appointment",
          status: "ok",
          detail: { outcome: "confirmed", booking_id: "bk-x" },
          created_at: "2026-11-25T09:00:30Z",
        },
      ],
    );
    await analyzeCall(db.client, "c1", ai(aiReply()).deps);
    assert.equal(analysis(db).appointment.outcome, "none");
  });
});

describe("calls with nothing to read, and calls not ready", () => {
  test("a missing, empty or one-sided transcript is analysed from ClickAI's records and is final, without asking the model", async () => {
    for (const transcript of [null, [], [{ role: "agent", text: "Hello?" }]]) {
      const db = world([
        call({ transcript, final_agent_variables: { outbound_result: "not_interested" } }),
      ]);
      const { deps, seen } = ai(aiReply());
      const r = await analyzeCall(db.client, "c1", deps);
      assert.deepEqual(r, { state: "analyzed", status: "no_transcript", source: "rules" });
      assert.equal(seen.length, 0, JSON.stringify(transcript));
      assert.equal(analysis(db).outcome, "not_interested");
      assert.equal(analysis(db).summary, null, "nothing was made up");
    }
  });

  test("failed, unanswered, busy and cancelled calls are no conversation", async () => {
    for (const [status, duration] of [
      ["failed", 0],
      ["no_answer", 0],
      ["busy", 0],
      ["cancelled", 0],
    ] as const) {
      const db = world([call({ status, duration_seconds: duration })]);
      const { deps, seen } = ai(aiReply());
      await analyzeCall(db.client, "c1", deps);
      assert.equal(analysis(db).outcome, "no_conversation", status);
      assert.equal(seen.length, 0, status);
    }
  });

  test("a call still going, or an inbound call, or an unknown call, is not analysed", async () => {
    const db = world([call({ status: "in_progress" }), call({ id: "c2", direction: "inbound" })]);
    const { deps } = ai(aiReply());
    assert.deepEqual(await analyzeCall(db.client, "c1", deps), { state: "not_final" });
    assert.deepEqual(await analyzeCall(db.client, "c2", deps), { state: "not_found" });
    assert.deepEqual(await analyzeCall(db.client, "nope", deps), { state: "not_found" });
    assert.equal(rows(db).length, 0);
  });

  test("with no AI available a conversation waits, basic data kept, and is redone once AI exists", async () => {
    const db = world([call({ final_agent_variables: { outbound_result: "interested" } })]);
    const first = await analyzeCall(db.client, "c1", { now: () => T0, ai: null });
    assert.deepEqual(first, { state: "analyzed", status: "pending_ai", source: "rules" });
    assert.equal(analysis(db).outcome, "interested");
    assert.deepEqual(await analyzeCall(db.client, "c1", { now: () => T0, ai: null }), {
      state: "unchanged",
    });
    const { deps } = ai(aiReply({ outcome: "interested", objections: ["too expensive"] }));
    const upgraded = await analyzeCall(db.client, "c1", deps);
    assert.deepEqual(upgraded, { state: "analyzed", status: "done", source: "ai" });
    assert.equal(rows(db).length, 1, "the same row, not a second one");
    assert.deepEqual(analysis(db).objections, ["too expensive"]);
  });
});

describe("failures and retries", () => {
  test("a bad or failed model answer keeps the basic analysis, records why, and waits before retrying", async () => {
    for (const reply of [
      "I'm sorry, I can't do that",
      new Error("overloaded"),
      '{"outcome":"nope"}',
    ]) {
      const db = world([
        call({ final_agent_variables: { outbound_result: "callback_requested" } }),
      ]);
      const { deps } = ai([reply]);
      const r = await analyzeCall(db.client, "c1", deps);
      assert.deepEqual(r, { state: "analyzed", status: "failed", source: "rules" });
      const row = rows(db)[0]!;
      assert.equal(row["attempts"], 1);
      assert.ok(String(row["last_error"]).length > 3);
      assert.equal(analysis(db).outcome, "callback_requested", "the report still has the call");
      row["updated_at"] = T0.toISOString(); // the test helper stamps the real clock
      assert.deepEqual(
        await analyzeCall(db.client, "c1", deps),
        { state: "unchanged" },
        "too soon",
      );
    }
  });

  test("after the wait it is retried, and a good answer replaces the basic one", async () => {
    const db = world([call()]);
    await analyzeCall(db.client, "c1", ai([new Error("overloaded")]).deps);
    const later = new Date(T0.getTime() + ANALYSIS_RETRY_AFTER_MS + 1000);
    rows(db)[0]!["updated_at"] = T0.toISOString();
    const { deps } = ai(aiReply());
    const r = await analyzeCall(db.client, "c1", { ...deps, now: () => later });
    assert.deepEqual(r, { state: "analyzed", status: "done", source: "ai" });
    assert.equal(rows(db).length, 1);
    assert.equal(rows(db)[0]!["attempts"], 2);
  });

  test("it stops after the allowed number of tries and keeps the basic analysis", async () => {
    const db = world([call()]);
    let now = T0;
    const { deps } = ai([new Error("down")]);
    for (let i = 0; i < ANALYSIS_MAX_ATTEMPTS + 2; i++) {
      await analyzeCall(db.client, "c1", { ...deps, now: () => now });
      now = new Date(now.getTime() + ANALYSIS_RETRY_AFTER_MS + 1000);
      rows(db)[0]!["updated_at"] = new Date(
        now.getTime() - ANALYSIS_RETRY_AFTER_MS - 500,
      ).toISOString();
    }
    assert.equal(rows(db)[0]!["attempts"], ANALYSIS_MAX_ATTEMPTS);
    assert.equal(rows(db)[0]!["status"], "failed");
    assert.equal(rows(db).length, 1);
  });
});

describe("the background sweep", () => {
  test("analyses finished, finalized calls that have no analysis, a few per run", async () => {
    const calls = Array.from({ length: 8 }, (_, i) =>
      call({ id: `c${i + 1}`, started_at: `2026-11-25T0${i}:00:00Z` }),
    );
    const db = world(calls);
    const { deps } = ai(aiReply());
    const first = await sweepCallAnalyses(db.client, deps, 5);
    assert.equal(first.considered, 5);
    assert.equal(first.analyzed, 5);
    assert.equal(rows(db).length, 5);
    const second = await sweepCallAnalyses(db.client, deps, 5);
    assert.equal(second.analyzed, 3);
    assert.equal(rows(db).length, 8, "every call once, none twice");
    const third = await sweepCallAnalyses(db.client, deps, 5);
    assert.equal(third.considered, 0);
  });

  test("leaves alone calls still being billed (not finalized), unfinished calls, and old calls", async () => {
    const db = world([
      call({ id: "pending", finalization_state: "pending" }),
      call({ id: "live", status: "in_progress" }),
      call({ id: "old", started_at: "2026-10-01T00:00:00Z" }),
      call({ id: "ok" }),
    ]);
    await sweepCallAnalyses(db.client, ai(aiReply()).deps);
    assert.deepEqual(
      rows(db).map((r) => r["call_id"]),
      ["ok"],
    );
  });

  test("retries a failed analysis once it is due, and upgrades a waiting one only when AI exists", async () => {
    const db = world([call({ id: "f" }), call({ id: "w", started_at: "2026-11-25T08:00:00Z" })]);
    await analyzeCall(db.client, "f", ai([new Error("down")]).deps);
    await analyzeCall(db.client, "w", { now: () => T0, ai: null });
    for (const r of rows(db)) r["updated_at"] = new Date(T0.getTime() - 3_600_000).toISOString();
    const none = await sweepCallAnalyses(db.client, { now: () => T0, ai: null });
    assert.equal(rows(db).find((r) => r["call_id"] === "w")!["status"], "pending_ai");
    assert.equal(none.analyzed, 0);
    await sweepCallAnalyses(db.client, ai(aiReply()).deps);
    assert.deepEqual(
      rows(db).map((r) => r["status"]),
      ["done", "done"],
    );
  });

  test("one failing call never stops the rest of the run", async () => {
    const db = world([call({ id: "a" }), call({ id: "b", started_at: "2026-11-25T08:00:00Z" })]);
    let n = 0;
    const deps: AnalysisDeps = {
      now: () => T0,
      ai: async () => {
        if (n++ === 0) throw new Error("boom");
        return { text: aiReply(), model: "m" };
      },
    };
    const s = await sweepCallAnalyses(db.client, deps);
    assert.equal(s.considered, 2);
    assert.equal(s.failed + s.analyzed, 2);
    assert.equal(rows(db).length, 2);
  });
});
