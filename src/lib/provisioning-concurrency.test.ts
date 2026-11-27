import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runProvisioningPipeline, type PipelineDeps } from "./provisioning-pipeline.server.ts";
import * as deployments from "./sarvam-inbound-deployment.server.ts";
import {
  defaultLiveRemapDeps,
  remapLiveAgent,
  type LiveNumber,
} from "./sarvam-live-remap.server.ts";
import {
  rotateDeploymentWebhook,
  resumeAfterFailedRotation,
  recoveryMarkerOf,
  type WebhookRotationDeps,
} from "./sarvam-webhook-rotation.server.ts";
import { applySarvamAgentMapping } from "./sarvam-agent-registration.server.ts";
import * as assignment from "./phone-number-assignment.server.ts";
import { checkInboundAdmission } from "./sarvam-inbound-admission.server.ts";
import { runProvisioning } from "./provisioning-runs.server.ts";
import { handleBridgeRpc } from "./operator-bridge-mcp.server.ts";
import {
  authenticateBridge,
  getWorkOrder,
  issueBridgeToken,
  type BridgeAuth,
  type WorkOrderDeps,
} from "./operator-bridge.server.ts";
import { CLICKAI_TOOL_NAMES } from "./sarvam-agent-tools-spec.ts";
import { getTelephonyAdapter, sarvamOutboundWebhookUrl } from "./telephony.server.ts";
import { SarvamTelephonyAdapter } from "./telephony/sarvam-provider.server.ts";
import {
  ORG,
  OTHER,
  snapshot,
  world,
  num,
  confirmToolAuth,
  toolEvidence,
} from "./provisioning-test-world.test-helper.ts";

/**
 * Concurrency, recovery and tenant isolation across EVERY path that changes a Sarvam
 * deployment or a customer's agent mapping. Real server functions and the real Sarvam
 * client against an in-memory database and a fake Sarvam: nothing is sent to a provider.
 */

type World = ReturnType<typeof world>;
const E164 = "+917900000002";
const NOW = new Date("2026-11-28T10:00:00Z");
const ENV = {
  SARVAM_API_KEY: "sk_test_key",
  SARVAM_ORG_ID: "org_1",
  SARVAM_WORKSPACE_ID: "ws_1",
  TELEPHONY_WEBHOOK_BASE_URL: "https://clickai.example",
  SARVAM_WEBHOOK_SECRET: "whsec_test_0123456789abcdef0123456789",
};

interface Dep {
  deployment_id: string;
  app_id: string;
  app_version: number;
  phone_numbers: string[];
  status: string;
  webhook_config?: { url: string } | undefined;
}

let sarvam: {
  all: Dep[];
  /** Every request that changes something: "PUT dep pause", "PATCH dep", "POST". */
  writes: string[];
  /** Edits Sarvam refused because the deployment was not paused. */
  refusedEdits: number;
  before: (request: string) => unknown;
  /** Runs after a lookup is answered but before the answer arrives: a slow reply. */
  slowReply: () => unknown;
};
let saved: Record<string, string | undefined>;
let originalFetch: typeof fetch;

beforeEach(() => {
  saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  originalFetch = globalThis.fetch;
  sarvam = {
    all: [],
    writes: [],
    refusedEdits: 0,
    before: () => undefined,
    slowReply: () => undefined,
  };
  let created = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, never>) : null;
    const rest = u.pathname.split("/deployments")[1]!.split("/").filter(Boolean);
    const id = rest[0] ? decodeURIComponent(rest[0]) : null;
    await new Promise((r) => setImmediate(r)); // a real call yields, so racers interleave
    await sarvam.before(`${method} ${rest[1] ?? (id ? "one" : "list")}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (method === "GET" && !id) {
      const q = u.searchParams.get("search") ?? "";
      const answer = json({ items: sarvam.all.filter((d) => d.phone_numbers.includes(q)) });
      await sarvam.slowReply();
      return answer;
    }
    if (method === "POST") {
      sarvam.writes.push("POST");
      const b = body as unknown as {
        app_id: string;
        app_version: number;
        connection_configs: { phone_numbers: string[] }[];
        webhook_config: { url: string };
      };
      const d: Dep = {
        deployment_id: `dep-${++created}`,
        app_id: b.app_id,
        app_version: b.app_version,
        phone_numbers: b.connection_configs[0]!.phone_numbers,
        status: "active",
        webhook_config: b.webhook_config,
      };
      sarvam.all.push(d);
      return json(d);
    }
    const d = sarvam.all.find((x) => x.deployment_id === id);
    if (!d) return json({}, 404);
    if (method === "PUT") {
      const { action } = body as unknown as { action: "pause" | "resume" };
      sarvam.writes.push(`PUT ${id} ${action}`);
      d.status = action === "pause" ? "paused" : "active";
      return json(d);
    }
    if (method === "PATCH") {
      sarvam.writes.push(`PATCH ${id}`);
      if (d.status !== "paused") {
        sarvam.refusedEdits++;
        return json({ detail: "Only paused deployments can be edited" }, 422);
      }
      const b = body as unknown as { app_version?: number; webhook_config?: { url: string } };
      if (b.app_version) d.app_version = b.app_version;
      if (b.webhook_config) d.webhook_config = b.webhook_config;
      return json(d);
    }
    return json(d);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const adapter = () => getTelephonyAdapter("sarvam") as SarvamTelephonyAdapter;
const number = (db: World) => num(db, "num_new");
const agent = (db: World) => db.tables["agent_configs"]![0]!;
const hosted = (id = "dep-live") => sarvam.all.find((d) => d.deployment_id === id)!;
const goodWebhook = () => {
  const w = sarvamOutboundWebhookUrl();
  assert.ok(w.ok);
  return { url: w.url };
};

/** A customer whose number has a deployment recorded and hosted at Sarvam. */
function customer(
  state: "live" | "inbound_off" | "suspended" | "not_live",
  hostedOver: Partial<Dep> = {},
) {
  const db = world({ outbound: false });
  Object.assign(number(db), {
    status: state === "not_live" ? "provisioning" : state === "suspended" ? "suspended" : "active",
    inbound_enabled: state === "live",
    connection_id: "conn_new",
    agent_config_id: "agent_new",
    provider_deployment_id: "dep-live",
    verified_deployment_id: state === "not_live" ? null : "dep-live",
    verified_sarvam_app_id: state === "not_live" ? null : "Customer-app-1",
    verified_sarvam_app_version: state === "not_live" ? null : 1,
  });
  sarvam.all.push({
    deployment_id: "dep-live",
    app_id: "Customer-app-1",
    app_version: 1,
    phone_numbers: [E164],
    status: "active",
    webhook_config: goodWebhook(),
    ...hostedOver,
  });
  return db;
}
const mapVersion = (db: World, version: number) => {
  agent(db)["sarvam_app_version"] = version;
  db.tables["agent_voice_language_settings"]![0]!["applied_sarvam_app_version"] = version;
};
const pipeline = (db: World, organizationId = ORG) => {
  const d: PipelineDeps = {
    loadSnapshot: async () => snapshot(),
    createDeployment: deployments.createInboundDeploymentForNumbers,
    getDeployment: async (id) => adapter().getDeployment(id),
    setDeploymentStatus: async (id, action) => adapter().setDeploymentStatus(id, action),
    syncDeployments: deployments.syncAgentDeployments,
    masterAgentAppId: "Master-agent",
    now: () => NOW,
  };
  return runProvisioningPipeline(db.client, organizationId, d);
};
/** What the admin "Pause" button does (the shared function once there is one). */
async function operatorPause(db: World) {
  const shared = (
    deployments as unknown as {
      setCustomerDeploymentStatus?: (
        a: unknown,
        p: { organizationId: string; deploymentId: string; action: "pause" },
      ) => Promise<unknown>;
    }
  ).setCustomerDeploymentStatus;
  const act = shared
    ? () => shared(db.client, { organizationId: ORG, deploymentId: "dep-live", action: "pause" })
    : () => adapter().setDeploymentStatus("dep-live", "pause");
  return act().then(
    () => "paused" as const,
    (e: Error) => e.message,
  );
}
/** Runs the operator's pause while `request` is in flight; a pause that "worked" must stick. */
async function pauseDuring(db: World, request: string, work: () => Promise<unknown>) {
  let outcome: string | null = null;
  sarvam.before = async (r) => {
    if (r !== request || outcome !== null) return;
    outcome = "starting";
    outcome = await operatorPause(db);
  };
  await work().catch(() => undefined);
  assert.ok(outcome, "the operator acted while the work was in flight");
  if (outcome === "paused") assert.equal(hosted().status, "paused", "the pause was undone");
  else assert.match(outcome, /another change/i);
}
const rotationDeps = (): WebhookRotationDeps => ({
  getDeployment: async (id) => adapter().getDeployment(id),
  setDeploymentStatus: async (id, action) => adapter().setDeploymentStatus(id, action),
  updateWebhook: async (id, webhook) =>
    adapter().updateInboundDeployment(id, { webhookConfig: webhook }),
  webhookUrl: () => sarvamOutboundWebhookUrl(),
});

describe("1. conflicting changes to one deployment are serialized", () => {
  test("a pause pressed during a version sync is not undone", async () => {
    const db = customer("not_live");
    mapVersion(db, 2);
    await pauseDuring(db, "PATCH one", () =>
      deployments.syncAgentDeployments(db.client, "agent_new"),
    );
  });

  test("a pause pressed while a number is being activated is not undone", async () => {
    const db = customer("not_live");
    await pauseDuring(db, "PUT status", () => pipeline(db));
  });

  test("a pause pressed during a webhook update is not undone", async () => {
    const db = customer("live", { webhook_config: { url: "https://clickai.example/old" } });
    await pauseDuring(db, "PATCH one", () =>
      rotateDeploymentWebhook(
        db.client,
        { organizationId: ORG, confirmPause: true },
        rotationDeps(),
      ),
    );
  });

  test("two syncs at once never edit an active deployment", async () => {
    const db = customer("not_live");
    mapVersion(db, 2);
    await Promise.allSettled([
      deployments.syncAgentDeployments(db.client, "agent_new"),
      deployments.syncAgentDeployments(db.client, "agent_new"),
    ]);
    assert.equal(sarvam.refusedEdits, 0);
    assert.deepEqual([hosted().app_version, hosted().status], [2, "active"]);
  });
});

describe("2. a live or switched-off number's agent changes only through verification", () => {
  for (const state of ["live", "inbound_off", "suspended"] as const) {
    test(`${state}: a sync never moves the deployment to an unverified version`, async () => {
      const db = customer(state);
      mapVersion(db, 2); // e.g. a template mapping copied the new version onto the agent
      await deployments.syncAgentDeployments(db.client, "agent_new");
      assert.deepEqual(sarvam.writes, []);
      assert.equal(hosted().app_version, 1);
    });

    test(`${state}: the mapping cannot be changed directly`, async () => {
      const db = customer(state);
      await assert.rejects(
        applySarvamAgentMapping(db.client, {
          agentConfigId: "agent_new",
          sarvamAppId: "Customer-app-1",
          sarvamAppVersion: 2,
          masterAgentAppId: "Master-agent",
        }),
        /Re-verify|switch|live/i,
      );
      assert.equal(agent(db)["sarvam_app_version"], 1);
    });
  }

  test("the verify-first move of a live number still works", async () => {
    const db = customer("live");
    const live: LiveNumber = {
      id: "num_new",
      e164: E164,
      organizationId: ORG,
      deploymentId: "dep-live",
    };
    const result = await remapLiveAgent(
      db.client,
      {
        organizationId: ORG,
        agentConfigId: "agent_new",
        number: live,
        appId: "Customer-app-1",
        appVersion: 2,
      },
      {
        getDeployment: async (id) => adapter().getDeployment(id),
        setDeploymentAppVersion: (id, v) => deployments.setDeploymentAppVersion(adapter(), id, v),
        setDeploymentStatus: (id, action) => adapter().setDeploymentStatus(id, action),
        masterAgentAppId: "Master-agent",
        now: () => NOW,
      },
    );
    assert.equal(result.outcome, "verified", result.detail);
    assert.deepEqual([agent(db)["sarvam_app_version"], hosted().app_version], [2, 2]);
    assert.equal((await admission(db)).admitted, true);
  });

  const admission = (db: World) =>
    checkInboundAdmission(db.client, { organizationId: ORG, agentConfigId: "agent_new" });

  test("the operator bridge cannot move a live customer off its verified version", async () => {
    const db = customer("live");
    const ADMIN = "00000000-0000-0000-0000-0000000000bb";
    db.tables["platform_admins"] = [{ user_id: ADMIN, role: "admin", is_active: true }];
    // The credential was replaced, so a person's retry parks the job at the agent step.
    db.tables["sarvam_agent_integrations"]![0]!["status"] = "disabled";
    const retry = () =>
      runProvisioning(
        db.client,
        { organizationId: ORG, trigger: "admin_retry", force: true },
        (_a, o) => pipeline(db, o),
        () => NOW,
      );
    await retry();
    const job = db.tables["provisioning_runs"]![0]!;
    assert.equal(job["current_step"], "waiting_for_integration_credential");
    assert.equal((await admission(db)).admitted, true, "answering before the bridge acts");
    const bridge: WorkOrderDeps = {
      loadSnapshot: async () => snapshot(),
      baseUrl: "https://clickai.example",
      masterAgentAppId: "Master-agent",
      masterAgentVersion: 2,
      resume: retry,
      now: () => NOW,
    };
    const token = await issueBridgeToken(db.client, {
      createdBy: ADMIN,
      runId: String(job["id"]),
      now: NOW,
    });
    const auth = (await authenticateBridge(db.client, `Bearer ${token.token}`, NOW)) as Extract<
      BridgeAuth,
      { ok: true }
    >;
    const call = (name: string, args: Record<string, unknown>) =>
      handleBridgeRpc(db.client, auth, bridge, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      });
    await call("report_tools_created", {
      workOrderId: job["id"],
      agentId: "Customer-app-1",
      clonedFrom: { agentId: "Master-agent", version: 2 },
      tools: [...CLICKAI_TOOL_NAMES],
    });
    const order = await getWorkOrder(db.client, String(job["id"]), bridge);
    await call("submit_agent_result", {
      workOrderId: job["id"],
      agentId: "Customer-app-1",
      version: 2,
      fingerprint: order.fingerprint,
      toolAuth: toolEvidence(),
    });
    assert.equal(agent(db)["sarvam_app_version"], 1);
    assert.deepEqual(await admission(db).then((a) => a.admitted), true);
  });

  test("a live version move cut off after Sarvam accepted it is completed by running it again", async () => {
    const db = customer("live", { app_version: 2 }); // Sarvam moved; ClickAI never saved it
    const result = await remapLiveAgent(
      db.client,
      {
        organizationId: ORG,
        agentConfigId: "agent_new",
        number: { id: "num_new", e164: E164, organizationId: ORG, deploymentId: "dep-live" },
        appId: "Customer-app-1",
        appVersion: 2,
      },
      {
        getDeployment: async (id) => adapter().getDeployment(id),
        setDeploymentAppVersion: (id, v) => deployments.setDeploymentAppVersion(adapter(), id, v),
        setDeploymentStatus: (id, action) => adapter().setDeploymentStatus(id, action),
        masterAgentAppId: "Master-agent",
        now: () => NOW,
      },
    );
    assert.equal(result.outcome, "verified", result.detail);
    assert.deepEqual(sarvam.writes, [], "nothing left to change at Sarvam");
    assert.equal(number(db)["verified_sarvam_app_version"], 2);
  });
});

describe("2b. a retry never writes verification from before a concurrent version move", () => {
  const move = (db: World) =>
    remapLiveAgent(
      db.client,
      {
        organizationId: ORG,
        agentConfigId: "agent_new",
        number: { id: "num_new", e164: E164, organizationId: ORG, deploymentId: "dep-live" },
        appId: "Customer-app-1",
        appVersion: 2,
      },
      {
        getDeployment: async (id) => adapter().getDeployment(id),
        setDeploymentAppVersion: (id, v) => deployments.setDeploymentAppVersion(adapter(), id, v),
        setDeploymentStatus: (id, action) => adapter().setDeploymentStatus(id, action),
        masterAgentAppId: "Master-agent",
        now: () => NOW,
      },
    );
  /** Both are done: a verified move is still verified, and the line still answers. */
  const consistent = async (db: World) => {
    const mapped = agent(db)["sarvam_app_version"];
    assert.equal(hosted().app_version, mapped);
    assert.equal(number(db)["verified_sarvam_app_version"], mapped);
    const result = await checkInboundAdmission(db.client, {
      organizationId: ORG,
      agentConfigId: "agent_new",
    });
    assert.equal(result.admitted, true, JSON.stringify(result));
  };

  test("the move happens while the retry waits for Sarvam's answer", async () => {
    const db = customer("live");
    let moved: unknown = null;
    // The reply to the retry's read is held back while the version move is attempted.
    let first = true;
    const run = runProvisioningPipeline(db.client, ORG, {
      loadSnapshot: async () => snapshot(),
      createDeployment: deployments.createInboundDeploymentForNumbers,
      getDeployment: async (id) => {
        const answer = await adapter().getDeployment(id);
        if (first) {
          first = false;
          moved = await move(db).then(
            (r) => r.outcome,
            (e: Error) => e.message,
          );
        }
        return answer;
      },
      setDeploymentStatus: async (id, action) => adapter().setDeploymentStatus(id, action),
      syncDeployments: deployments.syncAgentDeployments,
      masterAgentAppId: "Master-agent",
      now: () => NOW,
    });
    await run;
    assert.ok(moved);
    await consistent(db);
  });

  test("the move happens before the retry reaches Sarvam", async () => {
    const db = customer("live");
    await runProvisioningPipeline(db.client, ORG, {
      loadSnapshot: async () => {
        await move(db); // after the retry read the agent, before it reads the deployment
        return snapshot();
      },
      createDeployment: deployments.createInboundDeploymentForNumbers,
      getDeployment: async (id) => adapter().getDeployment(id),
      setDeploymentStatus: async (id, action) => adapter().setDeploymentStatus(id, action),
      syncDeployments: deployments.syncAgentDeployments,
      masterAgentAppId: "Master-agent",
      now: () => NOW,
    });
    await consistent(db);
  });
});

describe("2c. a mapping cannot change underneath an activation", () => {
  test("a version registered while the number is going live never leaves it live and unverified", async () => {
    const db = customer("not_live");
    let registered: string | null = null;
    sarvam.before = async (r) => {
      if (r !== "PUT status" || registered !== null || hosted().status !== "paused") return;
      registered = "starting";
      registered = await applySarvamAgentMapping(db.client, {
        agentConfigId: "agent_new",
        sarvamAppId: "Customer-app-1",
        sarvamAppVersion: 2,
        masterAgentAppId: "Master-agent",
      }).then(
        () => "changed",
        (e: Error) => e.message,
      );
    };
    await pipeline(db);
    assert.ok(registered, "the registration happened while activation was in flight");
    if (number(db)["status"] === "active")
      assert.equal(number(db)["verified_sarvam_app_version"], agent(db)["sarvam_app_version"]);
  });
});

describe("3. resuming after a webhook update respects a switched-off number", () => {
  for (const state of ["inbound_off", "suspended"] as const)
    test(`${state}: the deployment is not resumed`, async () => {
      const db = customer(state, { status: "paused" });
      number(db)["metadata"] = {
        sarvam_webhook_recovery: {
          deploymentId: "dep-live",
          originalStatus: "active",
          appId: "Customer-app-1",
          appVersion: 1,
          state: "recovery_required",
          recordedAt: NOW.toISOString(),
        },
      };
      await resumeAfterFailedRotation(db.client, { organizationId: ORG }, rotationDeps());
      assert.equal(hosted().status, "paused");
      assert.deepEqual(sarvam.writes, []);
    });
});

describe("4. recovery adopts only an unambiguous deployment of this number", () => {
  const ready = () => {
    const db = world({ outbound: false });
    Object.assign(number(db), { connection_id: "conn_new", agent_config_id: "agent_new" });
    return db;
  };
  const found = (id: string, over: Partial<Dep> = {}) =>
    sarvam.all.push({
      deployment_id: id,
      app_id: "Customer-app-1",
      app_version: 1,
      phone_numbers: [E164],
      status: "active",
      ...over,
    });
  const create = (db: World) =>
    deployments.createInboundDeploymentForNumbers(db.client, {
      phoneNumberIds: ["num_new"],
      name: "x",
    });

  test("exactly one deployment of this agent for exactly this number is adopted", async () => {
    const db = ready();
    found("dep-a");
    assert.equal((await create(db)).outcome, "adopted");
    assert.deepEqual(sarvam.writes, []);
  });

  test("two deployments routing the number: neither is picked", async () => {
    const db = ready();
    found("dep-a");
    found("dep-b", { status: "paused" });
    await assert.rejects(create(db), /already routes/);
    assert.equal(number(db)["provider_deployment_id"], null);
    assert.deepEqual(sarvam.writes, []);
  });

  test("a deployment that also routes someone else's number is not adopted", async () => {
    const db = ready();
    found("dep-a", { phone_numbers: [E164, "+917900000001"] });
    await assert.rejects(create(db), /already routes/);
    assert.equal(number(db)["provider_deployment_id"], null);
  });

  for (const [what, over] of [
    ["another agent", { app_id: "Other-app" }],
    ["another number only", { phone_numbers: ["+917900000001"] }],
  ] as const)
    test(`a recorded deployment of ${what} is never paused or resumed`, async () => {
      const db = customer("not_live", over as Partial<Dep>);
      const result = await pipeline(db);
      assert.deepEqual(sarvam.writes, []);
      assert.equal(result.state, "verification_failed", result.note);
      assert.equal(number(db)["status"], "provisioning");
    });
});

describe("5. no other entry point activates a number", () => {
  test("the legacy payment orchestrator does not activate without verification", async () => {
    const legacy = (
      (await import("./provisioning-orchestrator.server.ts")) as unknown as {
        provisionOrganizationAfterPayment?: (a: unknown, o: string) => Promise<unknown>;
      }
    ).provisionOrganizationAfterPayment;
    if (!legacy) return; // removed
    const db = world({ outbound: false, toolAuth: false });
    Object.assign(number(db), { connection_id: "conn_new", agent_config_id: "agent_new" });
    await legacy(db.client, ORG);
    assert.notEqual(number(db)["status"], "active");
  });
});

describe("6. a holder whose lock lapsed cannot act or overwrite", () => {
  const ready = () => {
    const db = world({ outbound: false });
    Object.assign(number(db), { connection_id: "conn_new", agent_config_id: "agent_new" });
    return db;
  };
  const lapse = (db: World) => {
    const meta = number(db)["metadata"] as { deployment_lock: { until: string } };
    meta.deployment_lock.until = new Date(Date.now() - 1000).toISOString();
  };
  const create = (db: World) =>
    deployments.createInboundDeploymentForNumbers(db.client, {
      phoneNumberIds: ["num_new"],
      name: "x",
    });
  /** A second creator takes over while the first is stuck in `request`. */
  async function overtaken(stalledIn: "lookup" | "creation") {
    const db = ready();
    let second: unknown = null;
    const takeOver = async () => {
      if (second) return;
      second = "running";
      lapse(db);
      second = await create(db);
    };
    if (stalledIn === "lookup") sarvam.slowReply = takeOver;
    else
      sarvam.before = async (r) => {
        if (r === "POST list") await takeOver();
      };
    const first = await create(db).then(
      (r) => r,
      (e: Error) => e,
    );
    return { db, first, second: second as { deploymentId: string } };
  }

  test("stalled while looking Sarvam up: it creates nothing afterwards", async () => {
    const { db, second } = await overtaken("lookup");
    assert.equal(sarvam.all.length, 1);
    assert.equal(number(db)["provider_deployment_id"], second.deploymentId);
  });

  test("stalled while creating: it does not overwrite the newer holder's record", async () => {
    const { db, first, second } = await overtaken("creation");
    assert.equal(number(db)["provider_deployment_id"], second.deploymentId);
    assert.ok(first instanceof Error, "the stale holder is told");
  });
});

describe("7. a number moved to another customer takes nothing with it", () => {
  const ORG3 = "org_third";
  async function moved() {
    const db = customer("live");
    Object.assign(number(db), {
      sarvam_number_confirmed_at: "2026-11-14T09:00:00Z",
      deployment_verified_at: "2026-11-14T09:00:00Z",
    });
    db.tables["organizations"]!.push({ id: ORG3, lifecycle_status: "setup_paid" });
    db.tables["agent_configs"]!.push({
      id: "agent_third",
      organization_id: ORG3,
      business_id: "biz_third",
      sarvam_app_id: "Third-app",
      sarvam_app_version: 1,
    });
    db.tables["telephony_connections"]!.push({
      id: "conn_third",
      organization_id: ORG3,
      provider: "sarvam",
      provider_connection_id: "conn-shared",
    });
    db.tables["sarvam_agent_integrations"]!.push({
      id: "int_third",
      organization_id: ORG3,
      agent_config_id: "agent_third",
      status: "active",
      role: "inbound",
      expires_at: null,
    });
    db.tables["agent_voice_language_settings"]!.push({
      ...db.tables["agent_voice_language_settings"]![0]!,
      id: "vl_third",
      organization_id: ORG3,
      agent_config_id: "agent_third",
      applied_sarvam_app_id: "Third-app",
    });
    confirmToolAuth(db, "Third-app", 1, ORG3);
    await assignment.assignNumberToOrganization(db.client, { numberId: "num_new", toOrgId: ORG3 });
    return db;
  }

  test("the old customer's deployment, verification and confirmation are dropped", async () => {
    const db = await moved();
    for (const field of [
      "provider_deployment_id",
      "verified_deployment_id",
      "verified_sarvam_app_id",
      "verified_sarvam_app_version",
      "deployment_verified_at",
      "sarvam_number_confirmed_at",
    ])
      assert.equal(number(db)[field] ?? null, null, field);
  });

  test("the new customer's provisioning never touches the old customer's deployment", async () => {
    const db = await moved();
    number(db)["sarvam_number_confirmed_at"] = "2026-11-28T09:00:00Z"; // confirmed again
    await pipeline(db, ORG3);
    assert.deepEqual(sarvam.writes, []);
    assert.deepEqual([hosted().status, hosted().app_id], ["active", "Customer-app-1"]);
    assert.notEqual(number(db)["status"], "active");
  });

  test("one customer's agent cannot be remapped in another's name", async () => {
    const db = customer("not_live");
    await assert.rejects(
      applySarvamAgentMapping(db.client, {
        agentConfigId: "agent_new",
        organizationId: OTHER,
        sarvamAppId: "Customer-app-1",
        sarvamAppVersion: 2,
        masterAgentAppId: "Master-agent",
      }),
      /does not belong/,
    );
    assert.equal(agent(db)["sarvam_app_version"], 1);
  });
});

describe("6. defects reproduced by the final safety audit", () => {
  const marker = (db: World) => recoveryMarkerOf(number(db)["metadata"]);
  const sync = async (db: World) =>
    (await deployments.syncAgentDeployments(db.client, "agent_new")).items[0]!;
  const move = async (db: World, appVersion: number) =>
    remapLiveAgent(
      db.client,
      {
        organizationId: ORG,
        agentConfigId: "agent_new",
        number: { id: "num_new", e164: E164, organizationId: ORG, deploymentId: "dep-live" },
        appId: "Customer-app-1",
        appVersion,
      },
      await defaultLiveRemapDeps(),
    );
  const admitted = async (db: World) =>
    (await checkInboundAdmission(db.client, { organizationId: ORG, agentConfigId: "agent_new" }))
      .admitted;
  const recover = (db: World) =>
    resumeAfterFailedRotation(db.client, { organizationId: ORG }, rotationDeps());
  const byAdmin = (db: World, action: "pause" | "resume") =>
    deployments.setCustomerDeploymentStatus(db.client, {
      organizationId: ORG,
      deploymentId: "dep-live",
      action,
    });
  /** A "PUT status" for a paused deployment is the resume. */
  const isResume = (request: string) => request === "PUT status" && hosted().status === "paused";
  const failResume = (times: number) => {
    let failed = 0;
    sarvam.before = (r) => {
      if (isResume(r) && failed < times) {
        failed++;
        throw new Error("network down");
      }
    };
  };
  const healthy = () => {
    sarvam.before = () => undefined;
  };
  /**
   * What stays on record (ClickAI and Sarvam) if the process dies as it is about to send
   * `at`: the work runs on, then everything is rewound to that moment, five minutes later
   * (the dead holder's lock has lapsed).
   */
  async function crashAt(db: World, at: (r: string) => boolean, work: () => Promise<unknown>) {
    let kept: { tables: World["tables"]; all: Dep[] } | null = null;
    sarvam.before = (r) => {
      if (!kept && at(r))
        kept = { tables: structuredClone(db.tables), all: structuredClone(sarvam.all) };
    };
    await work().catch(() => undefined);
    assert.ok(kept, "the crash point was reached");
    const { tables, all } = kept as { tables: World["tables"]; all: Dep[] };
    for (const [name, rows] of Object.entries(tables))
      db.tables[name]!.splice(0, db.tables[name]!.length, ...rows);
    sarvam.all = all;
    sarvam.writes.length = 0;
    delete (number(db)["metadata"] as Record<string, unknown> | undefined)?.["deployment_lock"];
    healthy();
  }

  describe("C1 a reassignment during creation records nothing for the new customer", () => {
    const reassign = (db: World) =>
      assignment.assignNumberToOrganization(db.client, { numberId: "num_new", toOrgId: OTHER });
    const create = (db: World) =>
      deployments.createInboundDeploymentForNumbers(db.client, {
        phoneNumberIds: ["num_new"],
        name: "x",
      });
    const fresh = () => {
      const db = customer("not_live");
      sarvam.all = [];
      Object.assign(number(db), { provider_deployment_id: null });
      return db;
    };
    const reassignDuringCreate = (db: World) => {
      let moved = false;
      sarvam.before = async (r) => {
        if (r !== "POST list" || moved) return;
        moved = true;
        await reassign(db);
      };
    };

    test("while Sarvam is creating the deployment", async () => {
      const db = fresh();
      reassignDuringCreate(db);
      await assert.rejects(create(db), /was not recorded/);
      assert.equal(number(db)["organization_id"], OTHER);
      assert.equal(number(db)["provider_deployment_id"] ?? null, null);
      await assert.rejects(
        deployments.setCustomerDeploymentStatus(db.client, {
          organizationId: OTHER,
          deploymentId: "dep-1",
          action: "pause",
        }),
        /does not belong/,
      );
    });

    test("while an existing deployment is being adopted", async () => {
      const db = fresh();
      sarvam.all.push({
        deployment_id: "dep-lost",
        app_id: "Customer-app-1",
        app_version: 1,
        phone_numbers: [E164],
        status: "active",
      });
      // The reassignment commits after the last ownership check, just before the write.
      const client = db.client as unknown as { from: (table: string) => unknown };
      const from = client.from.bind(client);
      let moved = false;
      client.from = (table: string) => {
        const query = from(table) as {
          update: (p: Record<string, unknown>) => unknown;
        };
        const update = query.update.bind(query);
        query.update = (payload) => {
          if ("provider_deployment_id" in payload && !moved) {
            moved = true;
            Object.assign(number(db), { organization_id: OTHER });
          }
          return update(payload);
        };
        return query;
      };
      await assert.rejects(create(db), /was not recorded/);
      assert.ok(moved);
      assert.equal(number(db)["provider_deployment_id"] ?? null, null);
    });

    test("a retry for the new customer never takes over the old customer's deployment", async () => {
      const db = fresh();
      reassignDuringCreate(db);
      await create(db).catch(() => undefined);
      healthy();
      await create(db).catch(() => undefined);
      assert.notEqual(number(db)["provider_deployment_id"], "dep-1");
    });
  });

  describe("C2 a failed resume during a live version move", () => {
    test("once: the line is put back, answering, with its verification", async () => {
      const db = customer("live");
      failResume(1);
      const result = await move(db, 2);
      assert.equal(result.outcome, "rolled_back", result.detail);
      assert.deepEqual([hosted().status, hosted().app_version], ["active", 1]);
      assert.equal(number(db)["verified_sarvam_app_version"], 1);
      assert.equal(await admitted(db), true);
      assert.equal(marker(db), null);
    });

    test("every time: recovery is on record, verification kept, nothing called verified", async () => {
      const db = customer("live");
      failResume(Infinity);
      const result = await move(db, 2);
      assert.equal(result.outcome, "recovery_required", result.detail);
      assert.deepEqual([hosted().status, hosted().app_version], ["paused", 1]);
      assert.equal(number(db)["verified_sarvam_app_version"], 1);
      assert.equal(agent(db)["sarvam_app_version"], 1);
      assert.equal(marker(db)?.state, "recovery_required");
      // Repeated attempts while Sarvam is still failing change nothing for the worse.
      for (const version of [2, 1, 2]) {
        assert.equal((await move(db, version)).outcome, "recovery_required");
        assert.deepEqual([hosted().status, hosted().app_version], ["paused", 1]);
        assert.equal(number(db)["verified_sarvam_app_version"], 1);
        assert.ok(marker(db));
      }
      healthy();
      const retried = await move(db, 2);
      assert.equal(retried.outcome, "verified", retried.detail);
      assert.deepEqual([hosted().status, hosted().app_version], ["active", 2]);
      assert.equal(marker(db), null);
      assert.equal(await admitted(db), true);
    });

    test("recorded recovery can be run with Resume deployment", async () => {
      const db = customer("live");
      failResume(Infinity);
      await move(db, 2);
      healthy();
      assert.equal((await recover(db)).outcome, "resumed");
      assert.equal(hosted().status, "active");
      assert.equal(marker(db), null);
    });

    const crashPoints = [
      ["after the pause, before the edit", (r: string) => r === "PATCH one"],
      ["after the edit, before the resume", isResume],
    ] as const;
    for (const [point, at] of crashPoints)
      for (const retry of [1, 2])
        test(`crash ${point}: asking for v${retry} again converges`, async () => {
          const db = customer("live");
          await crashAt(db, at, () => move(db, 2));
          assert.equal(hosted().status, "paused");
          const result = await move(db, retry);
          assert.equal(result.outcome, "verified", result.detail);
          assert.deepEqual([hosted().status, hosted().app_version], ["active", retry]);
          assert.equal(number(db)["verified_sarvam_app_version"], retry);
          assert.equal(marker(db), null);
          assert.equal(await admitted(db), true);
        });

    test("crash after the edit, and Sarvam refusing to undo it: blocked, on record, then converges", async () => {
      const db = customer("live");
      await crashAt(db, isResume, () => move(db, 2));
      sarvam.before = (r) => {
        if (r === "PATCH one") throw new Error("network down");
      };
      const result = await move(db, 1);
      assert.equal(result.outcome, "blocked", result.detail);
      assert.deepEqual([hosted().status, hosted().app_version], ["paused", 2]);
      assert.equal(await admitted(db), false, "an unverified version is never served");
      assert.ok(marker(db));
      healthy();
      assert.equal((await move(db, 1)).outcome, "verified");
      assert.deepEqual([hosted().status, hosted().app_version], ["active", 1]);
      assert.equal(await admitted(db), true);
    });

    test("crash after the edit: Resume deployment never resumes the unverified version", async () => {
      const db = customer("live");
      await crashAt(db, isResume, () => move(db, 2));
      const result = await recover(db);
      assert.equal(result.outcome, "refused");
      assert.match(result.detail, /Re-verify/);
      assert.equal(hosted().status, "paused");
      assert.deepEqual(sarvam.writes, []);
    });

    test("a number switched off during the move is not resumed behind the person's back", async () => {
      const db = customer("live");
      let failed = false;
      sarvam.before = (r) => {
        if (!isResume(r) || failed) return;
        failed = true;
        number(db)["inbound_enabled"] = false;
        throw new Error("network down");
      };
      const result = await move(db, 2);
      assert.equal(result.outcome, "recovery_required", result.detail);
      assert.equal(hosted().status, "paused");
    });

    test("a person's pause settles the recovery: a later move does not resume it", async () => {
      const db = customer("live");
      await crashAt(
        db,
        (r) => r === "PATCH one",
        () => move(db, 2),
      );
      await byAdmin(db, "pause");
      sarvam.writes.length = 0;
      assert.equal(marker(db), null);
      await move(db, 2);
      assert.equal(hosted().status, "paused");
      assert.deepEqual(sarvam.writes, []);
    });

    test("if the recovery cannot be recorded, nothing is paused", async () => {
      const db = customer("live");
      sarvam.before = (r) => {
        if (r === "GET one") db.failNext("phone_numbers", "update", { message: "db down" });
      };
      const result = await move(db, 2);
      assert.equal(result.outcome, "rolled_back", result.detail);
      assert.deepEqual(sarvam.writes, []);
      assert.equal(number(db)["verified_sarvam_app_version"], 1);
    });
  });

  describe("C3 a failed resume during a sync", () => {
    const drifted = () => customer("live", { webhook_config: undefined });

    test("is on record, and no later sync says in_sync until the line is back", async () => {
      const db = drifted();
      failResume(Infinity);
      const first = await sync(db);
      assert.equal(first.action, "error");
      assert.match(first.detail!, /Resume deployment/);
      assert.equal(marker(db)?.state, "recovery_required");
      healthy();
      sarvam.writes.length = 0;
      for (let i = 0; i < 3; i++) {
        const again = await sync(db);
        assert.equal(again.action, "error");
        assert.match(again.detail!, /Resume deployment/);
      }
      assert.deepEqual(sarvam.writes, [], "a retry changes nothing by itself");
      assert.equal(number(db)["verified_sarvam_app_version"], 1);
      const rotation = await rotateDeploymentWebhook(
        db.client,
        { organizationId: ORG, confirmPause: true },
        rotationDeps(),
      );
      assert.equal(rotation.outcome, "recovery_required");
      assert.equal((await recover(db)).outcome, "resumed");
      assert.equal((await sync(db)).action, "in_sync");
      assert.deepEqual([hosted().status, marker(db)], ["active", null]);
    });

    const crashPoints = [
      ["after the pause", (r: string) => r === "PATCH one"],
      ["before the resume", isResume],
    ] as const;
    for (const [point, at] of crashPoints)
      test(`crash ${point}: not in_sync, and recoverable`, async () => {
        const db = drifted();
        await crashAt(db, at, () => sync(db));
        assert.equal((await sync(db)).action, "error");
        assert.equal(hosted().status, "paused");
        assert.equal((await recover(db)).outcome, "resumed");
        const after = await sync(db);
        assert.notEqual(after.action, "error", after.detail);
        assert.equal(hosted().status, "active");
        assert.equal((await sync(db)).action, "in_sync");
      });

    test("crash after a version correction: recoverable on the verified version", async () => {
      const db = customer("live");
      mapVersion(db, 2);
      number(db)["verified_sarvam_app_version"] = 2;
      await crashAt(db, isResume, () => sync(db));
      assert.equal((await recover(db)).outcome, "resumed");
      assert.deepEqual([hosted().status, hosted().app_version], ["active", 2]);
    });

    for (const [point, at] of crashPoints)
      test(`a sync of a number not yet live that died ${point}: provisioning finishes it`, async () => {
        const db = customer("not_live");
        mapVersion(db, 2);
        confirmToolAuth(db, "Customer-app-1", 2, ORG);
        await crashAt(db, at, () => sync(db));
        assert.ok(marker(db));
        await pipeline(db);
        assert.deepEqual(
          [number(db)["status"], hosted().status, hosted().app_version, marker(db)],
          ["active", "active", 2, null],
        );
      });

    test("someone resumed it in Sarvam: the next sync confirms that and clears the record", async () => {
      const db = drifted();
      failResume(Infinity);
      await sync(db);
      healthy();
      hosted().status = "active";
      assert.notEqual((await sync(db)).action, "error");
      assert.equal(marker(db), null);
    });

    test("a live number paused at Sarvam is never reported in_sync", async () => {
      const db = customer("live", { status: "paused" });
      const item = await sync(db);
      assert.equal(item.action, "error");
      assert.match(item.detail!, /paused/);
      assert.deepEqual(sarvam.writes, []);
    });

    test("a live paused deployment that is edited is not reported as done", async () => {
      const db = customer("live", { status: "paused", webhook_config: undefined });
      const item = await sync(db);
      assert.equal(item.action, "error");
      assert.match(item.detail!, /paused/);
      assert.equal(hosted().status, "paused");
    });

    test("a paused deployment of a number that is not live is still in_sync", async () => {
      const db = customer("not_live", { status: "paused" });
      assert.equal((await sync(db)).action, "in_sync");
    });

    test("an admin's pause settles the record; only their resume brings it back", async () => {
      const db = drifted();
      failResume(Infinity);
      await sync(db);
      healthy();
      await byAdmin(db, "pause");
      assert.equal(marker(db), null);
      assert.equal((await sync(db)).action, "error");
      assert.equal(hosted().status, "paused");
      await byAdmin(db, "resume");
      assert.equal((await sync(db)).action, "in_sync");
    });

    test("an admin's resume clears the record", async () => {
      const db = drifted();
      failResume(Infinity);
      await sync(db);
      healthy();
      await byAdmin(db, "resume");
      assert.equal(marker(db), null);
    });

    test("a failed edit is resumed, reported, and leaves nothing owed", async () => {
      const db = drifted();
      sarvam.before = (r) => {
        if (r === "PATCH one") throw new Error("network down");
      };
      assert.equal((await sync(db)).action, "error");
      assert.deepEqual([hosted().status, marker(db)], ["active", null]);
    });

    for (const [name, lands] of [
      ["did not take effect", false],
      ["took effect", true],
    ] as const)
      test(`a failed pause that ${name}`, async () => {
        const db = drifted();
        sarvam.before = (r) => {
          if (r !== "PUT status" || hosted().status !== "active") return;
          if (lands) hosted().status = "paused";
          throw new Error("network down");
        };
        assert.equal((await sync(db)).action, "error");
        assert.equal(Boolean(marker(db)), lands);
        if (lands) assert.equal((await sync(db)).action, "error");
      });

    test("if the recovery cannot be recorded, nothing is paused", async () => {
      const db = drifted();
      sarvam.before = (r) => {
        if (r === "GET one") db.failNext("phone_numbers", "update", { message: "db down" });
      };
      assert.equal((await sync(db)).action, "error");
      assert.deepEqual(sarvam.writes, []);
    });
  });

  describe("C4 activation and provisioning", () => {
    /** The admin "Activate" button: the shared function, or what the button did before it. */
    const activate = (db: World) => {
      const shared = (
        assignment as unknown as {
          activateAssignedNumber?: (a: unknown, id: string) => Promise<unknown>;
        }
      ).activateAssignedNumber;
      const act = shared
        ? () => shared(db.client, "num_new")
        : async () => {
            if (number(db)["status"] === "active") throw new Error("This number is already active");
            if (number(db)["status"] === "released") throw new Error("A released number");
            Object.assign(number(db), { status: "active" });
          };
      return act().then(
        () => "activated" as const,
        (e: Error) => e.message,
      );
    };

    test("pressed while the job holds the deployment paused: refused, and the job finishes", async () => {
      const db = customer("not_live");
      let outcome: string | null = null;
      sarvam.before = async (r) => {
        if (r !== "GET one" || hosted().status !== "paused" || outcome !== null) return;
        outcome = "starting";
        outcome = await activate(db);
      };
      await pipeline(db);
      assert.match(String(outcome), /another change/i);
      assert.deepEqual([number(db)["status"], hosted().status], ["active", "active"]);
    });

    test("after a job died holding it paused: refused, not resumed, and a retry finishes it", async () => {
      const db = customer("not_live");
      await crashAt(db, isResume, () => pipeline(db));
      assert.equal(hosted().status, "paused");
      assert.match(await activate(db), /paused/);
      assert.notEqual(number(db)["status"], "active");
      assert.deepEqual(sarvam.writes, [], "the person's click resumes nothing");
      await pipeline(db);
      assert.deepEqual([number(db)["status"], hosted().status], ["active", "active"]);
    });

    test("a deployment a person paused stays paused and the number is not called active", async () => {
      const db = customer("not_live", { status: "paused" });
      assert.match(await activate(db), /paused/);
      assert.equal(number(db)["status"], "provisioning");
      await byAdmin(db, "resume");
      assert.equal(await activate(db), "activated");
    });

    test("refused when Sarvam cannot confirm the deployment", async () => {
      const db = customer("not_live");
      sarvam.before = () => {
        throw new Error("network down");
      };
      assert.notEqual(await activate(db), "activated");
      assert.equal(number(db)["status"], "provisioning");
    });

    test("an active deployment, or none yet, activates as before", async () => {
      const db = customer("suspended");
      assert.equal(await activate(db), "activated");
      assert.equal(number(db)["status"], "active");
      const bare = customer("not_live");
      number(bare)["provider_deployment_id"] = null;
      assert.equal(await activate(bare), "activated");
      assert.deepEqual(sarvam.writes, []);
    });

    test("already active and released numbers are still refused", async () => {
      assert.match(await activate(customer("live")), /already active/);
      const db = customer("not_live");
      number(db)["status"] = "released";
      assert.match(await activate(db), /released/);
    });
  });

  describe("C5 a released number's deployment is never changed", () => {
    function withReleased(db: World) {
      db.tables["phone_numbers"]!.push({
        id: "num_released",
        e164: "+917900000003",
        status: "released",
        provider: "sarvam",
        organization_id: ORG,
        agent_config_id: "agent_new",
        connection_id: "conn_new",
        provider_deployment_id: "dep-old",
        inbound_enabled: false,
      });
      sarvam.all.push({
        deployment_id: "dep-old",
        app_id: "Customer-app-1",
        app_version: 1,
        phone_numbers: ["+917900000003"],
        status: "active",
      });
    }
    const old = () => [hosted("dep-old").status, hosted("dep-old").app_version];
    const touchedOld = () => sarvam.writes.filter((w) => w.includes("dep-old"));

    test("by a provisioning run on the customer's new number", async () => {
      const db = customer("not_live");
      mapVersion(db, 2);
      confirmToolAuth(db, "Customer-app-1", 2, ORG);
      withReleased(db);
      await pipeline(db);
      assert.deepEqual(touchedOld(), []);
      assert.deepEqual(old(), ["active", 1]);
      assert.equal(hosted().app_version, 2, "the new number is still brought up to date");
    });

    test("by an admin sync", async () => {
      const db = customer("not_live");
      number(db)["status"] = "released";
      mapVersion(db, 2);
      assert.deepEqual(await deployments.syncAgentDeployments(db.client, "agent_new"), {
        items: [],
      });
      assert.deepEqual(sarvam.writes, []);
    });

    test("when the number is released while the sync is reading it", async () => {
      const db = customer("not_live");
      mapVersion(db, 2);
      sarvam.before = (r) => {
        if (r === "GET one") number(db)["status"] = "released";
      };
      await deployments.syncAgentDeployments(db.client, "agent_new");
      assert.deepEqual(sarvam.writes, []);
    });
  });
});
