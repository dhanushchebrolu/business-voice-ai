import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runProvisioningPipeline } from "./provisioning-pipeline.server.ts";
import { runProvisioning } from "./provisioning-runs.server.ts";
import {
  authenticateBridge,
  getWorkOrder,
  issueBridgeToken,
  listWorkOrders,
  revokeBridgeTokens,
  type BridgeAuth,
  type WorkOrderDeps,
} from "./operator-bridge.server.ts";
import { AUTH_FAILURE_MESSAGE, handleBridgeRpc } from "./operator-bridge-mcp.server.ts";
import { ORG, OTHER, snapshot, world, deps, num } from "./provisioning-test-world.test-helper.ts";

/**
 * The operator bridge against an in-memory database and a MOCKED operator
 * client: no Sarvam call is made and no Sarvam token exists anywhere. The
 * operator's Sarvam-side work (clone, configure, commit) is simulated by
 * "building" an agent id and version and reporting it.
 */

type World = ReturnType<typeof world>;
const NOW = new Date("2026-11-26T10:00:00Z");
const USER = "00000000-0000-0000-0000-0000000000aa";

/** A customer who finished onboarding, has a credential and number, but no agent yet. */
function waitingWorld(opts: { credential?: boolean } = {}) {
  const db = world({ appId: null });
  Object.assign(db.tables["agent_voice_language_settings"]![0]!, {
    status: "draft",
    applied_sarvam_app_id: null,
    applied_sarvam_app_version: null,
  });
  db.tables["agent_configs"]![0]!["sarvam_app_version"] = null;
  if (opts.credential === false)
    db.tables["sarvam_agent_integrations"] = db.tables["sarvam_agent_integrations"]!.filter(
      (r) => r["role"] !== "inbound",
    );
  return db;
}

const pipelineFor = (db: World, over: { appId?: string; appVersion?: number } = {}) =>
  deps(db, {
    deployment: { appId: over.appId ?? "Built-agent-1", appVersion: over.appVersion ?? 3 },
  }).d;

const first = (db: World, over = {}) =>
  runProvisioning(
    db.client,
    { organizationId: ORG, trigger: "customer_activate" },
    (a, o, h) => runProvisioningPipeline(a, o, pipelineFor(db, over), h.onStep),
    () => NOW,
  );

function bridgeDeps(
  db: World,
  over: Partial<WorkOrderDeps> = {},
): WorkOrderDeps & { resumed: string[] } {
  const resumed: string[] = [];
  return {
    resumed,
    loadSnapshot: async () => snapshot(),
    baseUrl: "https://clickai.example",
    masterAgentAppId: "Master-agent",
    resume: async (org) => {
      resumed.push(org);
      return runProvisioning(
        db.client,
        { organizationId: org, trigger: "admin_retry", force: true },
        (a, o, h) => runProvisioningPipeline(a, o, pipelineFor(db), h.onStep),
        () => NOW,
      );
    },
    ...over,
  };
}

const auth = (db: World): Extract<BridgeAuth, { ok: true }> => {
  void db;
  return { ok: true, tokenId: "tok_1", createdBy: USER, prefix: "cbr_abcd" };
};

const call = async (db: World, d: WorkOrderDeps, name: string, args: Record<string, unknown>) => {
  const out = await handleBridgeRpc(db.client, auth(db), d, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = (out as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { body: JSON.parse(result.content[0]!.text), isError: Boolean(result.isError) };
};

describe("bridge tokens", () => {
  test("only a hash is stored; the token authenticates until it expires", async () => {
    const db = world();
    const t = await issueBridgeToken(db.client, { createdBy: USER, hours: 8, now: NOW });
    const row = db.tables["operator_bridge_tokens"]![0]!;
    assert.notEqual(row["token_hash"], t.token);
    assert.doesNotMatch(JSON.stringify(row), new RegExp(t.token));
    const ok = await authenticateBridge(db.client, `Bearer ${t.token}`, NOW);
    assert.equal(ok.ok, true);
    const later = new Date(NOW.getTime() + 9 * 3_600_000);
    const expired = await authenticateBridge(db.client, `Bearer ${t.token}`, later);
    assert.deepEqual(expired, { ok: false, reason: "expired" });
    assert.match(AUTH_FAILURE_MESSAGE["expired"]!, /create a new one/);
  });

  test("lifetime is capped at 12 hours", async () => {
    const db = world();
    const t = await issueBridgeToken(db.client, { createdBy: USER, hours: 500, now: NOW });
    assert.equal(new Date(t.expiresAt).getTime() - NOW.getTime(), 12 * 3_600_000);
  });

  test("missing, malformed, unknown and revoked tokens are refused", async () => {
    const db = world();
    assert.deepEqual(await authenticateBridge(db.client, null, NOW), {
      ok: false,
      reason: "missing",
    });
    assert.deepEqual(await authenticateBridge(db.client, "Bearer nope", NOW), {
      ok: false,
      reason: "invalid",
    });
    assert.deepEqual(await authenticateBridge(db.client, `Bearer cbr_${"x".repeat(43)}`, NOW), {
      ok: false,
      reason: "invalid",
    });
    const t = await issueBridgeToken(db.client, { createdBy: USER, now: NOW });
    assert.equal(await revokeBridgeTokens(db.client, NOW), 1);
    assert.deepEqual(await authenticateBridge(db.client, `Bearer ${t.token}`, NOW), {
      ok: false,
      reason: "revoked",
    });
  });
});

describe("MCP protocol", () => {
  test("initialize, tools/list, ping, notifications and unknown methods", async () => {
    const db = world();
    const d = bridgeDeps(db);
    const rpc = (method: string, params?: object) =>
      handleBridgeRpc(db.client, auth(db), d, { jsonrpc: "2.0", id: 7, method, params });
    const init = (await rpc("initialize", { protocolVersion: "2025-06-18" })) as {
      result: { protocolVersion: string; capabilities: object };
    };
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.ok(init.result.capabilities);
    const list = (await rpc("tools/list")) as { result: { tools: { name: string }[] } };
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [
      "get_agent_work_order",
      "issue_agent_credential",
      "list_agent_work_orders",
      "submit_agent_result",
    ]);
    assert.deepEqual(await rpc("ping"), { jsonrpc: "2.0", id: 7, result: {} });
    assert.equal(await rpc("notifications/initialized"), null);
    assert.equal(((await rpc("nope")) as { error: { code: number } }).error.code, -32601);
    assert.equal(
      ((await handleBridgeRpc(db.client, auth(db), d, { id: 1 })) as { error: { code: number } })
        .error.code,
      -32600,
    );
  });
});

describe("work orders", () => {
  test("a customer waiting for an agent is listed; nothing else is", async () => {
    const db = waitingWorld();
    assert.deepEqual(await listWorkOrders(db.client), [], "no job yet");
    await first(db);
    const list = await listWorkOrders(db.client);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.stage, "needs_agent");
    assert.match(list[0]!.agentName, /^clickai-org_new-agent_ne/);
  });

  test("the order carries the generated spec, template, fingerprint and steps, and no secrets or other tenants", async () => {
    const db = waitingWorld();
    await first(db);
    const id = (await listWorkOrders(db.client))[0]!.workOrderId;
    const order = await getWorkOrder(db.client, id, bridgeDeps(db));
    assert.equal(order.templateAgentAppId, "Master-agent");
    assert.ok(order.fingerprint);
    assert.equal(order.credentialIssued, true);
    assert.ok(order.agent.systemPrompt.length > 100);
    assert.ok(order.agent.httpTools.length > 0);
    assert.match(order.instructions.join(" "), /submit_agent_result/);
    const text = JSON.stringify(order);
    assert.doesNotMatch(text, /token_hash|Bearer [A-Za-z0-9]{20}|org_other|agent_other|7900000001/);
    assert.match(text, /clickai\.example/);
  });

  test("incomplete onboarding data is reported, not turned into an agent", async () => {
    const db = waitingWorld();
    await first(db);
    const id = (await listWorkOrders(db.client))[0]!.workOrderId;
    const d = bridgeDeps(db, {
      loadSnapshot: async () => ({ ...snapshot({ calendar_book: true }), services: [] }),
    });
    const r = await call(db, d, "get_agent_work_order", { workOrderId: id });
    assert.equal(r.isError, true);
    assert.equal(r.body.error, "not_ready");
  });

  test("an unknown or closed work order is not found", async () => {
    const db = waitingWorld();
    const r = await call(db, bridgeDeps(db), "get_agent_work_order", { workOrderId: "nope" });
    assert.equal(r.body.error, "not_found");
  });
});

describe("submitting the built agent", () => {
  const setup = async () => {
    const db = waitingWorld();
    await first(db);
    const d = bridgeDeps(db);
    const id = (await listWorkOrders(db.client))[0]!.workOrderId;
    const order = await getWorkOrder(db.client, id, d);
    return { db, d, id, fp: order.fingerprint };
  };

  test("registers the agent, applies voice settings, resumes the job and activates the number", async () => {
    const { db, d, id, fp } = await setup();
    assert.notEqual(num(db, "num_new")["status"], "active");
    const r = await call(db, d, "submit_agent_result", {
      workOrderId: id,
      agentId: "Built-agent-1",
      version: 3,
      fingerprint: fp,
    });
    assert.equal(r.isError, false, JSON.stringify(r.body));
    assert.deepEqual(r.body, { status: "registered", jobResumed: true });
    const agent = db.tables["agent_configs"]![0]!;
    assert.equal(agent["sarvam_app_id"], "Built-agent-1");
    assert.equal(agent["sarvam_app_version"], 3);
    const vl = db.tables["agent_voice_language_settings"]![0]!;
    assert.equal(vl["status"], "applied");
    assert.equal(vl["applied_sarvam_app_version"], 3);
    assert.equal(
      num(db, "num_new")["status"],
      "active",
      "deployment, routing and activation followed",
    );
    assert.equal(db.tables["provisioning_runs"]![0]!["status"], "succeeded");
    const events = (db.tables["provisioning_run_events"] ?? []).map((e) => e["event"]);
    assert.ok(events.includes("agent_submitted"));
    assert.doesNotMatch(
      JSON.stringify(db.tables["provisioning_run_events"]),
      /"token":"cbr_abcd".*secret/,
    );
  });

  test("submitting twice changes nothing and creates no second deployment", async () => {
    const { db, d, id, fp } = await setup();
    const args = { workOrderId: id, agentId: "Built-agent-1", version: 3, fingerprint: fp };
    await call(db, d, "submit_agent_result", args);
    const again = await call(db, d, "submit_agent_result", args);
    assert.equal(again.isError, false);
    assert.equal(again.body.status, "already_registered");
    assert.equal(d.resumed.length, 1);
    assert.equal(db.tables["provisioning_runs"]!.length, 1);
  });

  test("an agent built from an outdated work order is refused and not registered", async () => {
    const { db, d, id } = await setup();
    const r = await call(db, d, "submit_agent_result", {
      workOrderId: id,
      agentId: "Built-agent-1",
      version: 3,
      fingerprint: "stale-fingerprint",
    });
    assert.equal(r.body.error, "conflict");
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_id"], null);
    assert.equal(d.resumed.length, 0);
  });

  test("the master template, malformed ids and bad versions are refused", async () => {
    const { db, d, id, fp } = await setup();
    const submit = (agentId: string, version: number) =>
      call(db, d, "submit_agent_result", { workOrderId: id, agentId, version, fingerprint: fp });
    assert.equal((await submit("Master-agent", 1)).body.error, "conflict");
    assert.equal((await submit("x y!", 1)).body.error, "invalid");
    assert.equal((await submit("Built-agent-1", 0)).body.error, "invalid");
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_id"], null);
  });

  test("a different agent for a customer that already has one needs the admin screen", async () => {
    const { db, d, id, fp } = await setup();
    await call(db, d, "submit_agent_result", {
      workOrderId: id,
      agentId: "Built-agent-1",
      version: 3,
      fingerprint: fp,
    });
    const r = await call(db, d, "submit_agent_result", {
      workOrderId: id,
      agentId: "Built-agent-2",
      version: 1,
      fingerprint: fp,
    });
    assert.equal(r.isError, true);
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_id"], "Built-agent-1");
  });

  test("if resuming fails the agent stays registered and the sweep continues the job", async () => {
    const db = waitingWorld();
    await first(db);
    const d = bridgeDeps(db, {
      resume: async () => {
        throw new Error("temporary outage");
      },
    });
    const id = (await listWorkOrders(db.client))[0]!.workOrderId;
    const fp = (await getWorkOrder(db.client, id, d)).fingerprint;
    const r = await call(db, d, "submit_agent_result", {
      workOrderId: id,
      agentId: "Built-agent-1",
      version: 3,
      fingerprint: fp,
    });
    assert.deepEqual(r.body, { status: "registered", jobResumed: false });
    const { sweepProvisioningRetries } = await import("./provisioning-runs.server.ts");
    const started: string[] = [];
    await sweepProvisioningRetries(db.client, {
      now: NOW,
      run: async (_a, i) => {
        started.push(i.organizationId);
        return { runId: id, claimed: true, status: "succeeded", result: null };
      },
    });
    assert.deepEqual(started, [ORG]);
  });
});

describe("credential issuance", () => {
  test("issued once; a second call never rotates the credential in use", async () => {
    const db = waitingWorld({ credential: false });
    await first(db);
    const d = bridgeDeps(db);
    const id = (await listWorkOrders(db.client))[0]!.workOrderId;
    assert.equal((await listWorkOrders(db.client))[0]!.stage, "needs_credential");
    const issued = await call(db, d, "issue_agent_credential", { workOrderId: id });
    assert.equal(issued.isError, false, JSON.stringify(issued.body));
    assert.match(issued.body.token, /^[A-Za-z0-9_-]{20,}/);
    // The database defaults new credentials to status "active"; the in-memory stand-in has no defaults.
    for (const r of db.tables["sarvam_agent_integrations"]!) r["status"] ??= "active";
    const stored = JSON.stringify(db.tables["sarvam_agent_integrations"]);
    assert.doesNotMatch(stored, new RegExp(issued.body.token), "only the hash is stored");
    const again = await call(db, d, "issue_agent_credential", { workOrderId: id });
    assert.equal(again.isError, true);
    assert.equal(again.body.error, "conflict");
    assert.doesNotMatch(
      JSON.stringify(db.tables["provisioning_run_events"] ?? []),
      new RegExp(issued.body.token),
    );
  });
});
