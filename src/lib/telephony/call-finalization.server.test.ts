import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finalizeTerminalCall, finalizeTerminalCallSafely } from "./call-finalization.server.ts";

/**
 * Orchestration of finalizeTerminalCall against a scripted client: which
 * database functions it calls, with what, and how a failing step is handled.
 * The exactly-once guarantees themselves (row lock, lease fencing, effects and
 * checkpoint in one transaction) are tested against real PostgreSQL in
 * supabase/migrations/sarvam_outbound_call_finalization.pg.test.ts.
 */

type Rpc = { fn: string; args: Record<string, unknown> };
type RpcReply = { data?: unknown; error?: { message: string } | null } | Error;

const CALL = {
  id: "call_1",
  organization_id: "org_1",
  status: "completed",
  duration_seconds: 61,
  campaign_id: "camp_1",
  campaign_contact_id: "cc_1",
  contact_id: "contact_1",
  final_agent_variables: { interest_level: "high" },
  billing_applied_at: null,
  campaign_applied_at: null,
};
const CAMPAIGN = {
  max_attempts: 3,
  retry_after_minutes: 60,
  retry_statuses: ["no_answer", "busy"],
};
const RATE = { customerAmountPerMinute: 500, providerCostPerMinute: 200, currency: "INR" };

function fakeClient(opts: {
  call?: Record<string, unknown> | null;
  campaign?: Record<string, unknown> | null;
  contact?: Record<string, unknown> | null;
  replies?: Partial<Record<string, RpcReply>>;
}) {
  const rpcs: Rpc[] = [];
  const defaults: Record<string, RpcReply> = {
    claim_call_finalization: { data: "token_1" },
    apply_call_billing: { data: "applied" },
    apply_call_campaign_outcome: { data: { result: "applied" } },
    complete_call_finalization: { data: true },
    fail_call_finalization: { data: true },
  };
  const rows: Record<string, unknown> = {
    call_logs: opts.call === undefined ? CALL : opts.call,
    campaigns: opts.campaign === undefined ? CAMPAIGN : opts.campaign,
    campaign_contacts: opts.contact === undefined ? { attempts: 1 } : opts.contact,
  };
  const client = {
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      const reply = opts.replies?.[fn] ?? defaults[fn];
      if (reply instanceof Error) throw reply;
      return { data: reply?.data ?? null, error: reply?.error ?? null };
    },
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        single: () => builder,
        maybeSingle: () => builder,
        then: (resolve: (r: unknown) => void) =>
          resolve({
            data: rows[table] ?? null,
            error: rows[table] ? null : { message: "missing" },
          }),
      };
      return builder;
    },
  };
  return { client: client as never, rpcs, names: () => rpcs.map((r) => r.fn) };
}

const getRate = async () => RATE;

describe("finalizeTerminalCall — orchestration", () => {
  test("no lease (done already, or another holder): nothing else runs", async () => {
    const f = fakeClient({ replies: { claim_call_finalization: { data: null } } });
    assert.deepEqual(await finalizeTerminalCall(f.client, "call_1", { getRate }), {
      state: "skipped",
    });
    assert.deepEqual(f.names(), ["claim_call_finalization"]);
  });

  test("a campaign call: bills by whole minutes, applies the decision, then completes", async () => {
    const f = fakeClient({});
    assert.deepEqual(await finalizeTerminalCall(f.client, "call_1", { getRate }), {
      state: "done",
    });
    assert.deepEqual(f.names(), [
      "claim_call_finalization",
      "apply_call_billing",
      "apply_call_campaign_outcome",
      "complete_call_finalization",
    ]);
    const billing = f.rpcs[1]!.args;
    assert.deepEqual(billing, {
      _call: "call_1",
      _token: "token_1",
      _amount: 1000, // 61s -> 2 minutes x 500
      _provider_cost: 400,
      _currency: "INR",
      _minutes: 2,
      _description: "outbound call · 2 min",
    });
    const campaign = f.rpcs[2]!.args;
    assert.equal(campaign["_token"], "token_1");
    assert.equal(campaign["_contact_status"], "completed");
    assert.equal(campaign["_next_attempt_at"], null);
    assert.equal(campaign["_create_lead"], true);
    assert.equal(campaign["_lead_score"], "hot");
    assert.equal(campaign["_lead_notes"], JSON.stringify({ interest_level: "high" }));
  });

  test("a retryable outcome under max attempts schedules a retry", async () => {
    const f = fakeClient({ call: { ...CALL, status: "no_answer", duration_seconds: 0 } });
    await finalizeTerminalCall(f.client, "call_1", { getRate });
    const campaign = f.rpcs.find((r) => r.fn === "apply_call_campaign_outcome")!.args;
    assert.equal(campaign["_contact_status"], "retry_scheduled");
    assert.ok(campaign["_next_attempt_at"]);
    assert.equal(campaign["_create_lead"], false);
    const billing = f.rpcs.find((r) => r.fn === "apply_call_billing")!.args;
    assert.equal(billing["_amount"], 0);
    assert.equal(billing["_minutes"], 0);
  });

  test("a call without a campaign still sets the campaign checkpoint (no outcome, no lead)", async () => {
    const f = fakeClient({ call: { ...CALL, campaign_id: null, campaign_contact_id: null } });
    assert.equal((await finalizeTerminalCall(f.client, "call_1", { getRate })).state, "done");
    const campaign = f.rpcs.find((r) => r.fn === "apply_call_campaign_outcome")!.args;
    assert.equal(campaign["_contact_status"], null);
    assert.equal(campaign["_create_lead"], false);
  });

  test("a failed billing step never stops the campaign step; the call is marked failed", async () => {
    const f = fakeClient({ replies: { apply_call_billing: { error: { message: "db down" } } } });
    const result = await finalizeTerminalCall(f.client, "call_1", { getRate });
    assert.equal(result.state, "failed");
    assert.match((result as { error: string }).error, /billing: db down/);
    assert.deepEqual(f.names(), [
      "claim_call_finalization",
      "apply_call_billing",
      "apply_call_campaign_outcome",
      "fail_call_finalization",
    ]);
    assert.equal(f.rpcs[3]!.args["_token"], "token_1");
  });

  test("a failed rate lookup is a billing failure; the campaign step still runs", async () => {
    const f = fakeClient({});
    const result = await finalizeTerminalCall(f.client, "call_1", {
      getRate: async () => {
        throw new Error("pricing unavailable");
      },
    });
    assert.match((result as { error: string }).error, /billing: pricing unavailable/);
    assert.ok(f.names().includes("apply_call_campaign_outcome"));
    assert.ok(!f.names().includes("apply_call_billing"));
  });

  test("a failed campaign step after billing: billing stays applied, the call is marked failed", async () => {
    const f = fakeClient({
      replies: { apply_call_campaign_outcome: { error: { message: "lock timeout" } } },
    });
    const result = await finalizeTerminalCall(f.client, "call_1", { getRate });
    assert.match((result as { error: string }).error, /campaign: lock timeout/);
    assert.deepEqual(f.names().slice(-1), ["fail_call_finalization"]);
    assert.ok(!f.names().includes("complete_call_finalization"));
  });

  test("a step whose checkpoint is already set is not run again", async () => {
    const f = fakeClient({ call: { ...CALL, billing_applied_at: "2026-11-10T00:00:00Z" } });
    assert.equal((await finalizeTerminalCall(f.client, "call_1", { getRate })).state, "done");
    assert.ok(!f.names().includes("apply_call_billing"));
  });

  test("a lost lease (stale worker) is a failure, never a silent success", async () => {
    const f = fakeClient({ replies: { apply_call_billing: { data: "lease_lost" } } });
    const result = await finalizeTerminalCall(f.client, "call_1", { getRate });
    assert.match((result as { error: string }).error, /billing: the lease was lost/);
  });

  test("completion refused (checkpoints missing or lease lost) is a failure", async () => {
    const f = fakeClient({ replies: { complete_call_finalization: { data: false } } });
    const result = await finalizeTerminalCall(f.client, "call_1", { getRate });
    assert.equal(result.state, "failed");
    assert.ok(f.names().includes("fail_call_finalization"));
  });

  test("an opted-out contact from the agent's variables", async () => {
    const f = fakeClient({ call: { ...CALL, final_agent_variables: { do_not_call: true } } });
    await finalizeTerminalCall(f.client, "call_1", { getRate });
    const campaign = f.rpcs.find((r) => r.fn === "apply_call_campaign_outcome")!.args;
    assert.equal(campaign["_contact_status"], "opted_out");
  });

  test("finalizeTerminalCallSafely never throws (the call stays retryable)", async () => {
    const f = fakeClient({ replies: { claim_call_finalization: new Error("network") } });
    await assert.rejects(finalizeTerminalCall(f.client, "call_1", { getRate }), /network/);
    assert.deepEqual(await finalizeTerminalCallSafely(f.client, "call_1", { getRate }), {
      state: "failed",
      error: "network",
    });
  });
});

describe("Phase 1 scope: Sarvam outbound only (source checks)", () => {
  const here = new URL(".", import.meta.url);
  const read = (rel: string) => readFileSync(new URL(rel, here), "utf8").replace(/\r\n/g, "\n");
  const processing = read("telephony-event-processing.server.ts");
  const migration = read(
    "../../../supabase/migrations/20261110090000_sarvam_outbound_call_finalization.sql",
  );

  test("only Sarvam outbound calls are finalized here; every other final status keeps its inline billing", () => {
    assert.match(
      processing,
      /const isSarvamOutbound = \(call: \{ provider: string; direction: string \}\) =>\s*call\.provider === "sarvam" && call\.direction === "outbound";/,
    );
    const finalizeBranch = processing.indexOf(
      "if (TERMINAL_CALL_STATUSES.includes(event.status) && isSarvamOutbound(call)) {",
    );
    const finalize = processing.indexOf(
      "await finalizeTerminalCallSafely(supabaseAdmin, call.id);",
      finalizeBranch,
    );
    const legacy = processing.indexOf("await finalizeCallBilling(", finalizeBranch);
    assert.ok(finalizeBranch > -1 && finalize > finalizeBranch && legacy > finalize);
    assert.match(processing.slice(finalize, legacy), /return;/);
    // The inbound insert path (Sarvam inbound, Exotel, Vobiz) is unchanged.
    assert.match(processing, /await finalizeCallBilling\(call, event\.durationSeconds \?\? 0\);/);
  });

  test("the trigger only marks Sarvam outbound calls, and the migration adds no wallet index", () => {
    assert.match(migration, /IF NEW\.provider = 'sarvam'\s*AND NEW\.direction = 'outbound'/);
    assert.doesNotMatch(migration, /INDEX[^;]*wallet_transactions/i);
    assert.match(migration, /PERFORM public\.debit_wallet_for_call\(/);
  });

  test("operator resolution keeps its event key once the call's status is written", () => {
    const resolution = read("../sarvam-call-resolution.server.ts");
    assert.match(
      resolution,
      /if \(now && isResolvableSarvamCall\(\{ \.\.\.call, status: now\.status \}\)\)\s*await supabaseAdmin\s*\.from\("webhook_events"\)\s*\.delete\(\)/,
    );
  });
});
