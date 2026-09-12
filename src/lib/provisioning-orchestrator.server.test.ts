import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { provisionOrganizationAfterPayment } from "./provisioning-orchestrator.server.ts";

/**
 * Behavioral coverage for provisionOrganizationAfterPayment — the function
 * the Razorpay webhook's setup_fee branch calls the instant a client's
 * setup payment clears. Takes its Supabase client as a parameter, so its
 * claim/link/deploy/advance-lifecycle logic can be exercised directly
 * against a scripted fake query builder, the same technique used for
 * claimAvailablePhoneNumber and createInboundDeploymentForNumbers.
 *
 * getTelephonyAdapter("sarvam") (used only on the "both connection and
 * agent are ready" path, via createInboundDeploymentForNumbers) reads real
 * env vars and issues a real fetch — set up the same way
 * sarvam-inbound-deployment.server.test.ts does: SARVAM_* env vars for the
 * call's duration, globalThis.fetch swapped out.
 */

interface QueryResult {
  data: unknown;
  error: unknown;
}
type OpType = "select" | "update";

function makeFakeSupabase(script: Record<string, Partial<Record<OpType, QueryResult[]>>>) {
  const consumedIdx: Record<string, Record<OpType, number>> = {};
  const calls: { table: string; type: OpType; payload?: unknown }[] = [];

  function nextResult(table: string, type: OpType): QueryResult {
    consumedIdx[table] ??= { select: 0, update: 0 };
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
      neq() {
        return builder;
      },
      is() {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      in() {
        return builder;
      },
      maybeSingle() {
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
      };
    },
  };

  return { client: client as never, calls };
}

async function withSarvamEnvAndFetch<T>(
  fetchResponse: { status: number; body: unknown },
  fn: () => Promise<T>,
): Promise<T> {
  const prior = {
    SARVAM_API_KEY: process.env["SARVAM_API_KEY"],
    SARVAM_ORG_ID: process.env["SARVAM_ORG_ID"],
    SARVAM_WORKSPACE_ID: process.env["SARVAM_WORKSPACE_ID"],
  };
  process.env["SARVAM_API_KEY"] = "sk_test_key";
  process.env["SARVAM_ORG_ID"] = "org_1";
  process.env["SARVAM_WORKSPACE_ID"] = "ws_1";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(fetchResponse.body), {
      status: fetchResponse.status,
    })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const ORG_ROW = { id: "org_1", lifecycle_status: "setup_paid" };
const POOL_NUMBER = {
  id: "num_1",
  e164: "+911111111111",
  organization_id: null,
  status: "available",
  provider: "sarvam",
  connection_id: null,
  agent_config_id: null,
  provider_deployment_id: null,
};

describe("provisionOrganizationAfterPayment — idempotent number claim", () => {
  test("claims a number from the pool when the org has none, and advances lifecycle_status to provisioning", async () => {
    const { client, calls } = makeFakeSupabase({
      organizations: {
        select: [{ data: ORG_ROW, error: null }],
        update: [{ data: null, error: null }],
      },
      phone_numbers: {
        select: [
          { data: [], error: null }, // no existing number for this org
          { data: [], error: null }, // pool candidate select (claim)
        ],
        update: [{ data: [], error: null }], // lost race — none available after all
      },
      telephony_connections: { select: [] },
      agent_configs: { select: [] },
    });

    const result = await provisionOrganizationAfterPayment(client, "org_1");

    assert.equal(result.organizationId, "org_1");
    assert.equal(result.numberClaimedNow, false); // pool empty in this script
    assert.match(result.note, /No phone number is currently available/);

    const orgUpdate = calls.find((c) => c.table === "organizations" && c.type === "update");
    assert.ok(orgUpdate);
    assert.equal(
      (orgUpdate!.payload as { lifecycle_status: string }).lifecycle_status,
      "provisioning",
    );
  });

  test("reuses an existing non-released number instead of claiming a second one from the pool", async () => {
    const existing = { ...POOL_NUMBER, organization_id: "org_1", status: "provisioning" };
    const { client, calls } = makeFakeSupabase({
      organizations: {
        select: [{ data: ORG_ROW, error: null }],
        update: [{ data: null, error: null }],
      },
      phone_numbers: { select: [{ data: [existing], error: null }] },
      telephony_connections: { select: [{ data: null, error: null }] },
      agent_configs: { select: [{ data: null, error: null }] },
    });

    const result = await provisionOrganizationAfterPayment(client, "org_1");

    assert.equal(result.numberClaimedNow, false);
    assert.equal(result.phoneNumberId, "num_1");
    assert.match(result.note, /Reusing already-assigned phone number/);
    // No update call against phone_numbers to claim a second number.
    const poolClaimUpdate = calls.find((c) => c.table === "phone_numbers" && c.type === "update");
    assert.equal(poolClaimUpdate, undefined);
  });
});

describe("provisionOrganizationAfterPayment — links existing connection/agent mapping, never invents one", () => {
  test("reports missing connection and agent mapping honestly, without attempting a deployment", async () => {
    const { client, calls } = makeFakeSupabase({
      organizations: {
        select: [{ data: ORG_ROW, error: null }],
        update: [{ data: null, error: null }],
      },
      phone_numbers: {
        select: [
          { data: [], error: null },
          { data: [{ id: "num_1" }], error: null },
        ],
        update: [{ data: [POOL_NUMBER], error: null }],
      },
      telephony_connections: { select: [{ data: null, error: null }] },
      agent_configs: { select: [{ data: null, error: null }] },
    });

    const result = await provisionOrganizationAfterPayment(client, "org_1");

    assert.equal(result.numberClaimedNow, true);
    assert.equal(result.deploymentCreatedNow, false);
    assert.match(result.note, /no registered Sarvam connection yet/);
    assert.match(result.note, /agent has not been mapped to a Sarvam app yet/);
    // No SARVAM_* env vars are set in this test's process, so
    // sarvamCredentialsConfigured is false here — that platform-wide
    // blocker takes priority over the per-org connection/agent gaps in
    // computeProvisioningState's own priority order (see the dedicated
    // "missing platform-wide Sarvam credentials" describe block below for
    // that case in isolation; a variant of this same scenario WITH
    // credentials configured would instead report waiting_for_connection,
    // since connection is checked before agent mapping).
    assert.equal(result.state, "waiting_for_credentials");

    // No deployment attempt: createInboundDeploymentForNumbers would need a
    // telephony_connections/agent_configs re-read it never gets to, and no
    // phone_numbers "activate" update should happen either.
    const updates = calls.filter((c) => c.table === "phone_numbers" && c.type === "update");
    assert.equal(
      updates.some((u) => (u.payload as { status?: string }).status === "active"),
      false,
    );
  });
});

describe("provisionOrganizationAfterPayment — automatic deployment when connection + agent are already mapped", () => {
  test("creates the deployment and marks the number active + outbound-enabled on success", async () => {
    const claimedNumber = { ...POOL_NUMBER, organization_id: "org_1" };
    const { client, calls } = makeFakeSupabase({
      organizations: {
        select: [{ data: ORG_ROW, error: null }],
        update: [{ data: null, error: null }],
      },
      phone_numbers: {
        select: [
          { data: [], error: null }, // no existing number
          { data: [{ id: "num_1" }], error: null }, // pool candidate
          // createInboundDeploymentForNumbers' own numbers lookup:
          {
            data: [
              {
                id: "num_1",
                e164: "+911111111111",
                organization_id: "org_1",
                connection_id: "conn_1",
                agent_config_id: "agent_1",
              },
            ],
            error: null,
          },
        ],
        update: [
          { data: [claimedNumber], error: null }, // claim
          { data: [{}], error: null }, // link connection_id/agent_config_id
          { data: [{}], error: null }, // createInboundDeploymentForNumbers' provider_deployment_id write
          { data: [{}], error: null }, // activate (status/inbound/outbound)
        ],
      },
      telephony_connections: {
        select: [
          {
            data: { id: "conn_1", provider: "sarvam", provider_connection_id: "sarvam_conn_1" },
            error: null,
          },
          {
            data: { id: "conn_1", provider: "sarvam", provider_connection_id: "sarvam_conn_1" },
            error: null,
          },
        ],
      },
      agent_configs: {
        select: [
          { data: { id: "agent_1", sarvam_app_id: "app_1", sarvam_app_version: 2 }, error: null },
          {
            data: {
              id: "agent_1",
              organization_id: "org_1",
              sarvam_app_id: "app_1",
              sarvam_app_version: 2,
            },
            error: null,
          },
        ],
      },
    });

    const result = await withSarvamEnvAndFetch(
      { status: 200, body: { deployment_id: "dep_1" } },
      () => provisionOrganizationAfterPayment(client, "org_1"),
    );

    assert.equal(result.deploymentCreatedNow, true);
    assert.match(result.note, /Created Sarvam inbound deployment dep_1/);
    assert.match(result.note, /now active with inbound and outbound enabled/);
    assert.equal(result.state, "active");

    const activateUpdate = calls.find(
      (c) =>
        c.table === "phone_numbers" &&
        c.type === "update" &&
        (c.payload as { status?: string }).status === "active",
    );
    assert.ok(activateUpdate);
    assert.equal((activateUpdate!.payload as { inbound_enabled: boolean }).inbound_enabled, true);
    assert.equal((activateUpdate!.payload as { outbound_enabled: boolean }).outbound_enabled, true);
  });

  test("a failed Sarvam call is caught and recorded in the note — never thrown, never marks the number active", async () => {
    const { client, calls } = makeFakeSupabase({
      organizations: {
        select: [{ data: ORG_ROW, error: null }],
        update: [{ data: null, error: null }],
      },
      phone_numbers: {
        select: [
          { data: [], error: null },
          { data: [{ id: "num_1" }], error: null },
          {
            data: [
              {
                id: "num_1",
                e164: "+911111111111",
                organization_id: "org_1",
                connection_id: "conn_1",
                agent_config_id: "agent_1",
              },
            ],
            error: null,
          },
        ],
        update: [
          { data: [{ ...POOL_NUMBER, organization_id: "org_1" }], error: null },
          { data: [{}], error: null },
        ],
      },
      telephony_connections: {
        select: [
          {
            data: { id: "conn_1", provider: "sarvam", provider_connection_id: "sarvam_conn_1" },
            error: null,
          },
          {
            data: { id: "conn_1", provider: "sarvam", provider_connection_id: "sarvam_conn_1" },
            error: null,
          },
        ],
      },
      agent_configs: {
        select: [
          { data: { id: "agent_1", sarvam_app_id: "app_1", sarvam_app_version: 2 }, error: null },
          {
            data: {
              id: "agent_1",
              organization_id: "org_1",
              sarvam_app_id: "app_1",
              sarvam_app_version: 2,
            },
            error: null,
          },
        ],
      },
    });

    const result = await withSarvamEnvAndFetch({ status: 500, body: { error: "boom" } }, () =>
      provisionOrganizationAfterPayment(client, "org_1"),
    );

    assert.equal(result.deploymentCreatedNow, false);
    assert.match(result.note, /Automatic inbound deployment creation failed/);
    assert.equal(result.state, "failed");

    const activateUpdate = calls.find(
      (c) =>
        c.table === "phone_numbers" &&
        c.type === "update" &&
        (c.payload as { status?: string }).status === "active",
    );
    assert.equal(activateUpdate, undefined);
  });
});

describe("provisionOrganizationAfterPayment — state reflects missing platform-wide Sarvam credentials", () => {
  test("reports waiting_for_credentials when SARVAM_* env vars are not configured, even with a number already assigned", async () => {
    const prior = {
      SARVAM_API_KEY: process.env["SARVAM_API_KEY"],
      SARVAM_INBOUND_VOICE_API_KEY: process.env["SARVAM_INBOUND_VOICE_API_KEY"],
      SARVAM_OUTBOUND_VOICE_API_KEY: process.env["SARVAM_OUTBOUND_VOICE_API_KEY"],
      SARVAM_VOICE_AGENTS_API_KEY: process.env["SARVAM_VOICE_AGENTS_API_KEY"],
      SARVAM_ORG_ID: process.env["SARVAM_ORG_ID"],
      SARVAM_WORKSPACE_ID: process.env["SARVAM_WORKSPACE_ID"],
    };
    for (const key of Object.keys(prior)) delete process.env[key];

    try {
      const existing = { ...POOL_NUMBER, organization_id: "org_1", status: "provisioning" };
      const { client } = makeFakeSupabase({
        organizations: {
          select: [{ data: ORG_ROW, error: null }],
          update: [{ data: null, error: null }],
        },
        phone_numbers: { select: [{ data: [existing], error: null }] },
        telephony_connections: { select: [{ data: null, error: null }] },
        agent_configs: { select: [{ data: null, error: null }] },
      });

      const result = await provisionOrganizationAfterPayment(client, "org_1");
      assert.equal(result.state, "waiting_for_credentials");
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("provisionOrganizationAfterPayment — never throws", () => {
  test("an unexpected database error is caught and returned as a note, not thrown", async () => {
    const client = {
      from() {
        throw new Error("connection reset");
      },
    } as never;
    const result = await provisionOrganizationAfterPayment(client, "org_1");
    assert.match(result.note, /Automatic provisioning failed unexpectedly/);
  });
});

describe("provisionOrganizationAfterPayment — lifecycle_status only ever advances forward", () => {
  test("does not advance an organization that is not in setup_paid (e.g. already active)", async () => {
    const activeOrg = { id: "org_1", lifecycle_status: "active" };
    const existing = { ...POOL_NUMBER, organization_id: "org_1", status: "active" };
    const { calls, client } = makeFakeSupabase({
      organizations: {
        select: [{ data: activeOrg, error: null }],
        update: [{ data: null, error: null }],
      },
      phone_numbers: { select: [{ data: [existing], error: null }] },
      telephony_connections: { select: [{ data: null, error: null }] },
      agent_configs: { select: [{ data: null, error: null }] },
    });

    await provisionOrganizationAfterPayment(client, "org_1");

    const orgUpdate = calls.find((c) => c.table === "organizations" && c.type === "update");
    assert.equal((orgUpdate!.payload as { lifecycle_status: string }).lifecycle_status, "active");
  });
});
