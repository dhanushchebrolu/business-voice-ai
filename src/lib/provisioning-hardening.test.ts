import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runProvisioningPipeline } from "./provisioning-pipeline.server.ts";
import { runProvisioning, sweepProvisioningRetries } from "./provisioning-runs.server.ts";
import { handleBridgeRpc } from "./operator-bridge-mcp.server.ts";
import { getWorkOrder, listWorkOrders, type WorkOrderDeps } from "./operator-bridge.server.ts";
import { registerProvisionedAgent } from "./sarvam-agent-provisioner.server.ts";
import { reportedAgent } from "./tool-auth-checkpoint.server.ts";
import { FAILURE_HINTS } from "./voice-provisioning-job.ts";
import { CLICKAI_TOOL_NAMES } from "./sarvam-agent-tools-spec.ts";
import {
  ORG,
  OTHER,
  snapshot,
  world,
  deps,
  num,
  confirmToolAuth,
} from "./provisioning-test-world.test-helper.ts";

/**
 * Pre-merge hardening: the checkpoint is mandatory however the agent was registered, waiting
 * jobs do not churn, an earlier job's report never blocks a replacement agent, and the
 * operator-facing text names the real procedure. Mocks only.
 */

type World = ReturnType<typeof world>;
const NOW = new Date("2026-11-27T10:00:00Z");
const SIX = [...CLICKAI_TOOL_NAMES];
const USER = "00000000-0000-0000-0000-0000000000bb";
const auth = { ok: true, tokenId: "tok", createdBy: USER, prefix: "cbr_test" } as const;
const bearer = SIX.map((name) => ({ name, authType: "bearer" }));
const iso = (ms: number) => new Date(ms).toISOString();

/** A customer with a number, credential and voice settings, but no agent registered yet. */
function newCustomer() {
  const db = world({ appId: null, toolAuth: false });
  Object.assign(db.tables["agent_voice_language_settings"]![0]!, {
    status: "draft",
    applied_sarvam_app_id: null,
    applied_sarvam_app_version: null,
  });
  db.tables["agent_configs"]![0]!["sarvam_app_version"] = null;
  return db;
}
const pipelineDeps = (db: World) =>
  deps(db, { deployment: { appId: "Cust-agent-1", appVersion: 3 } });
const run = (db: World, d = pipelineDeps(db), force = true, now = NOW) =>
  runProvisioning(
    db.client,
    { organizationId: ORG, trigger: "customer_activate", ...(force ? { force: true } : {}) },
    (a, o, h) => runProvisioningPipeline(a, o, d.d, h.onStep),
    () => now,
  );
const jobs = (db: World) => db.tables["provisioning_runs"]!;
const events = (db: World, name?: string) =>
  (db.tables["provisioning_run_events"] ?? []).filter((e) => !name || e["event"] === name);

/** What the admin screen's "register agent" does to the customer, via the shared code. */
const handRegister = (db: World, appId: string, version: number) =>
  registerProvisionedAgent(db.client, {
    organizationId: ORG,
    agentConfigId: "agent_new",
    appId,
    version,
    masterAgentAppId: "Master-agent",
  });

function bridge(db: World) {
  const d: WorkOrderDeps = {
    loadSnapshot: async () => snapshot(),
    baseUrl: "https://clickai.example",
    masterAgentAppId: "Master-agent",
    masterAgentVersion: 2,
    resume: async () => run(db),
  };
  return d;
}
const call = async (db: World, name: string, args: Record<string, unknown>) => {
  const out = await handleBridgeRpc(db.client, auth, bridge(db), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const r = (out as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { body: JSON.parse(r.content[0]!.text), isError: Boolean(r.isError) };
};
const report = (id: string, agentId: string) => ({
  workOrderId: id,
  agentId,
  clonedFrom: { agentId: "Master-agent", version: 2 },
  tools: SIX,
});

describe("the checkpoint is mandatory, however the agent was registered", () => {
  test("a hand-registered agent is NOT deployed or activated without the confirmation", async () => {
    const db = newCustomer();
    await run(db);
    await handRegister(db, "Hand-agent-1", 3);
    const dep = pipelineDeps(db);
    const r = await run(db, dep);
    assert.equal(r.result?.state, "waiting_for_tool_authentication", r.result?.note);
    assert.equal(jobs(db)[0]!["failure_code"], "TOOL_AUTH_PENDING");
    assert.equal(num(db, "num_new")["status"], "provisioning");
    assert.equal(dep.calls.create, 0, "no deployment");
    assert.equal(dep.calls.get + dep.calls.pause + dep.calls.resume, 0, "Sarvam not touched");
  });

  test("a report for a DIFFERENT agent does not open the gate for the registered one", async () => {
    const db = newCustomer();
    await run(db);
    db.tables["provisioning_run_events"] = [
      {
        run_id: jobs(db)[0]!["id"],
        organization_id: ORG,
        step: "creating_agent",
        event: "agent_tools_created",
        created_at: "2026-11-27T09:00:00Z",
        detail: { appId: "Operator-agent", tools: SIX },
      },
    ];
    await handRegister(db, "Hand-agent-1", 3); // the old bypass: an id with no report
    const r = await run(db);
    assert.equal(r.result?.state, "waiting_for_tool_authentication");
    assert.equal(num(db, "num_new")["status"], "provisioning");
  });

  test("a confirmation for another version or another agent never satisfies it", async () => {
    const db = newCustomer();
    await run(db);
    await handRegister(db, "Hand-agent-1", 3);
    confirmToolAuth(db, "Hand-agent-1", 2); // an older version
    confirmToolAuth(db, "Someone-elses-agent", 3);
    confirmToolAuth(db, "Hand-agent-1", 3, OTHER); // another customer's confirmation
    assert.equal((await run(db)).result?.state, "waiting_for_tool_authentication");
    assert.equal(num(db, "num_new")["status"], "provisioning");
  });

  test("with the confirmation for this agent and version, the SAME job continues to live", async () => {
    const db = newCustomer();
    await run(db);
    await handRegister(db, "Cust-agent-1", 3);
    assert.equal((await run(db)).result?.state, "waiting_for_tool_authentication");
    confirmToolAuth(db, "Cust-agent-1", 3);
    const dep = pipelineDeps(db);
    const r = await run(db, dep);
    assert.equal(r.status, "succeeded", String(r.result?.note));
    assert.equal(num(db, "num_new")["status"], "active");
    assert.equal(dep.calls.create, 1);
    assert.equal(jobs(db).length, 1, "one job throughout");
  });

  test("the operator's submit_agent_result is the way to confirm a hand-registered agent", async () => {
    const db = newCustomer();
    await run(db);
    await handRegister(db, "Cust-agent-1", 3);
    assert.equal((await run(db)).result?.state, "waiting_for_tool_authentication");
    const id = String(jobs(db)[0]!["id"]);
    const fingerprint = (await getWorkOrder(db.client, id, bridge(db))).fingerprint;
    // The queue shows the registered agent at the checkpoint, with no tool reported yet.
    const [item] = await listWorkOrders(db.client, NOW);
    assert.equal(item!.checkpoint?.agentId, "Cust-agent-1");
    assert.equal(item!.checkpoint?.readyForConfirmation, false);
    // Without the report the checkpoint cannot be skipped.
    const early = await call(db, "submit_agent_result", {
      workOrderId: id,
      agentId: "Cust-agent-1",
      version: 3,
      fingerprint,
      toolAuth: bearer,
    });
    assert.equal(early.body.error, "conflict");
    assert.equal(num(db, "num_new")["status"], "provisioning");
    assert.equal(
      (await call(db, "report_tools_created", report(id, "Cust-agent-1"))).isError,
      false,
    );
    const done = await call(db, "submit_agent_result", {
      workOrderId: id,
      agentId: "Cust-agent-1",
      version: 3,
      fingerprint,
      toolAuth: bearer,
    });
    assert.equal(done.body.status, "registered", JSON.stringify(done.body));
    assert.equal(num(db, "num_new")["status"], "active");
  });
});

describe("an already-live number keeps today's behaviour", () => {
  test("never gated, never paused or redeployed, only re-verified", async () => {
    // A live customer: agent registered by hand, number active, NO confirmation or report on file.
    const db = world({ numberStatus: "active", deploymentId: "dep-new", toolAuth: false });
    Object.assign(num(db, "num_new"), {
      inbound_enabled: true,
      connection_id: "conn_new",
      agent_config_id: "agent_new",
      verified_deployment_id: "dep-new",
      verified_sarvam_app_id: "Customer-app-1",
      verified_sarvam_app_version: 1,
    });
    const dep = deps(db, { deployment: { appId: "Customer-app-1", appVersion: 1 } });
    const before = JSON.stringify(db.tables["phone_numbers"]);
    const r = await runProvisioningPipeline(db.client, ORG, dep.d);
    assert.notEqual(r.state, "waiting_for_tool_authentication");
    assert.equal(num(db, "num_new")["status"], "active");
    assert.deepEqual([dep.calls.create, dep.calls.pause, dep.calls.resume], [0, 0, 0]);
    assert.equal(
      JSON.stringify(num(db, "num_other")),
      JSON.stringify(JSON.parse(before).find((n: { id: string }) => n.id === "num_other")),
      "another customer's number untouched",
    );
  });
});

describe("waiting jobs do not churn", () => {
  /** The database stamps updated_at on every update; the in-memory stand-in does not. */
  const stamp = (db: World, at: number) => {
    jobs(db)[0]!["updated_at"] = iso(at);
  };
  const sweepOnce = async (db: World, at: number) => {
    const out = await sweepProvisioningRetries(db.client, {
      now: new Date(at),
      run: async (a, i) => {
        const r = await runProvisioning(
          a,
          i,
          (x, o, h) => runProvisioningPipeline(x, o, pipelineDeps(db).d, h.onStep),
          () => new Date(at),
        );
        stamp(db, at);
        return r;
      },
    });
    return out;
  };

  test("a job already re-run on the current state is left alone for hours of sweeps", async () => {
    const db = newCustomer();
    const t0 = NOW.getTime();
    await run(db); // waiting_for_agent
    stamp(db, t0);
    await handRegister(db, "Hand-agent-1", 3);
    Object.assign(db.tables["agent_configs"]![0]!, { updated_at: iso(t0 + 60_000) });
    Object.assign(db.tables["agent_voice_language_settings"]![0]!, {
      updated_at: iso(t0 + 60_000),
    });

    // The registration happened after the job last ran: ONE sweep resumes it (recovery).
    const first = await sweepOnce(db, t0 + 120_000);
    assert.equal(first.processed, 1);
    assert.equal(jobs(db)[0]!["current_step"], "waiting_for_tool_authentication");
    const attempts = jobs(db)[0]!["attempts"];
    const eventCount = events(db).length;

    // Then a day of minute-by-minute sweeps changes nothing: no claim, no attempts, no events.
    for (let m = 3; m < 24 * 60; m += 1) {
      const r = await sweepOnce(db, t0 + m * 60_000);
      assert.equal(r.processed, 0, `sweep at minute ${m}`);
    }
    assert.equal(jobs(db)[0]!["attempts"], attempts, "attempts did not grow");
    assert.equal(events(db).length, eventCount, "no new events");
  });

  test("a real change since the last attempt resumes it again (recovery is preserved)", async () => {
    const db = newCustomer();
    const t0 = NOW.getTime();
    await run(db);
    stamp(db, t0);
    await handRegister(db, "Hand-agent-1", 3);
    Object.assign(db.tables["agent_configs"]![0]!, { updated_at: iso(t0 + 1_000) });
    Object.assign(db.tables["agent_voice_language_settings"]![0]!, { updated_at: iso(t0 + 1_000) });
    assert.equal((await sweepOnce(db, t0 + 60_000)).processed, 1);
    assert.equal((await sweepOnce(db, t0 + 120_000)).processed, 0);
    // The agent is re-registered (a new version): news, so one more resume.
    Object.assign(db.tables["agent_configs"]![0]!, { updated_at: iso(t0 + 150_000) });
    assert.equal((await sweepOnce(db, t0 + 180_000)).processed, 1);
    assert.equal((await sweepOnce(db, t0 + 240_000)).processed, 0);
    // The customer's voice settings change: also news.
    Object.assign(db.tables["agent_voice_language_settings"]![0]!, {
      updated_at: iso(t0 + 250_000),
    });
    assert.equal((await sweepOnce(db, t0 + 300_000)).processed, 1);
    assert.equal(num(db, "num_new")["status"], "provisioning", "still gated throughout");
  });

  test("a job with no registered agent is never swept", async () => {
    const db = newCustomer();
    const t0 = NOW.getTime();
    await run(db);
    stamp(db, t0 - 3_600_000);
    assert.equal((await sweepOnce(db, t0)).processed, 0);
  });
});

describe("a report belongs to one job", () => {
  async function jobWithReport(db: World, agentId: string) {
    await run(db);
    const id = String(jobs(db).at(-1)!["id"]);
    const r = await call(db, "report_tools_created", report(id, agentId));
    assert.equal(r.isError, false, JSON.stringify(r.body));
    return id;
  }

  test("a stale report from an earlier job does not block a replacement agent", async () => {
    const db = newCustomer();
    const firstId = await jobWithReport(db, "Old-agent-1");
    assert.equal((await reportedAgent(db.client, ORG, firstId))?.appId, "Old-agent-1");
    // That job ended (abandoned/failed); the customer is provisioned again from scratch.
    Object.assign(jobs(db)[0]!, { status: "failed", finished_at: iso(NOW.getTime()) });
    await run(db);
    const second = jobs(db).find((j) => j["status"] === "waiting")!;
    assert.notEqual(second["id"], firstId);
    // The new job sees nothing reported yet…
    assert.equal(await reportedAgent(db.client, ORG), null);
    // …and the replacement agent can be reported, then confirmed through to live.
    const again = await call(
      db,
      "report_tools_created",
      report(String(second["id"]), "New-agent-2"),
    );
    assert.equal(again.body.status, "recorded", JSON.stringify(again.body));
    assert.equal((await reportedAgent(db.client, ORG))?.appId, "New-agent-2");
    assert.equal(events(db, "agent_tools_created").length, 2, "both reports kept in the trail");
  });

  test("a different agent inside the SAME job is still refused (no duplicate agents)", async () => {
    const db = newCustomer();
    const id = await jobWithReport(db, "Agent-A");
    const other = await call(db, "report_tools_created", report(id, "Agent-B"));
    assert.equal(other.body.error, "conflict");
    assert.match(other.body.message, /Agent-A/);
    assert.equal(events(db, "agent_tools_created").length, 1);
  });

  test("reporting the same agent twice in one job is idempotent", async () => {
    const db = newCustomer();
    const id = await jobWithReport(db, "Agent-A");
    const attempts = jobs(db)[0]!["attempts"];
    const again = await call(db, "report_tools_created", report(id, "Agent-A"));
    assert.equal(again.body.status, "already_reported");
    assert.equal(events(db, "agent_tools_created").length, 1);
    assert.equal(jobs(db)[0]!["attempts"], attempts, "no extra job run");
  });

  test("a report is not shared across customers, and another customer's agent is refused", async () => {
    const db = newCustomer();
    const id = await jobWithReport(db, "Agent-A");
    db.tables["provisioning_run_events"]!.push({
      run_id: "other-job",
      organization_id: OTHER,
      step: "creating_agent",
      event: "agent_tools_created",
      created_at: iso(NOW.getTime()),
      detail: { appId: "Other-tenant-agent", tools: SIX },
    });
    assert.equal((await reportedAgent(db.client, ORG, id))?.appId, "Agent-A");
    // Even naming the other customer's job id, this customer never sees that report.
    assert.equal(await reportedAgent(db.client, ORG, "other-job"), null);
    const stolen = await call(db, "report_tools_created", report(id, "Other-app"));
    assert.equal(stolen.body.error, "conflict");
    assert.match(stolen.body.message, /another customer/);
    assert.equal(db.tables["agent_configs"]![1]!["sarvam_app_id"], "Other-app", "unchanged");
  });
});

describe("operator-facing text names the real procedure", () => {
  test("no instruction, hint or job note mentions confirm_tool_authentication", async () => {
    const db = newCustomer();
    await run(db);
    await handRegister(db, "Cust-agent-1", 3);
    const r = await run(db);
    const id = String(jobs(db)[0]!["id"]);
    const order = await getWorkOrder(db.client, id, bridge(db));
    const text = [
      r.result?.note,
      FAILURE_HINTS.TOOL_AUTH_PENDING,
      ...order.instructions,
      String(jobs(db)[0]!["note"]),
    ].join("\n");
    assert.doesNotMatch(text, /confirm_tool_authentication/);
    assert.match(String(r.result?.note), /submit_agent_result/);
    assert.match(String(FAILURE_HINTS.TOOL_AUTH_PENDING), /submit_agent_result/);
    assert.match(order.instructions.join("\n"), /submit_agent_result/);
  });
});
