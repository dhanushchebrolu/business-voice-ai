import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createInboundDeploymentForNumbers,
  syncAgentDeployments,
} from "./sarvam-inbound-deployment.server.ts";

/**
 * Behavioral coverage for createInboundDeploymentForNumbers — the logic
 * extracted from sarvam-admin.functions.ts's createSarvamInboundDeployment
 * (Task #92) so both the admin UI and the automatic provisioning
 * orchestrator call exactly one implementation. Unlike createServerFn-
 * wrapped handlers, this function takes its Supabase client as a
 * parameter, so it can be exercised directly against a scripted fake query
 * builder (no live Supabase instance). Its other dependency,
 * getTelephonyAdapter("sarvam"), reads real env vars and issues a real
 * fetch — exercised here the same way telephony.server.test.ts's
 * getTelephonyAdapter tests do: set SARVAM_* env vars for the duration of
 * the call, and swap out globalThis.fetch to avoid a live network call to
 * apps.sarvam.ai.
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
): Promise<{ result: T; requestedUrl: string | undefined; requestBody: unknown }> {
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
  process.env["TELEPHONY_WEBHOOK_BASE_URL"] = "https://clickai.example";
  process.env["SARVAM_WEBHOOK_SECRET"] = "whsec_test_0123456789abcdef0123456789";

  const originalFetch = globalThis.fetch;
  let requestedUrl: string | undefined;
  let requestBody: unknown;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    requestedUrl = String(url);
    requestBody = init?.body ? JSON.parse(init.body as string) : undefined;
    return new Response(JSON.stringify(fetchResponse.body), { status: fetchResponse.status });
  }) as typeof fetch;

  try {
    const result = await fn();
    return { result, requestedUrl, requestBody };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const NUMBER_ROW = {
  id: "num_1",
  e164: "+911111111111",
  organization_id: "org_1",
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
  sarvam_app_version: 3,
};

describe("createInboundDeploymentForNumbers — happy path", () => {
  test("validates, calls Sarvam, writes provider_deployment_id, and returns deploymentId + organizationId", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: {
        select: [{ data: [NUMBER_ROW], error: null }],
        update: [{ data: [{}], error: null }],
      },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
    });

    const { result, requestedUrl, requestBody } = await withSarvamEnvAndFetch(
      { status: 200, body: { deployment_id: "dep_123" } },
      () =>
        createInboundDeploymentForNumbers(client, {
          phoneNumberIds: ["num_1"],
          name: "Klyro - test inbound",
        }),
    );

    assert.deepEqual(result, {
      deploymentId: "dep_123",
      organizationId: "org_1",
      outcome: "created",
    });
    const webhookConfig = (requestBody as { webhook_config: { url: string; metadata: unknown } })
      .webhook_config;
    assert.match(
      webhookConfig.url,
      /^https:\/\/clickai\.example\/api\/public\/webhooks\/telephony\?provider=sarvam&verify_token=/,
    );
    assert.deepEqual(webhookConfig.metadata, { organization_id: "org_1" });
    assert.equal(
      requestedUrl,
      "https://apps.sarvam.ai/api/app-authoring/v1/orgs/org_1/workspaces/ws_1/deployments",
    );
    assert.equal((requestBody as { app_id: string }).app_id, "app_1");
    assert.deepEqual((requestBody as { connection_configs: unknown[] }).connection_configs, [
      { connection_id: "sarvam_conn_1", phone_numbers: ["+911111111111"] },
    ]);
    assert.equal((requestBody as { connection_id?: string }).connection_id, undefined);

    const updateCall = calls.find((c) => c.table === "phone_numbers" && c.type === "update");
    assert.ok(updateCall, "expected phone_numbers to be updated with the new deployment id");
    assert.equal(
      (updateCall!.payload as { provider_deployment_id: string }).provider_deployment_id,
      "dep_123",
    );
  });
});

describe("createInboundDeploymentForNumbers — cross-tenant mapping structurally rejected", () => {
  test("rejects a request whose phone numbers span more than one organization", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: {
        select: [
          {
            data: [NUMBER_ROW, { ...NUMBER_ROW, id: "num_2", organization_id: "org_2" }],
            error: null,
          },
        ],
      },
    });
    await assert.rejects(
      createInboundDeploymentForNumbers(client, {
        phoneNumberIds: ["num_1", "num_2"],
        name: "n",
      }),
      /must belong to the same organization/i,
    );
  });

  test("rejects a request whose phone numbers span more than one connection", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: {
        select: [
          {
            data: [NUMBER_ROW, { ...NUMBER_ROW, id: "num_2", connection_id: "conn_2" }],
            error: null,
          },
        ],
      },
    });
    await assert.rejects(
      createInboundDeploymentForNumbers(client, {
        phoneNumberIds: ["num_1", "num_2"],
        name: "n",
      }),
      /must share the same telephony connection/i,
    );
  });

  test("rejects a request whose phone numbers span more than one agent", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: {
        select: [
          {
            data: [NUMBER_ROW, { ...NUMBER_ROW, id: "num_2", agent_config_id: "agent_2" }],
            error: null,
          },
        ],
      },
    });
    await assert.rejects(
      createInboundDeploymentForNumbers(client, {
        phoneNumberIds: ["num_1", "num_2"],
        name: "n",
      }),
      /must share the same agent/i,
    );
  });

  test("rejects when a requested phone number id was not found at all", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: { select: [{ data: [NUMBER_ROW], error: null }] },
    });
    await assert.rejects(
      createInboundDeploymentForNumbers(client, {
        phoneNumberIds: ["num_1", "num_missing"],
        name: "n",
      }),
      /were not found/i,
    );
  });
});

describe("createInboundDeploymentForNumbers — connection/agent validation before the Sarvam call", () => {
  test("rejects when the connection is not registered with Sarvam yet", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: { select: [{ data: [NUMBER_ROW], error: null }] },
      telephony_connections: {
        select: [{ data: { ...CONNECTION_ROW, provider_connection_id: null }, error: null }],
      },
    });
    await assert.rejects(
      createInboundDeploymentForNumbers(client, { phoneNumberIds: ["num_1"], name: "n" }),
      /has not been registered with Sarvam yet/i,
    );
  });

  test("rejects when the connection provider is not sarvam", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: { select: [{ data: [NUMBER_ROW], error: null }] },
      telephony_connections: {
        select: [{ data: { ...CONNECTION_ROW, provider: "exotel" }, error: null }],
      },
    });
    await assert.rejects(
      createInboundDeploymentForNumbers(client, { phoneNumberIds: ["num_1"], name: "n" }),
      /only applies to sarvam connections/i,
    );
  });

  test("rejects when the agent has not been mapped to a Sarvam app yet", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: { select: [{ data: [NUMBER_ROW], error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: {
        select: [{ data: { ...AGENT_CONFIG_ROW, sarvam_app_id: null }, error: null }],
      },
    });
    await assert.rejects(
      createInboundDeploymentForNumbers(client, { phoneNumberIds: ["num_1"], name: "n" }),
      /has not been mapped to a Sarvam app yet/i,
    );
  });

  test("rejects when the agent's organization does not match the phone numbers' organization", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: { select: [{ data: [NUMBER_ROW], error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: {
        select: [{ data: { ...AGENT_CONFIG_ROW, organization_id: "org_other" }, error: null }],
      },
    });
    await assert.rejects(
      createInboundDeploymentForNumbers(client, { phoneNumberIds: ["num_1"], name: "n" }),
      /agent's organization does not match/i,
    );
  });
});

describe("createInboundDeploymentForNumbers — does not fake success", () => {
  test("propagates the adapter's error and never writes provider_deployment_id when the Sarvam call fails", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: { select: [{ data: [NUMBER_ROW], error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
    });

    await assert.rejects(
      withSarvamEnvAndFetch({ status: 500, body: { error: "boom" } }, () =>
        createInboundDeploymentForNumbers(client, { phoneNumberIds: ["num_1"], name: "n" }),
      ),
    );

    assert.equal(
      calls.some((c) => c.table === "phone_numbers" && c.type === "update"),
      false,
      "provider_deployment_id must not be written when the Sarvam call failed",
    );
  });
});

/** fetch stub answering by method + path suffix; records every request. */
async function withRoutedFetch<T>(
  routes: { method: string; suffix: string; status: number; body: unknown }[],
  fn: () => Promise<T>,
): Promise<{
  result?: T;
  error?: Error;
  requests: { method: string; url: string; body: unknown }[];
}> {
  const prior: Record<string, string | undefined> = {};
  const env = {
    SARVAM_API_KEY: "sk_test_key",
    SARVAM_ORG_ID: "org_1",
    SARVAM_WORKSPACE_ID: "ws_1",
    TELEPHONY_WEBHOOK_BASE_URL: "https://clickai.example",
    SARVAM_WEBHOOK_SECRET: "whsec_test_0123456789abcdef0123456789",
  };
  for (const [k, v] of Object.entries(env)) {
    prior[k] = process.env[k];
    process.env[k] = v;
  }
  const requests: { method: string; url: string; body: unknown }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({
      method,
      url: String(url),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const route = routes.find(
      (r) => r.method === method && String(url).split("?")[0]!.endsWith(r.suffix),
    );
    if (!route) return new Response(JSON.stringify({ detail: "unrouted" }), { status: 500 });
    return new Response(JSON.stringify(route.body), { status: route.status });
  }) as typeof fetch;
  try {
    return { result: await fn(), requests };
  } catch (err) {
    return { error: err as Error, requests };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("createInboundDeploymentForNumbers — never a duplicate deployment", () => {
  test("a number Klyro already has a deployment for returns it; nothing is sent to Sarvam", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: {
        select: [{ data: [{ ...NUMBER_ROW, provider_deployment_id: "dep_known" }], error: null }],
      },
    });
    const { result, requests } = await withRoutedFetch([], () =>
      createInboundDeploymentForNumbers(client, { phoneNumberIds: ["num_1"], name: "x" }),
    );
    assert.deepEqual(result, {
      deploymentId: "dep_known",
      organizationId: "org_1",
      outcome: "already_recorded",
    });
    assert.equal(requests.length, 0);
  });

  test("a deployment Sarvam already has for the number and agent is adopted, not created again", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: {
        select: [{ data: [NUMBER_ROW], error: null }],
        update: [{ data: [{}], error: null }],
      },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
    });
    const { result, requests } = await withRoutedFetch(
      [
        {
          method: "GET",
          suffix: "/deployments",
          status: 200,
          body: {
            items: [
              {
                deployment_id: "dep_lost",
                app_id: "app_1",
                app_version: 3,
                phone_numbers: ["+911111111111"],
              },
            ],
          },
        },
      ],
      () => createInboundDeploymentForNumbers(client, { phoneNumberIds: ["num_1"], name: "x" }),
    );
    assert.deepEqual(result, {
      deploymentId: "dep_lost",
      organizationId: "org_1",
      outcome: "adopted",
    });
    assert.ok(!requests.some((r) => r.method === "POST"), "no create request");
    const update = calls.find((c) => c.table === "phone_numbers" && c.type === "update");
    assert.equal(
      (update!.payload as { provider_deployment_id: string }).provider_deployment_id,
      "dep_lost",
    );
  });

  test("a number Sarvam routes to a different agent is a conflict: nothing created, nothing recorded", async () => {
    const { client, calls } = makeFakeSupabase({
      phone_numbers: { select: [{ data: [NUMBER_ROW], error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
    });
    const { error, requests } = await withRoutedFetch(
      [
        {
          method: "GET",
          suffix: "/deployments",
          status: 200,
          body: {
            items: [
              {
                deployment_id: "dep_other",
                app_id: "someone_else",
                phone_numbers: ["+91 11111 11111"],
              },
            ],
          },
        },
      ],
      () => createInboundDeploymentForNumbers(client, { phoneNumberIds: ["num_1"], name: "x" }),
    );
    assert.match(error?.message ?? "", /already routes .* dep_other .* no duplicate was created/);
    assert.ok(!requests.some((r) => r.method === "POST"));
    assert.ok(!calls.some((c) => c.type === "update"));
  });

  test("without the result webhook configured, no deployment is created", async () => {
    const { client } = makeFakeSupabase({
      phone_numbers: { select: [{ data: [NUMBER_ROW], error: null }] },
      telephony_connections: { select: [{ data: CONNECTION_ROW, error: null }] },
      agent_configs: { select: [{ data: AGENT_CONFIG_ROW, error: null }] },
    });
    const saved = process.env["SARVAM_WEBHOOK_SECRET"];
    const { error, requests } = await withRoutedFetch([], async () => {
      delete process.env["SARVAM_WEBHOOK_SECRET"];
      return createInboundDeploymentForNumbers(client, { phoneNumberIds: ["num_1"], name: "x" });
    });
    if (saved !== undefined) process.env["SARVAM_WEBHOOK_SECRET"] = saved;
    assert.match(error?.message ?? "", /result webhook is not configured/);
    assert.equal(requests.length, 0);
  });
});

describe("syncAgentDeployments", () => {
  const agent = {
    id: "agent_1",
    organization_id: "org_1",
    sarvam_app_id: "app_1",
    sarvam_app_version: 4,
  };
  const numbersFor = (ids: string[]) =>
    ids.map((d) => ({ organization_id: "org_1", provider: "sarvam", provider_deployment_id: d }));

  test("moves a deployment to the newly mapped version and adds a missing webhook, via PATCH only", async () => {
    const { client } = makeFakeSupabase({
      agent_configs: { select: [{ data: agent, error: null }] },
      phone_numbers: { select: [{ data: numbersFor(["dep_1"]), error: null }] },
    });
    const { result, requests } = await withRoutedFetch(
      [
        {
          method: "GET",
          suffix: "/deployments/dep_1",
          status: 200,
          body: {
            deployment_id: "dep_1",
            app_id: "app_1",
            app_version: 3,
            connection_configs: [{ connection_id: "c", agent_phone_number: "+911111111111" }],
          },
        },
        {
          method: "PATCH",
          suffix: "/deployments/dep_1",
          status: 200,
          body: { deployment_id: "dep_1" },
        },
      ],
      () => syncAgentDeployments(client, "agent_1"),
    );
    assert.deepEqual(result!.items, [
      {
        deploymentId: "dep_1",
        action: "updated",
        fromVersion: 3,
        toVersion: 4,
        webhookAdded: true,
      },
    ]);
    const patch = requests.find((r) => r.method === "PATCH")!;
    assert.equal((patch.body as { app_version: number }).app_version, 4);
    assert.match(
      (patch.body as { webhook_config: { url: string } }).webhook_config.url,
      /verify_token=/,
    );
    assert.ok(!requests.some((r) => r.method === "POST"), "never creates");
  });

  test("an active deployment is paused, moved to the new version, then resumed (Sarvam edits only paused ones)", async () => {
    const { client } = makeFakeSupabase({
      agent_configs: { select: [{ data: agent, error: null }] },
      phone_numbers: { select: [{ data: numbersFor(["dep_1"]), error: null }] },
    });
    const { result, requests } = await withRoutedFetch(
      [
        {
          method: "GET",
          suffix: "/deployments/dep_1",
          status: 200,
          body: {
            deployment_id: "dep_1",
            app_id: "app_1",
            app_version: 3,
            status: "active",
            webhook_config: { url: "https://clickai.example/x" },
          },
        },
        {
          method: "PUT",
          suffix: "/deployments/dep_1/status",
          status: 200,
          body: { deployment_id: "dep_1" },
        },
        {
          method: "PATCH",
          suffix: "/deployments/dep_1",
          status: 200,
          body: { deployment_id: "dep_1" },
        },
      ],
      () => syncAgentDeployments(client, "agent_1"),
    );
    assert.equal(result!.items[0]!.action, "updated");
    const calls = requests.filter((r) => r.method !== "GET");
    assert.deepEqual(
      calls.map((r) => [r.method, (r.body as { action?: string })?.action ?? null]),
      [
        ["PUT", "pause"],
        ["PATCH", null],
        ["PUT", "resume"],
      ],
    );
    assert.equal((calls[1]!.body as { app_version: number }).app_version, 4);
  });

  test("a failed edit still resumes the paused deployment and reports the error", async () => {
    const { client } = makeFakeSupabase({
      agent_configs: { select: [{ data: agent, error: null }] },
      phone_numbers: { select: [{ data: numbersFor(["dep_1"]), error: null }] },
    });
    const { result, requests } = await withRoutedFetch(
      [
        {
          method: "GET",
          suffix: "/deployments/dep_1",
          status: 200,
          body: { deployment_id: "dep_1", app_id: "app_1", app_version: 3, status: "active" },
        },
        {
          method: "PUT",
          suffix: "/deployments/dep_1/status",
          status: 200,
          body: { deployment_id: "dep_1" },
        },
        {
          method: "PATCH",
          suffix: "/deployments/dep_1",
          status: 422,
          body: { error: { message: "bad" } },
        },
      ],
      () => syncAgentDeployments(client, "agent_1"),
    );
    assert.equal(result!.items[0]!.action, "error");
    const actions = requests
      .filter((r) => r.method === "PUT")
      .map((r) => (r.body as { action: string }).action);
    assert.deepEqual(actions, ["pause", "resume"]);
  });

  test("an in-line deployment is untouched; one on a different agent is reported, not replaced", async () => {
    const { client } = makeFakeSupabase({
      agent_configs: { select: [{ data: agent, error: null }] },
      phone_numbers: { select: [{ data: numbersFor(["dep_ok", "dep_other"]), error: null }] },
    });
    const { result, requests } = await withRoutedFetch(
      [
        {
          method: "GET",
          suffix: "/deployments/dep_ok",
          status: 200,
          body: {
            deployment_id: "dep_ok",
            app_id: "app_1",
            app_version: 4,
            webhook_config: { url: "https://clickai.example/x" },
          },
        },
        {
          method: "GET",
          suffix: "/deployments/dep_other",
          status: 200,
          body: { deployment_id: "dep_other", app_id: "app_9", app_version: 1 },
        },
      ],
      () => syncAgentDeployments(client, "agent_1"),
    );
    assert.deepEqual(
      result!.items.map((i) => [i.deploymentId, i.action]),
      [
        ["dep_ok", "in_sync"],
        ["dep_other", "app_mismatch"],
      ],
    );
    assert.ok(!requests.some((r) => r.method !== "GET"), "read-only when nothing needs changing");
  });
});
