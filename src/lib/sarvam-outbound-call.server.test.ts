import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sendSarvamInstantOutboundCall } from "./sarvam-outbound-call.server.ts";

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
  const calls: { table: string; type: OpType; payload?: unknown }[] = [];

  function nextResult(table: string, type: OpType): QueryResult {
    consumedIdx[table] ??= { select: 0, update: 0, insert: 0 };
    const idx = consumedIdx[table]![type]++;
    const result = script[table]?.[type]?.[idx];
    if (!result) throw new Error(`test bug: no scripted ${type} result #${idx} for table ${table}`);
    return result;
  }

  function makeBuilder(table: string, type: OpType, payload?: unknown) {
    const builder = {
      select() {
        return builder;
      },
      eq() {
        return builder;
      },
      maybeSingle() {
        return builder;
      },
      single() {
        return builder;
      },
      then(resolve: (r: QueryResult) => void, reject: (e: unknown) => void): Promise<void> {
        calls.push({ table, type, payload });
        return Promise.resolve(nextResult(table, type)).then(resolve as never, reject);
      },
    };
    return builder;
  }

  const client = {
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

  return { client: client as never, calls };
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
  };
  process.env["SARVAM_API_KEY"] = "sk_test_key";
  process.env["SARVAM_ORG_ID"] = "org_1";
  process.env["SARVAM_WORKSPACE_ID"] = "ws_1";
  process.env["TELEPHONY_WEBHOOK_BASE_URL"] = "https://vaani.example";
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

    assert.deepEqual(result, { callId: "call_1", interactionId: "int_1" });
    assert.equal((requestBody as { app_config: { app_id: string } }).app_config.app_id, "app_1");
    assert.equal(
      (requestBody as { user_config: { user_phone_number: string } }).user_config.user_phone_number,
      "+912222222222",
    );

    const insertCall = calls.find((c) => c.table === "call_logs" && c.type === "insert");
    assert.ok(insertCall);
    assert.equal((insertCall!.payload as { status: string }).status, "initiated");

    const updateCall = calls.find((c) => c.table === "call_logs" && c.type === "update");
    assert.ok(updateCall);
    assert.equal((updateCall!.payload as { provider_call_id: string }).provider_call_id, "int_1");
  });

  test("never writes provider_call_id when interaction_id is absent from the response — no fabricated id", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
      call_logs: { insert: [{ data: { id: "call_1" }, error: null }] },
    });

    const { result } = await withSarvamEnvAndFetch({ status: 200, body: {} }, () =>
      sendSarvamInstantOutboundCall(client, { phoneNumberId: "num_1", toE164: "+912222222222" }),
    );

    assert.equal(result.interactionId, null);
    const updateCall = calls.find((c) => c.table === "call_logs" && c.type === "update");
    assert.equal(updateCall, undefined);
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

describe("sendSarvamInstantOutboundCall — does not fake success", () => {
  test("marks the call_logs row failed and rethrows when the Sarvam call itself fails — never silently drops it", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: { select: [{ data: PHONE_NUMBER_ROW, error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
      call_logs: {
        insert: [{ data: { id: "call_1" }, error: null }],
        update: [{ data: null, error: null }],
      },
    });

    await assert.rejects(
      withSarvamEnvAndFetch({ status: 500, body: { error: "boom" } }, () =>
        sendSarvamInstantOutboundCall(client, { phoneNumberId: "num_1", toE164: "+912222222222" }),
      ),
    );

    const updateCall = calls.find((c) => c.table === "call_logs" && c.type === "update");
    assert.ok(updateCall);
    assert.equal((updateCall!.payload as { status: string }).status, "failed");
    assert.ok((updateCall!.payload as { failure_reason: string }).failure_reason);
  });
});
