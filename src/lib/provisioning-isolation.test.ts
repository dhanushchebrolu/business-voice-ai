import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runProvisioningPipeline } from "./provisioning-pipeline.server.ts";
import {
  changeMarks,
  runProvisioning,
  sweepProvisioningRetries,
} from "./provisioning-runs.server.ts";
import { handleBridgeRpc } from "./operator-bridge-mcp.server.ts";
import {
  authenticateBridge,
  getWorkOrder,
  issueBridgeToken,
  type BridgeAuth,
  type WorkOrderDeps,
} from "./operator-bridge.server.ts";
import { CLICKAI_TOOL_NAMES } from "./sarvam-agent-tools-spec.ts";
import {
  ORG,
  OTHER,
  AGENT_REF,
  snapshot,
  world,
  deps,
  num,
  confirmToolAuth,
  toolEvidence,
} from "./provisioning-test-world.test-helper.ts";

/**
 * Bridge-token isolation (one customer, one job, inbound agent, single registration), the
 * submitted evidence being bound to the job, and the recovery sweep's fairness beyond any
 * page size. Mocks only.
 */

type World = ReturnType<typeof world>;
const NOW = new Date("2026-11-27T10:00:00Z");
const ADMIN = "00000000-0000-0000-0000-0000000000bb";
const SIX = [...CLICKAI_TOOL_NAMES];
const OTHER_JOB = "job-other";

const pipelineDeps = (db: World) =>
  deps(db, { deployment: { appId: "Cust-agent-1", appVersion: 3 } });
const run = (db: World, d = pipelineDeps(db)) =>
  runProvisioning(
    db.client,
    { organizationId: ORG, trigger: "customer_activate", force: true },
    (a, o, h) => runProvisioningPipeline(a, o, d.d, h.onStep),
    () => NOW,
  );
const jobs = (db: World) => db.tables["provisioning_runs"]!;
/** The events this test's own actions wrote (not the world's seeded confirmations). */
const events = (db: World, name: string) =>
  (db.tables["provisioning_run_events"] ?? []).filter(
    (e) => e["event"] === name && e["run_id"] !== "confirmed-in-test",
  );

/** ORG's job waiting for its agent, and a second customer's job waiting too. */
async function twoJobs() {
  const db = world({ appId: null, toolAuth: false });
  Object.assign(db.tables["agent_voice_language_settings"]![0]!, {
    status: "draft",
    applied_sarvam_app_id: null,
    applied_sarvam_app_version: null,
  });
  db.tables["agent_configs"]![0]!["sarvam_app_version"] = null;
  db.tables["platform_admins"] = [{ user_id: ADMIN, role: "admin", is_active: true }];
  await run(db);
  Object.assign(db.tables["agent_configs"]![1]!, {
    sarvam_app_id: null,
    sarvam_app_version: null,
  });
  jobs(db).push({
    id: OTHER_JOB,
    organization_id: OTHER,
    trigger: "customer_activate",
    status: "waiting",
    current_step: "waiting_for_agent",
    created_at: NOW.toISOString(),
    attempts: 1,
  });
  return { db, jobId: String(jobs(db)[0]!["id"]) };
}

function bridge(db: World): WorkOrderDeps {
  return {
    loadSnapshot: async () => snapshot(),
    baseUrl: "https://clickai.example",
    masterAgentAppId: "Master-agent",
    masterAgentVersion: 2,
    resume: async () => run(db),
    now: () => NOW,
  };
}
/** A real token, issued and then authenticated exactly as the HTTP route does it. */
async function session(db: World, runId: string) {
  const t = await issueBridgeToken(db.client, { createdBy: ADMIN, runId, now: NOW });
  const check = (at = NOW) => authenticateBridge(db.client, `Bearer ${t.token}`, at);
  const auth = await check();
  assert.equal(auth.ok, true);
  return { token: t, check, auth: auth as Extract<BridgeAuth, { ok: true }> };
}
const callAs = async (
  db: World,
  auth: Extract<BridgeAuth, { ok: true }>,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const out = await handleBridgeRpc(db.client, auth, bridge(db), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const r = (out as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { body: JSON.parse(r.content[0]!.text), isError: Boolean(r.isError) };
};
const report = (workOrderId: string, agentId = "Cust-agent-1") => ({
  workOrderId,
  agentId,
  clonedFrom: { agentId: "Master-agent", version: 2 },
  tools: SIX,
});
async function reported() {
  const world = await twoJobs();
  const s = await session(world.db, world.jobId);
  const r = await callAs(world.db, s.auth, "report_tools_created", report(world.jobId));
  assert.equal(r.isError, false, JSON.stringify(r.body));
  const fingerprint = (await getWorkOrder(world.db.client, world.jobId, bridge(world.db)))
    .fingerprint;
  const submit = (over: Record<string, unknown> = {}) => ({
    workOrderId: world.jobId,
    agentId: "Cust-agent-1",
    version: 3,
    fingerprint,
    toolAuth: toolEvidence(),
    ...over,
  });
  return { ...world, ...s, submit };
}
const registered = (db: World) => db.tables["agent_configs"]![0]!["sarvam_app_id"];

describe("a token is limited to one customer and one job", () => {
  test("it lists only its own work order", async () => {
    const { db, jobId } = await twoJobs();
    const { auth } = await session(db, jobId);
    const list = await callAs(db, auth, "list_agent_work_orders");
    assert.deepEqual(
      list.body.map((w: { workOrderId: string }) => w.workOrderId),
      [jobId],
    );
    assert.deepEqual([auth.organizationId, auth.runId, auth.role], [ORG, jobId, "inbound"]);
  });

  test("every operation on another customer's job is answered as if it did not exist", async () => {
    const { db, jobId } = await twoJobs();
    const { auth } = await session(db, jobId);
    const before = JSON.stringify([jobs(db)[1], db.tables["agent_configs"]![1]]);
    for (const [name, args] of [
      ["get_agent_work_order", { workOrderId: OTHER_JOB }],
      ["report_tools_created", report(OTHER_JOB, "Stolen-agent")],
      ["report_blocker", { workOrderId: OTHER_JOB, reason: "other" }],
      [
        "submit_agent_result",
        {
          workOrderId: OTHER_JOB,
          agentId: "Stolen-agent",
          version: 1,
          fingerprint: "x",
          toolAuth: toolEvidence(),
        },
      ],
    ] as const) {
      const r = await callAs(db, auth, name, args);
      assert.equal(r.body.error, "not_found", name);
    }
    assert.equal(JSON.stringify([jobs(db)[1], db.tables["agent_configs"]![1]]), before);
    assert.equal(
      (db.tables["provisioning_run_events"] ?? []).filter((e) => e["organization_id"] === OTHER)
        .length,
      0,
    );
  });

  test("another job of the SAME customer is out of reach; the old job's token dies with it", async () => {
    const { db, jobId } = await twoJobs();
    const old = await session(db, jobId);
    Object.assign(jobs(db)[0]!, { status: "failed", current_step: "failed" });
    await run(db); // a new job for the same customer
    const next = String(
      jobs(db).find(
        (j) => j["status"] === "waiting" && j["id"] !== OTHER_JOB && j["id"] !== jobId,
      )!["id"],
    );
    const denied = await callAs(db, old.auth, "get_agent_work_order", { workOrderId: next });
    assert.equal(denied.body.error, "not_found");
    assert.deepEqual(await old.check(), { ok: false, reason: "revoked" });
    const fresh = await session(db, next);
    const back = await callAs(db, fresh.auth, "get_agent_work_order", { workOrderId: jobId });
    assert.equal(back.body.error, "not_found");
  });

  test("a token can only be issued for an open work order, and only for the role it waits on", async () => {
    const { db, jobId } = await twoJobs();
    await assert.rejects(
      issueBridgeToken(db.client, { createdBy: ADMIN, runId: "no-such-job", now: NOW }),
      /No open work order/,
    );
    await assert.rejects(
      issueBridgeToken(db.client, { createdBy: ADMIN, runId: jobId, role: "outbound", now: NOW }),
      /is for the inbound agent/,
    );
    Object.assign(jobs(db)[0]!, { status: "succeeded" });
    await assert.rejects(
      issueBridgeToken(db.client, { createdBy: ADMIN, runId: jobId, now: NOW }),
      /No open work order/,
    );
  });

  test("a token whose role or scope is not exactly inbound-for-this-job is refused", async () => {
    for (const change of [
      { agent_role: "outbound" },
      { agent_role: null },
      { organization_id: null },
      { run_id: null },
      { organization_id: OTHER },
    ]) {
      const { db, jobId } = await twoJobs();
      const s = await session(db, jobId);
      Object.assign(db.tables["operator_bridge_tokens"]![0]!, change);
      assert.deepEqual(await s.check(), { ok: false, reason: "revoked" }, JSON.stringify(change));
    }
  });

  test("it ends with its job: finished, failed, inbound done, or deleted; never revived", async () => {
    for (const end of [
      { status: "succeeded" },
      { status: "failed" },
      { status: "waiting", current_step: "waiting_for_outbound_agent" },
      "deleted",
    ] as const) {
      const { db, jobId } = await twoJobs();
      const s = await session(db, jobId);
      const row = { ...jobs(db)[0]! };
      if (end === "deleted") jobs(db).shift();
      else Object.assign(jobs(db)[0]!, end);
      assert.deepEqual(await s.check(), { ok: false, reason: "revoked" }, JSON.stringify(end));
      if (end === "deleted") jobs(db).unshift(row);
      else Object.assign(jobs(db)[0]!, row);
      assert.deepEqual(await s.check(), { ok: false, reason: "revoked" }, "stays revoked");
    }
  });

  test("it survives the job running between the operator's calls", async () => {
    const { db, jobId } = await twoJobs();
    const s = await session(db, jobId);
    Object.assign(jobs(db)[0]!, { status: "running" });
    assert.equal((await s.check()).ok, true);
  });

  test("expired, or replaced by a newer token for the job: refused", async () => {
    const { db, jobId } = await twoJobs();
    const first = await session(db, jobId);
    assert.deepEqual(await first.check(new Date(NOW.getTime() + 3_600_000)), {
      ok: false,
      reason: "expired",
    });
    const second = await session(db, jobId);
    assert.deepEqual(await first.check(), { ok: false, reason: "revoked" });
    assert.equal((await second.check()).ok, true);
  });
});

describe("replay", () => {
  test("the registration uses the token up: it cannot be replayed", async () => {
    const { db, auth, check, submit } = await reported();
    const done = await callAs(db, auth, "submit_agent_result", submit());
    assert.equal(done.body.status, "registered", JSON.stringify(done.body));
    assert.deepEqual(await check(), { ok: false, reason: "revoked" });
    assert.equal(events(db, "agent_submitted").length, 1);
  });

  test("two simultaneous submissions with one token register once", async () => {
    const { db, auth, submit } = await reported();
    const out = await Promise.all([
      callAs(db, auth, "submit_agent_result", submit()),
      callAs(db, auth, "submit_agent_result", submit()),
    ]);
    assert.equal(out.filter((o) => o.body.status === "registered").length, 1);
    assert.equal(events(db, "agent_submitted").length, 1);
    assert.equal(events(db, "tool_auth_confirmed").length, 1);
  });

  test("a captured request replayed after the token was used changes nothing", async () => {
    const { db, auth, submit } = await reported();
    await callAs(db, auth, "submit_agent_result", submit());
    const before = JSON.stringify([db.tables["agent_configs"], events(db, "agent_submitted")]);
    // Even handed straight to the handler (past authentication), a different version is refused.
    const r = await callAs(db, auth, "submit_agent_result", submit({ version: 9 }));
    assert.equal(r.isError, true);
    assert.equal(
      JSON.stringify([db.tables["agent_configs"], events(db, "agent_submitted")]),
      before,
    );
  });

  test("a refused submission does not use the token up, so it can be corrected", async () => {
    const { db, auth, check, submit } = await reported();
    const stale = await callAs(db, auth, "submit_agent_result", submit({ fingerprint: "old" }));
    assert.match(stale.body.message, /outdated work order/);
    assert.equal((await check()).ok, true);
    assert.equal(registered(db), null);
    const ok = await callAs(db, auth, "submit_agent_result", submit());
    assert.equal(ok.body.status, "registered");
  });
});

describe("the submission is bound to this customer, job and role", () => {
  test("every tool in the work order sends this customer's fixed reference", async () => {
    const { db, jobId } = await twoJobs();
    const order = await getWorkOrder(db.client, jobId, bridge(db));
    assert.deepEqual(order.scope, { customerId: ORG, jobId, agentRole: "inbound" });
    assert.equal(order.agentRef, AGENT_REF);
    for (const t of order.tools) {
      const body = (t.connectorConfig as { body: Record<string, unknown>[] }).body;
      assert.deepEqual(
        body.filter((b) => b["name"] === "agent_ref"),
        [{ name: "agent_ref", type: "static", value: AGENT_REF }],
        t.name,
      );
    }
  });

  for (const [name, ref] of [
    ["another customer's reference", "inbound:agent_other"],
    ["the outbound role's reference", "outbound:agent_new"],
    ["no reference", undefined],
  ] as const)
    test(`tools carrying ${name} are refused and nothing is registered`, async () => {
      const { db, auth, check, submit } = await reported();
      const evidence = toolEvidence().map((e, i) => (i === 3 ? { ...e, agentRef: ref } : e));
      const r = await callAs(db, auth, "submit_agent_result", submit({ toolAuth: evidence }));
      assert.equal(r.body.error, "conflict");
      assert.match(r.body.message, /agent_ref.*book_appointment/s);
      assert.equal(registered(db), null);
      assert.equal((await check()).ok, true);
    });

  test("an agent another customer's job reported cannot be taken", async () => {
    const { db, jobId } = await twoJobs();
    jobs(db)[1]!["sarvam_agent_id"] = "Their-agent";
    const { auth } = await session(db, jobId);
    const r = await callAs(db, auth, "report_tools_created", report(jobId, "Their-agent"));
    assert.match(r.body.message, /another customer/);
    assert.equal(events(db, "agent_tools_created").length, 0);
  });

  test("an outbound agent cannot be reported as the inbound one", async () => {
    const { db, jobId } = await twoJobs();
    const { auth } = await session(db, jobId);
    const r = await callAs(db, auth, "report_tools_created", report(jobId, "Customer-out-1"));
    assert.match(r.body.message, /outbound agent/);
    assert.equal(events(db, "agent_tools_created").length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* The recovery sweep                                                  */
/* ------------------------------------------------------------------ */

/** The mark each crowd job would record if it ran on the data as it stands. */
const current = new WeakMap<World, Map<string, string>>();
/** `n` waiting customers; `changed(i)` says whose agent changed since their last attempt. */
async function crowd(n: number, changed: (i: number) => boolean, confirmationsEach = 0) {
  const db = world();
  db.tables["provisioning_runs"] = [];
  db.tables["provisioning_run_events"] = [];
  for (let i = 0; i < n; i++) {
    const id = String(i).padStart(5, "0");
    const org = `org_${id}`;
    db.tables["provisioning_runs"].push({
      id: `run_${id}`,
      organization_id: org,
      trigger: "customer_activate",
      status: "waiting",
      current_step: "waiting_for_agent",
    });
    db.tables["agent_configs"]!.push({
      id: `agent_${id}`,
      organization_id: org,
      sarvam_app_id: `App-${id}`,
      updated_at: "a",
    });
    for (let c = 0; c < confirmationsEach; c++)
      db.tables["provisioning_run_events"].push({
        id: `ev_${id}_${String(c).padStart(5, "0")}`,
        organization_id: org,
        event: "tool_auth_confirmed",
        created_at: `c${String(c).padStart(5, "0")}`,
      });
  }
  const rows = db.tables["provisioning_runs"]!;
  const marks = await changeMarks(
    db.client,
    rows.map((r) => String(r["organization_id"])),
  );
  current.set(db, marks);
  rows.forEach((r, i) => {
    r["diagnostics"] = { seenChange: changed(i) ? "old" : marks.get(String(r["organization_id"])) };
  });
  return db;
}
/** Sweeps whose runs "fix" the job (marker caught up), as a real attempt would. */
async function cycle(
  db: World,
  minute: number,
  behaviour: (org: string) => "ok" | "throw" | "stays" = () => "ok",
  maxRuns = 3,
) {
  const claimed: string[] = [];
  const tried: string[] = [];
  await sweepProvisioningRetries(db.client, {
    now: new Date(NOW.getTime() + minute * 60_000),
    maxRuns,
    run: async (_a, i) => {
      tried.push(i.organizationId);
      const how = behaviour(i.organizationId);
      if (how === "throw") throw new Error("this job always fails");
      claimed.push(i.organizationId);
      if (how === "ok") {
        const row = jobs(db).find((j) => j["organization_id"] === i.organizationId)!;
        row["diagnostics"] = { seenChange: current.get(db)!.get(i.organizationId) };
      }
      return { runId: "x", claimed: true, status: "waiting", result: null };
    },
  });
  return { claimed, tried };
}

describe("sweep fairness beyond any page", () => {
  test("changed jobs far past 200 (and past a 500-row page) are all processed over cycles", async () => {
    const changed = new Set([1, 250, 499, 500, 777, 1199]);
    const db = await crowd(1200, (i) => changed.has(i));
    const seen: string[] = [];
    for (let minute = 0; minute < 4; minute++) seen.push(...(await cycle(db, minute)).claimed);
    assert.deepEqual(
      seen.sort(),
      [...changed].map((i) => `org_${String(i).padStart(5, "0")}`).sort(),
    );
    assert.deepEqual((await cycle(db, 5)).claimed, [], "nothing left: no repeats");
  });

  test("more than 1,000 confirmations: markers stay exact, so no unchanged job churns", async () => {
    const db = await crowd(300, () => false, 5); // 1,500 confirmations
    assert.deepEqual((await cycle(db, 0)).tried, []);
    // The very last confirmation row changes for one customer: seen, and only that one.
    db.tables["provisioning_run_events"]!.push({
      id: "ev_zzzzz",
      organization_id: "org_00299",
      event: "tool_auth_confirmed",
      created_at: "d00000",
    });
    assert.deepEqual((await cycle(db, 1)).tried, ["org_00299"]);
  });

  test("jobs that always fail do not block the others", async () => {
    const db = await crowd(8, () => true);
    const broken = new Set(["org_00000", "org_00001", "org_00002", "org_00003"]);
    const done = new Set<string>();
    for (let minute = 0; minute < 8; minute++)
      for (const o of (await cycle(db, minute, (o) => (broken.has(o) ? "throw" : "ok"))).claimed)
        done.add(o);
    assert.deepEqual([...done].sort(), ["org_00004", "org_00005", "org_00006", "org_00007"]);
  });

  test("jobs that stay changed take turns: every one gets a run, with a stable order", async () => {
    const db = await crowd(20, () => true);
    const done = new Set<string>();
    for (let minute = 0; minute < 20; minute++)
      for (const o of (await cycle(db, minute, () => "stays", 1)).claimed) done.add(o);
    assert.equal(done.size, 20);
  });

  test("a failing tick is bounded", async () => {
    const db = await crowd(100, () => true);
    assert.equal((await cycle(db, 0, () => "throw")).tried.length, 9);
  });

  test("a flood of due retries does not hold back a changed waiting job", async () => {
    const db = await crowd(1, () => true);
    for (let i = 0; i < 50; i++)
      jobs(db).push({
        id: `due_${i}`,
        organization_id: `org_due_${i}`,
        trigger: "setup_fee",
        status: "pending",
        next_attempt_at: "2026-11-27T09:00:00.000Z",
      });
    assert.ok((await cycle(db, 0)).claimed.includes("org_00000"));
  });
});

describe("concurrent attempts", () => {
  test("two simultaneous sweeps claim a job once and create one deployment", async () => {
    const { db, auth, submit } = await reported();
    // The submission's own resume is lost, so only the sweep can continue the job.
    const d = { ...bridge(db), resume: async () => undefined };
    await handleBridgeRpc(db.client, auth, d, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "submit_agent_result", arguments: submit() },
    });
    assert.equal(num(db, "num_new")["status"], "provisioning");
    const dep = pipelineDeps(db);
    let claims = 0;
    const sweep = () =>
      sweepProvisioningRetries(db.client, {
        now: NOW,
        run: async (_a, i) => {
          const r = await runProvisioning(
            db.client,
            i,
            (x, o, h) => runProvisioningPipeline(x, o, dep.d, h.onStep),
            () => NOW,
          );
          // (The other customer's job has recorded no state yet, so it may run too.)
          if (r.claimed && i.organizationId === ORG) claims++;
          return r;
        },
      });
    await Promise.all([sweep(), sweep()]);
    assert.equal(claims, 1);
    assert.equal(dep.calls.create, 1);
    assert.equal(num(db, "num_new")["status"], "active");
    assert.equal(jobs(db).filter((j) => j["organization_id"] === ORG).length, 1);
  });

  test("a confirmation alone cannot activate another customer's number", async () => {
    const { db } = await twoJobs();
    confirmToolAuth(db, "Cust-agent-1", 3, OTHER);
    await run(db);
    assert.equal(num(db, "num_new")["status"], "provisioning");
  });
});

describe("closed customers, older versions and superseded attempts", () => {
  for (const lifecycle of ["suspended", "cancelled", "archived"])
    test(`a ${lifecycle} customer gets no token, and loses the one it had for good`, async () => {
      const { db, jobId } = await twoJobs();
      const s = await session(db, jobId);
      const org = db.tables["organizations"]![0]!;
      const before = org["lifecycle_status"];
      org["lifecycle_status"] = lifecycle;
      assert.deepEqual(await s.check(), { ok: false, reason: "revoked" });
      await assert.rejects(
        issueBridgeToken(db.client, { createdBy: ADMIN, runId: jobId, now: NOW }),
        /suspended or cancelled/,
      );
      org["lifecycle_status"] = before;
      assert.deepEqual(await s.check(), { ok: false, reason: "revoked" }, "not revived");
    });

  test("an older version never replaces a newer registered one", async () => {
    const { db, auth, check, submit } = await reported();
    Object.assign(db.tables["agent_configs"]![0]!, {
      sarvam_app_id: "Cust-agent-1",
      sarvam_app_version: 4,
    });
    const r = await callAs(db, auth, "submit_agent_result", submit({ version: 3 }));
    assert.match(r.body.message, /version 3 is older/);
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_version"], 4);
    assert.equal(events(db, "tool_auth_confirmed").length, 0);
    assert.equal((await check()).ok, true, "the token is not used up");
  });

  test("a superseded attempt stops at its next step: it never resumes or activates", async () => {
    const { db } = await twoJobs();
    Object.assign(db.tables["agent_configs"]![0]!, {
      sarvam_app_id: "Cust-agent-1",
      sarvam_app_version: 3,
    });
    Object.assign(db.tables["agent_voice_language_settings"]![0]!, {
      status: "applied",
      applied_sarvam_app_id: "Cust-agent-1",
      applied_sarvam_app_version: 3,
    });
    confirmToolAuth(db, "Cust-agent-1", 3);
    const dep = pipelineDeps(db);
    const read = dep.d.getDeployment;
    dep.d.getDeployment = async (id) => {
      // While Sarvam is answering, another worker reclaims the job.
      Object.assign(jobs(db)[0]!, {
        attempts: Number(jobs(db)[0]!["attempts"]) + 1,
        status: "running",
        current_job_step: "newer",
      });
      return read(id);
    };
    const r = await run(db, dep);
    assert.deepEqual([r.claimed, r.result], [false, null]);
    assert.equal(num(db, "num_new")["status"], "provisioning");
    assert.equal(num(db, "num_new")["verified_deployment_id"] ?? null, null);
    assert.equal(dep.calls.resume, 0);
    assert.equal(jobs(db)[0]!["current_job_step"], "newer", "the newer attempt's record is kept");
  });
});
