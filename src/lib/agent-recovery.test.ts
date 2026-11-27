import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { releaseAgentId, confirmOutboundToolCredentials } from "./agent-recovery.server.ts";
import { runProvisioningPipeline } from "./provisioning-pipeline.server.ts";
import { runProvisioning } from "./provisioning-runs.server.ts";
import {
  authenticateBridge,
  issueBridgeToken,
  reportToolsCreated,
  submitAgentResult,
  type BridgeAuth,
  type WorkOrderDeps,
  getWorkOrder,
  getOutboundWorkOrder,
} from "./operator-bridge.server.ts";
import { outboundAgentTarget, setOutboundReady } from "./sarvam-outbound-mode.server.ts";
import {
  applySarvamAgentMapping,
  applySarvamOutboundAgentMapping,
} from "./sarvam-agent-registration.server.ts";
import { claimedByAnotherCustomer, toolAuthStatus } from "./tool-auth-checkpoint.server.ts";
import { ORG, OTHER, snapshot, world, deps, num } from "./provisioning-test-world.test-helper.ts";

/**
 * Recovery from the two stuck states: a wrongly reported agent id (H1), and outbound agents
 * that could not be confirmed or re-enabled (H2). Real pipeline, runner and bridge; mocks only.
 */

type World = ReturnType<typeof world>;
type Auth = Extract<BridgeAuth, { ok: true }>;
const NOW = new Date("2026-11-27T10:00:00Z");
const ADMIN = "00000000-0000-0000-0000-0000000000bb";
const ACTOR = { userId: ADMIN, email: "admin@clickai.example" };
const OUT_REF = "outbound:agent_new";
const BOOKING = { calendar_book: true, capture_lead: true };

const run = (db: World, d: ReturnType<typeof deps>) =>
  runProvisioning(
    db.client,
    { organizationId: ORG, trigger: "customer_activate", force: true },
    (a, o, h) => runProvisioningPipeline(a, o, d.d, h.onStep),
    () => NOW,
  );
const job = (db: World) =>
  db.tables["provisioning_runs"]!.find((j) => j["organization_id"] === ORG)!;
const agent = (db: World) => db.tables["agent_configs"]![0]!;
const audit = (db: World, action: string) =>
  (db.tables["audit_logs"] ?? []).filter((r) => r["action"] === action);
const writes = (d: ReturnType<typeof deps>) => [
  d.calls.create,
  d.calls.pause,
  d.calls.resume,
  d.calls.sync,
];
/** Everything about the live inbound side, apart from re-verification timestamps. */
const inbound = (db: World) =>
  JSON.stringify([
    agent(db)["sarvam_app_id"],
    agent(db)["sarvam_app_version"],
    { ...num(db, "num_new"), updated_at: 0, deployment_verified_at: 0 },
  ]);

function bridge(db: World, d: ReturnType<typeof deps>): WorkOrderDeps {
  return {
    loadSnapshot: async () => snapshot(BOOKING),
    baseUrl: "https://clickai.example",
    masterAgentAppId: "Master-agent",
    outboundMasterAgentAppId: "Master-out",
    masterAgentVersion: 2,
    resume: async () => run(db, d),
    now: () => NOW,
  };
}

async function setup(over: Parameters<typeof world>[0]) {
  const db = world(over);
  db.tables["platform_admins"] = [{ user_id: ADMIN, role: "admin", is_active: true }];
  const d = deps(db, { loadSnapshot: async () => snapshot(BOOKING) });
  await run(db, d);
  return { db, d, jobId: String(job(db)["id"]) };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function session(c: Ctx) {
  const t = await issueBridgeToken(c.db.client, { createdBy: ADMIN, runId: c.jobId, now: NOW });
  const check = () => authenticateBridge(c.db.client, `Bearer ${t.token}`, NOW);
  const auth = await check();
  assert.equal(auth.ok, true);
  return { check, auth: auth as Auth };
}

async function toolNames(c: Ctx, role: "inbound" | "outbound") {
  const build = role === "inbound" ? getWorkOrder : getOutboundWorkOrder;
  const order = await build(c.db.client, c.jobId, bridge(c.db, c.d));
  return { names: order.tools.map((t) => t.name), fingerprint: order.fingerprint };
}

async function report(c: Ctx, auth: Auth, appId: string) {
  const { names } = await toolNames(c, auth.role);
  return reportToolsCreated(
    c.db.client,
    {
      workOrderId: c.jobId,
      appId,
      tools: names,
      ...(auth.role === "inbound" ? { clonedFrom: { agentId: "Master-agent", version: 2 } } : {}),
    },
    auth,
    bridge(c.db, c.d),
  );
}

async function submit(c: Ctx, auth: Auth, appId: string, fingerprint: string, names: string[]) {
  return submitAgentResult(
    c.db.client,
    {
      workOrderId: c.jobId,
      appId,
      version: 1,
      fingerprint,
      toolAuth: names.map((name) => ({
        name,
        authType: "bearer",
        agentRef: `${auth.role}:agent_new`,
      })),
    },
    auth,
    bridge(c.db, c.d),
  );
}

const release = (c: { db: World }, appId: string, organizationId = ORG) =>
  releaseAgentId(c.db.client, {
    organizationId,
    appId,
    actor: ACTOR,
    reason: "typed the wrong id",
    now: NOW,
  });

/** A customer waiting for the inbound agent; nothing live yet. */
const waitingInbound = () => setup({ appId: null, outbound: false });
/** A live inbound customer whose job waits for the outbound agent. */
async function liveWaitingOutbound() {
  const c = await setup({ outbound: "no_agent", outboundToolAuth: false });
  assert.equal(job(c.db)["current_step"], "waiting_for_outbound_agent");
  assert.equal(num(c.db, "num_new")["status"], "active");
  return c;
}

describe("H1: a wrong agent id does not trap the job", () => {
  test("release, then the correct id is reported, submitted and goes live", async () => {
    const c = await waitingInbound();
    const first = await session(c);
    await report(c, first.auth, "Typo-agent-1");
    assert.equal(job(c.db)["current_step"], "waiting_for_tool_authentication");
    await assert.rejects(report(c, first.auth, "Right-agent-1"), /already reported.*releases it/s);
    assert.equal(await claimedByAnotherCustomer(c.db.client, "Typo-agent-1", OTHER), true);

    const done = await release(c, "Typo-agent-1");
    assert.deepEqual(done, { released: 1, tokensRevoked: 1, jobState: "waiting_for_agent" });
    assert.equal(job(c.db)["current_step"], "waiting_for_agent");
    assert.equal(job(c.db)["sarvam_agent_id"], null);
    assert.equal(job(c.db)["id"], c.jobId, "same job");
    assert.equal(await claimedByAnotherCustomer(c.db.client, "Typo-agent-1", OTHER), false);
    const [entry] = audit(c.db, "SARVAM_AGENT_ID_RELEASED");
    assert.deepEqual(
      [entry!["organization_id"], entry!["admin_user_id"], entry!["reason"]],
      [ORG, ADMIN, "typed the wrong id"],
    );
    assert.equal(
      c.db.tables["provisioning_run_events"]!.filter((e) => e["event"] === "agent_id_released")
        .length,
      1,
    );
    // A later run keeps waiting for an agent: the released report never comes back.
    await run(c.db, c.d);
    assert.equal(job(c.db)["current_step"], "waiting_for_agent");

    const second = await session(c);
    // The deployment ClickAI creates runs the corrected agent.
    c.d.sarvam.appId = "Right-agent-1";
    await report(c, second.auth, "Right-agent-1");
    const order = await toolNames(c, "inbound");
    const result = await submit(c, second.auth, "Right-agent-1", order.fingerprint, order.names);
    assert.equal(result.status, "registered");
    assert.equal(agent(c.db)["sarvam_app_id"], "Right-agent-1");
    assert.equal(num(c.db, "num_new")["status"], "active", String(job(c.db)["note"]));
    assert.equal(job(c.db)["current_step"], "waiting_for_outbound_credential", "moved on");
  });

  test("stale submissions stay rejected after the release", async () => {
    const c = await waitingInbound();
    const old = await session(c);
    await report(c, old.auth, "Typo-agent-1");
    const order = await toolNames(c, "inbound");
    await release(c, "Typo-agent-1");

    assert.deepEqual(await old.check(), { ok: false, reason: "revoked" });
    // Requests that had already passed authentication before the release.
    await assert.rejects(
      submit(c, old.auth, "Typo-agent-1", order.fingerprint, order.names),
      /Report the agent's tools first/,
    );
    await assert.rejects(report(c, old.auth, "Typo-agent-1"), /token has ended/);
    const fresh = await session(c);
    await assert.rejects(
      submit(c, fresh.auth, "Typo-agent-1", order.fingerprint, order.names),
      /Report the agent's tools first/,
    );
    await report(c, fresh.auth, "Right-agent-1");
    await assert.rejects(
      submit(c, old.auth, "Right-agent-1", order.fingerprint, order.names),
      /already used/,
    );
    await assert.rejects(
      submit(c, fresh.auth, "Typo-agent-1", order.fingerprint, order.names),
      /Report the agent's tools first/,
    );
    assert.equal(agent(c.db)["sarvam_app_id"], null);
  });

  test("correcting an outbound id leaves the live number and deployment alone", async () => {
    const c = await liveWaitingOutbound();
    const first = await session(c);
    await report(c, first.auth, "Typo-out-1");
    const before = inbound(c.db);
    const provider = writes(c.d);
    const reads = c.d.calls.get;

    const done = await release(c, "Typo-out-1");
    assert.equal(done.jobState, "waiting_for_outbound_agent");
    assert.equal(c.d.calls.get, reads, "releasing does not even read from Sarvam");

    const second = await session(c);
    await report(c, second.auth, "Right-out-1");
    const order = await toolNames(c, "outbound");
    await submit(c, second.auth, "Right-out-1", order.fingerprint, order.names);
    assert.equal(agent(c.db)["sarvam_outbound_app_id"], "Right-out-1");
    assert.equal(job(c.db)["status"], "succeeded");
    assert.deepEqual(writes(c.d), provider, "no create, pause, resume or sync");
    assert.equal(inbound(c.db), before);
    assert.equal(outboundAgentTarget(agent(c.db) as never), null, "nothing dialled yet");
  });

  test("a wrong id that was submitted: register the right one, release the wrong one", async () => {
    const c = await liveWaitingOutbound();
    const first = await session(c);
    await report(c, first.auth, "Wrong-out-1");
    const order = await toolNames(c, "outbound");
    await submit(c, first.auth, "Wrong-out-1", order.fingerprint, order.names);
    await assert.rejects(release(c, "Wrong-out-1"), /registered for this customer/);

    await applySarvamOutboundAgentMapping(c.db.client, {
      agentConfigId: "agent_new",
      organizationId: ORG,
      sarvamAppId: "Right-out-1",
      sarvamAppVersion: 1,
      masterAgentAppIds: [],
      registeredBy: ADMIN,
      now: NOW,
    });
    await release(c, "Wrong-out-1");
    assert.equal(
      (
        await toolAuthStatus(c.db.client, {
          organizationId: ORG,
          appId: "Wrong-out-1",
          version: 1,
          role: "outbound",
        })
      ).confirmed,
      false,
    );
    assert.equal(await claimedByAnotherCustomer(c.db.client, "Wrong-out-1", OTHER), false);
  });

  test("hand registration after a typo: the job accepts the right id once released", async () => {
    const c = await waitingInbound();
    const first = await session(c);
    await report(c, first.auth, "Typo-agent-1");
    await applySarvamAgentMapping(c.db.client, {
      agentConfigId: "agent_new",
      organizationId: ORG,
      sarvamAppId: "Right-agent-1",
      sarvamAppVersion: 1,
      masterAgentAppId: "Master-agent",
    });
    Object.assign(c.db.tables["agent_voice_language_settings"]![0]!, {
      applied_sarvam_app_id: "Right-agent-1",
    });
    await run(c.db, c.d);
    const stuck = await session(c);
    await assert.rejects(report(c, stuck.auth, "Right-agent-1"), /already reported/);
    const done = await release(c, "Typo-agent-1");
    assert.equal(done.jobState, "waiting_for_tool_authentication", "still needs its confirmation");
    const fresh = await session(c);
    c.d.sarvam.appId = "Right-agent-1";
    await report(c, fresh.auth, "Right-agent-1");
    const order = await toolNames(c, "inbound");
    await submit(c, fresh.auth, "Right-agent-1", order.fingerprint, order.names);
    assert.equal(num(c.db, "num_new")["status"], "active");
  });

  test("releasing is limited to this customer's own records and keeps isolation", async () => {
    const c = await waitingInbound();
    const s = await session(c);
    await report(c, s.auth, "Typo-agent-1");
    await assert.rejects(release(c, "Typo-agent-1", OTHER), /Nothing is recorded/);
    await assert.rejects(release(c, "Never-seen-1"), /Nothing is recorded/);
    await assert.rejects(release(c, "cbr_abcdefghij", ORG), /Nothing is recorded/);
    await assert.rejects(release(c, "no spaces allowed"), /does not look like/);
    await assert.rejects(
      releaseAgentId(c.db.client, {
        organizationId: ORG,
        appId: "Typo-agent-1",
        actor: ACTOR,
        reason: "  ",
      }),
      /reason is required/,
    );
    assert.equal(audit(c.db, "SARVAM_AGENT_ID_RELEASED").length, 0);
    assert.equal((await s.check()).ok, true, "refusals change nothing");
    // Another customer's registered agent stays theirs, released or not.
    await release(c, "Typo-agent-1");
    const fresh = await session(c);
    await assert.rejects(report(c, fresh.auth, "Other-app"), /belongs to another customer/);
  });

  test("another customer's report blocks an id until that report is released", async () => {
    const c = await waitingInbound();
    c.db.tables["provisioning_run_events"]!.push({
      id: "evt_other",
      run_id: "run_other",
      organization_id: OTHER,
      event: "agent_tools_created",
      created_at: NOW.toISOString(),
      detail: { role: "inbound", appId: "Shared-typo-1" },
    });
    const s = await session(c);
    await assert.rejects(report(c, s.auth, "Shared-typo-1"), /another customer.*release/s);
    (c.db.tables["audit_logs"] ??= []).push({
      id: "aud_other",
      organization_id: OTHER,
      action: "SARVAM_AGENT_ID_RELEASED",
      new_value: { appId: "Shared-typo-1", recordIds: ["evt_other"] },
    });
    await report(c, s.auth, "Shared-typo-1");
  });

  test("a running job, or an audit log that cannot be written, releases nothing", async () => {
    const c = await waitingInbound();
    const s = await session(c);
    await report(c, s.auth, "Typo-agent-1");
    job(c.db)["status"] = "running";
    await assert.rejects(release(c, "Typo-agent-1"), /running/);
    job(c.db)["status"] = "waiting";
    c.db.failNext("audit_logs", "insert", { message: "audit down" });
    await assert.rejects(release(c, "Typo-agent-1"));
    assert.equal(job(c.db)["current_step"], "waiting_for_tool_authentication");
    assert.equal(job(c.db)["sarvam_agent_id"], "Typo-agent-1");
    await release(c, "Typo-agent-1");
    assert.equal(job(c.db)["current_step"], "waiting_for_agent");
  });

  test("an id released by mistake can be reported again with a new token", async () => {
    const c = await waitingInbound();
    await report(c, (await session(c)).auth, "Agent-a-1");
    await release(c, "Agent-a-1");
    const result = await report(c, (await session(c)).auth, "Agent-a-1");
    assert.equal(result.status, "recorded");
    assert.equal(job(c.db)["current_step"], "waiting_for_tool_authentication");
  });
});

/** A live customer from before the checkpoint: outbound v1 confirmed, no confirmation on record. */
async function legacy(over: { inboundCredential?: false } = {}) {
  const db = world({
    numberStatus: "active",
    deploymentId: "dep-new",
    toolAuth: false,
    outboundToolAuth: false,
  });
  Object.assign(num(db, "num_new"), {
    inbound_enabled: true,
    verified_deployment_id: "dep-new",
    connection_id: "conn_new",
    agent_config_id: "agent_new",
  });
  Object.assign(agent(db), {
    sarvam_outbound_ready_app_id: "Customer-out-1",
    sarvam_outbound_ready_version: 1,
    sarvam_outbound_max_call_seconds: 300,
    sarvam_outbound_registered_at: "2026-11-20T00:00:00Z",
  });
  if (over.inboundCredential === false)
    db.tables["sarvam_agent_integrations"] = db.tables["sarvam_agent_integrations"]!.filter(
      (r) => r["role"] === "outbound",
    );
  db.tables["audit_logs"] = [];
  return db;
}
const ready = (db: World, on = true) =>
  setOutboundReady(db.client, {
    organizationId: ORG,
    ready: on,
    maxCallSeconds: 300,
    actor: ACTOR,
  });
const target = (db: World) => outboundAgentTarget(agent(db) as never);
const registerOutbound = (db: World, appId: string, version: number, now = NOW) =>
  applySarvamOutboundAgentMapping(db.client, {
    agentConfigId: "agent_new",
    organizationId: ORG,
    sarvamAppId: appId,
    sarvamAppVersion: version,
    masterAgentAppIds: ["Master-agent", "Master-out"],
    registeredBy: ADMIN,
    now,
  });
function confirm(
  db: World,
  over: Partial<Parameters<typeof confirmOutboundToolCredentials>[1]> = {},
) {
  return confirmOutboundToolCredentials(db.client, {
    organizationId: ORG,
    appId: "Customer-out-1",
    version: Number(agent(db)["sarvam_outbound_app_version"]),
    agentRef: OUT_REF,
    masterAgentAppIds: ["Master-agent", "Master-out"],
    actor: ACTOR,
    reason: "checked in Sarvam",
    resume: async () => assert.fail("no job to resume"),
    now: NOW,
    ...over,
  });
}
const outboundCredential = (db: World) =>
  db.tables["sarvam_agent_integrations"]!.find((r) => r["role"] === "outbound")!;

describe("H2: an existing outbound customer can recover", () => {
  test("a confirmed configuration stays as it is, and re-confirming it is allowed", async () => {
    const db = await legacy();
    assert.deepEqual(target(db), { appId: "Customer-out-1", appVersion: 1 });
    assert.equal((await ready(db)).ok, true);
    assert.deepEqual(target(db), { appId: "Customer-out-1", appVersion: 1 });
    assert.equal(db.tables["audit_logs"]!.length, 0);
  });

  test("withdraw, then enable the same version again", async () => {
    const db = await legacy();
    const off = await ready(db, false);
    assert.deepEqual([off.ok, "evidencePreserved" in off], [true, false]);
    assert.equal(target(db), null, "withdrawn means withdrawn");
    const [kept] = audit(db, "SARVAM_OUTBOUND_CONFIRMATION_PRESERVED");
    assert.equal(kept!["admin_user_id"], ADMIN);
    assert.deepEqual(kept!["new_value"], { app_id: "Customer-out-1", app_version: 1 });
    const on = await ready(db);
    assert.equal(on.ok, true, JSON.stringify(on));
    assert.deepEqual(target(db), { appId: "Customer-out-1", appVersion: 1 });
  });

  test("a changed version is not dialled and cannot be confirmed without a new check", async () => {
    const db = await legacy();
    await registerOutbound(db, "Customer-out-1", 2);
    assert.equal(target(db), null);
    const refused = await ready(db);
    assert.equal(refused.ok, false);
    assert.match((refused as { reason: string }).reason, /not confirmed for this version/);

    await confirm(db);
    assert.equal(target(db), null, "confirming credentials never switches calling on");
    assert.equal((await ready(db)).ok, true);
    assert.deepEqual(target(db), { appId: "Customer-out-1", appVersion: 2 });
  });

  test("the previous confirmed version can be restored after a newer one", async () => {
    const db = await legacy();
    await registerOutbound(db, "Customer-out-1", 2);
    await confirm(db);
    await ready(db);
    await registerOutbound(db, "Customer-out-1", 1);
    assert.equal(target(db), null);
    assert.equal((await ready(db)).ok, true);
    assert.deepEqual(target(db), { appId: "Customer-out-1", appVersion: 1 });
  });

  test("withdrawn before this change: an earlier 'ready' record counts only if it is outbound's", async () => {
    const entry = (over: Record<string, unknown>, at = "2026-11-21T00:00:00Z") => ({
      id: "aud_old",
      organization_id: ORG,
      action: "SARVAM_OUTBOUND_READY_SET",
      created_at: at,
      new_value: { ready: true, app_id: "Customer-out-1", app_version: 1 },
      ...over,
    });
    const withdrawn = async (row: Record<string, unknown>) => {
      const db = await legacy();
      Object.assign(agent(db), {
        sarvam_outbound_ready_app_id: null,
        sarvam_outbound_ready_version: null,
      });
      db.tables["audit_logs"] = [row];
      return (await ready(db)).ok;
    };
    assert.equal(await withdrawn(entry({})), true);
    assert.equal(await withdrawn(entry({}, "2026-11-19T00:00:00Z")), false, "before registration");
    assert.equal(await withdrawn(entry({ organization_id: OTHER })), false, "another customer");
    assert.equal(
      await withdrawn(entry({ new_value: { app_id: "Customer-out-1", app_version: 2 } })),
      false,
      "another version",
    );
    assert.equal(
      await withdrawn(entry({ new_value: { app_id: "Customer-app-1", app_version: 1 } })),
      false,
      "the inbound agent",
    );
    assert.equal(await withdrawn(entry({ action: "SARVAM_OUTBOUND_READY_CLEARED" })), false);
  });

  test("a recorded confirmation is stale without a live outbound credential", async () => {
    const db = await legacy();
    await ready(db, false);
    outboundCredential(db)["status"] = "disabled";
    assert.equal((await ready(db)).ok, false);
    Object.assign(outboundCredential(db), { status: "active", expires_at: "2020-01-01T00:00:00Z" });
    assert.equal((await ready(db)).ok, false);
    outboundCredential(db)["expires_at"] = null;
    assert.equal((await ready(db)).ok, true);
  });

  test("releasing an agent id ends its recorded confirmations", async () => {
    const db = await legacy();
    await ready(db, false);
    await registerOutbound(db, "Replacement-out-1", 1);
    await release({ db }, "Customer-out-1");
    await registerOutbound(db, "Customer-out-1", 1);
    assert.equal((await ready(db)).ok, false);
    assert.equal(target(db), null);
  });

  test("releasing a replaced agent also clears its stale 'ready' mapping", async () => {
    const db = await legacy();
    await registerOutbound(db, "Replacement-out-1", 1);
    await release({ db }, "Customer-out-1");
    assert.equal(agent(db)["sarvam_outbound_ready_app_id"], null);
    assert.equal(agent(db)["sarvam_outbound_app_id"], "Replacement-out-1");
  });

  test("an admin confirmation checks the version, reference, role and credential", async () => {
    const db = await legacy();
    await registerOutbound(db, "Customer-out-1", 2);
    await assert.rejects(confirm(db, { version: 1 }), /registered outbound agent is/);
    await assert.rejects(confirm(db, { appId: "Customer-app-1" }), /registered outbound agent is/);
    await assert.rejects(confirm(db, { agentRef: "inbound:agent_new" }), /agent_ref/);
    await assert.rejects(confirm(db, { masterAgentAppIds: ["Customer-out-1"] }), /master template/);
    await assert.rejects(confirm(db, { reason: " " }), /reason/);
    await assert.rejects(confirm(db, { organizationId: OTHER }), /outbound Sarvam agent first/);
    outboundCredential(db)["status"] = "disabled";
    await assert.rejects(confirm(db), /live outbound credential/);
    outboundCredential(db)["status"] = "active";
    db.failNext("audit_logs", "insert", { message: "audit down" });
    await assert.rejects(confirm(db));
    assert.equal(audit(db, "SARVAM_OUTBOUND_TOOL_AUTH_CONFIRMED").length, 0);
    assert.equal((await ready(db)).ok, false);
  });

  test("recorded confirmations never serve the inbound agent", async () => {
    const db = await legacy();
    db.tables["audit_logs"] = [
      {
        id: "aud_in",
        organization_id: ORG,
        action: "SARVAM_OUTBOUND_TOOL_AUTH_CONFIRMED",
        created_at: NOW.toISOString(),
        new_value: { app_id: "Customer-app-1", app_version: 1 },
      },
    ];
    for (const role of ["inbound", "outbound"] as const)
      assert.equal(
        (
          await toolAuthStatus(db.client, {
            organizationId: ORG,
            appId: "Customer-app-1",
            version: 1,
            role,
          })
        ).confirmed,
        false,
        role,
      );
  });

  test("an outbound confirmation says nothing about an inbound role", async () => {
    const db = await legacy();
    await registerOutbound(db, "Customer-out-1", 2);
    await confirm(db);
    const status = async (role: "inbound" | "outbound") =>
      (
        await toolAuthStatus(db.client, {
          organizationId: ORG,
          appId: "Customer-out-1",
          version: 2,
          role,
        })
      ).confirmed;
    assert.deepEqual([await status("outbound"), await status("inbound")], [true, false]);
  });

  test("missing inbound setup no longer blocks outbound recovery, and nothing live moves", async () => {
    const db = await legacy({ inboundCredential: false });
    const d = deps(db);
    await run(db, d);
    assert.equal(job(db)["current_step"], "waiting_for_integration_credential");
    const before = inbound(db);
    const reads = d.calls.get;
    await registerOutbound(db, "Customer-out-1", 2);
    let resumed = 0;
    const out = await confirm(db, { resume: async () => ++resumed });
    assert.deepEqual([out.jobResumed, resumed], [false, 0], "a job at an inbound step is not run");
    assert.equal((await ready(db)).ok, true);
    assert.deepEqual(target(db), { appId: "Customer-out-1", appVersion: 2 });
    assert.equal(inbound(db), before);
    assert.deepEqual([...writes(d), d.calls.get], [0, 0, 0, 0, reads]);
  });

  test("a job waiting on outbound tool credentials resumes and completes", async () => {
    const db = await legacy();
    await registerOutbound(db, "Customer-out-1", 2);
    const d = deps(db);
    await run(db, d);
    assert.equal(job(db)["current_step"], "waiting_for_outbound_tool_authentication");
    const before = inbound(db);
    const out = await confirm(db, { resume: () => run(db, d) });
    assert.equal(out.jobResumed, true);
    assert.equal(job(db)["status"], "succeeded", String(job(db)["note"]));
    assert.deepEqual(writes(d), [0, 0, 0, 0]);
    assert.equal(inbound(db), before);
    assert.equal(target(db), null, "calling still needs its own confirmation");
  });

  test("if the earlier confirmation cannot be kept, withdrawing still works and says so", async () => {
    const db = await legacy();
    db.failNext("audit_logs", "insert", { message: "audit down" });
    const off = await ready(db, false);
    assert.deepEqual(
      [off.ok, (off as { evidencePreserved?: boolean }).evidencePreserved],
      [true, false],
    );
    assert.equal(target(db), null);
    assert.equal((await ready(db)).ok, false);
    await confirm(db);
    assert.equal((await ready(db)).ok, true);
  });

  test("an old one-agent 'ready' mapping is never kept as outbound evidence", async () => {
    const db = await legacy();
    Object.assign(agent(db), { sarvam_outbound_ready_app_id: "Customer-app-1" });
    await ready(db, false);
    assert.equal(audit(db, "SARVAM_OUTBOUND_CONFIRMATION_PRESERVED").length, 0);
  });
});
