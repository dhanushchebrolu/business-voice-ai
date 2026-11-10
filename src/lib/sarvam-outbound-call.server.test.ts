import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isSarvamOutboundDestinationAllowed,
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

function makeFakeSupabase(script: Record<string, Partial<Record<OpType, QueryResult[]>>>) {
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
    const result = script[table]?.[type]?.[idx];
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
        return Promise.resolve(nextResult(table, type)).then(resolve as never, reject);
      },
    };
    return builder;
  }

  // Database functions (finalization): recorded; claim returns no lease, so
  // finalization is a no-op here (its own tests cover what runs next).
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    async rpc(fn: string, args: Record<string, unknown>) {
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

  return { client: client as never, calls, rpcs };
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
};
const CONNECTION_ROW = {
  id: "conn_1",
  provider: "sarvam",
  provider_connection_id: "sarvam_conn_1",
};
const AGENT_CONFIG_ROW = {
  id: "agent_1",
  organization_id: "org_1",
  sarvam_app_id: "app_1",
  sarvam_app_version: 2,
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
      sendSarvamInstantOutboundCall(client, { phoneNumberId: "num_1", toE164: "+912222222222" }),
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
        sendSarvamInstantOutboundCall(client, { phoneNumberId: "num_1", toE164: "+912222222222" }),
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
      sendSarvamInstantOutboundCall(client, { phoneNumberId: "num_1", toE164: "+912222222222" }),
      /only applies to Sarvam-provisioned numbers/i,
    );
  });

  test("rejects when the number has no connection configured", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: {
        select: [{ data: { ...PHONE_NUMBER_ROW, connection_id: null }, error: null }],
      },
    });
    await assert.rejects(
      sendSarvamInstantOutboundCall(client, { phoneNumberId: "num_1", toE164: "+912222222222" }),
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
    sendSarvamInstantOutboundCall(client, { phoneNumberId: "num_1", toE164: "+912222222222" }),
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
    const guard = calls.find((c) => c.table === "call_logs" && c.type === "select")!;
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
          sendSarvamInstantOutboundCall(client, { phoneNumberId: "num_1", toE164: bad }),
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
          phoneNumberId: "num_1",
          toE164: "0091 98765 43210",
        }),
    );
    const guard = calls.find((c) => c.table === "call_logs" && c.type === "select")!;
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
        sendSarvamInstantOutboundCall(client, { phoneNumberId: "num_1", toE164: "+912222222222" }),
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
        sendSarvamInstantOutboundCall(client, { phoneNumberId: "num_1", toE164: "+912222222222" }),
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
