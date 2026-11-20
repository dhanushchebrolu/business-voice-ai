import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import {
  OUTCOME_RECONCILE_ROTATION_POINTS,
  reconcileCallOutcomes,
  reconcileRotationStart,
} from "./call-outcome-reconciliation.server.ts";
import {
  callLeadId,
  recordCallOutcome,
  type AuthenticatedIntegration,
} from "./sarvam-agent-api.server.ts";

/** The inbound admission gate, admitted (the real gate is covered in its own tests). */
const ADMITTED = async () => ({ admitted: true as const, numberIds: [], deploymentIds: [] });

/**
 * Recovery of end-of-call outcomes the Sarvam on-end tool never delivered,
 * from the stored call-end webhook, against an in-memory database with the
 * production once-per-call outcome index. Nothing reaches Sarvam or Supabase.
 */

type Row = Record<string, unknown>;
const ORG = "org_a";
const NOW = new Date("2026-11-18T10:00:00Z");
const CALLER = "+919876500077";
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const AUTH: AuthenticatedIntegration = {
  integrationId: "int_1",
  organizationId: ORG,
  agentConfigId: "agent_1",
  businessId: "biz_1",
  testCallerNumbers: [],
  role: "inbound",
};

function setup(calls: Row[], events: Row[] = []) {
  const db = memorySupabase({
    tables: {
      sarvam_agent_integrations: [
        {
          id: "int_1",
          organization_id: ORG,
          agent_config_id: "agent_1",
          status: "active",
          expires_at: null,
          test_caller_numbers: ["+919999999999"],
          role: "inbound",
        },
      ],
      agent_configs: [{ id: "agent_1", organization_id: ORG, business_id: "biz_1" }],
      call_logs: calls,
      sarvam_agent_events: events,
      leads: [],
    },
    uniques: [
      // leads primary key (the call's deterministic lead id)
      { table: "leads", key: (r) => String(r["id"]) },
      // idx_sarvam_agent_events_one_outcome
      {
        table: "sarvam_agent_events",
        key: (r) =>
          r["kind"] === "call_outcome" && r["interaction_id"]
            ? `${r["integration_id"]}:${r["interaction_id"]}`
            : null,
      },
    ],
  });
  const t = (name: string) => db.tables[name] ?? [];
  const outcomes = (interaction: string) =>
    t("sarvam_agent_events").filter(
      (e) => e["kind"] === "call_outcome" && e["interaction_id"] === interaction,
    );
  return { db, t, outcomes };
}

const inboundCall = (over: Row = {}): Row => ({
  id: "call_1",
  organization_id: ORG,
  provider: "sarvam",
  direction: "inbound",
  status: "completed",
  provider_call_id: "20261118/abc",
  caller_number: CALLER,
  ended_at: minutesAgo(20),
  final_agent_variables: {
    call_outcome: "callback_requested",
    call_summary: "Wants a root canal next week.",
    customer_name: "Asha",
    caller_interest: "root canal",
    requested_slot: "",
    opted_out: "no",
  },
  ...over,
});

describe("end-of-call outcome reconciliation", () => {
  test("a missing outcome is recovered once: one outcome row, one lead, even when run again", async () => {
    const s = setup([inboundCall()]);
    const first = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    const second = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    assert.deepEqual(first, {
      candidates: 1,
      recorded: 1,
      duplicates: 0,
      noIntegration: 0,
      notAdmitted: 0,
      leadsCompleted: 0,
      errors: 0,
    });
    assert.equal(second.candidates, 0, "already recorded");
    assert.equal(s.outcomes("20261118/abc").length, 1);
    const detail = s.outcomes("20261118/abc")[0]!["detail"] as Row;
    assert.equal(detail["source"], "reconciliation");
    assert.equal(s.t("leads").length, 1);
    assert.equal(s.t("leads")[0]!["phone"], CALLER);
  });

  test("a recovered opt-out suppresses the call's callback lead and creates none", async () => {
    const s = setup(
      [
        inboundCall({
          final_agent_variables: {
            call_outcome: "callback_requested",
            customer_name: "Asha",
            opted_out: "yes",
          },
        }),
      ],
      [
        {
          id: "ev_cb",
          integration_id: "int_1",
          organization_id: ORG,
          kind: "callback",
          status: "ok",
          interaction_id: "20261118/abc",
          detail: { lead_id: "lead_cb" },
        },
      ],
    );
    s.t("leads").push({ id: "lead_cb", organization_id: ORG, status: "new", phone: CALLER });
    await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    assert.equal(s.t("leads").length, 1, "no new lead");
    assert.equal(s.t("leads")[0]!["status"], "do_not_contact");
    const detail = s.outcomes("20261118/abc")[0]!["detail"] as Row;
    assert.equal(detail["opted_out"], true);
    assert.equal(detail["suppressed_lead_id"], "lead_cb");
  });

  test("variables stored grouped by the Sarvam parser (older rows) are still recovered", async () => {
    const s = setup([
      inboundCall({
        final_agent_variables: {
          final: { call_outcome: "callback_requested", customer_name: "Asha", opted_out: "yes" },
          output: {},
        },
      }),
    ]);
    await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    const detail = s.outcomes("20261118/abc")[0]!["detail"] as Row;
    assert.equal(detail["outcome"], "callback_requested");
    assert.equal(detail["opted_out"], true, "the opt-out inside `final` is honoured");
    assert.equal(s.t("leads").length, 0);
  });

  test("a call the tool already recorded is left alone", async () => {
    const s = setup(
      [inboundCall()],
      [
        {
          id: "ev_out",
          integration_id: "int_1",
          organization_id: ORG,
          kind: "call_outcome",
          status: "ok",
          interaction_id: "20261118/abc",
          detail: { outcome: "booked" },
        },
      ],
    );
    const result = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    assert.equal(result.candidates, 0);
    assert.equal(s.t("leads").length, 0);
  });

  test("a late tool call after a recovery is a duplicate: no second lead or audit row", async () => {
    const s = setup([inboundCall()]);
    await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    const late = await recordCallOutcome({ supabaseAdmin: s.db.client }, AUTH, "20261118/abc", {
      outcome: "callback_requested",
      customerName: "Asha",
      callerNumber: CALLER,
      optedOut: "no",
      source: "tool",
    });
    assert.deepEqual(late, { duplicate: true, leadId: null });
    assert.equal(s.outcomes("20261118/abc").length, 1);
    assert.equal(s.t("leads").length, 1);
  });

  test("concurrent recoveries and a tool call record one outcome and one lead", async () => {
    const s = setup([inboundCall()]);
    await Promise.all([
      reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED }),
      reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED }),
      recordCallOutcome({ supabaseAdmin: s.db.client }, AUTH, "20261118/abc", {
        outcome: "callback_requested",
        customerName: "Asha",
        callerNumber: CALLER,
        optedOut: "no",
        source: "tool",
      }),
    ]);
    assert.equal(s.outcomes("20261118/abc").length, 1);
    assert.equal(s.t("leads").length, 1);
  });

  test("recent calls wait for the tool; calls without final variables, test calls and unknown workspaces are skipped", async () => {
    const s = setup([
      inboundCall({ id: "recent", provider_call_id: "i-recent", ended_at: minutesAgo(2) }),
      inboundCall({ id: "novars", provider_call_id: "i-novars", final_agent_variables: null }),
      inboundCall({ id: "outbound", provider_call_id: "i-out", direction: "outbound" }),
      inboundCall({ id: "test", provider_call_id: "i-test", caller_number: "+919999999999" }),
      inboundCall({ id: "orphan", provider_call_id: "i-orphan", organization_id: "org_none" }),
    ]);
    const result = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    assert.equal(result.candidates, 2, "the test call and the orphan");
    assert.equal(result.recorded, 1);
    assert.equal(result.noIntegration, 1);
    assert.equal(s.outcomes("i-recent").length, 0);
    assert.equal(s.outcomes("i-novars").length, 0);
    assert.equal(s.outcomes("i-out").length, 0);
    assert.equal((s.outcomes("i-test")[0]!["detail"] as Row)["test_call"], true);
    assert.equal(s.t("leads").length, 0, "a test caller never becomes a lead");
  });

  test("a failure on one call is counted and the rest continue", async () => {
    const s = setup([
      inboundCall({ id: "a", provider_call_id: "i-a", ended_at: minutesAgo(30) }),
      inboundCall({ id: "b", provider_call_id: "i-b", ended_at: minutesAgo(20) }),
    ]);
    s.db.failNext("sarvam_agent_events", "insert", { message: "connection reset" });
    const original = console.error;
    console.error = () => {};
    let result;
    try {
      result = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    } finally {
      console.error = original;
    }
    assert.equal(result.errors, 1);
    assert.equal(result.recorded, 1);
    // The failed one is picked up by the next run.
    const again = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    assert.equal(again.recorded, 1);
    assert.equal(s.t("leads").length, 2);
  });
});

describe("outcome and lead: the crash window between the two writes", () => {
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.error;
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.error = original;
    }
  };

  const toolCall = (s: ReturnType<typeof setup>) =>
    recordCallOutcome({ supabaseAdmin: s.db.client }, AUTH, "20261118/abc", {
      outcome: "callback_requested",
      customerName: "Asha",
      callerNumber: CALLER,
      optedOut: "no",
      source: "tool",
    });

  test("the lead write fails after the tool recorded the outcome: the sweep saves it later, exactly once", async () => {
    const s = setup([inboundCall()]);
    s.db.failNext("leads", "insert", { message: "connection reset" });
    assert.deepEqual(await quiet(() => toolCall(s)), { duplicate: false, leadId: null });
    assert.equal(s.t("leads").length, 0, "the outcome row exists, the lead does not");
    const due = s.outcomes("20261118/abc")[0]!["detail"] as Row;
    assert.ok(due["lead"], "the outcome row keeps the due lead (outbox)");
    assert.equal(due["lead_id"], undefined);

    const sweep = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    assert.equal(sweep.candidates, 0, "the outcome itself is not re-recorded");
    assert.equal(sweep.leadsCompleted, 1);
    assert.equal(s.t("leads").length, 1);
    const expectedId = await callLeadId("int_1", "20261118/abc");
    assert.equal(s.t("leads")[0]!["id"], expectedId, "the call's deterministic lead id");
    assert.equal((s.outcomes("20261118/abc")[0]!["detail"] as Row)["lead_id"], expectedId);

    const again = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    assert.equal(again.leadsCompleted, 0);
    assert.equal(s.t("leads").length, 1, "never a second lead");
    assert.equal(
      s.t("sarvam_agent_events").filter((e) => e["kind"] === "lead" && e["status"] === "ok").length,
      1,
      "one lead audit record",
    );
  });

  test("the lead is saved but the outcome row is not updated: the sweep finds it and adds nothing", async () => {
    const s = setup([inboundCall()]);
    s.db.failNext("sarvam_agent_events", "update", { message: "connection reset" });
    await assert.rejects(quiet(() => toolCall(s)));
    assert.equal(s.t("leads").length, 1);
    assert.equal((s.outcomes("20261118/abc")[0]!["detail"] as Row)["lead_id"], undefined);
    const sweep = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    assert.equal(sweep.leadsCompleted, 1, "completed by finding the existing lead");
    assert.equal(s.t("leads").length, 1);
    assert.ok((s.outcomes("20261118/abc")[0]!["detail"] as Row)["lead_id"]);
    assert.equal(
      s.t("sarvam_agent_events").filter((e) => e["kind"] === "lead" && e["status"] === "ok").length,
      1,
      "the lead was audited once, when it was created",
    );
  });

  test("a retried tool call completes a lead its first attempt did not save", async () => {
    const s = setup([]);
    const call = () =>
      recordCallOutcome({ supabaseAdmin: s.db.client }, AUTH, "i-tool", {
        outcome: "callback_requested",
        customerName: "Asha",
        callerNumber: CALLER,
        optedOut: "no",
        source: "tool",
      });
    s.db.failNext("leads", "insert", { message: "timeout" });
    const first = await quiet(call);
    assert.deepEqual(first, { duplicate: false, leadId: null });
    assert.equal(s.t("leads").length, 0);
    assert.deepEqual(await call(), { duplicate: true, leadId: null });
    assert.equal(s.t("leads").length, 1);
    assert.deepEqual(await call(), { duplicate: true, leadId: null });
    assert.equal(s.t("leads").length, 1);
  });

  test("a lead the team deleted after it was saved is never recreated", async () => {
    const s = setup([inboundCall()]);
    await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    s.db.tables["leads"]!.length = 0; // deleted by staff
    const again = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    assert.equal(again.leadsCompleted, 0);
    assert.equal(s.t("leads").length, 0);
  });

  test("an opt-out finds the call's lead by its deterministic id even without a callback record", async () => {
    const s = setup([]);
    const id = await callLeadId("int_1", "i-opt");
    // A callback lead whose audit row was never written (the process stopped after the insert).
    s.t("leads").push({ id, organization_id: ORG, status: "new", phone: CALLER });
    await recordCallOutcome({ supabaseAdmin: s.db.client }, AUTH, "i-opt", {
      outcome: "callback_requested",
      callerNumber: CALLER,
      optedOut: "yes",
      source: "tool",
    });
    assert.equal(s.t("leads")[0]!["status"], "do_not_contact");
    assert.equal(s.t("leads").length, 1);
  });
});

describe("reconciliation enforces the inbound admission gate", () => {
  const ORG_B = "org_b";
  /** Two workspaces, each with an integration, agent and one missing outcome. */
  function twoWorkspaces() {
    const s = setup([
      inboundCall({ id: "call_a", provider_call_id: "i-a" }),
      inboundCall({ id: "call_b", provider_call_id: "i-b", organization_id: ORG_B }),
    ]);
    s.t("sarvam_agent_integrations").push({
      id: "int_b",
      organization_id: ORG_B,
      agent_config_id: "agent_b",
      status: "active",
      expires_at: null,
      test_caller_numbers: [],
      role: "inbound",
    });
    s.t("agent_configs").push({ id: "agent_b", organization_id: ORG_B, business_id: "biz_b" });
    return s;
  }
  const deny = (reason: string) => async (): Promise<{ admitted: false; reason: never }> => ({
    admitted: false,
    reason: reason as never,
  });

  for (const [label, reason] of [
    ["paused (inbound turned off)", "inbound_disabled"],
    ["suspended workspace", "organization_inactive"],
    ["unverified number", "not_verified"],
    ["transient lookup failure", "lookup_failed"],
  ] as const) {
    test(`${label}: no outcome or lead, and the call stays eligible`, async () => {
      const s = setup([inboundCall()]);
      const first = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: deny(reason) });
      assert.equal(first.notAdmitted, 1);
      assert.equal(first.recorded, 0);
      assert.equal(s.outcomes("20261118/abc").length, 0, "no outcome written");
      assert.equal(s.t("leads").length, 0, "no lead written");
      // Once admitted (still inside the window), the same call is recovered.
      const later = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
      assert.equal(later.recorded, 1);
      assert.equal(s.t("leads").length, 1);
    });
  }

  test("an admission check that throws is treated as not admitted", async () => {
    const s = setup([inboundCall()]);
    const result = await reconcileCallOutcomes(s.db.client, {
      now: NOW,
      admission: async () => {
        throw new Error("connection reset");
      },
    });
    assert.equal(result.notAdmitted, 1);
    assert.equal(result.errors, 0);
    assert.equal(s.outcomes("20261118/abc").length, 0);
  });

  test("each workspace is checked on its own, with its own agent", async () => {
    const s = twoWorkspaces();
    const asked: Record<string, string>[] = [];
    const result = await reconcileCallOutcomes(s.db.client, {
      now: NOW,
      admission: async (_admin, input) => {
        asked.push({ ...input } as Record<string, string>);
        return input.organizationId === ORG
          ? { admitted: true as const, numberIds: [], deploymentIds: [] }
          : { admitted: false as const, reason: "not_verified" as const };
      },
    });
    assert.equal(result.recorded, 1);
    assert.equal(result.notAdmitted, 1);
    assert.equal(s.outcomes("i-a").length, 1);
    assert.equal(s.outcomes("i-b").length, 0, "the denied workspace gets nothing");
    assert.deepEqual(
      asked.sort((x, y) => x["organizationId"]!.localeCompare(y["organizationId"]!)),
      [
        { organizationId: ORG, agentConfigId: "agent_1" },
        { organizationId: ORG_B, agentConfigId: "agent_b" },
      ],
      "checked once per workspace, with that workspace's own agent",
    );
    assert.ok(s.t("leads").every((l) => l["organization_id"] === ORG));
  });

  test("by default the real gate runs and fails closed (no number or deployment on record)", async () => {
    const s = setup([inboundCall()]);
    const result = await reconcileCallOutcomes(s.db.client, { now: NOW });
    assert.equal(result.notAdmitted, 1);
    assert.equal(s.outcomes("20261118/abc").length, 0);
    assert.equal(s.t("leads").length, 0);
  });

  test("a due lead is not completed for a workspace that is not admitted", async () => {
    const s = setup([inboundCall()]);
    s.db.failNext("leads", "insert", { message: "timeout" });
    await recordCallOutcome({ supabaseAdmin: s.db.client }, AUTH, "20261118/abc", {
      outcome: "callback_requested",
      customerName: "Asha",
      callerNumber: CALLER,
      optedOut: "no",
      source: "tool",
    });
    assert.equal(s.t("leads").length, 0);
    const denied = await reconcileCallOutcomes(s.db.client, {
      now: NOW,
      admission: deny("inbound_disabled"),
    });
    assert.equal(denied.leadsCompleted, 0);
    assert.equal(s.t("leads").length, 0);
    const admitted = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    assert.equal(admitted.leadsCompleted, 1);
    assert.equal(s.t("leads").length, 1);
  });
});

describe("reconciliation reaches every eligible row (no starvation)", () => {
  test("missing outcomes: calls that keep being skipped never hide a newer one", async () => {
    const ORG_X = "org_x"; // has no integration: skipped every run
    const calls = Array.from({ length: 9 }, (_, i) =>
      inboundCall({
        id: `stuck_${i}`,
        provider_call_id: `i-stuck-${i}`,
        organization_id: ORG_X,
        ended_at: minutesAgo(60 * 24 * 6 - i),
      }),
    );
    calls.push(inboundCall({ id: "zz_new", provider_call_id: "i-new", ended_at: minutesAgo(15) }));
    const s = setup(calls);
    const result = await reconcileCallOutcomes(s.db.client, {
      now: NOW,
      limit: 2,
      admission: ADMITTED,
    });
    assert.equal(result.noIntegration, 9);
    assert.equal(result.recorded, 1, "the newest call is reached in the same run");
    assert.equal(s.outcomes("i-new").length, 1);
  });

  test("due leads: rows that keep failing never hide a newer due lead", async () => {
    const ORG_X = "org_x";
    const s = setup([]);
    for (let i = 0; i < 9; i++)
      s.t("sarvam_agent_events").push({
        id: `ev_stuck_${i}`,
        integration_id: "int_x",
        organization_id: ORG_X, // no integration: skipped every run
        kind: "call_outcome",
        status: "ok",
        interaction_id: `i-stuck-${i}`,
        detail: { lead: { name: "X", phone: CALLER, asked_about: null, notes: null } },
        created_at: minutesAgo(60 * 24 * 6),
      });
    s.t("sarvam_agent_events").push({
      id: "zz_ev_new",
      integration_id: "int_1",
      organization_id: ORG,
      kind: "call_outcome",
      status: "ok",
      interaction_id: "i-new",
      detail: { lead: { name: "Asha", phone: CALLER, asked_about: null, notes: null } },
      created_at: minutesAgo(5),
    });
    const result = await reconcileCallOutcomes(s.db.client, {
      now: NOW,
      limit: 2,
      admission: ADMITTED,
    });
    assert.equal(result.leadsCompleted, 1);
    assert.equal(s.t("leads").length, 1);
    assert.equal(s.t("leads")[0]!["id"], await callLeadId("int_1", "i-new"));
  });

  test("completed outcome rows are never selected as due", async () => {
    const s = setup([]);
    s.t("sarvam_agent_events").push({
      id: "ev_done",
      integration_id: "int_1",
      organization_id: ORG,
      kind: "call_outcome",
      status: "ok",
      interaction_id: "i-done",
      detail: { lead: { name: "A", phone: CALLER, asked_about: null, notes: null }, lead_id: "x" },
      created_at: minutesAgo(5),
    });
    const result = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    assert.equal(result.leadsCompleted, 0);
    assert.equal(s.t("leads").length, 0);
  });
});

describe("reconciliation past one run's page budget (rotating keyset)", () => {
  // 40 uuid-shaped ids spread over the whole id space; budget 2 rows x 3 pages = 6 per run.
  const uuid = (i: number) =>
    `${((i * 251) % 256).toString(16).padStart(2, "0")}${String(i).padStart(6, "0")}-0000-4000-8000-000000000000`;
  const budget = { limit: 2, maxPages: 3, admission: ADMITTED };

  test("the start is deterministic, one of 64 evenly spaced ids, advancing every five minutes", () => {
    assert.equal(
      reconcileRotationStart(NOW),
      reconcileRotationStart(new Date(NOW.getTime() + 60_000)),
    );
    const starts = new Set(
      Array.from({ length: OUTCOME_RECONCILE_ROTATION_POINTS }, (_, k) =>
        reconcileRotationStart(new Date(NOW.getTime() + k * 5 * 60_000)),
      ),
    );
    assert.equal(starts.size, OUTCOME_RECONCILE_ROTATION_POINTS);
    assert.equal(
      reconcileRotationStart(
        new Date(NOW.getTime() + OUTCOME_RECONCILE_ROTATION_POINTS * 5 * 60_000),
      ),
      reconcileRotationStart(NOW),
    );
  });

  test("missing outcomes: one run reads its budget; successive runs reach every call exactly once", async () => {
    const calls = Array.from({ length: 40 }, (_, i) =>
      inboundCall({ id: uuid(i), provider_call_id: `i-${i}`, ended_at: minutesAgo(30) }),
    );
    const s = setup(calls);
    const first = await reconcileCallOutcomes(s.db.client, { now: NOW, ...budget });
    assert.equal(first.candidates, 6, "one run never reads more than its budget");
    assert.equal(first.recorded, 6);
    let runs = 1;
    const recorded = () =>
      s.t("sarvam_agent_events").filter((e) => e["kind"] === "call_outcome").length;
    while (recorded() < 40 && runs < OUTCOME_RECONCILE_ROTATION_POINTS) {
      const now = new Date(NOW.getTime() + runs * 5 * 60_000);
      await reconcileCallOutcomes(s.db.client, { now, ...budget });
      runs++;
    }
    assert.ok(
      runs < OUTCOME_RECONCILE_ROTATION_POINTS,
      `all reached within one rotation (${runs} runs)`,
    );
    for (let i = 0; i < 40; i++) assert.equal(s.outcomes(`i-${i}`).length, 1, `call ${i}`);
    assert.equal(s.t("leads").length, 40, "one lead per call, none twice");
  });

  test("due leads: rows past the budget are completed by later runs; denied workspaces stay untouched", async () => {
    const s = setup([]);
    for (let i = 0; i < 40; i++)
      s.t("sarvam_agent_events").push({
        id: uuid(i),
        integration_id: "int_1",
        organization_id: ORG,
        kind: "call_outcome",
        status: "ok",
        interaction_id: `i-${i}`,
        detail: { lead: { name: "A", phone: CALLER, asked_about: null, notes: null } },
        created_at: minutesAgo(10),
      });
    const denied = async () => ({ admitted: false as const, reason: "no_deployment" });
    const blocked = await reconcileCallOutcomes(s.db.client, {
      now: NOW,
      ...budget,
      admission: denied as never,
    });
    assert.equal(blocked.leadsCompleted, 0);
    assert.equal(s.t("leads").length, 0, "not admitted: nothing written");
    for (let k = 0; k < OUTCOME_RECONCILE_ROTATION_POINTS; k++)
      await reconcileCallOutcomes(s.db.client, {
        now: new Date(NOW.getTime() + k * 5 * 60_000),
        ...budget,
      });
    assert.equal(s.t("leads").length, 40);
    assert.equal(new Set(s.t("leads").map((l) => l["id"])).size, 40, "no lead twice");
  });

  test("rows older than the seven-day window are never read, whatever the rotation", async () => {
    const calls = Array.from({ length: 10 }, (_, i) =>
      inboundCall({
        id: uuid(i),
        provider_call_id: `old-${i}`,
        ended_at: minutesAgo(60 * 24 * 7 + 5),
      }),
    );
    const s = setup(calls);
    for (let k = 0; k < OUTCOME_RECONCILE_ROTATION_POINTS; k++)
      await reconcileCallOutcomes(s.db.client, {
        now: new Date(NOW.getTime() + k * 5 * 60_000),
        ...budget,
      });
    assert.equal(s.t("sarvam_agent_events").length, 0);
  });
});

describe("an opt-out from the outbound agent's end-of-call tool reaches do-not-call", () => {
  const OUTBOUND: AuthenticatedIntegration = {
    ...AUTH,
    integrationId: "int_out",
    role: "outbound",
  };
  const dialled = (to: string, startedAt = new Date().toISOString()): Row => ({
    id: `call_${to}`,
    organization_id: ORG,
    provider: "sarvam",
    direction: "outbound",
    status: "in_progress",
    destination_number: to,
    started_at: startedAt,
  });

  test("a number ClickAI dialled in the last hour is put on do-not-call at once", async () => {
    const s = setup([dialled(CALLER)]);
    await recordCallOutcome({ supabaseAdmin: s.db.client }, OUTBOUND, "i-out", {
      outcome: "not_interested",
      callerNumber: CALLER,
      optedOut: "yes",
      source: "tool",
    });
    const contact = s.t("contacts").find((c) => c["phone"] === CALLER);
    assert.equal(contact?.["opted_out"], true);
  });

  test("never for a number ClickAI did not dial (a test chat or a forged caller number)", async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const s = setup([dialled("+919876500001"), dialled(CALLER, old)]);
    await recordCallOutcome({ supabaseAdmin: s.db.client }, OUTBOUND, "i-out2", {
      outcome: "not_interested",
      callerNumber: CALLER,
      optedOut: "yes",
      source: "tool",
    });
    assert.equal(s.t("contacts").length, 0);
  });

  test("an inbound opt-out marks the lead; the number check reads it (no contact is created)", async () => {
    const s = setup([dialled(CALLER)]);
    await recordCallOutcome({ supabaseAdmin: s.db.client }, AUTH, "i-in", {
      outcome: "not_interested",
      callerNumber: CALLER,
      optedOut: "yes",
      source: "tool",
    });
    assert.equal(s.t("contacts").length, 0);
  });
});
