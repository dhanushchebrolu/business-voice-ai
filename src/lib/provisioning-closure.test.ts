import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProvisioningPipeline } from "./provisioning-pipeline.server.ts";
import { runProvisioning, sweepProvisioningRetries } from "./provisioning-runs.server.ts";
import { handleBridgeRpc, BRIDGE_TOOLS } from "./operator-bridge-mcp.server.ts";
import {
  authenticateBridge,
  getWorkOrder,
  issueBridgeToken,
  type WorkOrderDeps,
} from "./operator-bridge.server.ts";
import { issueIntegrationCredential } from "./sarvam-integration-credential.server.ts";
import { sanitizeDiagnostic } from "./voice-provisioning-job.ts";
import { provisioningStatusLabel } from "./provisioning-status.ts";
import { CLICKAI_TOOL_NAMES } from "./sarvam-agent-tools-spec.ts";
import {
  ORG,
  snapshot,
  world,
  deps,
  num,
  confirmToolAuth,
} from "./provisioning-test-world.test-helper.ts";

/**
 * Security and reliability closure: no credential ever reaches the operator's AI client, a
 * bridge token dies with its issuer's rights, the sweep loses no change and starts no loop,
 * and no status claims calling is live before it is. Mocks only.
 */

type World = ReturnType<typeof world>;
const NOW = new Date("2026-11-27T10:00:00Z");
const USER = "00000000-0000-0000-0000-0000000000bb";
const SIX = [...CLICKAI_TOOL_NAMES];
const auth = { ok: true, tokenId: "tok", createdBy: USER, prefix: "cbr_test" } as const;
const iso = (ms: number) => new Date(ms).toISOString();

function newCustomer() {
  const db = world({ appId: null, toolAuth: false });
  Object.assign(db.tables["agent_voice_language_settings"]![0]!, {
    status: "draft",
    applied_sarvam_app_id: null,
    applied_sarvam_app_version: null,
  });
  db.tables["agent_configs"]![0]!["sarvam_app_version"] = null;
  db.tables["sarvam_agent_integrations"] = db.tables["sarvam_agent_integrations"]!.filter(
    (r) => r["role"] !== "inbound",
  );
  return db;
}
const pipelineDeps = (db: World) =>
  deps(db, { deployment: { appId: "Cust-agent-1", appVersion: 3 } });
const run = (db: World, during?: () => void) =>
  runProvisioning(
    db.client,
    { organizationId: ORG, trigger: "customer_activate", force: true },
    async (a, o, h) => {
      const result = await runProvisioningPipeline(a, o, pipelineDeps(db).d, h.onStep);
      during?.();
      return result;
    },
    () => NOW,
  );
const job = (db: World) => db.tables["provisioning_runs"]![0]!;
function bridge(db: World): WorkOrderDeps {
  return {
    loadSnapshot: async () => snapshot(),
    baseUrl: "https://clickai.example",
    masterAgentAppId: "Master-agent",
    masterAgentVersion: 2,
    resume: async () => run(db),
  };
}
const rpc = (db: World, method: string, params?: object) =>
  handleBridgeRpc(db.client, auth, bridge(db), { jsonrpc: "2.0", id: 1, method, params });
const call = async (db: World, name: string, args: Record<string, unknown>) =>
  JSON.stringify(await rpc(db, "tools/call", { name, arguments: args }));
/** The credential as a person generates it in the admin screen. */
async function adminCredential(db: World) {
  const issued = await issueIntegrationCredential(db.client, {
    organizationId: ORG,
    agentConfigId: "agent_new",
    role: "inbound",
    createdBy: USER,
  });
  // The database defaults new credentials to active; the in-memory stand-in has no defaults.
  for (const r of db.tables["sarvam_agent_integrations"]!) r["status"] ??= "active";
  return issued.token;
}

describe("no credential ever reaches the operator's AI client", () => {
  test("the bridge has no tool that issues or returns a credential", async () => {
    assert.deepEqual(BRIDGE_TOOLS.map((t) => t.name).sort(), [
      "get_agent_work_order",
      "list_agent_work_orders",
      "report_blocker",
      "report_tools_created",
      "submit_agent_result",
    ]);
    const db = newCustomer();
    await run(db);
    const before = db.tables["sarvam_agent_integrations"]!.length;
    const out = await call(db, "issue_agent_credential", { workOrderId: String(job(db)["id"]) });
    assert.match(out, /Unknown tool/);
    assert.equal(db.tables["sarvam_agent_integrations"]!.length, before, "nothing issued");
  });

  test("only the admin screen's server function can create one", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const callers = (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && !f.includes(".test"))
      .filter((f) => f !== "sarvam-integration-credential.server.ts")
      .filter((f) => /\bissueIntegrationCredential\(/.test(readFileSync(join(dir, f), "utf8")));
    assert.deepEqual(callers, ["sarvam-integration.functions.ts"]);
  });

  test("a whole operator session: no response, event, job record or table holds the raw value", async () => {
    const db = newCustomer();
    await run(db); // waiting for the credential
    const token = await adminCredential(db);
    const id = String(job(db)["id"]);
    await run(db);
    const responses = [
      await call(db, "list_agent_work_orders", {}),
      await call(db, "get_agent_work_order", { workOrderId: id }),
      await call(db, "report_blocker", { workOrderId: id, reason: "other", message: "paused" }),
      await call(db, "report_tools_created", {
        workOrderId: id,
        agentId: "Cust-agent-1",
        clonedFrom: { agentId: "Master-agent", version: 2 },
        tools: SIX,
      }),
    ];
    const fingerprint = (await getWorkOrder(db.client, id, bridge(db))).fingerprint;
    responses.push(
      await call(db, "submit_agent_result", {
        workOrderId: id,
        agentId: "Cust-agent-1",
        version: 3,
        fingerprint,
        toolAuth: SIX.map((name) => ({ name, authType: "bearer" })),
      }),
    );
    assert.match(responses.at(-1)!, /registered/);
    assert.ok(!responses.join("\n").includes(token), "never returned to the AI client");
    assert.ok(!JSON.stringify(db.tables).includes(token), "only its hash is persisted anywhere");
  });

  test("the instructions keep the operator's AI away from the value", async () => {
    const db = newCustomer();
    await run(db);
    const order = await getWorkOrder(db.client, String(job(db)["id"]), bridge(db));
    const text = order.instructions.join("\n");
    assert.match(text, /Never ask for, read, repeat or type a credential value/);
    assert.match(text, /do not call configure_secret/);
    assert.doesNotMatch(text, /issue_agent_credential/);
  });

  test("a credential pasted where an agent id belongs is refused, never stored or echoed", async () => {
    const db = newCustomer();
    await run(db);
    const token = await adminCredential(db);
    await run(db);
    const id = String(job(db)["id"]);
    for (const pasted of [token, `cbr_${"a".repeat(43)}`]) {
      for (const tool of ["report_tools_created", "submit_agent_result"]) {
        const out = await call(db, tool, {
          workOrderId: id,
          agentId: pasted,
          version: 3,
          fingerprint: "x",
          clonedFrom: { agentId: "Master-agent", version: 2 },
          tools: SIX,
          toolAuth: [],
        });
        assert.match(out, /does not look like a Sarvam agent id/);
        assert.ok(!out.includes(pasted));
      }
      await call(db, "report_blocker", {
        workOrderId: id,
        reason: "other",
        message: `failed with ${pasted}`,
      });
      assert.ok(!JSON.stringify(db.tables).includes(pasted));
    }
    assert.equal(
      sanitizeDiagnostic("x cai_sv_short y cbr_abc"),
      "x cai_sv_[redacted] y cbr_[redacted]",
    );
  });
});

describe("a bridge token only lives as long as its issuer's rights", () => {
  async function issued(role = "super_admin") {
    const db = world();
    db.tables["platform_admins"] = [{ user_id: USER, role, is_active: true }];
    const t = await issueBridgeToken(db.client, { createdBy: USER, now: NOW });
    const check = () => authenticateBridge(db.client, `Bearer ${t.token}`, NOW);
    return { db, check, admin: () => db.tables["platform_admins"]![0]! };
  }

  test("roles that may build agents are accepted", async () => {
    for (const role of ["super_admin", "admin", "operations"])
      assert.equal((await (await issued(role)).check()).ok, true, role);
  });

  for (const [name, change] of [
    ["deactivated", (a: Record<string, unknown>) => (a["is_active"] = false)],
    ["downgraded to support", (a: Record<string, unknown>) => (a["role"] = "support")],
    ["downgraded to finance", (a: Record<string, unknown>) => (a["role"] = "finance")],
  ] as const)
    test(`an issuer who is ${name} loses the token at once, for good`, async () => {
      const { db, check, admin } = await issued();
      assert.equal((await check()).ok, true);
      change(admin());
      assert.deepEqual(await check(), { ok: false, reason: "revoked" });
      assert.ok(db.tables["operator_bridge_tokens"]![0]!["revoked_at"]);
      Object.assign(admin(), { role: "super_admin", is_active: true });
      assert.deepEqual(await check(), { ok: false, reason: "revoked" }, "not revived");
    });

  test("a removed admin's token is refused; another admin's token is unaffected", async () => {
    const { db, check } = await issued();
    const other = "00000000-0000-0000-0000-0000000000cc";
    db.tables["platform_admins"]!.push({ user_id: other, role: "admin", is_active: true });
    const t2 = await issueBridgeToken(db.client, { createdBy: other, now: NOW });
    db.tables["platform_admins"] = db.tables["platform_admins"]!.filter(
      (r) => r["user_id"] !== USER,
    );
    assert.deepEqual(await check(), { ok: false, reason: "revoked" });
    assert.equal((await authenticateBridge(db.client, `Bearer ${t2.token}`, NOW)).ok, true);
  });
});

describe("the sweep loses no change and starts no loop", () => {
  const t0 = NOW.getTime();
  /** The database bumps updated_at on every change; the in-memory stand-in does not. */
  /** What registering does: the agent row and the applied voice settings both change. */
  const registerAt = (db: World, at: number) => {
    Object.assign(db.tables["agent_configs"]![0]!, {
      sarvam_app_id: "Cust-agent-1",
      sarvam_app_version: 3,
      updated_at: iso(at),
    });
    Object.assign(db.tables["agent_voice_language_settings"]![0]!, {
      status: "applied",
      applied_sarvam_app_id: "Cust-agent-1",
      applied_sarvam_app_version: 3,
      updated_at: iso(at),
    });
  };
  const sweep = async (db: World) => {
    const started: string[] = [];
    await sweepProvisioningRetries(db.client, {
      now: NOW,
      run: async (a, i) => {
        started.push(i.organizationId);
        return runProvisioning(
          a,
          i,
          (x, o, h) => runProvisioningPipeline(x, o, pipelineDeps(db).d, h.onStep),
          () => NOW,
        );
      },
    });
    return started;
  };
  async function waiting() {
    const db = newCustomer();
    await run(db);
    await adminCredential(db);
    await run(db);
    return db;
  }

  test("a change made WHILE an attempt was running is picked up afterwards, once", async () => {
    const db = await waiting();
    await run(db, () => registerAt(db, t0 + 1000)); // registered after the pipeline had read
    assert.equal(job(db)["current_step"], "waiting_for_agent", "this attempt missed it");
    assert.deepEqual(await sweep(db), [ORG]);
    assert.equal(job(db)["current_step"], "waiting_for_tool_authentication");
    assert.deepEqual(await sweep(db), []);
  });

  test("a confirmation whose own resume failed is picked up and activates once", async () => {
    const db = await waiting();
    registerAt(db, t0 + 1000);
    await run(db);
    assert.deepEqual(await sweep(db), []);
    confirmToolAuth(db, "Cust-agent-1", 3);
    assert.deepEqual(await sweep(db), [ORG]);
    assert.equal(num(db, "num_new")["status"], "active");
    assert.deepEqual(await sweep(db), []);
    assert.equal(db.tables["provisioning_runs"]!.length, 1, "no second job");
  });

  test("an operator's blocker stays visible: reporting it causes no re-run", async () => {
    const db = await waiting();
    registerAt(db, t0 + 1000);
    await run(db);
    await call(db, "report_blocker", {
      workOrderId: String(job(db)["id"]),
      reason: "sarvam_auth_required",
    });
    assert.deepEqual(await sweep(db), []);
    assert.equal(job(db)["failure_code"], "WAITING_FOR_OPERATOR");
  });

  test("many unchanged waiting jobs cannot starve the one that changed", async () => {
    const db = await waiting();
    for (let i = 0; i < 60; i++) {
      const org = `org_idle_${i}`;
      db.tables["provisioning_runs"]!.unshift({
        id: `idle_${i}`,
        organization_id: org,
        trigger: "customer_activate",
        status: "waiting",
        current_step: "waiting_for_agent",
        diagnostics: { seenChange: "a||" },
      });
      db.tables["agent_configs"]!.push({
        id: `agent_${org}`,
        organization_id: org,
        sarvam_app_id: `App-${i}`,
        updated_at: "a",
      });
    }
    registerAt(db, t0 + 1000);
    const started: string[] = [];
    await sweepProvisioningRetries(db.client, {
      now: NOW,
      run: async (_a, i) => {
        started.push(i.organizationId);
        return { runId: "x", claimed: true, status: "waiting", result: null };
      },
    });
    assert.deepEqual(started, [ORG]);
  });

  test("a superseded (reclaimed) attempt cannot overwrite the newer attempt's record", async () => {
    const db = await waiting();
    await run(db, () => {
      // Another worker reclaimed the job while this attempt was still working.
      Object.assign(job(db), {
        attempts: Number(job(db)["attempts"]) + 1,
        status: "running",
        current_step: "newer-attempt",
      });
    });
    assert.equal(job(db)["status"], "running");
    assert.equal(job(db)["current_step"], "newer-attempt");
  });
});

describe("no status claims calling is live before it is", () => {
  test("every not-yet-active combination says so", () => {
    const flags = [false, true];
    for (const connectionLinked of flags)
      for (const agentSarvamMapped of flags)
        for (const inboundEnabled of flags)
          for (const outboundEnabled of flags) {
            const s = provisioningStatusLabel({
              lifecycleStatus: "provisioning",
              hasNumber: true,
              numberActive: false,
              connectionLinked,
              agentSarvamMapped,
              inboundEnabled,
              outboundEnabled,
            });
            assert.notEqual(s.tone, "live");
            assert.doesNotMatch(s.label, /activ|live now|calling/i, s.label);
          }
  });
});
