import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  assignNumberToOrganization,
  findOtherE164Holder,
  NUMBER_HELD_MESSAGE,
} from "./phone-number-assignment.server.ts";
import {
  loadCallDetail,
  placeSarvamCallForOrganization,
  type OutboundGates,
} from "./sarvam-admin-calls.server.ts";
import {
  INVALID_DESTINATION_MESSAGE,
  UNRESOLVED_CALL_MESSAGE,
} from "./sarvam-outbound-call.server.ts";

/**
 * Behavioural coverage for the admin dashboard's Sarvam server logic: number
 * assignment (duplicates, tenant isolation), the admin call-on-behalf gate and
 * dial path (real sendSarvamInstantOutboundCall, mocked HTTP), and the call
 * detail used for monitoring. Runs against a small in-memory database.
 */

type Row = Record<string, unknown>;

class MemoryDb {
  tables: Record<string, Row[]> = {};
  rpcs: { fn: string; args: unknown }[] = [];
  rpc = async (fn: string, args: unknown) => {
    this.rpcs.push({ fn, args });
    return { data: null, error: null }; // finalization claim: no lease, nothing runs
  };
  from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    let returning = false;
    let mode: "many" | "single" | "maybe" = "many";
    let limit = Infinity;
    const q = {
      select() {
        if (op !== "select") returning = true;
        return q;
      },
      insert(p: Row) {
        op = "insert";
        payload = p;
        return q;
      },
      update(p: Row) {
        op = "update";
        payload = p;
        return q;
      },
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
      order: () => q,
      limit: (n: number) => ((limit = n), q),
      maybeSingle: () => ((mode = "maybe"), q),
      single: () => ((mode = "single"), q),
      then: (resolve: (r: { data: unknown; error: unknown }) => void) => {
        const rows = (this.tables[table] ??= []);
        let data: unknown;
        if (op === "insert") {
          const row = { id: randomUUID(), ...payload };
          rows.push(row);
          data = mode === "many" ? [row] : row;
        } else {
          const hit = rows.filter((r) => filters.every((f) => f(r))).slice(0, limit);
          if (op === "update") {
            hit.forEach((r) => Object.assign(r, payload));
            data = returning ? hit : null;
          } else data = mode === "many" ? hit : (hit[0] ?? null);
        }
        resolve({ data, error: null });
      },
    };
    return q;
  };
}

const ORG_A = "org_a";
const ORG_B = "org_b";
let db: MemoryDb;
const client = () => db as never;

beforeEach(() => {
  db = new MemoryDb();
  db.tables["organizations"] = [
    { id: ORG_A, name: "Alpha", client_id: "C-1" },
    { id: ORG_B, name: "Beta", client_id: "C-2" },
  ];
  db.tables["telephony_connections"] = [
    { id: "conn_a", organization_id: ORG_A, provider: "sarvam", provider_connection_id: "sc_a" },
    { id: "conn_b", organization_id: ORG_B, provider: "sarvam", provider_connection_id: "sc_b" },
  ];
  db.tables["agent_configs"] = [
    {
      id: "agent_a",
      organization_id: ORG_A,
      agent_name: "A",
      sarvam_app_id: "app_a",
      sarvam_app_version: 1,
    },
    {
      id: "agent_b",
      organization_id: ORG_B,
      agent_name: "B",
      sarvam_app_id: "app_b",
      sarvam_app_version: 3,
    },
  ];
  db.tables["phone_numbers"] = [];
  db.tables["call_logs"] = [];
});

function number(overrides: Row): Row {
  const row = {
    id: randomUUID(),
    e164: "+918000000001",
    provider: "sarvam",
    status: "active",
    organization_id: ORG_A,
    connection_id: "conn_a",
    agent_config_id: "agent_a",
    inbound_enabled: true,
    outbound_enabled: true,
    ...overrides,
  };
  db.tables["phone_numbers"]!.push(row);
  return row;
}

describe("number assignment", () => {
  test("a pool number assigned to a customer is linked to that customer's own connection and agent, calling off", async () => {
    const n = number({
      organization_id: null,
      status: "available",
      connection_id: null,
      agent_config_id: null,
    });
    await assignNumberToOrganization(client(), { numberId: n["id"] as string, toOrgId: ORG_B });
    assert.equal(n["organization_id"], ORG_B);
    assert.equal(n["status"], "provisioning");
    assert.equal(n["outbound_enabled"], false);
    assert.equal(n["inbound_enabled"], false);
    assert.equal(n["connection_id"], "conn_b");
    assert.equal(n["agent_config_id"], "agent_b");
  });

  test("tenant isolation: reassigning never keeps the previous customer's connection or agent", async () => {
    const n = number({});
    db.tables["telephony_connections"] = db.tables["telephony_connections"]!.filter(
      (c) => c["organization_id"] !== ORG_B,
    );
    await assignNumberToOrganization(client(), { numberId: n["id"] as string, toOrgId: ORG_B });
    assert.equal(n["connection_id"], null, "org B has no connection, so none — never conn_a");
    assert.equal(n["agent_config_id"], "agent_b");
  });

  test("duplicate prevention: an e164 held by another customer cannot be assigned again", async () => {
    number({ organization_id: ORG_A, status: "provisioning" });
    const dup = number({ organization_id: null, status: "available", connection_id: null });
    await assert.rejects(
      assignNumberToOrganization(client(), { numberId: dup["id"] as string, toOrgId: ORG_B }),
      { message: NUMBER_HELD_MESSAGE },
    );
    assert.equal(dup["organization_id"], null, "unchanged");
  });

  test("released numbers, same-customer moves and unknown customers are refused", async () => {
    const released = number({ status: "released" });
    await assert.rejects(
      assignNumberToOrganization(client(), { numberId: released["id"] as string, toOrgId: ORG_B }),
      /released number cannot be reassigned/,
    );
    const n = number({ e164: "+918000000002" });
    await assert.rejects(
      assignNumberToOrganization(client(), { numberId: n["id"] as string, toOrgId: ORG_A }),
      /already assigned to this customer/,
    );
    await assert.rejects(
      assignNumberToOrganization(client(), { numberId: n["id"] as string, toOrgId: "org_x" }),
      /Destination client not found/,
    );
    assert.equal(n["organization_id"], ORG_A);
  });

  test("a released row does not count as holding the number", async () => {
    number({ status: "released" });
    assert.equal(await findOtherE164Holder(client(), "+918000000001"), null);
  });
});

/* ------------------------------------------------------------------ */

const allowAll: OutboundGates = {
  checkTelephonyAccess: (async (orgId: string, numberId: string) => {
    const n = db.tables["phone_numbers"]!.find(
      (r) => r["id"] === numberId && r["organization_id"] === orgId,
    );
    if (!n)
      return {
        allowed: false,
        reason: "This phone number is not assigned to this organization.",
        phoneNumber: null,
      };
    if (n["status"] !== "active")
      return {
        allowed: false,
        reason: `This number is ${n["status"]}, not active.`,
        phoneNumber: n,
      };
    if (!n["outbound_enabled"])
      return {
        allowed: false,
        reason: "Outbound calling is disabled on this number.",
        phoneNumber: n,
      };
    return { allowed: true, reason: null, phoneNumber: n };
  }) as never,
  walletCanAffordOutbound: async () => true,
};

async function withSarvam<T>(
  response: { status: number; body: unknown },
  fn: () => Promise<T>,
): Promise<{ result?: T; error?: unknown; requests: unknown[] }> {
  const keys = [
    "SARVAM_API_KEY",
    "SARVAM_ORG_ID",
    "SARVAM_WORKSPACE_ID",
    "TELEPHONY_WEBHOOK_BASE_URL",
    "SARVAM_WEBHOOK_SECRET",
    "SARVAM_OUTBOUND_TEST_ALLOWLIST",
  ];
  const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    SARVAM_API_KEY: "sk_test",
    SARVAM_ORG_ID: "o",
    SARVAM_WORKSPACE_ID: "w",
    TELEPHONY_WEBHOOK_BASE_URL: "https://clickai.test",
    SARVAM_WEBHOOK_SECRET: "secret",
  });
  delete process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"];
  const requests: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    requests.push(init?.body ? JSON.parse(init.body as string) : null);
    return new Response(JSON.stringify(response.body), { status: response.status });
  }) as typeof fetch;
  try {
    return { result: await fn(), requests };
  } catch (error) {
    return { error, requests };
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("admin call-on-behalf: gates, dialling and provider errors", () => {
  test("places one real call through the shared path and records the provider's attempt id", async () => {
    const n = number({});
    const { result, requests, error } = await withSarvam(
      { status: 200, body: { attempt_id: "att_1" } },
      () =>
        placeSarvamCallForOrganization(
          client(),
          { orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
          allowAll,
        ),
    );
    assert.equal(error, undefined);
    assert.equal(result?.outcome, "started");
    assert.equal(requests.length, 1, "dialled exactly once");
    const call = db.tables["call_logs"]![0]!;
    assert.equal(call["id"], result?.callId);
    assert.equal(call["organization_id"], ORG_A);
    assert.equal(call["destination_number"], "+919876543210");
    assert.equal(call["status"], "initiated");
    assert.equal(call["provider_call_id"], "att_1");
  });

  test("tenant isolation: a number belonging to another customer is refused before anything is written", async () => {
    const n = number({
      organization_id: ORG_B,
      connection_id: "conn_b",
      agent_config_id: "agent_b",
    });
    const { error, requests } = await withSarvam({ status: 200, body: {} }, () =>
      placeSarvamCallForOrganization(
        client(),
        { orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
        allowAll,
      ),
    );
    assert.match((error as Error).message, /not assigned to this organization/);
    assert.equal(requests.length, 0);
    assert.equal(db.tables["call_logs"]!.length, 0);
  });

  test("tenant isolation: a number still pointing at another customer's connection is refused", async () => {
    const n = number({ connection_id: "conn_b" });
    const { error, requests } = await withSarvam({ status: 200, body: {} }, () =>
      placeSarvamCallForOrganization(
        client(),
        { orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
        allowAll,
      ),
    );
    assert.match((error as Error).message, /connection does not belong to this organization/);
    assert.equal(requests.length, 0);
    assert.equal(db.tables["call_logs"]!.length, 0);
  });

  test("inactive numbers, outbound off, non-Sarvam numbers and an empty wallet are refused", async () => {
    const cases: [Row, OutboundGates, RegExp][] = [
      [{ status: "provisioning" }, allowAll, /not active/],
      [{ outbound_enabled: false }, allowAll, /Outbound calling is disabled/],
      [{ provider: "vobiz" }, allowAll, /only applies to Sarvam/],
      [
        {},
        { ...allowAll, walletCanAffordOutbound: async () => false },
        /Insufficient wallet balance/,
      ],
    ];
    for (const [overrides, gates, expected] of cases) {
      db.tables["phone_numbers"] = [];
      const n = number(overrides);
      const { error, requests } = await withSarvam({ status: 200, body: {} }, () =>
        placeSarvamCallForOrganization(
          client(),
          { orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
          gates,
        ),
      );
      assert.match((error as Error).message, expected);
      assert.equal(requests.length, 0);
    }
    assert.equal(db.tables["call_logs"]!.length, 0);
  });

  test("destination validation: a number without a country code is refused", async () => {
    const n = number({});
    const { error } = await withSarvam({ status: 200, body: {} }, () =>
      placeSarvamCallForOrganization(
        client(),
        { orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "98765" },
        allowAll,
      ),
    );
    assert.equal((error as Error).message, INVALID_DESTINATION_MESSAGE);
    assert.equal(db.tables["call_logs"]!.length, 0);
  });

  test("no repeated dialling: an unresolved earlier call to the same number blocks a new one", async () => {
    const n = number({});
    db.tables["call_logs"]!.push({
      id: "earlier",
      organization_id: ORG_A,
      provider: "sarvam",
      direction: "outbound",
      destination_number: "+919876543210",
      status: "outcome_unknown",
    });
    const { error, requests } = await withSarvam({ status: 200, body: {} }, () =>
      placeSarvamCallForOrganization(
        client(),
        { orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
        allowAll,
      ),
    );
    assert.equal((error as Error).message, UNRESOLVED_CALL_MESSAGE);
    assert.equal(requests.length, 0);
  });

  test("a definite provider rejection marks the call failed (zero-charge finalization) and surfaces the error", async () => {
    const n = number({});
    const { error, requests } = await withSarvam(
      { status: 400, body: { error: { message: "invalid number" } } },
      () =>
        placeSarvamCallForOrganization(
          client(),
          { orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
          allowAll,
        ),
    );
    assert.ok(error instanceof Error);
    assert.equal(requests.length, 1, "never retried");
    const call = db.tables["call_logs"]![0]!;
    assert.equal(call["status"], "failed");
    assert.equal(call["resolution_source"], "start_failure");
    assert.ok(
      db.rpcs.some((r) => r.fn === "claim_call_finalization"),
      "finalization was run",
    );
  });

  test("an ambiguous provider error is held as unconfirmed, not failed and not retried", async () => {
    const n = number({});
    const { result, requests } = await withSarvam({ status: 503, body: {} }, () =>
      placeSarvamCallForOrganization(
        client(),
        { orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
        allowAll,
      ),
    );
    assert.equal(result?.outcome, "unknown");
    assert.ok(requests.length >= 1);
    assert.equal(db.tables["call_logs"]![0]!["status"], "outcome_unknown");
  });
});

/* ------------------------------------------------------------------ */

describe("call detail for monitoring", () => {
  function seedCall(overrides: Row = {}): Row {
    const n = number({});
    const call = {
      id: "call_1",
      organization_id: ORG_A,
      phone_number_id: n["id"],
      provider: "sarvam",
      direction: "outbound",
      status: "completed",
      provider_call_id: "att_1",
      provider_metadata: { interaction_id: "int_1" },
      caller_number: "+918000000001",
      destination_number: "+919876543210",
      started_at: "2026-11-10T10:00:00Z",
      answered_at: "2026-11-10T10:00:05Z",
      ended_at: "2026-11-10T10:01:05Z",
      duration_seconds: 60,
      recording_url: null,
      transcript: [{ role: "agent", text: "Hello" }, { role: "user", text: "Hi" }, "garbage"],
      currency: "INR",
      provider_cost: 150,
      customer_charge: 400,
      finalization_state: "done",
      finalization_attempts: 1,
      billing_applied_at: "2026-11-10T10:01:06Z",
      ...overrides,
    };
    db.tables["call_logs"]!.push(call);
    return call;
  }

  test("returns real stored data: ids, billing kept separate, wallet debits, webhooks, transcript; no invented recording", async () => {
    seedCall();
    db.tables["wallet_transactions"] = [
      {
        organization_id: ORG_A,
        kind: "call_usage",
        reference: "call_1",
        amount: -400,
        currency: "INR",
        created_at: "t",
      },
      {
        organization_id: ORG_B,
        kind: "call_usage",
        reference: "call_1",
        amount: -1,
        currency: "INR",
        created_at: "t",
      },
    ];
    db.tables["webhook_events"] = [
      {
        provider: "sarvam",
        event_id: "att_1",
        event_type: "completed",
        created_at: "t1",
        processed_at: "t2",
        error: null,
      },
      {
        provider: "sarvam",
        event_id: "att_other",
        event_type: "completed",
        created_at: "t1",
        processed_at: "t2",
        error: null,
      },
    ];
    const d = await loadCallDetail(client(), "call_1");
    assert.equal(d.providerCallId, "att_1");
    assert.equal(d.interactionId, "int_1");
    assert.equal(d.customer.name, "Alpha");
    assert.equal(d.providerCost, 150);
    assert.equal(d.customerCharge, 400);
    assert.deepEqual(
      d.walletDebits.map((w) => w.amount),
      [-400],
      "only this customer's debit for this call",
    );
    assert.deepEqual(
      d.webhookEvents.map((e) => e.event_id),
      ["att_1"],
    );
    assert.equal(d.recordingUrl, null);
    assert.deepEqual(d.transcript, [
      { role: "agent", text: "Hello" },
      { role: "user", text: "Hi" },
    ]);
    assert.equal(d.agent?.sarvamAppId, "app_a");
  });

  test("failed / unanswered calls show their reason, zero charge, and no transcript", async () => {
    seedCall({
      status: "no_answer",
      transcript: null,
      duration_seconds: 0,
      customer_charge: 0,
      failure_reason: "no answer",
    });
    const d = await loadCallDetail(client(), "call_1");
    assert.equal(d.status, "no_answer");
    assert.equal(d.customerCharge, 0);
    assert.equal(d.transcript, null);
    assert.equal(d.failureReason, "no answer");
    assert.deepEqual(d.walletDebits, []);
  });

  test("an unknown call id is an error", async () => {
    await assert.rejects(loadCallDetail(client(), "nope"), /Call not found/);
  });
});
