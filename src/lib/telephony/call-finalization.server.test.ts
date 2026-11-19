import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finalizeTerminalCall, finalizeTerminalCallSafely } from "./call-finalization.server.ts";
import { callLeadId } from "../sarvam-agent-api.server.ts";

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
  /** Error returned by every insert (e.g. a unique violation on a retried lead). */
  insertError?: { code?: string; message: string } | null;
  /** The workspace's contact for the dialled number; null = none yet. */
  existingContact?: Record<string, unknown> | null;
}) {
  const rpcs: Rpc[] = [];
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const updates: { table: string; patch: Record<string, unknown> }[] = [];
  let contact = opts.existingContact ?? null;
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
        in: () => builder,
        update: (patch: Record<string, unknown>) => {
          updates.push({ table, patch });
          return builder;
        },
        insert: (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          if (table === "contacts" && !opts.insertError) contact = { id: "ct_new", ...row };
          return {
            then: (resolve: (r: unknown) => void) => resolve({ error: opts.insertError ?? null }),
          };
        },
        then: (resolve: (r: unknown) => void) =>
          table === "contacts"
            ? resolve({ data: contact, error: null })
            : resolve({
                data: rows[table] ?? null,
                error: rows[table] ? null : { message: "missing" },
              }),
      };
      return builder;
    },
  };
  return {
    client: client as never,
    rpcs,
    inserts,
    updates,
    names: () => rpcs.map((r) => r.fn),
  };
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

  test("a completed call where the contact opted out records the opt-out and creates no lead", async () => {
    const f = fakeClient({
      call: { ...CALL, final_agent_variables: { opted_out: "yes", interest_level: "high" } },
    });
    assert.equal((await finalizeTerminalCall(f.client, "call_1", { getRate })).state, "done");
    const campaign = f.rpcs.find((r) => r.fn === "apply_call_campaign_outcome")!.args;
    assert.equal(campaign["_contact_status"], "opted_out");
    assert.equal(campaign["_create_lead"], false);
  });

  test("variables stored grouped as the Sarvam parser makes them ({ final, output }) are read correctly", async () => {
    const f = fakeClient({
      call: {
        ...CALL,
        final_agent_variables: {
          initial: { call_direction: "outbound" },
          final: { opted_out: "yes", interest_level: "high", business_description: "…" },
          output: {},
        },
      },
    });
    await finalizeTerminalCall(f.client, "call_1", { getRate });
    const campaign = f.rpcs.find((r) => r.fn === "apply_call_campaign_outcome")!.args;
    assert.equal(campaign["_contact_status"], "opted_out", "the opt-out inside `final` is seen");
    assert.equal(campaign["_create_lead"], false);
    assert.deepEqual(campaign["_output_variables"], { opted_out: "yes", interest_level: "high" });
  });

  test("lead notes and campaign output keep only the approved fields", async () => {
    const f = fakeClient({
      call: {
        ...CALL,
        final_agent_variables: {
          call_outcome: "callback_requested",
          call_summary: "Wants a cleaning.",
          interest_level: "high",
          opted_out: "no",
          faqs: "Q: EMI? …",
          business_email: "clinic@example.com",
          campaign_objective: "Remind patients",
        },
      },
    });
    await finalizeTerminalCall(f.client, "call_1", { getRate });
    const campaign = f.rpcs.find((r) => r.fn === "apply_call_campaign_outcome")!.args;
    assert.deepEqual(JSON.parse(campaign["_lead_notes"] as string), {
      call_outcome: "callback_requested",
      call_summary: "Wants a cleaning.",
      interest_level: "high",
    });
    assert.deepEqual(campaign["_output_variables"], {
      call_outcome: "callback_requested",
      call_summary: "Wants a cleaning.",
      opted_out: "no",
      interest_level: "high",
    });
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

describe("finalizeTerminalCall: follow-up lead for a single outbound call", () => {
  const DIALLED = "+919876500077";
  const single = (vars: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    ...CALL,
    campaign_id: null,
    campaign_contact_id: null,
    contact_id: null,
    business_id: "biz_1",
    destination_number: DIALLED,
    final_agent_variables: vars,
    ...over,
  });
  const leads = (f: ReturnType<typeof fakeClient>) => f.inserts.filter((i) => i.table === "leads");

  test("an explicit callback request saves exactly one lead, on ClickAI's own dialled number", async () => {
    const f = fakeClient({
      call: single({
        outbound_result: "callback_requested",
        opted_out: "no",
        wrong_number: "no",
        customer_name: "  Asha  ",
      }),
    });
    assert.deepEqual(await finalizeTerminalCall(f.client, "call_1", { getRate }), {
      state: "done",
    });
    assert.equal(leads(f).length, 1);
    const row = leads(f)[0]!.row;
    assert.equal(row["id"], await callLeadId("outbound-callback", "call_1"));
    assert.equal(row["phone"], DIALLED);
    assert.equal(row["call_id"], "call_1");
    assert.equal(row["organization_id"], "org_1");
    assert.equal(row["business_id"], "biz_1");
    assert.equal(row["name"], "Asha");
    // No campaign: the campaign step still runs for its checkpoint but creates no lead itself.
    const campaign = f.rpcs.find((r) => r.fn === "apply_call_campaign_outcome")!.args;
    assert.equal(campaign["_create_lead"], false);
  });

  test("a retried finalization finds the same lead (unique violation) and still completes", async () => {
    const f = fakeClient({
      call: single({ outbound_result: "callback_requested", opted_out: "no" }),
      insertError: { code: "23505", message: "duplicate key value" },
    });
    assert.deepEqual(await finalizeTerminalCall(f.client, "call_1", { getRate }), {
      state: "done",
    });
    assert.equal(leads(f).length, 1, "one attempt, same deterministic id");
    assert.equal(leads(f)[0]!.row["id"], await callLeadId("outbound-callback", "call_1"));
  });

  test("any other insert error fails the step instead of losing the lead silently", async () => {
    const f = fakeClient({
      call: single({ outbound_result: "callback_requested", opted_out: "no" }),
      insertError: { code: "42501", message: "permission denied" },
    });
    const result = await finalizeTerminalCall(f.client, "call_1", { getRate });
    assert.equal(result.state, "failed");
    assert.ok(!f.names().includes("apply_call_campaign_outcome"), "checkpoint not set");
  });

  test("booking interest alone (the agent sent them to the clinic) never creates a lead", async () => {
    for (const outbound_result of ["interested", "not_interested", "booked", undefined, ""]) {
      const f = fakeClient({
        call: single({
          // The inbound-taxonomy outcome Sarvam picks for a refused outbound booking.
          call_outcome: "callback_requested",
          outbound_result,
          interest_level: "high",
          opted_out: "no",
        }),
      });
      await finalizeTerminalCall(f.client, "call_1", { getRate });
      assert.equal(leads(f).length, 0, String(outbound_result));
    }
  });

  test("an opt-out takes precedence, even if the result also says callback_requested", async () => {
    for (const vars of [
      { outbound_result: "opted_out", opted_out: "yes" },
      { outbound_result: "callback_requested", opted_out: "yes" },
      { outbound_result: "callback_requested", do_not_call: "true" },
    ]) {
      const f = fakeClient({ call: single(vars) });
      await finalizeTerminalCall(f.client, "call_1", { getRate });
      assert.equal(leads(f).length, 0, JSON.stringify(vars));
    }
  });

  test("a wrong number never creates a lead", async () => {
    for (const vars of [
      { outbound_result: "wrong_person", wrong_number: "yes" },
      { outbound_result: "callback_requested", wrong_number: "yes" },
    ]) {
      const f = fakeClient({ call: single(vars) });
      await finalizeTerminalCall(f.client, "call_1", { getRate });
      assert.equal(leads(f).length, 0, JSON.stringify(vars));
    }
  });

  test("an unconnected call, a non-exact value or an unusable dialled number creates none", async () => {
    const cases: Record<string, unknown>[] = [
      single({ outbound_result: "callback_requested" }, { status: "no_answer" }),
      single({ outbound_result: "Callback_Requested " }),
      single({ outbound_result: ["callback_requested"] }),
      single({ outbound_result: "callback_requested" }, { destination_number: "not-a-number" }),
      single({ outbound_result: "callback_requested" }, { destination_number: null }),
    ];
    for (const call of cases) {
      const f = fakeClient({ call });
      await finalizeTerminalCall(f.client, "call_1", { getRate });
      assert.equal(leads(f).length, 0, JSON.stringify(call));
    }
  });

  test("a campaign call is unchanged: no single-call lead, the campaign step decides", async () => {
    const f = fakeClient({
      call: { ...CALL, final_agent_variables: { outbound_result: "callback_requested" } },
    });
    await finalizeTerminalCall(f.client, "call_1", { getRate });
    assert.equal(leads(f).length, 0);
    const campaign = f.rpcs.find((r) => r.fn === "apply_call_campaign_outcome")!.args;
    assert.equal(campaign["_create_lead"], true);
  });
});

describe("finalizeTerminalCall: do-not-call from a single outbound call", () => {
  const DIALLED = "+919876500077";
  const single = (vars: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    ...CALL,
    campaign_id: null,
    campaign_contact_id: null,
    contact_id: null,
    business_id: "biz_1",
    destination_number: DIALLED,
    final_agent_variables: vars,
    ...over,
  });
  const contactInserts = (f: ReturnType<typeof fakeClient>) =>
    f.inserts.filter((i) => i.table === "contacts");
  const optOutUpdates = (f: ReturnType<typeof fakeClient>) =>
    f.updates.filter((u) => u.table === "contacts" && u.patch["opted_out"] === true);

  test("an opt-out with no contact yet adds the dialled number to do-not-call, then completes", async () => {
    for (const vars of [{ opted_out: "yes" }, { do_not_call: "true" }]) {
      const f = fakeClient({ call: single(vars) });
      const result = await finalizeTerminalCall(f.client, "call_1", { getRate });
      assert.deepEqual(result, { state: "done" }, JSON.stringify(vars));
      const [insert] = contactInserts(f);
      assert.equal(insert?.row["phone"], DIALLED);
      assert.equal(insert?.row["organization_id"], CALL.organization_id);
      assert.equal(insert?.row["opted_out"], true);
      assert.equal(insert?.row["opted_out_reason"], "Requested during an outbound call");
    }
  });

  test("an existing contact is suppressed in place, never duplicated", async () => {
    const f = fakeClient({
      call: single({ opted_out: "yes" }),
      existingContact: { id: "ct_1" },
    });
    assert.deepEqual(await finalizeTerminalCall(f.client, "call_1", { getRate }), {
      state: "done",
    });
    assert.equal(contactInserts(f).length, 0);
    assert.equal(optOutUpdates(f).length, 1);
    // Its not-yet-dialled campaign enrolments are stopped too.
    assert.ok(f.updates.some((u) => u.table === "campaign_contacts"));
  });

  test("a contact created meanwhile (unique violation) is still suppressed", async () => {
    const f = fakeClient({
      call: single({ opted_out: "yes" }),
      insertError: { code: "23505", message: "duplicate key value" },
    });
    // The racing writer's row is what the second read finds.
    const realFrom = (f.client as { from: (t: string) => unknown }).from;
    let reads = 0;
    (f.client as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === "contacts" && f.inserts.some((i) => i.table === "contacts")) reads++;
      const b = realFrom(t) as Record<string, unknown>;
      if (t === "contacts" && reads > 0)
        b["then"] = (resolve: (r: unknown) => void) =>
          resolve({ data: { id: "ct_race" }, error: null });
      return b;
    };
    assert.deepEqual(await finalizeTerminalCall(f.client, "call_1", { getRate }), {
      state: "done",
    });
    assert.equal(optOutUpdates(f).length, 1);
  });

  test("any other contact error fails the step, so the opt-out is retried, not lost", async () => {
    const f = fakeClient({
      call: single({ opted_out: "yes" }),
      insertError: { code: "42501", message: "permission denied" },
    });
    const result = await finalizeTerminalCall(f.client, "call_1", { getRate });
    assert.equal(result.state, "failed");
    assert.ok(!f.names().includes("apply_call_campaign_outcome"), "checkpoint not set");
  });

  test("no opt-out, a wrong number, or an unusable dialled number adds nothing", async () => {
    for (const call of [
      single({ outbound_result: "interested" }),
      single({ wrong_number: "yes" }),
      single({ opted_out: "no", do_not_call: "no" }),
      single({ opted_out: "yes" }, { destination_number: "not-a-number" }),
    ]) {
      const f = fakeClient({ call });
      await finalizeTerminalCall(f.client, "call_1", { getRate });
      assert.equal(contactInserts(f).length, 0, JSON.stringify(call.final_agent_variables));
      assert.equal(optOutUpdates(f).length, 0);
    }
  });

  test("a campaign call is left to apply_call_campaign_outcome", async () => {
    const f = fakeClient({ call: { ...CALL, final_agent_variables: { opted_out: "yes" } } });
    await finalizeTerminalCall(f.client, "call_1", { getRate });
    assert.equal(contactInserts(f).length, 0);
    assert.equal(optOutUpdates(f).length, 0);
  });
});
