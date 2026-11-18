import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import {
  CALL_VARIABLE_RETENTION_MS,
  expireCallVariables,
} from "./call-variable-retention.server.ts";
import {
  OUTCOME_RECONCILE_MAX_AGE_MS,
  reconcileCallOutcomes,
} from "./call-outcome-reconciliation.server.ts";

/** The inbound admission gate, admitted (the real gate is covered in its own tests). */
const ADMITTED = async () => ({ admitted: true as const, numberIds: [], deploymentIds: [] });

/**
 * Seven-day expiry of stored call variables (call_logs.final_agent_variables)
 * against an in-memory database. Only that column may change.
 */

type Row = Record<string, unknown>;
const ORG = "org_a";
const NOW = new Date("2026-11-18T10:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const VARS = { call_outcome: "callback_requested", customer_name: "Asha", opted_out: "no" };

const call = (id: string, over: Row = {}): Row => ({
  id,
  organization_id: ORG,
  provider: "sarvam",
  direction: "inbound",
  status: "completed",
  provider_call_id: `i-${id}`,
  caller_number: "+919876500088",
  ended_at: ago(8 * DAY),
  transcript: [{ role: "user", text: "Hello" }],
  summary: "Caller asked for a callback.",
  finalization_state: null,
  final_agent_variables: { ...VARS },
  ...over,
});

function setup(calls: Row[]) {
  const db = memorySupabase({
    tables: {
      call_logs: calls,
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
      sarvam_agent_events: [
        {
          id: "ev_1",
          integration_id: "int_1",
          organization_id: ORG,
          kind: "call_outcome",
          interaction_id: "i-old",
          status: "ok",
          detail: { opted_out: true, suppressed_lead_id: "lead_1" },
        },
        { id: "ev_2", kind: "lead", status: "ok", organization_id: ORG, detail: {} },
      ],
      leads: [{ id: "lead_1", organization_id: ORG, status: "do_not_contact" }],
      contacts: [{ id: "c_1", organization_id: ORG, opted_out: true }],
      campaign_contacts: [{ id: "cc_1", contact_id: "c_1", status: "opted_out" }],
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
  const row = (id: string) => db.tables["call_logs"]!.find((r) => r["id"] === id)!;
  return { db, row };
}

describe("call variable retention", () => {
  test("the retention period is the seven-day recovery window plus a grace hour", () => {
    assert.equal(OUTCOME_RECONCILE_MAX_AGE_MS, 7 * DAY);
    assert.equal(CALL_VARIABLE_RETENTION_MS, 7 * DAY + HOUR);
  });

  test("expired variables are cleared; everything still inside the window is kept", async () => {
    const s = setup([
      call("old"),
      call("young", { ended_at: ago(6 * DAY) }),
      call("edge", { ended_at: ago(7 * DAY + 30 * 60 * 1000) }), // window closed, grace hour not over
      call("out_done", { direction: "outbound", finalization_state: "done" }),
      call("out_pending", {
        direction: "outbound",
        finalization_state: "pending",
        ended_at: ago(30 * DAY),
      }),
      call("out_failed", {
        direction: "outbound",
        finalization_state: "failed",
        ended_at: ago(30 * DAY),
      }),
      call("exotel", { provider: "exotel" }),
    ]);
    const result = await expireCallVariables(s.db.client, { now: NOW });
    assert.deepEqual(result, { inboundCleared: 1, outboundCleared: 1, metadataSanitized: 0 });
    assert.equal(s.row("old")["final_agent_variables"], null);
    assert.equal(s.row("out_done")["final_agent_variables"], null);
    for (const kept of ["young", "edge", "out_pending", "out_failed", "exotel"])
      assert.deepEqual(s.row(kept)["final_agent_variables"], VARS, kept);
  });

  test("a call still inside the recovery window is recovered first, and only cleared later", async () => {
    // Ended 6 days 23 hours ago; the tool call never arrived.
    const s = setup([call("late", { ended_at: ago(7 * DAY - HOUR) })]);
    await expireCallVariables(s.db.client, { now: NOW });
    assert.deepEqual(s.row("late")["final_agent_variables"], VARS, "not cleared yet");
    const recovered = await reconcileCallOutcomes(s.db.client, { now: NOW, admission: ADMITTED });
    assert.equal(recovered.recorded, 1, "reconciliation still had the variables");
    // Two hours later the window and the grace hour are over.
    const later = new Date(NOW.getTime() + 2 * HOUR + 1);
    assert.deepEqual(await expireCallVariables(s.db.client, { now: later }), {
      inboundCleared: 1,
      outboundCleared: 0,
      metadataSanitized: 0,
    });
    assert.equal(s.row("late")["final_agent_variables"], null);
  });

  test("only final_agent_variables changes: call logs, outcomes, leads, audit and opt-outs survive", async () => {
    const s = setup([
      call("old"),
      call("out_done", { direction: "outbound", finalization_state: "done" }),
    ]);
    const snapshot = (table: string) => JSON.parse(JSON.stringify(s.db.tables[table])) as Row[];
    const before = {
      events: snapshot("sarvam_agent_events"),
      leads: snapshot("leads"),
      contacts: snapshot("contacts"),
      campaignContacts: snapshot("campaign_contacts"),
      calls: snapshot("call_logs"),
    };
    await expireCallVariables(s.db.client, { now: NOW });
    assert.deepEqual(snapshot("sarvam_agent_events"), before.events);
    assert.deepEqual(snapshot("leads"), before.leads);
    assert.deepEqual(snapshot("contacts"), before.contacts);
    assert.deepEqual(snapshot("campaign_contacts"), before.campaignContacts);
    assert.equal(s.db.tables["call_logs"]!.length, 2, "no call log deleted");
    for (const [i, after] of snapshot("call_logs").entries()) {
      const { final_agent_variables: _a, updated_at: _u, ...rest } = after;
      const { final_agent_variables: _b, updated_at: _v, ...restBefore } = before.calls[i]!;
      assert.deepEqual(rest, restBefore, "every other column is unchanged");
    }
  });

  test("running it again clears nothing more", async () => {
    const s = setup([call("old"), call("old2")]);
    assert.deepEqual(await expireCallVariables(s.db.client, { now: NOW }), {
      inboundCleared: 2,
      outboundCleared: 0,
      metadataSanitized: 0,
    });
    assert.deepEqual(await expireCallVariables(s.db.client, { now: NOW }), {
      inboundCleared: 0,
      outboundCleared: 0,
      metadataSanitized: 0,
    });
  });

  test("concurrent runs clear each row once and never anything newer", async () => {
    const calls = Array.from({ length: 12 }, (_, i) => call(`old${i}`));
    calls.push(call("young", { ended_at: ago(DAY) }));
    const s = setup(calls);
    const results = await Promise.all([
      expireCallVariables(s.db.client, { now: NOW, limit: 5 }),
      expireCallVariables(s.db.client, { now: NOW, limit: 5 }),
      expireCallVariables(s.db.client, { now: NOW, limit: 5 }),
    ]);
    const cleared = results.reduce((n, r) => n + r.inboundCleared, 0);
    assert.ok(cleared <= 12, "no row counted twice");
    // Keep running until nothing is left, as the hourly job would.
    for (let i = 0; i < 5; i++) await expireCallVariables(s.db.client, { now: NOW, limit: 5 });
    for (let i = 0; i < 12; i++) assert.equal(s.row(`old${i}`)["final_agent_variables"], null);
    assert.deepEqual(s.row("young")["final_agent_variables"], VARS);
  });
});

describe("older provider_metadata is reduced to its identifiers", () => {
  const RAW = {
    app_id: "Conversatio-9c6a04cd-3334",
    interaction_id: "20261112/abc",
    deployment_id: "Smile-Denta-be071be0-703e",
    user_phone_number: "+919876500099",
    agent_phone_number: "+917900000061",
    final_agent_variables: { customer_name: "Asha", faqs: "…" },
    output_agent_variables: { opted_out: "no" },
    interaction_transcript: [{ role: "user", en_text: "Call me on 98765 00099" }],
    recording_url: "https://recordings.example/abc.wav",
    _agent_variables: { final: { customer_name: "Asha" } },
  };
  const LATE = { status: "completed", receivedAt: "2026-11-12T11:00:00Z" };
  const meta = (s: ReturnType<typeof setup>, id: string) => s.row(id)["provider_metadata"] as Row;

  test("an old raw Sarvam row keeps only interaction_id, recording_url, app_id and its late report", async () => {
    const s = setup([
      call("old", { provider_metadata: { ...RAW, late_provider_report: LATE }, updated_at: "u1" }),
      call("young", { ended_at: ago(DAY), provider_metadata: { ...RAW }, updated_at: "u2" }),
      call("clean", { provider_metadata: { interaction_id: "i-clean" }, updated_at: "u3" }),
      call("exotel", {
        provider: "exotel",
        provider_metadata: { From: "+919876500097" },
        updated_at: "u4",
      }),
      call("voice", {
        provider: "livekit_sip",
        provider_metadata: { livekit_room: "room_1", billing: "done", user_phone_number: "+91…" },
        updated_at: "u5",
      }),
    ]);
    const before = JSON.parse(JSON.stringify(s.db.tables["call_logs"])) as Row[];
    const result = await expireCallVariables(s.db.client, { now: NOW });
    assert.equal(result.metadataSanitized, 1);
    assert.deepEqual(meta(s, "old"), {
      interaction_id: "20261112/abc",
      app_id: "Conversatio-9c6a04cd-3334",
      recording_url: "https://recordings.example/abc.wav",
      late_provider_report: LATE,
    });
    const text = JSON.stringify(meta(s, "old"));
    for (const leak of ["+919876500099", "+917900000061", "Asha", "98765", "faqs", "opted_out"])
      assert.ok(!text.includes(leak), leak);
    for (const kept of ["young", "clean", "exotel", "voice"])
      assert.deepEqual(
        meta(s, kept),
        before.find((r) => r["id"] === kept)!["provider_metadata"],
        kept,
      );
    // The call log itself, its transcript and summary are untouched.
    const after = s.row("old");
    const original = before.find((r) => r["id"] === "old")!;
    for (const col of ["id", "status", "transcript", "summary", "caller_number", "ended_at"])
      assert.deepEqual(after[col], original[col], col);
    assert.equal(s.db.tables["call_logs"]!.length, 5);
  });

  test("running it again changes nothing", async () => {
    const s = setup([call("old", { provider_metadata: { ...RAW }, updated_at: "u1" })]);
    assert.equal((await expireCallVariables(s.db.client, { now: NOW })).metadataSanitized, 1);
    assert.equal((await expireCallVariables(s.db.client, { now: NOW })).metadataSanitized, 0);
  });

  test("a write that lands between the read and the cleanup is never overwritten", async () => {
    const s = setup([call("old", { provider_metadata: { ...RAW }, updated_at: "u1" })]);
    const client = s.db.client as unknown as { from: (t: string) => Record<string, unknown> };
    const realFrom = client.from;
    let intercepted = false;
    client.from = (table: string) => {
      const builder = realFrom(table) as Record<string, (...a: unknown[]) => unknown>;
      if (table !== "call_logs" || intercepted) return builder;
      const realUpdate = builder["update"]!;
      builder["update"] = (payload: unknown) => {
        if ((payload as Row)["provider_metadata"] !== undefined && !intercepted) {
          intercepted = true;
          // Another writer (e.g. a late provider report) commits first.
          Object.assign(s.row("old"), {
            provider_metadata: { ...RAW, late_provider_report: LATE },
            updated_at: "u2",
          });
        }
        return realUpdate(payload);
      };
      return builder;
    };
    const first = await expireCallVariables(s.db.client, { now: NOW });
    client.from = realFrom;
    assert.equal(first.metadataSanitized, 0, "the stale copy matched no row");
    assert.deepEqual(meta(s, "old")["late_provider_report"], LATE, "the other write survived");
    const second = await expireCallVariables(s.db.client, { now: NOW });
    assert.equal(second.metadataSanitized, 1);
    assert.deepEqual(meta(s, "old")["late_provider_report"], LATE);
    assert.equal(meta(s, "old")["user_phone_number"], undefined);
  });
});
