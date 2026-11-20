import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import { runProvisioningPipeline, type PipelineDeps } from "./provisioning-pipeline.server.ts";
import { runProvisioning, type ProvisioningTrigger } from "./provisioning-runs.server.ts";
import {
  applySarvamAgentMapping,
  applySarvamOutboundAgentMapping,
} from "./sarvam-agent-registration.server.ts";
import { customerSetupSteps, provisioningStatusLabel } from "./provisioning-status.ts";
import { outboundAgentTarget } from "./sarvam-outbound-mode.server.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";

/**
 * End-to-end dual-agent provisioning, run locally: the real run orchestrator
 * (provisioning-runs), the real pipeline and the real registration helpers
 * over an in-memory database, with Sarvam's deployment API mocked as a small
 * stateful service. The ClickAI team's manual steps (confirm the number,
 * issue credentials, create agents in Sarvam and register them) are the same
 * writes the admin server functions make. At every stage the customer's view
 * is derived from the database exactly as the dashboard derives it.
 */

const ORG = "org_e2e";
const NUMBER = "+917900000050";

function snapshot(): AgentSnapshot {
  return {
    business: {
      name: "E2E Dental",
      business_type: "dental_clinic",
      description: "Clinic.",
      country: "IN",
      timezone: "Asia/Kolkata",
      currency: "INR",
    },
    hours: [{ day_of_week: 1, is_closed: false, intervals: [{ start: "09:00", end: "18:00" }] }],
    services: [{ name: "Cleaning", currency: "INR", is_active: true }],
    faqs: [],
    rules: [],
    knowledge: [],
    agent: {
      agent_name: "Aria",
      persona: "friendly",
      objectives: [],
      capabilities: { calendar_book: true, capture_lead: true },
      primary_language: "en-IN",
      extra_languages: [],
      multilingual: true,
      voice_id: "ritu",
      speaking_pace: 1,
      greetings: {},
      transfer_number: null,
      after_hours_behavior: "take_message",
    },
  } as AgentSnapshot;
}

/** A paid customer who finished onboarding; nothing in Sarvam yet. */
function world() {
  return memorySupabase({
    uniques: [
      {
        table: "provisioning_runs",
        key: (r) =>
          ["pending", "running", "waiting"].includes(r["status"] as string)
            ? (r["organization_id"] as string)
            : null,
      },
      { table: "agent_configs", key: (r) => (r["sarvam_app_id"] as string | null) ?? null },
      {
        table: "agent_configs",
        key: (r) => (r["sarvam_outbound_app_id"] as string | null) ?? null,
      },
      {
        table: "sarvam_agent_integrations",
        key: (r) =>
          r["status"] === "active" ? `${r["agent_config_id"]}:${r["role"] as string}` : null,
      },
    ],
    tables: {
      organizations: [{ id: ORG, lifecycle_status: "setup_paid" }],
      agent_configs: [
        {
          id: "agent_e2e",
          organization_id: ORG,
          business_id: "biz_e2e",
          sarvam_app_id: null,
          sarvam_app_version: null,
          sarvam_outbound_app_id: null,
          sarvam_outbound_app_version: null,
        },
      ],
      telephony_connections: [
        { id: "conn_e2e", organization_id: ORG, provider: "sarvam", provider_connection_id: "c-1" },
      ],
      phone_numbers: [],
      sarvam_agent_integrations: [],
      sarvam_applications: [],
      provisioning_runs: [],
      agent_voice_language_settings: [
        {
          id: "vl_e2e",
          organization_id: ORG,
          agent_config_id: "agent_e2e",
          default_language: "English",
          allowed_languages: ["English", "Hindi"],
          auto_language_switch: true,
          sarvam_voice_internal_id: "01a0cf17-12bd-7de3-9df0-f607db604d52",
          status: "saved",
        },
      ],
    },
  });
}
type World = ReturnType<typeof world>;

/** Sarvam's documented deployment API as a stateful mock, with failure injection. */
function sarvamMock(db: World) {
  const deployments = new Map<
    string,
    { appId: string; appVersion: number; status: string; numbers: string[] }
  >();
  const fail = {
    /** The create reaches Sarvam but the response is lost (timeout). */
    createTimeout: 0,
    /** The deployment reads back on the wrong agent (someone changed it in Sarvam). */
    wrongAgent: false,
    resume: 0,
    /** The pipeline hits an unexpected error (database outage). */
    loadSnapshot: 0,
  };
  const counts = { creates: 0, adopts: 0 };
  const agent = () => db.tables["agent_configs"]![0]!;
  const deps: PipelineDeps = {
    loadSnapshot: async () => {
      if (fail.loadSnapshot > 0) {
        fail.loadSnapshot--;
        throw new Error("simulated database outage");
      }
      return snapshot();
    },
    // Mirrors createInboundDeploymentForNumbers' contract: adopt the
    // deployment already routing the number instead of creating another.
    createDeployment: async (_admin, { phoneNumberIds }) => {
      const row = db.tables["phone_numbers"]!.find((n) => n["id"] === phoneNumberIds[0])!;
      const existing = [...deployments].find(([, d]) => d.numbers.includes(String(row["e164"])));
      if (existing) {
        counts.adopts++;
        row["provider_deployment_id"] = existing[0];
        return { deploymentId: existing[0], outcome: "adopted" };
      }
      counts.creates++;
      const id = `dep-${counts.creates}`;
      deployments.set(id, {
        appId: String(agent()["sarvam_app_id"]),
        appVersion: Number(agent()["sarvam_app_version"]),
        status: "active", // documented: deployments are created active
        numbers: [String(row["e164"])],
      });
      if (fail.createTimeout > 0) {
        fail.createTimeout--;
        throw Object.assign(new Error("Sarvam timed out"), { status: 504, outcomeUnknown: true });
      }
      row["provider_deployment_id"] = id;
      return { deploymentId: id, outcome: "created" };
    },
    getDeployment: async (id) => {
      const d = deployments.get(id)!;
      return {
        deploymentId: id,
        appId: fail.wrongAgent ? "Someone-else" : d.appId,
        appVersion: d.appVersion,
        status: d.status,
        phoneNumbers: d.numbers,
        webhookUrlConfigured: true,
      };
    },
    setDeploymentStatus: async (id, action) => {
      if (action === "resume" && fail.resume > 0) {
        fail.resume--;
        throw new Error("Sarvam is temporarily unavailable.");
      }
      deployments.get(id)!.status = action === "pause" ? "paused" : "active";
    },
    syncDeployments: async () => undefined,
    masterAgentAppId: "Master-in",
    outboundMasterAgentAppId: "Master-out",
    now: () => new Date("2026-11-20T10:00:00Z"),
  };
  return { deps, deployments, fail, counts };
}

const run = (db: World, s: ReturnType<typeof sarvamMock>, trigger: ProvisioningTrigger) =>
  runProvisioning(db.client, { organizationId: ORG, trigger }, (a, org) =>
    runProvisioningPipeline(a, org, s.deps),
  );

/** What the customer's dashboard shows, from the same rows it reads. */
function customerView(db: World) {
  const agent = db.tables["agent_configs"]![0]!;
  const n = db.tables["phone_numbers"]![0];
  const input = {
    lifecycleStatus: String(db.tables["organizations"]![0]!["lifecycle_status"]),
    hasNumber: Boolean(n),
    numberActive: n?.["status"] === "active",
    connectionLinked: Boolean(n?.["connection_id"]),
    agentSarvamMapped: Boolean(agent["sarvam_app_id"] && agent["sarvam_app_version"]),
    inboundEnabled: Boolean(n?.["inbound_enabled"]),
    outboundEnabled: Boolean(n?.["outbound_enabled"]),
  };
  const label = provisioningStatusLabel(input);
  const steps = customerSetupSteps({
    agentExists: true,
    inboundAgentReady: input.agentSarvamMapped,
    outboundAgentReady: Boolean(agent["sarvam_outbound_app_id"]),
    hasNumber: input.hasNumber,
    numberActive: input.numberActive,
    inboundEnabled: input.inboundEnabled,
    needsAttention: label.tone === "error",
  });
  return {
    label: label.label,
    current: steps.find((x) => x.status !== "done")?.label ?? "all done",
  };
}

// The ClickAI team's manual steps: the same writes the admin functions make.
const ops = {
  assignNumber(db: World) {
    db.tables["phone_numbers"]!.push({
      id: "num_e2e",
      e164: NUMBER,
      status: "provisioning",
      provider: "sarvam",
      organization_id: ORG,
      connection_id: null,
      agent_config_id: null,
      provider_deployment_id: null,
      inbound_enabled: false,
      sarvam_number_confirmed_at: null,
    });
  },
  confirmNumber(db: World) {
    db.tables["phone_numbers"]![0]!["sarvam_number_confirmed_at"] = "2026-11-20T09:00:00Z";
  },
  issueCredential(db: World, role: "inbound" | "outbound") {
    const active = db.tables["sarvam_agent_integrations"]!.find(
      (r) => r["role"] === role && r["status"] === "active",
    );
    if (active) return; // issuing again rotates in place, never a second row
    db.tables["sarvam_agent_integrations"]!.push({
      id: `int-${role}`,
      organization_id: ORG,
      agent_config_id: "agent_e2e",
      status: "active",
      expires_at: null,
      role,
    });
  },
  async registerInbound(db: World, appId = "E2E-in-1") {
    await applySarvamAgentMapping(db.client, {
      agentConfigId: "agent_e2e",
      organizationId: ORG,
      sarvamAppId: appId,
      sarvamAppVersion: 1,
      masterAgentAppId: "Master-in",
    });
    Object.assign(db.tables["agent_voice_language_settings"]![0]!, {
      status: "applied",
      applied_sarvam_app_id: appId,
      applied_sarvam_app_version: 1,
    });
  },
  registerOutbound: (db: World, appId = "E2E-out-1") =>
    applySarvamOutboundAgentMapping(db.client, {
      agentConfigId: "agent_e2e",
      organizationId: ORG,
      sarvamAppId: appId,
      sarvamAppVersion: 1,
      masterAgentAppIds: ["Master-in", "Master-out"],
      registeredBy: "admin_1",
      now: new Date("2026-11-20T10:00:00Z"),
    }),
};

function invariants(db: World, s: ReturnType<typeof sarvamMock>) {
  assert.ok(s.deployments.size <= 1, `one deployment at most, got ${s.deployments.size}`);
  for (const role of ["inbound", "outbound"])
    assert.ok(
      db.tables["sarvam_agent_integrations"]!.filter(
        (r) => r["role"] === role && r["status"] === "active",
      ).length <= 1,
      `one active ${role} credential at most`,
    );
  assert.ok(
    db.tables["provisioning_runs"]!.filter((r) =>
      ["pending", "running", "waiting"].includes(String(r["status"])),
    ).length <= 1,
    "one active provisioning run at most",
  );
  const agent = db.tables["agent_configs"]![0]!;
  if (agent["sarvam_outbound_app_id"])
    assert.notEqual(agent["sarvam_outbound_app_id"], agent["sarvam_app_id"]);
  // Provisioning never makes the customer dialable: outbound stays unconfirmed and off.
  assert.equal(outboundAgentTarget(agent as never), null);
  assert.notEqual(db.tables["phone_numbers"]![0]?.["outbound_enabled"], true);
}

describe("dual-agent provisioning end to end (mocked Sarvam)", () => {
  test("activation → inbound → live line → outbound → ready, with the customer's view at each stage", async () => {
    const db = world();
    const s = sarvamMock(db);
    const stages: { step: string; state: string | undefined; customer: string }[] = [];
    const record = async (step: string, trigger: ProvisioningTrigger = "admin_retry") => {
      const r = await run(db, s, trigger);
      invariants(db, s);
      const v = customerView(db);
      stages.push({ step, state: r.result?.state, customer: `${v.label} / ${v.current}` });
      return r;
    };

    // Activation: the setup-fee payment triggers provisioning twice (webhook retry).
    const first = await record("payment", "setup_fee");
    const again = await record("payment repeated", "setup_fee");
    assert.equal(first.runId, again.runId, "the repeated activation reuses the same run");
    assert.equal(first.result?.state, "waiting_for_number");
    assert.equal(db.tables["organizations"]![0]!["lifecycle_status"], "provisioning");

    ops.assignNumber(db);
    await record("number assigned");
    ops.confirmNumber(db);
    await record("number confirmed");
    ops.issueCredential(db, "inbound");
    await record("inbound credential");
    await ops.registerInbound(db);
    const live = await record("inbound agent registered");
    assert.equal(live.result?.state, "waiting_for_outbound_credential", live.result?.note);
    assert.equal(db.tables["phone_numbers"]![0]!["status"], "active");
    ops.issueCredential(db, "outbound");
    await record("outbound credential");
    await ops.registerOutbound(db);
    const done = await record("outbound agent registered");
    assert.equal(done.result?.state, "active", done.result?.note);
    assert.equal(done.status, "succeeded");
    // Running again after success starts a new run that only re-reads.
    const after = await record("re-run after success");
    assert.equal(after.result?.state, "active");

    assert.deepEqual(
      stages.map((x) => `${x.step}: ${x.state} | ${x.customer}`),
      [
        "payment: waiting_for_number | Waiting for phone number / Assigning your phone number",
        "payment repeated: waiting_for_number | Waiting for phone number / Assigning your phone number",
        "number assigned: waiting_for_number_confirmation | Setup needs admin attention / Creating your inbound AI agent",
        "number confirmed: waiting_for_integration_credential | Setup needs admin attention / Creating your inbound AI agent",
        "inbound credential: waiting_for_agent | Setup needs admin attention / Creating your inbound AI agent",
        "inbound agent registered: waiting_for_outbound_credential | Inbound calling active / Creating your outbound AI agent",
        "outbound credential: waiting_for_outbound_agent | Inbound calling active / Creating your outbound AI agent",
        "outbound agent registered: active | Inbound calling active / all done",
        "re-run after success: active | Inbound calling active / all done",
      ],
    );
    assert.equal(s.counts.creates, 1, "exactly one deployment ever created");
    assert.equal(
      s.deployments.get("dep-1")!.appId,
      "E2E-in-1",
      "the deployment serves the inbound agent",
    );
  });

  test("recovery from a failure at every step: no duplicate deployment, credential, agent or run", async () => {
    const db = world();
    const s = sarvamMock(db);
    const step = async (expect: string) => {
      const r = await run(db, s, "admin_retry").catch((e: Error) => ({
        result: { state: `threw: ${e.message}` },
        status: "failed",
      }));
      invariants(db, s);
      assert.equal(r.result?.state, expect);
      return r;
    };

    // An unexpected error mid-pipeline fails the run; the retry claims it again.
    s.fail.loadSnapshot = 1;
    await step("threw: simulated database outage");
    assert.equal(db.tables["provisioning_runs"]![0]!["status"], "failed");
    await step("waiting_for_number");

    ops.assignNumber(db);
    ops.confirmNumber(db);
    ops.issueCredential(db, "inbound");
    ops.issueCredential(db, "inbound"); // issued twice: still one active credential
    await ops.registerInbound(db);
    await ops.registerInbound(db); // registered twice: same mapping, no error

    // The create reaches Sarvam but times out: a retryable failure...
    s.fail.createTimeout = 1;
    await step("failed");
    assert.equal(db.tables["phone_numbers"]![0]!["status"], "provisioning");
    // ...and the retry adopts the deployment Sarvam made instead of a second one.
    s.fail.wrongAgent = true;
    await step("verification_failed");
    assert.equal(s.counts.creates, 1);
    assert.equal(s.counts.adopts, 1);
    assert.equal(db.tables["phone_numbers"]![0]!["status"], "provisioning", "never activated");
    s.fail.wrongAgent = false;
    s.fail.resume = 1;
    await step("verification_failed");
    assert.equal(db.tables["phone_numbers"]![0]!["status"], "provisioning");
    await step("waiting_for_outbound_credential");
    assert.equal(db.tables["phone_numbers"]![0]!["status"], "active");

    ops.issueCredential(db, "outbound");
    // Wrong outbound ids are refused and change nothing; then the right one.
    for (const wrong of ["E2E-in-1", "Master-out", "Master-in"])
      await assert.rejects(ops.registerOutbound(db, wrong));
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_outbound_app_id"], null);
    await step("waiting_for_outbound_agent");
    await ops.registerOutbound(db);
    await ops.registerOutbound(db); // repeated: no-op
    await step("active");
    await step("active");

    assert.equal(s.counts.creates, 1, "one deployment ever created");
    assert.equal(s.deployments.size, 1);
    assert.equal(db.tables["sarvam_agent_integrations"]!.length, 2, "one credential per role");
    const runs = db.tables["provisioning_runs"]!;
    assert.ok(runs.every((r) => ["failed", "succeeded"].includes(String(r["status"]))));
  });

  test("two activations racing for the same customer share one run; the loser does nothing", async () => {
    const db = world();
    const s = sarvamMock(db);
    const [a, b] = await Promise.all([run(db, s, "setup_fee"), run(db, s, "setup_fee")]);
    assert.equal(a.runId, b.runId);
    assert.equal([a.claimed, b.claimed].filter(Boolean).length >= 1, true);
    assert.equal(db.tables["provisioning_runs"]!.length, 1);
    invariants(db, s);
  });
});
