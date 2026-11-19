import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import { reconcileCallOutcomes } from "./call-outcome-reconciliation.server.ts";
import {
  recordCallOutcome,
  resolveLeadDirection,
  type AuthenticatedIntegration,
} from "./sarvam-agent-api.server.ts";

/**
 * Which end-of-call outcomes become leads, by call direction. Sarvam's
 * call_outcome uses the inbound taxonomy: on an outbound call a booking the
 * agent must refuse reads as callback_requested. Those outcomes must never
 * become leads; genuine inbound callback requests must, including from a
 * number the clinic recently called. Direction comes only from stored
 * identifiers (interaction id, call direction, ownership), never a time window.
 */

type Row = Record<string, unknown>;
const ORG = "org_a";
const NOW = new Date("2026-11-19T10:00:00Z");
const CALLER = "+919876500077";
const CLINIC = "+917965860061";
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const ADMITTED = async () => ({ admitted: true as const, numberIds: [], deploymentIds: [] });

const AUTH: AuthenticatedIntegration = {
  integrationId: "int_1",
  organizationId: ORG,
  agentConfigId: "agent_1",
  businessId: "biz_1",
  testCallerNumbers: [],
};

function setup(calls: Row[] = [], numbers: Row[] = []) {
  const db = memorySupabase({
    tables: {
      sarvam_agent_integrations: [
        {
          id: "int_1",
          organization_id: ORG,
          agent_config_id: "agent_1",
          status: "active",
          expires_at: null,
          test_caller_numbers: [],
        },
      ],
      agent_configs: [{ id: "agent_1", organization_id: ORG, business_id: "biz_1" }],
      call_logs: calls,
      phone_numbers: numbers,
      sarvam_agent_events: [],
      leads: [],
    },
    uniques: [
      { table: "leads", key: (r) => String(r["id"]) },
      {
        table: "sarvam_agent_events",
        key: (r) =>
          r["kind"] === "call_outcome" && r["interaction_id"]
            ? `${r["integration_id"]}:${r["interaction_id"]}`
            : null,
      },
    ],
  });
  const deps = { supabaseAdmin: db.client, now: () => NOW };
  const outcome = (interaction: string) =>
    (db.tables["sarvam_agent_events"] ?? []).find(
      (e) => e["kind"] === "call_outcome" && e["interaction_id"] === interaction,
    );
  const detail = (interaction: string) => (outcome(interaction)?.["detail"] ?? {}) as Row;
  const leads = () => db.tables["leads"] ?? [];
  const sweep = () => reconcileCallOutcomes(db.client, { now: NOW, admission: ADMITTED });
  return { db, deps, detail, leads, sweep };
}

/** A ClickAI outbound call: written before dialling, `initiated` until Sarvam's result arrives. */
const outboundCall = (over: Row = {}): Row => ({
  id: "call_out",
  organization_id: ORG,
  provider: "sarvam",
  direction: "outbound",
  status: "initiated",
  provider_call_id: "att_1",
  provider_metadata: {},
  destination_number: CALLER,
  created_at: minutesAgo(3),
  ...over,
});

const callback = (over: Record<string, unknown> = {}) => ({
  outcome: "callback_requested",
  summary: "Wants an appointment.",
  customerName: "Ravi",
  callerNumber: CALLER,
  interest: "root canal",
  requestedSlot: "",
  optedOut: "no",
  source: "tool" as const,
  ...over,
});

describe("call_outcome leads by call direction", () => {
  test("outbound booking refusal: held while the call is open, dropped once Sarvam links it", async () => {
    const s = setup([outboundCall()]);
    const result = await recordCallOutcome(s.deps, AUTH, "i-out", callback());
    assert.equal(result.leadId, null);
    assert.equal(s.leads().length, 0, "no lead while the direction is unknown");
    assert.ok(s.detail("i-out")["lead"], "held as due, not saved");

    // Sarvam's result webhook arrives: the outbound row now carries the interaction id.
    const call = s.db.tables["call_logs"]![0]!;
    call["status"] = "completed";
    call["provider_metadata"] = { interaction_id: "i-out" };
    await s.sweep();
    assert.equal(s.leads().length, 0);
    assert.equal(s.detail("i-out")["lead"], undefined, "sweep stops looking");
    assert.equal(s.detail("i-out")["lead_skipped"], "outbound");
    await s.sweep();
    assert.equal(s.leads().length, 0, "still none on later runs");
  });

  test("outbound booking refusal when Sarvam's result already arrived: dropped at once", async () => {
    const s = setup([
      outboundCall({ status: "completed", provider_metadata: { interaction_id: "i-out" } }),
    ]);
    await recordCallOutcome(s.deps, AUTH, "i-out", callback());
    assert.equal(s.leads().length, 0);
    assert.equal(s.detail("i-out")["lead_skipped"], "outbound");
  });

  test("normal inbound callback request: one lead, at once", async () => {
    const s = setup();
    const result = await recordCallOutcome(s.deps, AUTH, "i-in", callback());
    assert.ok(result.leadId);
    assert.equal(s.leads().length, 1);
    assert.equal(s.leads()[0]!["phone"], CALLER);
    assert.equal(s.detail("i-in")["lead_id"], result.leadId);
  });

  test("inbound callback from a number the clinic dialled minutes ago still becomes a lead", async () => {
    const s = setup([
      outboundCall({
        status: "completed",
        provider_metadata: { interaction_id: "i-out-earlier" },
        created_at: minutesAgo(4),
        ended_at: minutesAgo(1),
      }),
    ]);
    const result = await recordCallOutcome(s.deps, AUTH, "i-in", callback());
    assert.ok(result.leadId, "same number, different interaction: inbound");
    assert.equal(s.leads().length, 1);
  });

  test("inbound callback while an unrelated outbound call is open: held, then saved once linked", async () => {
    const s = setup([outboundCall({ destination_number: "+919811122233" })]);
    await recordCallOutcome(s.deps, AUTH, "i-in", callback());
    assert.equal(s.leads().length, 0, "held: an open outbound call could be this one");

    // The inbound call-end webhook stores the call under its interaction id.
    s.db.tables["call_logs"]!.push({
      id: "call_in",
      organization_id: ORG,
      provider: "sarvam",
      direction: "inbound",
      status: "completed",
      provider_call_id: "i-in",
      caller_number: CALLER,
      created_at: minutesAgo(1),
    });
    await s.sweep();
    assert.equal(s.leads().length, 1);
    assert.equal(s.leads()[0]!["phone"], CALLER);
    await s.sweep();
    assert.equal(s.leads().length, 1, "never doubled");
  });

  test("opt-out before any interest: no lead", async () => {
    const s = setup([outboundCall({ provider_metadata: { interaction_id: "i-out" } })]);
    await recordCallOutcome(
      s.deps,
      AUTH,
      "i-out",
      callback({ outcome: "not_interested", interest: "", optedOut: "yes" }),
    );
    assert.equal(s.leads().length, 0);
    assert.equal(s.detail("i-out")["opted_out"], true);
    assert.equal(s.detail("i-out")["lead"], undefined);
  });

  test("opt-out after showing interest: no lead, inbound or outbound", async () => {
    for (const calls of [[], [outboundCall()]]) {
      const s = setup(calls);
      await recordCallOutcome(s.deps, AUTH, "i-x", callback({ optedOut: "yes" }));
      assert.equal(s.leads().length, 0, `${calls.length} open outbound calls`);
      assert.equal(s.detail("i-x")["lead"], undefined);
    }
  });

  test("wrong number (not a request for anything): no lead", async () => {
    const s = setup();
    await recordCallOutcome(
      s.deps,
      AUTH,
      "i-wrong",
      callback({ outcome: "not_interested", customerName: "", interest: "" }),
    );
    assert.equal(s.leads().length, 0);
  });

  test("the clinic's own number as caller id is never a customer lead", async () => {
    const s = setup([], [{ id: "pn_1", organization_id: ORG, e164: CLINIC, status: "active" }]);
    await recordCallOutcome(s.deps, AUTH, "i-own", callback({ callerNumber: CLINIC }));
    assert.equal(s.leads().length, 0);
    assert.equal(s.detail("i-own")["lead_skipped"], "own_number");
  });

  test("another customer's calls never decide this customer's direction", async () => {
    const s = setup([
      outboundCall({ organization_id: "org_b", provider_metadata: { interaction_id: "i-in" } }),
    ]);
    assert.equal(await resolveLeadDirection(s.deps, AUTH, "i-in", CALLER), "inbound");
  });
});
