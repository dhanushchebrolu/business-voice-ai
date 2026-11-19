import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DESTINATION_LIMIT_MESSAGE,
  HOURLY_LIMIT_MESSAGE,
  INSUFFICIENT_BALANCE_MESSAGE,
  SINGLE_CALL_LIMITS,
  TOO_MANY_IN_FLIGHT_MESSAGE,
  UNRESOLVED_CALL_MESSAGE,
  isSarvamOutboundDestinationAllowed,
  persistStartResult,
  sendSarvamInstantOutboundCall,
} from "./sarvam-outbound-call.server.ts";

/**
 * Behavioral coverage for sendSarvamInstantOutboundCall — the logic
 * extracted from sarvam-outbound.functions.ts's createSarvamInstantOutboundCall
 * so both the customer-facing path and the admin-only test action
 * (testSarvamOutboundCall) call exactly one implementation. Same technique
 * as sarvam-inbound-deployment.server.test.ts: a scripted fake Supabase
 * client, and SARVAM_* env vars + a mocked fetch for the adapter call
 * itself (no live network call to apps.sarvam.ai).
 */

interface QueryResult {
  data: unknown;
  error: unknown;
}
type OpType = "select" | "update" | "insert";

/** 11:00 India time: inside the calling window, whenever the suite runs. */
const DAYTIME = new Date("2026-11-19T05:30:00Z");

/**
 * Lookups that are not part of a test's script: the prior-relationship check
 * (by default the number called the business before, so it qualifies) and the
 * contacts/leads/bookings reads it makes. Never consume scripted results.
 */
function defaultResult(
  table: string,
  type: OpType,
  filters: [string, unknown][],
  relationship: boolean,
): QueryResult | undefined {
  if (type !== "select") return undefined;
  const has = (col: string, value?: unknown) =>
    filters.some(([c, v]) => c === col && (value === undefined || v === value));
  if (table === "call_logs" && has("direction", "inbound"))
    return { data: relationship ? [{ id: "earlier_inbound_call" }] : [], error: null };
  if (table === "leads" || table === "bookings") return { data: [], error: null };
  if (table === "contacts" && !has("opted_out")) return { data: [], error: null };
  return undefined;
}

function makeFakeSupabase(
  script: Record<string, Partial<Record<OpType, QueryResult[]>>>,
  options: { relationship?: boolean; admission?: Record<string, unknown> } = {},
) {
  const consumedIdx: Record<string, Record<OpType, number>> = {};
  const calls: {
    table: string;
    type: OpType;
    payload?: unknown;
    filters?: [string, unknown][];
  }[] = [];

  function nextResult(table: string, type: OpType): QueryResult {
    consumedIdx[table] ??= { select: 0, update: 0, insert: 0 };
    const idx = consumedIdx[table]![type]++;
    const result =
      script[table]?.[type]?.[idx] ??
      // The do-not-call lookup: unless a test scripts it, the number is not on the list.
      (table === "contacts" && type === "select" && !script[table]
        ? { data: [], error: null }
        : undefined);
    if (!result) throw new Error(`test bug: no scripted ${type} result #${idx} for table ${table}`);
    return result;
  }

  function makeBuilder(table: string, type: OpType, payload?: unknown) {
    const filters: [string, unknown][] = [];
    const builder = {
      select() {
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return builder;
      },
      in(column: string, values: unknown[]) {
        filters.push([`${column} in`, values]);
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        return builder;
      },
      single() {
        return builder;
      },
      then(resolve: (r: QueryResult) => void, reject: (e: unknown) => void): Promise<void> {
        calls.push({ table, type, payload, filters });
        const result =
          defaultResult(table, type, filters, options.relationship ?? true) ??
          nextResult(table, type);
        return Promise.resolve(result).then(resolve as never, reject);
      },
    };
    return builder;
  }

  // Database functions (finalization): recorded; claim returns no lease, so
  // finalization is a no-op here (its own tests cover what runs next).
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const admissions: Record<string, unknown>[] = [];
  const client = {
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "admit_single_outbound_call") {
        // The admission reserves the call row: it consumes the test's scripted
        // call_logs insert result, recorded as that insert (its SQL has its own tests).
        admissions.push(args);
        calls.push({
          table: "call_logs",
          type: "insert",
          payload: {
            organization_id: args["_org"],
            phone_number_id: args["_phone_number_id"],
            provider: "sarvam",
            direction: "outbound",
            caller_number: args["_caller_number"],
            destination_number: args["_destination"],
            status: "initiated",
            idempotency_key: args["_idempotency_key"],
          },
        });
        if (options.admission) return { data: options.admission, error: null };
        const r = nextResult("call_logs", "insert");
        const err = r.error as { code?: string } | null;
        if (err?.code === "23505")
          return { data: { result: "refused", reason: "destination_busy" }, error: null };
        if (err) return { data: null, error: err };
        return {
          data: { result: "admitted", call_id: (r.data as { id: string }).id },
          error: null,
        };
      }
      rpcs.push({ fn, args });
      return { data: null, error: null };
    },
    from(table: string) {
      return {
        select() {
          return makeBuilder(table, "select");
        },
        update(payload: unknown) {
          return makeBuilder(table, "update", payload);
        },
        insert(payload: unknown) {
          return makeBuilder(table, "insert", payload);
        },
      };
    },
  };

  return { client: client as never, calls, rpcs, admissions };
}

async function withSarvamEnvAndFetch<T>(
  fetchResponse: { status: number; body: unknown },
  fn: () => Promise<T>,
): Promise<{ result: T; requestBody: unknown }> {
  const prior = {
    SARVAM_API_KEY: process.env["SARVAM_API_KEY"],
    SARVAM_ORG_ID: process.env["SARVAM_ORG_ID"],
    SARVAM_WORKSPACE_ID: process.env["SARVAM_WORKSPACE_ID"],
    TELEPHONY_WEBHOOK_BASE_URL: process.env["TELEPHONY_WEBHOOK_BASE_URL"],
    SARVAM_WEBHOOK_SECRET: process.env["SARVAM_WEBHOOK_SECRET"],
  };
  process.env["SARVAM_API_KEY"] = "sk_test_key";
  process.env["SARVAM_ORG_ID"] = "org_1";
  process.env["SARVAM_WORKSPACE_ID"] = "ws_1";
  process.env["TELEPHONY_WEBHOOK_BASE_URL"] = "https://clickai.test";
  process.env["SARVAM_WEBHOOK_SECRET"] = "test-webhook-secret";
  const originalFetch = globalThis.fetch;
  let requestBody: unknown;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    requestBody = init?.body ? JSON.parse(init.body as string) : undefined;
    return new Response(JSON.stringify(fetchResponse.body), { status: fetchResponse.status });
  }) as typeof fetch;
  try {
    const result = await fn();
    return { result, requestBody };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const PHONE_NUMBER_ROW = {
  id: "num_1",
  e164: "+911111111111",
  organization_id: "org_1",
  provider: "sarvam",
  connection_id: "conn_1",
  agent_config_id: "agent_1",
  outbound_enabled: true,
};
const CONNECTION_ROW = {
  id: "conn_1",
  organization_id: "org_1",
  provider: "sarvam",
  provider_connection_id: "sarvam_conn_1",
};
const AGENT_CONFIG_ROW = {
  id: "agent_1",
  organization_id: "org_1",
  sarvam_app_id: "app_1",
  sarvam_app_version: 2,
  sarvam_outbound_ready_app_id: "app_1",
  sarvam_outbound_ready_version: 2,
};

describe("sendSarvamInstantOutboundCall — happy path", () => {
  test("validates, dials, writes provider_call_id, and returns the call id + interaction id", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
      call_logs: {
        select: [{ data: null, error: null }], // no unresolved earlier call to this number
        insert: [{ data: { id: "call_1" }, error: null }],
        update: [{ data: null, error: null }],
      },
    });

    const { result, requestBody } = await withSarvamEnvAndFetch(
      { status: 200, body: { interaction_id: "int_1" } },
      () =>
        sendSarvamInstantOutboundCall(client, {
          now: DAYTIME,
          phoneNumberId: "num_1",
          toE164: "+912222222222",
        }),
    );

    assert.deepEqual(result, { callId: "call_1", interactionId: "int_1", outcome: "started" });
    assert.equal((requestBody as { app_config: { app_id: string } }).app_config.app_id, "app_1");
    assert.equal(
      (requestBody as { user_config: { user_phone_number: string } }).user_config.user_phone_number,
      "+912222222222",
    );

    const insertCall = calls.find((c) => c.table === "call_logs" && c.type === "insert");
    assert.ok(insertCall);
    assert.equal((insertCall!.payload as { status: string }).status, "initiated");

    // interaction_id alone is kept in provider_metadata but never becomes provider_call_id.
    const updateCall = calls.find((c) => c.table === "call_logs" && c.type === "update");
    assert.ok(updateCall);
    const payload = updateCall!.payload as Record<string, unknown>;
    assert.equal("provider_call_id" in payload, false);
    assert.deepEqual(payload["provider_metadata"], { interaction_id: "int_1" });
  });

  test("never writes provider_call_id when interaction_id is absent from the response — no fabricated id", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
      call_logs: {
        select: [{ data: null, error: null }],
        insert: [{ data: { id: "call_1" }, error: null }],
      },
    });

    const { result } = await withSarvamEnvAndFetch({ status: 200, body: {} }, () =>
      sendSarvamInstantOutboundCall(client, {
        now: DAYTIME,
        phoneNumberId: "num_1",
        toE164: "+912222222222",
      }),
    );

    assert.equal(result.interactionId, null);
    const updateCall = calls.find((c) => c.table === "call_logs" && c.type === "update");
    assert.equal(updateCall, undefined);
  });

  test("persists the documented attempt_id as provider_call_id", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
      call_logs: {
        select: [{ data: null, error: null }], // no unresolved earlier call to this number
        insert: [{ data: { id: "call_1" }, error: null }],
        update: [{ data: null, error: null }],
      },
    });

    const { requestBody } = await withSarvamEnvAndFetch(
      { status: 200, body: { attempt_id: "att_1" } },
      () =>
        sendSarvamInstantOutboundCall(client, {
          now: DAYTIME,
          phoneNumberId: "num_1",
          toE164: "+912222222222",
        }),
    );

    const updateCall = calls.find((c) => c.table === "call_logs" && c.type === "update");
    assert.equal((updateCall!.payload as { provider_call_id: string }).provider_call_id, "att_1");
    const metadata = (requestBody as { webhook_config: { metadata: Record<string, string> } })
      .webhook_config.metadata;
    assert.equal(metadata["call_id"], "call_1");
  });
});

describe("sendSarvamInstantOutboundCall — validation before ever dialing", () => {
  test("rejects a non-sarvam phone number", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: {
        select: [{ data: { ...PHONE_NUMBER_ROW, provider: "exotel" }, error: null }],
      },
    });
    await assert.rejects(
      sendSarvamInstantOutboundCall(client, {
        now: DAYTIME,
        phoneNumberId: "num_1",
        toE164: "+912222222222",
      }),
      /only applies to Sarvam-provisioned numbers/i,
    );
  });

  test("refuses a number on this workspace's do-not-call list before anything is written or dialled", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      contacts: { select: [{ data: [{ id: "contact_dnc" }], error: null }] },
    });
    const { requestBody } = await withSarvamEnvAndFetch({ status: 200, body: {} }, () =>
      assert.rejects(
        sendSarvamInstantOutboundCall(client, {
          now: DAYTIME,
          phoneNumberId: "num_1",
          toE164: "+912222222222",
        }),
        /do-not-call list/i,
      ),
    );
    assert.equal(requestBody, undefined, "nothing was sent to Sarvam");
    const lookup = calls.find((c) => c.table === "contacts")!;
    assert.deepEqual(lookup.filters, [
      ["organization_id", PHONE_NUMBER_ROW.organization_id],
      ["phone", "+912222222222"],
      ["opted_out", true],
    ]);
    assert.ok(!calls.some((c) => c.type !== "select"), "nothing written");
  });

  test("rejects when the number has no connection configured", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: {
        select: [{ data: { ...PHONE_NUMBER_ROW, connection_id: null }, error: null }],
      },
    });
    await assert.rejects(
      sendSarvamInstantOutboundCall(client, {
        now: DAYTIME,
        phoneNumberId: "num_1",
        toE164: "+912222222222",
      }),
      /no telephony connection configured/i,
    );
  });

  test("rejects when the connection is not registered with Sarvam", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: {
        select: [{ data: { ...CONNECTION_ROW, provider_connection_id: null }, error: null }],
      },
    });
    await assert.rejects(
      withSarvamEnvAndFetch({ status: 200, body: {} }, () =>
        sendSarvamInstantOutboundCall(client, {
          now: DAYTIME,
          phoneNumberId: "num_1",
          toE164: "+912222222222",
        }),
      ),
      /has not been registered yet/i,
    );
  });

  test("rejects when the agent has not been mapped to a Sarvam app", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: {
        select: [{ data: { ...AGENT_CONFIG_ROW, sarvam_app_id: null }, error: null }],
      },
    });
    await assert.rejects(
      withSarvamEnvAndFetch({ status: 200, body: {} }, () =>
        sendSarvamInstantOutboundCall(client, {
          now: DAYTIME,
          phoneNumberId: "num_1",
          toE164: "+912222222222",
        }),
      ),
      /has not been mapped to a Sarvam app yet/i,
    );
  });
});

function scriptForStartFailure(updateRows: unknown[]) {
  return makeFakeSupabase({
    phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
    telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
    agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
    call_logs: {
      select: [{ data: null, error: null }],
      insert: [{ data: { id: "call_1" }, error: null }],
      update: [{ data: updateRows, error: null }],
    },
  });
}
const dial = (client: never, status: number) =>
  withSarvamEnvAndFetch({ status, body: { error: "boom" } }, () =>
    sendSarvamInstantOutboundCall(client, {
      now: DAYTIME,
      phoneNumberId: "num_1",
      toE164: "+912222222222",
    }),
  );

describe("sendSarvamInstantOutboundCall — does not fake success", () => {
  test("a definite rejection (400) marks the row failed, only while still initiated, and rethrows", async () => {
    const { client, calls, rpcs } = scriptForStartFailure([{ id: "call_1" }]);
    await assert.rejects(dial(client, 400));
    // Not placed: finalization runs for the call (zero charge, marked done).
    assert.deepEqual(
      rpcs.map((r) => [r.fn, r.args["_call"]]),
      [["claim_call_finalization", "call_1"]],
    );

    const updateCall = calls.find((c) => c.table === "call_logs" && c.type === "update")!;
    assert.equal((updateCall.payload as { status: string }).status, "failed");
    assert.ok((updateCall.payload as { failure_reason: string }).failure_reason);
    assert.deepEqual(updateCall.filters, [
      ["id", "call_1"],
      ["status", "initiated"],
    ]);
  });

  for (const status of [503, 429]) {
    test(`an ambiguous ${status} marks the row outcome_unknown (no ended_at) and reports outcome unknown`, async () => {
      const { client, calls } = scriptForStartFailure([{ id: "call_1" }]);
      const { result } = await dial(client, status);
      assert.deepEqual(result, { callId: "call_1", interactionId: null, outcome: "unknown" });

      const updateCall = calls.find((c) => c.table === "call_logs" && c.type === "update")!;
      const payload = updateCall.payload as Record<string, unknown>;
      assert.equal(payload["status"], "outcome_unknown");
      assert.equal("ended_at" in payload, false);
      assert.deepEqual(updateCall.filters, [
        ["id", "call_1"],
        ["status", "initiated"],
      ]);
    });
  }

  test("a webhook that already resolved the call wins: nothing is overwritten and no error is thrown", async () => {
    // The conditional update matched no row: the call had already left `initiated`.
    const { client } = scriptForStartFailure([]);
    const { result } = await dial(client, 400);
    assert.equal(result.outcome, "started");
  });

  test("refuses to call a number that has an unresolved earlier call — nothing inserted, nothing dialled", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
      call_logs: { select: [{ data: { id: "earlier_call" }, error: null }] },
    });
    await assert.rejects(dial(client, 200), /hasn't finished or has an unconfirmed outcome/);
    const guard = calls.find(
      (c) =>
        c.table === "call_logs" &&
        c.type === "select" &&
        !c.filters?.some(([k]) => k === "caller_number"),
    )!;
    // Blocks exactly the calls an operator can resolve: initiated (with or
    // without an attempt id) or outcome_unknown.
    assert.ok(
      guard.filters!.some(
        ([k, v]) => k === "status in" && JSON.stringify(v) === '["initiated","outcome_unknown"]',
      ),
    );
    assert.ok(guard.filters!.some(([k, v]) => k === "destination_number" && v === "+912222222222"));
    assert.equal(
      calls.some((c) => c.type === "insert"),
      false,
    );
  });

  test("a concurrent request that reserved the number first (23505 on insert): refused, nothing dialled", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
      call_logs: {
        select: [{ data: null, error: null }], // the pre-check ran before the other request inserted
        insert: [
          {
            data: null,
            error: {
              code: "23505",
              message: 'violates "idx_call_logs_sarvam_outbound_number_reservation"',
            },
          },
        ],
      },
    });
    let dialled = false;
    const originalFetch = globalThis.fetch;
    await assert.rejects(
      withSarvamEnvAndFetch({ status: 200, body: { attempt_id: "att_x" } }, async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
          dialled = true;
          return realFetch(...args);
        }) as typeof fetch;
        return sendSarvamInstantOutboundCall(client, {
          now: DAYTIME,
          phoneNumberId: "num_1",
          toE164: "+912222222222",
        });
      }),
      /hasn't finished or has an unconfirmed outcome/,
    );
    globalThis.fetch = originalFetch;
    assert.equal(dialled, false);
    assert.equal(
      calls.some((c) => c.type === "update"),
      false,
    );
  });
});

describe("sendSarvamInstantOutboundCall — canonical destination numbers", () => {
  test("an invalid number is rejected before any database access or Sarvam request", async () => {
    // An empty script: any database call would fail the test with "no scripted … result".
    const { client, calls } = makeFakeSupabase({});
    for (const bad of ["+910987654321", "9876543210", "+0919876543210", "not a number"]) {
      const { requestBody } = await withSarvamEnvAndFetch({ status: 200, body: {} }, async () => {
        await assert.rejects(
          sendSarvamInstantOutboundCall(client, {
            now: DAYTIME,
            phoneNumberId: "num_1",
            toE164: bad,
          }),
          /valid destination number with its country code/,
        );
      });
      assert.equal(requestBody, undefined, `nothing sent to Sarvam for ${bad}`);
    }
    assert.deepEqual(calls, []);
  });

  test("an equivalent format is reserved, inserted and dialled as the canonical number", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
      call_logs: {
        select: [{ data: null, error: null }],
        insert: [{ data: { id: "call_1" }, error: null }],
        update: [{ data: null, error: null }],
      },
    });
    const { requestBody } = await withSarvamEnvAndFetch(
      { status: 200, body: { attempt_id: "att_1" } },
      () =>
        sendSarvamInstantOutboundCall(client, {
          now: DAYTIME,
          phoneNumberId: "num_1",
          toE164: "0091 98765 43210",
        }),
    );
    const guard = calls.find(
      (c) =>
        c.table === "call_logs" &&
        c.type === "select" &&
        !c.filters?.some(([k]) => k === "caller_number"),
    )!;
    assert.ok(guard.filters!.some(([k, v]) => k === "destination_number" && v === "+919876543210"));
    const insert = calls.find((c) => c.table === "call_logs" && c.type === "insert")!;
    assert.equal(
      (insert.payload as { destination_number: string }).destination_number,
      "+919876543210",
    );
    assert.equal(
      (requestBody as { user_config: { user_phone_number: string } }).user_config.user_phone_number,
      "+919876543210",
    );
  });
});

describe("supervised-test allowlist (SARVAM_OUTBOUND_TEST_ALLOWLIST)", () => {
  async function withAllowlist<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
    const prior = process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"];
    if (value === undefined) delete process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"];
    else process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"] = value;
    try {
      return await fn();
    } finally {
      if (prior === undefined) delete process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"];
      else process.env["SARVAM_OUTBOUND_TEST_ALLOWLIST"] = prior;
    }
  }

  test("unset: no restriction", async () => {
    await withAllowlist(undefined, () =>
      assert.equal(isSarvamOutboundDestinationAllowed("+912222222222"), true),
    );
  });

  test("set: only the listed numbers, compared in canonical form", async () => {
    await withAllowlist("0091 99999 99999, +91-88888-88888", () => {
      assert.equal(isSarvamOutboundDestinationAllowed("+919999999999"), true);
      assert.equal(isSarvamOutboundDestinationAllowed("+918888888888"), true);
      assert.equal(isSarvamOutboundDestinationAllowed("+912222222222"), false);
    });
  });

  test("set but with no valid number: nothing is allowed (fails closed)", async () => {
    await withAllowlist("not-a-number", () =>
      assert.equal(isSarvamOutboundDestinationAllowed("+912222222222"), false),
    );
  });

  test("a number outside the list is refused before any database access or Sarvam request", async () => {
    const { client, calls, rpcs } = makeFakeSupabase({});
    await withAllowlist("+919999999999", async () => {
      const { requestBody } = await withSarvamEnvAndFetch({ status: 200, body: {} }, async () => {
        await assert.rejects(
          sendSarvamInstantOutboundCall(client, {
            now: DAYTIME,
            phoneNumberId: "num_1",
            toE164: "+912222222222",
          }),
          /limited to approved test numbers/,
        );
      });
      assert.equal(requestBody, undefined);
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(rpcs, []);
  });
});

describe("sendSarvamInstantOutboundCall — authenticated result webhook", () => {
  test("Sarvam is given the result URL with provider=sarvam and verify_token", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
      call_logs: {
        select: [{ data: null, error: null }],
        insert: [{ data: { id: "call_1" }, error: null }],
        update: [{ data: null, error: null }],
      },
    });
    const { requestBody } = await withSarvamEnvAndFetch(
      { status: 200, body: { attempt_id: "att_1" } },
      () =>
        sendSarvamInstantOutboundCall(client, {
          now: DAYTIME,
          phoneNumberId: "num_1",
          toE164: "+912222222222",
        }),
    );
    const config = (requestBody as { webhook_config: { url: string; metadata: unknown } })
      .webhook_config;
    assert.equal(
      config.url,
      "https://clickai.test/api/public/webhooks/telephony?provider=sarvam&verify_token=test-webhook-secret",
    );
    const url = new URL(config.url);
    assert.equal(url.searchParams.get("provider"), "sarvam");
    assert.equal(url.searchParams.get("verify_token"), "test-webhook-secret");
  });

  test("without SARVAM_WEBHOOK_SECRET the call is refused: nothing written, nothing sent to Sarvam", async () => {
    const { SARVAM_WEBHOOK_SECRET_MISSING_MESSAGE } = await import("./telephony.server.ts");
    // Only the phone-number read is scripted: any later database call would fail the test.
    const { client, calls } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
    });
    const { requestBody } = await withSarvamEnvAndFetch({ status: 200, body: {} }, async () => {
      delete process.env["SARVAM_WEBHOOK_SECRET"]; // restored by the helper
      await assert.rejects(
        sendSarvamInstantOutboundCall(client, {
          now: DAYTIME,
          phoneNumberId: "num_1",
          toE164: "+912222222222",
        }),
        (err: unknown) => (err as Error).message === SARVAM_WEBHOOK_SECRET_MISSING_MESSAGE,
      );
    });
    assert.equal(requestBody, undefined, "nothing was sent to Sarvam");
    assert.deepEqual(
      calls.map((c) => `${c.table}.${c.type}`),
      ["phone_numbers.select"],
    );
  });

  test("the message names the missing setting without exposing any value", async () => {
    const { SARVAM_WEBHOOK_SECRET_MISSING_MESSAGE } = await import("./telephony.server.ts");
    assert.match(SARVAM_WEBHOOK_SECRET_MISSING_MESSAGE, /SARVAM_WEBHOOK_SECRET/);
    assert.doesNotMatch(SARVAM_WEBHOOK_SECRET_MISSING_MESSAGE, /verify_token=|test-webhook-secret/);
  });
});

describe("persistStartResult — saving Sarvam's start response", () => {
  function failingClient(mode: "error" | "throw") {
    const writes: unknown[] = [];
    const client = {
      from: () => ({
        update: (patch: unknown) => ({
          eq: async () => {
            writes.push(patch);
            if (mode === "throw") throw new Error("network down");
            return { error: { code: "57014", message: "statement timeout" } };
          },
        }),
      }),
    };
    return { client: client as never, writes };
  }

  for (const mode of ["error", "throw"] as const)
    test(`a write that keeps failing (${mode}) is tried twice, logged, and never thrown`, async () => {
      const { client, writes } = failingClient(mode);
      const logged: unknown[][] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void logged.push(args);
      try {
        const saved = await persistStartResult(client, "call_1", {
          attemptId: "att_1",
          interactionId: "int_1",
        });
        assert.equal(saved, false);
      } finally {
        console.error = original;
      }
      assert.equal(writes.length, 2);
      assert.deepEqual(writes[0], {
        provider_call_id: "att_1",
        provider_metadata: { interaction_id: "int_1" },
      });
      assert.equal(logged.length, 2);
      assert.equal(logged[0]![0], "sarvam_outbound:start_result_not_saved");
      assert.doesNotMatch(JSON.stringify(logged), /att_1|int_1/, "ids from Sarvam are not logged");
    });

  test("nothing to save: no write at all", async () => {
    const { client, writes } = failingClient("error");
    assert.equal(await persistStartResult(client, "call_1", {}), true);
    assert.equal(writes.length, 0);
  });

  test("the single call still reports started when the write fails", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
      call_logs: {
        select: [{ data: null, error: null }],
        insert: [{ data: { id: "call_1" }, error: null }],
        update: [
          { data: null, error: { code: "57014", message: "statement timeout" } },
          { data: null, error: { code: "57014", message: "statement timeout" } },
        ],
      },
    });
    const original = console.error;
    console.error = () => {};
    try {
      const { result } = await withSarvamEnvAndFetch(
        { status: 200, body: { attempt_id: "att_1" } },
        () =>
          sendSarvamInstantOutboundCall(client, {
            now: DAYTIME,
            phoneNumberId: "num_1",
            toE164: "+912222222222",
          }),
      );
      assert.deepEqual(result, { callId: "call_1", interactionId: null, outcome: "started" });
    } finally {
      console.error = original;
    }
  });
});

describe("sendSarvamInstantOutboundCall — one agent, outbound mode set per call", () => {
  const scriptUntilDial = (
    agentRow: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: agentRow, error: null }] },
      call_logs: {
        select: [{ data: null, error: null }],
        insert: [{ data: { id: "call_1" }, error: null }],
        update: [{ data: null, error: null }],
      },
      ...extra,
    });

  for (const [label, row] of [
    [
      "never confirmed for outbound",
      {
        ...AGENT_CONFIG_ROW,
        sarvam_outbound_ready_app_id: null,
        sarvam_outbound_ready_version: null,
      },
    ],
    [
      "remapped to a version not yet confirmed",
      { ...AGENT_CONFIG_ROW, sarvam_outbound_ready_version: 1 },
    ],
  ] as const)
    test(`refused when the agent version is ${label}: nothing reserved, nothing dialled`, async () => {
      const { client, calls } = scriptUntilDial(row);
      const { result, requestBody } = await withSarvamEnvAndFetch({ status: 200, body: {} }, () =>
        sendSarvamInstantOutboundCall(client, {
          now: DAYTIME,
          phoneNumberId: "num_1",
          toE164: "+912222222222",
        }).then(
          () => "dialled",
          (e: Error) => e.message,
        ),
      );
      assert.match(String(result), /not been confirmed for outbound/);
      assert.equal(requestBody, undefined, "no request to Sarvam");
      assert.equal(
        calls.filter((c) => c.table === "call_logs" && c.type !== "select").length,
        0,
        "no reservation",
      );
    });

  test("dials the customer's ONE agent mapping with direction, call id, objective and the outbound opening line", async () => {
    const { client } = scriptUntilDial(
      { ...AGENT_CONFIG_ROW, business_id: "biz_1" },
      {
        businesses: {
          select: [
            { data: { name: "Smile Bright Dental", organization_id: "org_1" }, error: null },
          ],
        },
      },
    );
    const { requestBody } = await withSarvamEnvAndFetch(
      { status: 200, body: { attempt_id: "att_1" } },
      () =>
        sendSarvamInstantOutboundCall(client, {
          now: DAYTIME,
          phoneNumberId: "num_1",
          toE164: "+912222222222",
          objective: " Confirm\ntomorrow's visit ",
          // A caller-supplied value can never change the direction or the call id.
          agentVariables: {
            call_direction: "inbound",
            clickai_call_id: "someone-else",
            note: "kept",
          },
        }),
    );
    const appConfig = (requestBody as { app_config: Record<string, unknown> }).app_config;
    assert.equal(appConfig["app_id"], "app_1", "the same agent the inbound deployment uses");
    assert.equal(appConfig["app_version"], 2);
    assert.deepEqual(appConfig["agent_variables"], {
      note: "kept",
      call_direction: "outbound",
      clickai_call_id: "call_1",
      campaign_objective: "Confirm tomorrow's visit",
    });
    assert.deepEqual(appConfig["app_overrides"], {
      initial_bot_message:
        "Hello, this is the virtual assistant calling from Smile Bright Dental. Is this a good time to talk?",
    });
  });

  test("another customer's business name is never used in the opening line", async () => {
    const { client } = scriptUntilDial(
      { ...AGENT_CONFIG_ROW, business_id: "biz_other" },
      {
        businesses: {
          select: [{ data: { name: "Other Clinic", organization_id: "org_2" }, error: null }],
        },
      },
    );
    const { requestBody } = await withSarvamEnvAndFetch({ status: 200, body: {} }, () =>
      sendSarvamInstantOutboundCall(client, {
        now: DAYTIME,
        phoneNumberId: "num_1",
        toE164: "+912222222222",
      }),
    );
    const overrides = (
      requestBody as { app_config: { app_overrides: { initial_bot_message: string } } }
    ).app_config.app_overrides;
    assert.doesNotMatch(overrides.initial_bot_message, /Other Clinic/);
  });
});

describe("sendSarvamInstantOutboundCall — reserved outbound variables", () => {
  test("caller-supplied variables cannot set the objective or instructions; only the objective parameter can", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
      call_logs: {
        select: [{ data: null, error: null }],
        insert: [{ data: { id: "call_1" }, error: null }],
        update: [{ data: null, error: null }],
      },
    });
    const { requestBody } = await withSarvamEnvAndFetch({ status: 200, body: {} }, () =>
      sendSarvamInstantOutboundCall(client, {
        now: DAYTIME,
        phoneNumberId: "num_1",
        toE164: "+912222222222",
        agentVariables: {
          campaign_objective: "smuggled",
          campaign_instructions: "smuggled",
          keep: "yes",
        },
      }),
    );
    const vars = (requestBody as { app_config: { agent_variables: Record<string, unknown> } })
      .app_config.agent_variables;
    assert.equal("campaign_objective" in vars, false);
    assert.equal("campaign_instructions" in vars, false);
    assert.equal(vars["keep"], "yes");
    assert.equal(vars["call_direction"], "outbound");
  });
});

describe("pre-dial eligibility, idempotency and atomic admission", () => {
  const KEY = "req_0123456789abcdef0123";
  const ready = (over: Parameters<typeof makeFakeSupabase>[1] = {}, callLogs: QueryResult[] = []) =>
    makeFakeSupabase(
      {
        phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
        telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
        agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
        call_logs: {
          select: callLogs.length ? callLogs : [{ data: null, error: null }],
          insert: [{ data: { id: "call_1" }, error: null }],
          update: [{ data: null, error: null }],
        },
      },
      over,
    );
  const place = (
    client: never,
    extra: Partial<Parameters<typeof sendSarvamInstantOutboundCall>[1]> = {},
  ) =>
    withSarvamEnvAndFetch({ status: 200, body: { attempt_id: "att_1" } }, () =>
      sendSarvamInstantOutboundCall(client, {
        now: DAYTIME,
        phoneNumberId: "num_1",
        toE164: "+912222222222",
        idempotencyKey: KEY,
        ...extra,
      }).then(
        (r) => r as unknown,
        (e: Error) => e as unknown,
      ),
    );
  const message = (r: unknown) => String((r as { message?: unknown }).message);

  test("the request id and every limit reach the admission; a new call is dialled once", async () => {
    const f = ready();
    const { result, requestBody } = await place(f.client);
    assert.equal((result as { callId: string }).callId, "call_1");
    assert.ok(requestBody, "dialled");
    assert.equal(f.admissions.length, 1);
    assert.deepEqual(f.admissions[0], {
      _org: "org_1",
      _phone_number_id: "num_1",
      _destination: "+912222222222",
      _caller_number: "+911111111111",
      _idempotency_key: KEY,
      _max_in_flight: SINGLE_CALL_LIMITS.inFlight,
      _max_per_hour: SINGLE_CALL_LIMITS.perHour,
      _max_per_day: SINGLE_CALL_LIMITS.perDay,
      _max_per_destination_day: SINGLE_CALL_LIMITS.perDestinationDay,
    });
  });

  test("without a request id the server makes one, so the admission always has a key", async () => {
    const f = ready();
    await place(f.client, { idempotencyKey: undefined });
    assert.match(String(f.admissions[0]!["_idempotency_key"]), /^srv_[0-9a-f]{32}$/);
  });

  test("a malformed request id is refused before anything is read", async () => {
    const f = ready();
    const { result, requestBody } = await place(f.client, { idempotencyKey: "short" });
    assert.match(message(result), /valid request id/);
    assert.equal(requestBody, undefined);
    assert.equal(f.calls.length, 0);
  });

  test("a repeat while the first call is open returns that call and dials nothing", async () => {
    const f = ready({}, [
      { data: { id: "call_first", status: "initiated", idempotency_key: KEY }, error: null },
    ]);
    const { result, requestBody } = await place(f.client);
    assert.deepEqual(result, {
      callId: "call_first",
      interactionId: null,
      outcome: "started",
      duplicate: true,
    });
    assert.equal(requestBody, undefined, "no second Sarvam request");
    assert.equal(f.admissions.length, 0);
  });

  test("a repeat the admission recognises (raced past the open-call read) dials nothing", async () => {
    for (const [status, outcome] of [
      ["completed", "started"],
      ["outcome_unknown", "unknown"],
    ] as const) {
      const f = ready({ admission: { result: "duplicate", call_id: "call_first", status } });
      const { result, requestBody } = await place(f.client);
      assert.equal((result as { outcome: string }).outcome, outcome, status);
      assert.equal((result as { duplicate: boolean }).duplicate, true);
      assert.equal(requestBody, undefined);
    }
  });

  test("a repeat of an attempt that was not placed says so, so the user starts a new one", async () => {
    const f = ready({
      admission: { result: "duplicate", call_id: "call_first", status: "failed" },
    });
    const { result, requestBody } = await place(f.client);
    assert.match(message(result), /was not placed/);
    assert.equal(requestBody, undefined);
  });

  test("every admission refusal has a clear reason and dials nothing", async () => {
    const cases: [string, string | RegExp][] = [
      ["in_flight_limit", TOO_MANY_IN_FLIGHT_MESSAGE],
      ["hourly_limit", HOURLY_LIMIT_MESSAGE],
      ["daily_limit", /a day/],
      ["destination_daily_limit", DESTINATION_LIMIT_MESSAGE],
      ["insufficient_balance", INSUFFICIENT_BALANCE_MESSAGE],
      ["destination_busy", UNRESOLVED_CALL_MESSAGE],
      ["number_not_owned", /not assigned to this organization/],
      ["idempotency_key_reused", /different number/],
      ["something_new", /could not be admitted/],
    ];
    for (const [reason, expected] of cases) {
      const f = ready({ admission: { result: "refused", reason } });
      const { result, requestBody } = await place(f.client);
      if (typeof expected === "string") assert.equal(message(result), expected, reason);
      else assert.match(message(result), expected, reason);
      assert.equal(requestBody, undefined, reason);
    }
  });

  test("a failed admission call (database error) fails closed: nothing dialled", async () => {
    const f = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
      call_logs: {
        select: [{ data: null, error: null }],
        insert: [{ data: null, error: { code: "57014", message: "statement timeout" } }],
      },
    });
    const { result, requestBody } = await place(f.client);
    assert.match(message(result), /statement timeout/);
    assert.equal(requestBody, undefined);
  });

  test("no prior relationship with the business: refused before any reservation", async () => {
    const f = ready({ relationship: false });
    const { result, requestBody } = await place(f.client);
    assert.match(message(result), /only calls people who already know your business/);
    assert.equal(requestBody, undefined);
    assert.equal(f.admissions.length, 0);
  });

  test("a relationship lookup that fails refuses the call (fails closed)", async () => {
    const f = ready();
    const client = f.client as unknown as { from: (t: string) => Record<string, unknown> };
    const realFrom = client.from.bind(client);
    client.from = (t: string) => {
      const table = realFrom(t);
      if (t !== "leads") return table;
      const select = table["select"] as () => Record<string, unknown>;
      return {
        ...table,
        select: () => {
          const b = select();
          b["then"] = (resolve: (r: unknown) => void) =>
            resolve({ data: null, error: { message: "leads unavailable" } });
          return b;
        },
      };
    };
    const { result, requestBody } = await place(f.client);
    assert.match(message(result), /leads unavailable/);
    assert.equal(requestBody, undefined);
    assert.equal(f.admissions.length, 0);
  });

  test("calling hours: outside 09:00–21:00 India time nothing is read or dialled", async () => {
    for (const iso of ["2026-11-19T15:30:00Z", "2026-11-19T03:29:00Z"]) {
      const f = ready();
      const { result, requestBody } = await place(f.client, { now: new Date(iso) });
      assert.match(message(result), /between 9:00 AM and 9:00 PM/, iso);
      assert.equal(requestBody, undefined);
      assert.equal(f.calls.length, 0);
    }
  });

  test("the kill switch and non-Indian destinations stop the call before anything is read", async () => {
    const prior = process.env["OUTBOUND_CALLING_DISABLED"];
    process.env["OUTBOUND_CALLING_DISABLED"] = "true";
    try {
      const f = ready();
      const { result } = await place(f.client);
      assert.match(message(result), /paused/);
      assert.equal(f.calls.length, 0);
    } finally {
      if (prior === undefined) delete process.env["OUTBOUND_CALLING_DISABLED"];
      else process.env["OUTBOUND_CALLING_DISABLED"] = prior;
    }
    const f = ready();
    const { result } = await place(f.client, { toE164: "+14155550123" });
    assert.match(message(result), /Indian \(\+91\) numbers/);
    assert.equal(f.calls.length, 0);
  });
});

describe("the number's own outbound switch", () => {
  test("a number with outbound off never dials, on any path that reaches the dial function", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: {
        select: [{ data: { ...PHONE_NUMBER_ROW, outbound_enabled: false }, error: null }],
      },
    });
    const { result, requestBody } = await withSarvamEnvAndFetch(
      { status: 200, body: { attempt_id: "att_1" } },
      () =>
        sendSarvamInstantOutboundCall(client, {
          now: DAYTIME,
          phoneNumberId: "num_1",
          toE164: "+912222222222",
        }).then(
          () => "dialled",
          (e: Error) => e.message,
        ),
    );
    assert.equal(result, "Outbound calling is disabled on this number.");
    assert.equal(requestBody, undefined);
    assert.equal(calls.filter((c) => c.table !== "phone_numbers").length, 0);
  });
});
