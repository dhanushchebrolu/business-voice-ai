import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runProvisioningPipeline, type PipelineDeps } from "./provisioning-pipeline.server.ts";
import { runProvisioning } from "./provisioning-runs.server.ts";
import { handleBridgeRpc } from "./operator-bridge-mcp.server.ts";
import {
  authenticateBridge,
  getOutboundWorkOrder,
  getWorkOrder,
  issueBridgeToken,
  listWorkOrders,
  type BridgeAuth,
  type WorkOrderDeps,
} from "./operator-bridge.server.ts";
import { ensureCustomerAgent, type AgentProvisioner } from "./sarvam-agent-provisioner.server.ts";
import { outboundAgentTarget, setOutboundReady } from "./sarvam-outbound-mode.server.ts";
import { reportedAgent, toolAuthStatus } from "./tool-auth-checkpoint.server.ts";
import { agentCallStatus } from "./provisioning-status.ts";
import { outboundConfirmed, registeredAgent, OUTBOUND_FORBIDDEN_TOOLS } from "./agent-roles.ts";
import { buildOutboundAgentConfig } from "./universal-agent-config.ts";
import { CLICKAI_TOOL_NAMES } from "./sarvam-agent-tools-spec.ts";
import {
  ORG,
  OTHER,
  snapshot,
  world,
  deps,
  num,
  confirmToolAuth,
  toolEvidence,
} from "./provisioning-test-world.test-helper.ts";

/**
 * Two agents per customer through the whole operator flow: the outbound agent has its own work
 * order, tools, token role, checkpoint and registration, and neither role can ever stand in
 * for the other. Mocks only.
 */

type World = ReturnType<typeof world>;
type Auth = Extract<BridgeAuth, { ok: true }>;
const NOW = new Date("2026-11-27T10:00:00Z");
const ADMIN = "00000000-0000-0000-0000-0000000000bb";
const OUT = "Cust-out-9";
const OUT_REF = "outbound:agent_new";
const BOOKING = { calendar_book: true, capture_lead: true };

const run = (db: World, d = deps(db)) =>
  runProvisioning(
    db.client,
    { organizationId: ORG, trigger: "customer_activate", force: true },
    (a, o, h) => runProvisioningPipeline(a, o, d.d, h.onStep),
    () => NOW,
  );
const job = (db: World) =>
  db.tables["provisioning_runs"]!.find((j) => j["organization_id"] === ORG)!;
const agent = (db: World) => db.tables["agent_configs"]![0]!;
const events = (db: World, name: string) =>
  (db.tables["provisioning_run_events"] ?? []).filter(
    (e) => e["event"] === name && e["run_id"] !== "confirmed-in-test",
  );

function bridge(db: World, caps: Record<string, boolean> = BOOKING): WorkOrderDeps {
  return {
    loadSnapshot: async () => snapshot(caps),
    baseUrl: "https://clickai.example",
    masterAgentAppId: "Master-agent",
    outboundMasterAgentAppId: "Master-out",
    masterAgentVersion: 2,
    resume: async () => run(db),
    now: () => NOW,
  };
}

/** A customer whose inbound agent is confirmed and live; no outbound agent yet. */
async function inboundLive() {
  const db = world({ outbound: "no_agent", outboundToolAuth: false });
  db.tables["platform_admins"] = [{ user_id: ADMIN, role: "admin", is_active: true }];
  const first = await run(db);
  assert.equal(first.result?.state, "waiting_for_outbound_agent", first.result?.note);
  assert.equal(num(db, "num_new")["status"], "active");
  return { db, jobId: String(job(db)["id"]) };
}
async function session(db: World, runId: string) {
  const t = await issueBridgeToken(db.client, { createdBy: ADMIN, runId, now: NOW });
  const check = () => authenticateBridge(db.client, `Bearer ${t.token}`, NOW);
  const auth = await check();
  assert.equal(auth.ok, true);
  return { token: t, check, auth: auth as Auth };
}
const call = async (
  db: World,
  auth: Auth,
  name: string,
  args: Record<string, unknown> = {},
  caps?: Record<string, boolean>,
) => {
  const out = await handleBridgeRpc(db.client, auth, bridge(db, caps), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const r = (out as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { body: JSON.parse(r.content[0]!.text), isError: Boolean(r.isError) };
};
async function outboundOrder(db: World, jobId: string, caps = BOOKING) {
  return getOutboundWorkOrder(db.client, jobId, bridge(db, caps));
}
async function outboundReported() {
  const world = await inboundLive();
  const s = await session(world.db, world.jobId);
  const order = await outboundOrder(world.db, world.jobId);
  const tools = order.tools.map((t) => t.name);
  const r = await call(world.db, s.auth, "report_tools_created", {
    workOrderId: world.jobId,
    agentId: OUT,
    tools,
  });
  assert.equal(r.isError, false, JSON.stringify(r.body));
  const evidence = tools.map((name) => ({ name, authType: "bearer", agentRef: OUT_REF }));
  const submit = (over: Record<string, unknown> = {}) => ({
    workOrderId: world.jobId,
    agentId: OUT,
    version: 1,
    fingerprint: order.fingerprint,
    toolAuth: evidence,
    ...over,
  });
  return { ...world, ...s, order, tools, evidence, submit };
}

describe("the outbound work order", () => {
  test("is its own agent: new, restricted tools, its own credential, reference and rules", async () => {
    const { db, jobId } = await inboundLive();
    const order = await outboundOrder(db, jobId);
    assert.deepEqual(order.scope, { customerId: ORG, jobId, agentRole: "outbound" });
    assert.match(order.agentName, /-out$/);
    assert.equal(order.agentRef, OUT_REF);
    assert.equal("clone" in order, false, "never cloned from another agent");
    assert.equal(order.create.configureAgent.name, order.agentName);
    const names = order.tools.map((t) => t.name);
    assert.ok(names.includes("clickai_business_context") && names.includes("record_call_outcome"));
    assert.ok(names.includes("check_availability") && names.includes("book_appointment"));
    for (const forbidden of OUTBOUND_FORBIDDEN_TOOLS) assert.ok(!names.includes(forbidden));
    assert.deepEqual(order.forbiddenTools, [...OUTBOUND_FORBIDDEN_TOOLS]);
    assert.equal(order.callHandling.callTransfer, false);
    assert.equal(order.callHandling.maxCallSeconds, 300);
    assert.ok(order.inputVariables.some((v) => v.name === "clickai_call_id"));
    assert.doesNotMatch(order.instructions.join("\n"), /clone_from|cai_sv_/);
    assert.match(order.instructions.join("\n"), /never use, copy or clone/i);
  });

  test("every tool carries the outbound reference and no credential; bindings are typed", async () => {
    const { db, jobId } = await inboundLive();
    const order = await outboundOrder(db, jobId);
    for (const t of order.tools) {
      const c = t.connectorConfig as {
        body: { name: string; type: string; value: unknown }[];
        url: string;
      };
      assert.deepEqual(
        c.body.filter((b) => b.name === "agent_ref"),
        [{ name: "agent_ref", type: "static", value: OUT_REF }],
        t.name,
      );
      assert.equal("auth" in c, false);
      assert.match(c.url, /^https:\/\/clickai\.example\/api\/public\/sarvam\/agent\//);
      const interaction = c.body.find((b) => b.name === "interaction_id")!;
      assert.equal(interaction.type, "system_variable", t.name);
      for (const b of c.body)
        if (typeof b.value === "string") assert.doesNotMatch(b.value, /^@/, `${t.name}.${b.name}`);
    }
    const book = order.tools.find((t) => t.name === "book_appointment")!.connectorConfig as {
      body: { name: string; type: string }[];
    };
    assert.equal(book.body.find((b) => b.name === "clickai_call_id")!.type, "agent_variable");
  });

  test("tools follow the customer's capabilities: no booking means no booking tool", async () => {
    const { db, jobId } = await inboundLive();
    const order = await outboundOrder(db, jobId, { capture_lead: true } as typeof BOOKING);
    const names = order.tools.map((t) => t.name);
    for (const n of ["book_appointment", "reschedule_appointment", "cancel_appointment"])
      assert.ok(!names.includes(n), n);
    assert.ok(!names.includes("request_callback"));
  });

  test("the queue and checkpoint show the role", async () => {
    const { db, jobId } = await inboundLive();
    const [item] = await listWorkOrders(db.client, NOW);
    assert.deepEqual(
      [item!.workOrderId, item!.agentRole, item!.stage],
      [jobId, "outbound", "needs_agent"],
    );
    assert.match(item!.agentName, /-out$/);
  });
});

describe("a token and an operation belong to one role", () => {
  test("the outbound job gets an outbound token; an inbound one cannot be asked for", async () => {
    const { db, jobId } = await inboundLive();
    await assert.rejects(
      issueBridgeToken(db.client, { createdBy: ADMIN, runId: jobId, role: "inbound", now: NOW }),
      /is for the outbound agent/,
    );
    const { auth } = await session(db, jobId);
    assert.equal(auth.role, "outbound");
    const list = await call(db, auth, "list_agent_work_orders");
    assert.deepEqual(
      list.body.map((w: { agentRole: string }) => w.agentRole),
      ["outbound"],
    );
    const order = await call(db, auth, "get_agent_work_order", { workOrderId: jobId });
    assert.equal(order.body.scope.agentRole, "outbound");
    await assert.rejects(getWorkOrder(db.client, jobId, bridge(db)), /No open work order/);
  });

  test("an inbound token dies when the job moves to the outbound agent, and cannot act on it", async () => {
    const db = world({
      appId: null,
      outbound: "no_agent",
      toolAuth: false,
      outboundToolAuth: false,
    });
    db.tables["platform_admins"] = [{ user_id: ADMIN, role: "admin", is_active: true }];
    Object.assign(db.tables["agent_voice_language_settings"]![0]!, {
      status: "draft",
      applied_sarvam_app_id: null,
    });
    await run(db);
    const jobId = String(job(db)["id"]);
    const inbound = await session(db, jobId);
    assert.equal(inbound.auth.role, "inbound");
    Object.assign(job(db), { current_step: "waiting_for_outbound_agent" });
    // Even handed straight to the handler, an inbound token cannot report an outbound agent.
    const r = await call(db, inbound.auth, "report_tools_created", {
      workOrderId: jobId,
      agentId: OUT,
      tools: [...CLICKAI_TOOL_NAMES],
    });
    assert.equal(r.body.error, "not_found");
    assert.deepEqual(await inbound.check(), { ok: false, reason: "revoked" });
    assert.equal(events(db, "agent_tools_created").length, 0);
  });

  test("an outbound token cannot read or change an inbound work order", async () => {
    const { db, jobId } = await inboundLive();
    const outbound = await session(db, jobId);
    Object.assign(job(db), { current_step: "waiting_for_tool_authentication" });
    for (const [name, args] of [
      ["get_agent_work_order", { workOrderId: jobId }],
      ["report_blocker", { workOrderId: jobId, reason: "other" }],
    ] as const)
      assert.equal((await call(db, outbound.auth, name, args)).isError, true, name);
    assert.deepEqual(await outbound.check(), { ok: false, reason: "revoked" });
  });
});

describe("an agent of one role is never accepted as the other", () => {
  const refusals: [string, string, RegExp][] = [
    ["the customer's own inbound agent", "Customer-app-1", /own agent|inbound agent/],
    ["the inbound master", "Master-agent", /master template/],
    ["the outbound master", "Master-out", /master template/],
    ["another customer's inbound agent", "Other-app", /inbound agent|another customer/],
  ];
  for (const [name, agentId, message] of refusals)
    test(`outbound: ${name} is refused`, async () => {
      const { db, jobId } = await inboundLive();
      const { auth } = await session(db, jobId);
      const order = await outboundOrder(db, jobId);
      const r = await call(db, auth, "report_tools_created", {
        workOrderId: jobId,
        agentId,
        tools: order.tools.map((t) => t.name),
      });
      assert.equal(r.isError, true);
      assert.match(r.body.message, message);
      assert.equal(events(db, "agent_tools_created").length, 0);
    });

  test("outbound: another customer's outbound agent, or one their job reported, is refused", async () => {
    for (const seed of [
      (db: World) => (db.tables["agent_configs"]![1]!["sarvam_outbound_app_id"] = OUT),
      (db: World) =>
        (db.tables["provisioning_run_events"] ??= []).push({
          run_id: "their-job",
          organization_id: OTHER,
          event: "agent_tools_created",
          detail: { role: "outbound", appId: OUT },
        }),
    ]) {
      const { db, jobId } = await inboundLive();
      seed(db);
      const { auth } = await session(db, jobId);
      const order = await outboundOrder(db, jobId);
      const r = await call(db, auth, "report_tools_created", {
        workOrderId: jobId,
        agentId: OUT,
        tools: order.tools.map((t) => t.name),
      });
      assert.match(r.body.message, /another customer/);
    }
  });

  test("outbound: a copy of the inbound agent or its master is refused", async () => {
    const { db, jobId } = await inboundLive();
    const { auth } = await session(db, jobId);
    const tools = (await outboundOrder(db, jobId)).tools.map((t) => t.name);
    for (const from of ["Customer-app-1", "Master-agent"]) {
      const r = await call(db, auth, "report_tools_created", {
        workOrderId: jobId,
        agentId: OUT,
        tools,
        clonedFrom: { agentId: from, version: 1 },
      });
      assert.match(r.body.message, /never the inbound agent/, from);
    }
  });

  test("outbound: the six inbound tools, or an extra callback tool, are refused", async () => {
    const { db, jobId } = await inboundLive();
    const { auth } = await session(db, jobId);
    const own = (await outboundOrder(db, jobId)).tools.map((t) => t.name);
    for (const tools of [[...CLICKAI_TOOL_NAMES], [...own, "request_callback"], own.slice(1)]) {
      const r = await call(db, auth, "report_tools_created", {
        workOrderId: jobId,
        agentId: OUT,
        tools,
      });
      assert.equal(r.body.error, "invalid", tools.join(","));
    }
  });

  test("inbound: the customer's outbound agent is refused as the inbound one", async () => {
    const db = world({ appId: null, toolAuth: false });
    db.tables["platform_admins"] = [{ user_id: ADMIN, role: "admin", is_active: true }];
    Object.assign(db.tables["agent_voice_language_settings"]![0]!, { status: "draft" });
    await run(db);
    const jobId = String(job(db)["id"]);
    const { auth } = await session(db, jobId);
    const r = await call(db, auth, "report_tools_created", {
      workOrderId: jobId,
      agentId: "Customer-out-1",
      clonedFrom: { agentId: "Master-agent", version: 2 },
      tools: [...CLICKAI_TOOL_NAMES],
    });
    assert.match(r.body.message, /outbound agent/);
  });
});

describe("confirming the outbound agent", () => {
  test("an inbound reference or inbound evidence is refused", async () => {
    const { db, auth, submit, evidence, check } = await outboundReported();
    const wrongRef = await call(
      db,
      auth,
      "submit_agent_result",
      submit({ toolAuth: evidence.map((e) => ({ ...e, agentRef: "inbound:agent_new" })) }),
    );
    assert.match(wrongRef.body.message, /agent_ref/);
    const inbound = await call(
      db,
      auth,
      "submit_agent_result",
      submit({ toolAuth: toolEvidence() }),
    );
    assert.equal(inbound.body.error, "invalid");
    assert.equal(agent(db)["sarvam_outbound_app_id"], null);
    assert.equal((await check()).ok, true);
  });

  test("registers only the outbound agent, completes the same job, and enables no calling", async () => {
    const { db, auth, submit, check, jobId } = await outboundReported();
    assert.equal(job(db)["current_step"], "waiting_for_outbound_tool_authentication");
    // Everything inbound, apart from re-verification timestamps.
    const inboundState = () =>
      JSON.stringify([
        agent(db)["sarvam_app_id"],
        agent(db)["sarvam_app_version"],
        { ...num(db, "num_new"), updated_at: 0, deployment_verified_at: 0 },
      ]);
    const before = inboundState();
    const done = await call(db, auth, "submit_agent_result", submit());
    assert.equal(done.body.status, "registered", JSON.stringify(done.body));
    assert.deepEqual(registeredAgent(agent(db), "outbound"), { appId: OUT, version: 1 });
    assert.equal(job(db)["id"], jobId);
    assert.equal(job(db)["status"], "succeeded");
    assert.equal(inboundState(), before, "the inbound agent and number are as they were");
    assert.deepEqual(await check(), { ok: false, reason: "revoked" }, "single use");
    // Registered and confirmed tools: still nothing may be dialled.
    assert.equal(outboundConfirmed(agent(db)), false);
    assert.equal(outboundAgentTarget(agent(db) as never), null);
    const ready = await setOutboundReady(db.client, {
      organizationId: ORG,
      ready: true,
      maxCallSeconds: 300,
    });
    assert.equal(ready.ok, true, JSON.stringify(ready));
    assert.deepEqual(outboundAgentTarget(agent(db) as never), { appId: OUT, appVersion: 1 });
    assert.notEqual(outboundAgentTarget(agent(db) as never)!.appId, agent(db)["sarvam_app_id"]);
  });

  test("each role's report and confirmation stay with that role", async () => {
    const { db, jobId, auth, submit } = await outboundReported();
    assert.equal(await reportedAgent(db.client, ORG, jobId, "inbound"), null);
    assert.equal((await reportedAgent(db.client, ORG, jobId, "outbound"))?.appId, OUT);
    await call(db, auth, "submit_agent_result", submit());
    const status = (role: "inbound" | "outbound") =>
      toolAuthStatus(db.client, { organizationId: ORG, appId: OUT, version: 1, role });
    assert.equal((await status("outbound")).confirmed, true);
    assert.equal((await status("inbound")).confirmed, false);
  });

  test("a hand-registered outbound agent waits for its confirmation; inbound is untouched", async () => {
    const { db } = await inboundLive();
    Object.assign(agent(db), { sarvam_outbound_app_id: OUT, sarvam_outbound_app_version: 1 });
    const dep = deps(db);
    const r = await run(db, dep);
    assert.equal(r.result?.state, "waiting_for_outbound_tool_authentication");
    assert.equal(num(db, "num_new")["status"], "active");
    assert.deepEqual([dep.calls.create, dep.calls.pause, dep.calls.resume], [0, 0, 0]);
    // An INBOUND-role confirmation of the same id does not count.
    confirmToolAuth(db, OUT, 1);
    assert.equal((await run(db)).result?.state, "waiting_for_outbound_tool_authentication");
    confirmToolAuth(db, OUT, 1, ORG, "outbound");
    assert.equal((await run(db)).result?.state, "active");
  });

  test("an existing customer already confirmed for calling is left exactly as before", async () => {
    const { db } = await inboundLive();
    Object.assign(agent(db), {
      sarvam_outbound_app_id: OUT,
      sarvam_outbound_app_version: 1,
      sarvam_outbound_ready_app_id: OUT,
      sarvam_outbound_ready_version: 1,
    });
    const before = JSON.stringify(agent(db));
    const r = await run(db);
    assert.equal(r.result?.state, "active", r.result?.note);
    assert.equal(JSON.stringify(agent(db)), before);
  });

  test("with no outbound agent nothing falls back to the inbound agent", async () => {
    const { db } = await inboundLive();
    assert.equal(outboundAgentTarget(agent(db) as never), null);
    assert.equal(registeredAgent(agent(db), "outbound"), null);
    assert.deepEqual(registeredAgent(agent(db), "inbound"), {
      appId: "Customer-app-1",
      version: 1,
    });
  });
});

describe("a provider that can author agents (not Sarvam today)", () => {
  test("creates the outbound agent from the outbound template and registers it as outbound only", async () => {
    const { db } = await inboundLive();
    const created: { role: string; templateAppId: string | null; name: string }[] = [];
    const provider: AgentProvisioner = {
      supported: true,
      findAgentByName: async () => null,
      createAgent: async (i) => {
        created.push(i);
        return { appId: OUT };
      },
      configureAgent: async ({ config }) => {
        assert.equal((config as { role?: string }).role, "outbound", "its own configuration");
        return { version: 1 };
      },
      verifyAgent: async () => ({ ok: true, detail: "" }),
    };
    const out = await ensureCustomerAgent(
      db.client,
      {
        role: "outbound",
        organizationId: ORG,
        agentConfigId: "agent_new",
        config: buildOutboundAgentConfig(snapshot(BOOKING), null),
        masterAgentAppId: "Master-agent",
        outboundMasterAgentAppId: "Master-out",
      },
      provider,
    );
    assert.equal(out.kind, "ready");
    assert.deepEqual([created[0]!.role, created[0]!.templateAppId], ["outbound", "Master-out"]);
    assert.match(created[0]!.name, /-out$/);
    assert.equal(agent(db)["sarvam_outbound_app_id"], OUT);
    assert.equal(agent(db)["sarvam_app_id"], "Customer-app-1");
    // Even then the credential checkpoint applies before the job completes.
    const d: PipelineDeps = deps(db).d;
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "waiting_for_outbound_tool_authentication");
  });
});

describe("customer status keeps the two directions apart", () => {
  test("only a usable direction reads as live", () => {
    const view = (inboundLive: boolean, outboundRegistered: boolean, ready: boolean) =>
      agentCallStatus({
        inboundLive,
        outboundRegistered,
        outboundConfirmed: ready,
      }).map((s) => `${s.direction}:${s.label}:${s.tone}`);
    assert.deepEqual(view(true, false, false), [
      "inbound:Live:live",
      "outbound:Not set up yet:idle",
    ]);
    assert.deepEqual(view(true, true, false), [
      "inbound:Live:live",
      "outbound:Awaiting final checks:ready",
    ]);
    assert.deepEqual(view(false, true, true), ["inbound:Not live yet:idle", "outbound:Ready:live"]);
  });

  test("confirmation counts only for exactly the registered version", () => {
    const row = {
      sarvam_outbound_app_id: OUT,
      sarvam_outbound_app_version: 2,
      sarvam_outbound_ready_app_id: OUT,
      sarvam_outbound_ready_version: 1,
    };
    assert.equal(outboundConfirmed(row), false);
    assert.equal(outboundConfirmed({ ...row, sarvam_outbound_ready_version: 2 }), true);
    assert.equal(outboundConfirmed({}), false);
  });
});

describe("partial failure, retry and concurrency on the outbound agent", () => {
  test("two simultaneous outbound submissions register and confirm once", async () => {
    const { db, auth, submit } = await outboundReported();
    const out = await Promise.all([
      call(db, auth, "submit_agent_result", submit()),
      call(db, auth, "submit_agent_result", submit()),
    ]);
    assert.equal(out.filter((o) => o.body.status === "registered").length, 1);
    assert.equal(events(db, "tool_auth_confirmed").length, 1);
  });

  test("a lost resume leaves the job waiting; a retry completes it without repeating anything", async () => {
    const { db, auth, submit, jobId } = await outboundReported();
    const lost = await handleBridgeRpc(
      db.client,
      auth,
      {
        ...bridge(db),
        resume: async () => {
          throw new Error("worker stopped");
        },
      },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "submit_agent_result", arguments: submit() },
      },
    );
    assert.match(JSON.stringify(lost), /jobResumed\\": false/);
    assert.equal(job(db)["status"], "waiting");
    assert.equal(registeredAgent(agent(db), "outbound")?.appId, OUT);
    const dep = deps(db);
    const retried = await run(db, dep);
    assert.equal(retried.status, "succeeded", String(retried.result?.note));
    assert.equal(job(db)["id"], jobId);
    assert.deepEqual([dep.calls.create, dep.calls.pause, dep.calls.resume], [0, 0, 0]);
    assert.equal(events(db, "tool_auth_confirmed").length, 1);
  });
});
