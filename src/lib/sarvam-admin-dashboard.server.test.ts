import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  assignNumberToOrganization,
  findOtherE164Holder,
  NUMBER_HELD_MESSAGE,
} from "./phone-number-assignment.server.ts";
import {
  HOURLY_LIMIT_MESSAGE,
  loadCallDetail,
  loadOutboundCallingStatus,
  placeSarvamCallForOrganization,
  SINGLE_CALL_LIMITS,
  TOO_MANY_IN_FLIGHT_MESSAGE,
  type OutboundGates,
  type OutboundStatusDeps,
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
  /** Wallet balance (paise) and outbound price the admission model reads. */
  walletBalance = 1_000_000;
  rate = 400;
  rpc = async (fn: string, args: unknown) => {
    this.rpcs.push({ fn, args });
    if (fn === "admit_single_outbound_call")
      return { data: this.admit(args as Record<string, unknown>), error: null };
    return { data: null, error: null }; // finalization claim: no lease, nothing runs
  };
  /**
   * An in-memory model of admit_single_outbound_call (migration
   * 20261119090000), so these tests drive the real TypeScript path end to end.
   * The SQL itself, including its concurrency, is tested against PostgreSQL in
   * outbound_call_admission.pg.test.ts.
   */
  admit(a: Record<string, unknown>) {
    const calls = (this.tables["call_logs"] ??= []);
    const org = a["_org"];
    const to = a["_destination"];
    const existing = calls.find(
      (c) => c["organization_id"] === org && c["idempotency_key"] === a["_idempotency_key"],
    );
    if (existing)
      return existing["destination_number"] === to
        ? { result: "duplicate", call_id: existing["id"], status: existing["status"] }
        : { result: "refused", reason: "idempotency_key_reused" };
    const owns = (this.tables["phone_numbers"] ?? []).some(
      (n) =>
        n["id"] === a["_phone_number_id"] &&
        n["organization_id"] === org &&
        n["status"] === "active",
    );
    if (!owns) return { result: "refused", reason: "number_not_owned" };
    const number = (this.tables["phone_numbers"] ?? []).find(
      (n) => n["id"] === a["_phone_number_id"],
    );
    const agent = (this.tables["agent_configs"] ?? []).find(
      (g) => g["id"] === number?.["agent_config_id"] && g["organization_id"] === org,
    );
    const maxSeconds = agent?.["sarvam_outbound_max_call_seconds"] as number | null | undefined;
    if (!maxSeconds) return { result: "refused", reason: "max_call_length_not_set" };
    const cap = Math.ceil(maxSeconds / 60);
    const since = (ms: number) => new Date(Date.now() - ms).toISOString();
    const recent = calls.filter(
      (c) =>
        c["organization_id"] === org &&
        c["direction"] === "outbound" &&
        (c["campaign_id"] ?? null) === null &&
        String(c["started_at"]) > since(24 * 3600_000) &&
        c["resolution_source"] !== "start_failure",
    );
    const open = ["initiated", "ringing", "answered", "in_progress", "outcome_unknown"];
    const inFlight = recent.filter((c) => open.includes(String(c["status"]))).length;
    if (inFlight >= Number(a["_max_in_flight"]))
      return { result: "refused", reason: "in_flight_limit" };
    const lastHour = recent.filter((c) => String(c["started_at"]) > since(3600_000)).length;
    if (lastHour >= Number(a["_max_per_hour"]))
      return { result: "refused", reason: "hourly_limit" };
    if (recent.length >= Number(a["_max_per_day"]))
      return { result: "refused", reason: "daily_limit" };
    const toThem = recent.filter((c) => c["destination_number"] === to).length;
    if (toThem >= Number(a["_max_per_destination_day"]))
      return { result: "refused", reason: "destination_daily_limit" };
    // Worst case: every open single call at its own locked terms, any age, plus this one.
    const openReserved = calls
      .filter(
        (c) =>
          c["organization_id"] === org &&
          c["direction"] === "outbound" &&
          (c["campaign_id"] ?? null) === null &&
          open.includes(String(c["status"])),
      )
      .reduce(
        (sum, c) =>
          sum +
          Number(c["billing_cap_minutes"] ?? 1) * Number(c["billing_rate_per_minute"] ?? this.rate),
        0,
      );
    if ((this.rate > 0 || openReserved > 0) && this.walletBalance < openReserved + this.rate * cap)
      return { result: "refused", reason: "insufficient_balance" };
    const busy = calls.some(
      (c) =>
        c["organization_id"] === org &&
        c["provider"] === "sarvam" &&
        c["direction"] === "outbound" &&
        c["destination_number"] === to &&
        ["initiated", "outcome_unknown"].includes(String(c["status"])),
    );
    if (busy) return { result: "refused", reason: "destination_busy" };
    const row = {
      id: randomUUID(),
      organization_id: org,
      phone_number_id: a["_phone_number_id"],
      provider: "sarvam",
      direction: "outbound",
      caller_number: a["_caller_number"],
      destination_number: to,
      status: "initiated",
      started_at: new Date().toISOString(),
      idempotency_key: a["_idempotency_key"],
      billing_cap_minutes: cap,
      billing_rate_per_minute: this.rate,
    };
    calls.push(row);
    return { result: "admitted", call_id: row.id };
  }
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
      gt: (c: string, v: string) => (filters.push((r) => String(r[c] ?? "") > v), q),
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

/** 11:00 India time: inside the calling window, whenever the suite runs. */
const DAYTIME = new Date("2026-11-19T05:30:00Z");
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
      sarvam_outbound_app_id: "app_a-out",
      sarvam_outbound_app_version: 1,
      sarvam_outbound_ready_app_id: "app_a-out",
      sarvam_outbound_ready_version: 1,
      sarvam_outbound_max_call_seconds: 300,
    },
    {
      id: "agent_b",
      organization_id: ORG_B,
      agent_name: "B",
      sarvam_app_id: "app_b",
      sarvam_app_version: 3,
      sarvam_outbound_app_id: "app_b-out",
      sarvam_outbound_app_version: 3,
      sarvam_outbound_ready_app_id: "app_b-out",
      sarvam_outbound_ready_version: 3,
      sarvam_outbound_max_call_seconds: 600,
    },
  ];
  db.tables["phone_numbers"] = [];
  db.tables["call_logs"] = [];
  // The people these tests call already know the clinic (prior-relationship rule).
  db.tables["contacts"] = [
    { id: "ct_1", organization_id: ORG_A, phone: "+919876543210", opted_out: false },
  ];
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
  // The pilot allowlist fails closed: list exactly the numbers these tests dial.
  process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"] =
    "+919876543210,+918000000001,+918000000002,+918000000003,+918000000004,+918000000005";
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
          { now: DAYTIME, orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
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

  test("the admin's reason for the call reaches the agent as campaign_objective, sanitized, with the direction fixed", async () => {
    const n = number({});
    const { requests, error } = await withSarvam(
      { status: 200, body: { attempt_id: "att_2" } },
      () =>
        placeSarvamCallForOrganization(
          client(),
          {
            now: DAYTIME,
            orgId: ORG_A,
            phoneNumberId: n["id"] as string,
            toE164: "+919876543210",
            objective: "  Reminder about\nyour cleaning   appointment ",
          },
          allowAll,
        ),
    );
    assert.equal(error, undefined);
    const vars = (requests[0] as { app_config: { agent_variables: Record<string, string> } })
      .app_config.agent_variables;
    assert.equal(vars["campaign_objective"], "Reminder about your cleaning appointment");
    assert.equal(vars["call_direction"], "outbound");
    assert.equal(vars["clickai_call_id"], db.tables["call_logs"]![0]!["id"]);
  });

  test("without a reason no campaign_objective is sent", async () => {
    const n = number({});
    const { requests } = await withSarvam({ status: 200, body: { attempt_id: "att_3" } }, () =>
      placeSarvamCallForOrganization(
        client(),
        { now: DAYTIME, orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
        allowAll,
      ),
    );
    const vars = (requests[0] as { app_config: { agent_variables: Record<string, string> } })
      .app_config.agent_variables;
    assert.equal("campaign_objective" in vars, false);
    assert.equal(vars["call_direction"], "outbound");
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
        { now: DAYTIME, orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
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
        { now: DAYTIME, orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
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
      [{ emptyWallet: true }, allowAll, /Insufficient wallet balance/],
    ];
    for (const [{ emptyWallet, ...overrides }, gates, expected] of cases) {
      db.walletBalance = emptyWallet ? 0 : 1_000_000;
      db.tables["phone_numbers"] = [];
      const n = number(overrides);
      const { error, requests } = await withSarvam({ status: 200, body: {} }, () =>
        placeSarvamCallForOrganization(
          client(),
          { now: DAYTIME, orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
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
        { now: DAYTIME, orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "98765" },
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
        { now: DAYTIME, orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
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
          { now: DAYTIME, orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
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
        { now: DAYTIME, orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
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
    // This is an outbound call: the outbound agent, never the inbound one.
    assert.deepEqual(
      [d.agent?.role, d.agent?.sarvamAppId, d.agent?.sarvamAppVersion],
      ["outbound", "app_a-out", 1],
    );
  });

  test("an inbound call shows the inbound agent; a missing outbound agent is not replaced", async () => {
    seedCall({ direction: "inbound" });
    const inbound = await loadCallDetail(client(), "call_1");
    assert.deepEqual([inbound.agent?.role, inbound.agent?.sarvamAppId], ["inbound", "app_a"]);
    for (const c of db.tables["call_logs"]!) c["direction"] = "outbound";
    Object.assign(
      db.tables["agent_configs"]!.find((a) => a["id"] === "agent_a")!,
      {
        sarvam_outbound_app_id: null,
        sarvam_outbound_app_version: null,
      },
    );
    const outbound = await loadCallDetail(client(), "call_1");
    assert.deepEqual([outbound.agent?.role, outbound.agent?.sarvamAppId], ["outbound", null]);
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

describe("single-call limits per customer", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const pastCall = (status: string, startedMinutesAgo: number, org = ORG_A): Row => ({
    id: randomUUID(),
    organization_id: org,
    provider: "sarvam",
    direction: "outbound",
    status,
    destination_number: `+91987650${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`,
    started_at: minutesAgo(startedMinutesAgo),
  });
  const place = (gates: OutboundGates = allowAll) => {
    db.tables["phone_numbers"] = [];
    const n = number({});
    return withSarvam({ status: 200, body: { attempt_id: "att_l" } }, () =>
      placeSarvamCallForOrganization(
        client(),
        { now: DAYTIME, orgId: ORG_A, phoneNumberId: n["id"] as string, toE164: "+919876543210" },
        gates,
      ),
    );
  };

  test("too many calls still in progress: refused before anything is written or dialled", async () => {
    for (let i = 0; i < SINGLE_CALL_LIMITS.inFlight; i++)
      db.tables["call_logs"]!.push(pastCall(i % 2 ? "outcome_unknown" : "initiated", 2));
    const { error, requests } = await place();
    assert.equal((error as Error).message, TOO_MANY_IN_FLIGHT_MESSAGE);
    assert.equal(requests.length, 0);
    assert.equal(db.tables["call_logs"]!.length, SINGLE_CALL_LIMITS.inFlight);
  });

  test("the hourly limit counts every call started in the last hour, final or not", async () => {
    for (let i = 0; i < SINGLE_CALL_LIMITS.perHour; i++)
      db.tables["call_logs"]!.push(pastCall("completed", 30));
    const { error, requests } = await place();
    assert.equal((error as Error).message, HOURLY_LIMIT_MESSAGE);
    assert.equal(requests.length, 0);
  });

  test("older calls, campaign calls and other customers' calls never count", async () => {
    for (let i = 0; i < SINGLE_CALL_LIMITS.perHour; i++) {
      db.tables["call_logs"]!.push(pastCall("completed", 90));
      db.tables["call_logs"]!.push(pastCall("initiated", 2, ORG_B));
      db.tables["call_logs"]!.push({ ...pastCall("initiated", 2), campaign_id: "camp_1" });
    }
    const { error, result } = await place();
    assert.equal(error, undefined);
    assert.equal(result?.outcome, "started");
  });

  test("the wallet must cover this call's longest length plus every open call's reservation", async () => {
    // An open call from before locked terms reserves one minute; this call, 5 minutes (300 s).
    db.tables["call_logs"]!.push(pastCall("initiated", 2), pastCall("completed", 5));
    db.walletBalance = db.rate + 5 * db.rate - 1;
    const { error, requests } = await place();
    assert.match((error as Error).message, /Insufficient wallet balance/);
    assert.equal(requests.length, 0);
    db.walletBalance = db.rate + 5 * db.rate;
    const ok = await place();
    assert.equal(ok.error, undefined);
    const row = db.tables["call_logs"]!.find((c) => c["id"] === ok.result?.callId)!;
    assert.equal(row["billing_cap_minutes"], 5, "the cap is locked on the call");
    assert.equal(row["billing_rate_per_minute"], db.rate, "and so is the price");
  });

  test("an agent with no maximum call length recorded admits nothing", async () => {
    db.tables["agent_configs"]![0]!["sarvam_outbound_max_call_seconds"] = null;
    const { error, requests } = await place();
    assert.match((error as Error).message, /no maximum call length/);
    assert.equal(requests.length, 0);
  });

  test("the same request id twice (double click, retry): one call, dialled once", async () => {
    const n = number({});
    const once = () =>
      withSarvam({ status: 200, body: { attempt_id: "att_dup" } }, () =>
        placeSarvamCallForOrganization(
          client(),
          {
            now: DAYTIME,
            orgId: ORG_A,
            phoneNumberId: n["id"] as string,
            toE164: "+919876543210",
            idempotencyKey: "req_aaaaaaaaaaaaaaaaaaaa",
          },
          allowAll,
        ),
      );
    const first = await once();
    const second = await once();
    assert.equal(first.requests.length, 1);
    assert.equal(second.requests.length, 0, "the repeat never reaches Sarvam");
    assert.equal(second.result?.callId, first.result?.callId);
    assert.equal(second.result?.duplicate, true);
    assert.equal(db.tables["call_logs"]!.length, 1);
  });
});

describe("loadOutboundCallingStatus: what the customer sees before calling", () => {
  const deps = (over: Partial<OutboundStatusDeps> = {}): OutboundStatusDeps => ({
    checkFeatureAccess: async () => ({ allowed: true, reason: null }),
    walletCanAffordOutbound: async () => true,
    getCallRate: async () => ({ customerAmountPerMinute: 400, currency: "INR" }),
    now: () => DAYTIME,
    ...over,
  });

  test("outside calling hours, or with the kill switch on, the preview says so", async () => {
    number({});
    const night = await loadOutboundCallingStatus(
      client(),
      ORG_A,
      deps({ now: () => new Date("2026-11-19T17:00:00Z") }),
    );
    assert.match(night.blockers.join(" "), /9:00 AM and 9:00 PM/);
    const prior = process.env["OUTBOUND_CALLING_DISABLED"];
    process.env["OUTBOUND_CALLING_DISABLED"] = "true";
    try {
      const paused = await loadOutboundCallingStatus(client(), ORG_A, deps());
      assert.match(paused.blockers.join(" "), /paused/);
    } finally {
      if (prior === undefined) delete process.env["OUTBOUND_CALLING_DISABLED"];
      else process.env["OUTBOUND_CALLING_DISABLED"] = prior;
    }
  });

  test("a ready, outbound-enabled number has no blockers; price and limits are reported", async () => {
    const n = number({});
    db.tables["wallet_balances"] = [
      { organization_id: ORG_B, balance: 999 },
      { organization_id: ORG_A, balance: 5000 },
    ];
    const status = await loadOutboundCallingStatus(client(), ORG_A, deps());
    assert.equal(status.walletBalance, 5000, "this customer's own balance only");
    assert.deepEqual(status.blockers, []);
    assert.equal(status.numbers.length, 1);
    assert.equal(status.numbers[0]!.id, n["id"]);
    assert.deepEqual(status.numbers[0]!.blockers, []);
    assert.equal(status.ratePerMinute, 400);
    assert.equal(status.currency, "INR");
    assert.deepEqual(status.limits, SINGLE_CALL_LIMITS);
    assert.ok(!("providerCost" in status) && !JSON.stringify(status).includes("provider_cost"));
  });

  test("outbound off and an agent version not confirmed for outbound are each explained", async () => {
    number({ outbound_enabled: false });
    db.tables["agent_configs"]![0]!["sarvam_outbound_ready_version"] = null;
    const status = await loadOutboundCallingStatus(client(), ORG_A, deps());
    assert.equal(status.numbers[0]!.blockers.length, 2);
    assert.match(status.numbers[0]!.blockers.join(" "), /not switched on/);
    assert.match(status.numbers[0]!.blockers.join(" "), /not been set up for outbound/);
  });

  test("locked phone feature and low balance are workspace-wide blockers", async () => {
    number({});
    const asked: number[] = [];
    const status = await loadOutboundCallingStatus(
      client(),
      ORG_A,
      deps({
        checkFeatureAccess: async () => ({ allowed: false, reason: "Payment is overdue." }),
        walletCanAffordOutbound: async (_org, minutes = 1) => {
          asked.push(minutes);
          return false;
        },
      }),
    );
    assert.deepEqual(status.blockers, [
      "Payment is overdue.",
      "Your wallet balance is too low: each call needs enough for its longest possible length (5 minutes). Add funds to call.",
    ]);
    assert.deepEqual(asked, [5], "one call at the agent's 5-minute limit");
    assert.equal(status.maxCallMinutes, 5);
  });

  test("an agent with no maximum call length is not ready, and nothing is reserved", async () => {
    db.tables["agent_configs"]![0]!["sarvam_outbound_max_call_seconds"] = null;
    number({});
    const status = await loadOutboundCallingStatus(client(), ORG_A, deps());
    assert.match(status.numbers[0]!.blockers.join(" "), /not been set up for outbound/);
    assert.equal(status.maxCallMinutes, null);
  });

  test("only this customer's active Sarvam numbers are listed; another customer's agent never counts as ready", async () => {
    number({});
    number({ e164: "+918000000002", status: "released" });
    number({ e164: "+918000000003", provider: "vobiz" });
    number({ e164: "+918000000004", organization_id: ORG_B, connection_id: "conn_b" });
    const mixed = number({ e164: "+918000000005", agent_config_id: "agent_b" });
    const status = await loadOutboundCallingStatus(client(), ORG_A, deps());
    assert.equal(status.numbers.length, 2);
    const listed = status.numbers.find((x) => x.id === mixed["id"]);
    assert.match(listed!.blockers.join(" "), /not been set up for outbound/);
  });
});
