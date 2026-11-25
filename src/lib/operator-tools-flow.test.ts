import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProvisioningPipeline } from "./provisioning-pipeline.server.ts";
import {
  runProvisioning,
  sweepProvisioningRetries,
  type RunProvisioningInput,
} from "./provisioning-runs.server.ts";
import { handleBridgeRpc } from "./operator-bridge-mcp.server.ts";
import { getWorkOrder, listWorkOrders, type WorkOrderDeps } from "./operator-bridge.server.ts";
import { loadActivationView } from "./voice-activation.server.ts";
import { toolAuthStatus } from "./tool-auth-checkpoint.server.ts";
import {
  CLICKAI_TOOL_NAMES,
  DEFAULT_MASTER_AGENT_APP_ID,
  DEFAULT_MASTER_AGENT_VERSION,
  clickAiToolDefinitions,
  sarvamSafePrompt,
} from "./sarvam-agent-tools-spec.ts";
import { masterAgentAppId, masterAgentVersion } from "./sarvam-agent-registration.server.ts";
import { buildSarvamAgentPrompt } from "./sarvam-agent-prompt.ts";
import { MASTER_AGENT_TOOLS } from "./universal-agent-config.ts";
import { customerJobView, JOB_STEP_KEYS } from "./voice-provisioning-job.ts";
import { ORG, OTHER, snapshot, world, deps, num } from "./provisioning-test-world.test-helper.ts";

/**
 * Cloning the committed master, recreating the six tools (clones carry none), and the
 * tool-authentication checkpoint. Mocks only: no Sarvam call is made.
 */

type World = ReturnType<typeof world>;
const NOW = new Date("2026-11-26T10:00:00Z");
const USER = "00000000-0000-0000-0000-0000000000bb";
const here = dirname(fileURLToPath(import.meta.url));
const SIX = [...CLICKAI_TOOL_NAMES];
const bearer = SIX.map((name) => ({ name, authType: "bearer" }));
const auth = { ok: true, tokenId: "tok", createdBy: USER, prefix: "cbr_test" } as const;

function waitingWorld(caps?: Record<string, boolean>) {
  const db = world({ appId: null });
  Object.assign(db.tables["agent_voice_language_settings"]![0]!, {
    status: "draft",
    applied_sarvam_app_id: null,
    applied_sarvam_app_version: null,
  });
  db.tables["agent_configs"]![0]!["sarvam_app_version"] = null;
  void caps;
  return db;
}
const pipeline = (db: World) => deps(db, { deployment: { appId: "Cust-agent-1", appVersion: 3 } });
const runWith = (db: World, d = pipeline(db), input: Partial<RunProvisioningInput> = {}) =>
  runProvisioning(
    db.client,
    { organizationId: ORG, trigger: "customer_activate", ...input },
    (a, o, h) => runProvisioningPipeline(a, o, d.d, h.onStep),
    () => NOW,
  );
function bridge(db: World, over: Partial<WorkOrderDeps> = {}, caps?: Record<string, boolean>) {
  const resumed: string[] = [];
  const d: WorkOrderDeps & { resumed: string[] } = {
    resumed,
    loadSnapshot: async () => snapshot(caps),
    baseUrl: "https://clickai.example",
    masterAgentAppId: "Master-agent",
    masterAgentVersion: 2,
    resume: async (org) => {
      resumed.push(org);
      return runProvisioning(
        db.client,
        { organizationId: org, trigger: "admin_retry", force: true },
        (a, o, h) => runProvisioningPipeline(a, o, pipeline(db).d, h.onStep),
        () => NOW,
      );
    },
    ...over,
  };
  return d;
}
const call = async (db: World, d: WorkOrderDeps, name: string, args: Record<string, unknown>) => {
  const out = await handleBridgeRpc(db.client, auth, d, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const r = (out as { result: { content: { text: string }[]; isError?: boolean } }).result;
  return { body: JSON.parse(r.content[0]!.text), isError: Boolean(r.isError) };
};
const reportArgs = (id: string, over: Record<string, unknown> = {}) => ({
  workOrderId: id,
  agentId: "Cust-agent-1",
  clonedFrom: { agentId: "Master-agent", version: 2 },
  tools: SIX,
  ...over,
});
const runRow = (db: World) => db.tables["provisioning_runs"]![0]!;
const events = (db: World, name?: string) =>
  (db.tables["provisioning_run_events"] ?? []).filter((e) => !name || e["event"] === name);

async function openOrder(caps?: Record<string, boolean>) {
  const db = waitingWorld();
  await runWith(db);
  const d = bridge(db, {}, caps);
  const id = (await listWorkOrders(db.client))[0]!.workOrderId;
  const order = await getWorkOrder(db.client, id, d);
  return { db, d, id, order };
}

describe("the six tool definitions (committed master version 2)", () => {
  const defs = clickAiToolDefinitions("https://clickai.in");
  const byName = Object.fromEntries(defs.map((t) => [t.name, t]));
  const cfg = (n: string) =>
    byName[n]!.connectorConfig as {
      url: string;
      lifecycle: string;
      body: { name: string; type: string; value?: { variable_name: string } }[];
      timeout_seconds: number;
      on_failure?: string;
      resp_template?: string;
      save_to_variables?: { response_path: string; variable_name: string }[];
    };

  test("exactly the six tools, in order, at the existing ClickAI endpoints", () => {
    assert.deepEqual(
      defs.map((d) => d.name),
      SIX,
    );
    const base = "https://clickai.in/api/public/sarvam/agent";
    assert.equal(cfg("clickai_business_context").url, `${base}/context`);
    for (const n of SIX.filter((n) => n !== "clickai_business_context"))
      assert.equal(cfg(n).url, `${base}/tools/${n}`);
  });

  test("execution timing: on start, during the call, on end", () => {
    assert.equal(byName["clickai_business_context"]!.toolType, "webhook_on_start");
    assert.equal(cfg("clickai_business_context").lifecycle, "on_start");
    assert.equal(byName["record_call_outcome"]!.toolType, "webhook_on_end");
    assert.equal(cfg("record_call_outcome").lifecycle, "on_end");
    for (const n of [
      "get_business_info",
      "check_availability",
      "book_appointment",
      "request_callback",
    ]) {
      assert.equal(byName[n]!.toolType, "webhook", n);
      assert.equal(cfg(n).lifecycle, "run", n);
    }
  });

  test("typed Interaction ID and User Identifier bindings, never template strings", () => {
    for (const n of SIX) {
      const id = cfg(n).body.find((b) => b.name === "interaction_id");
      assert.deepEqual(id, {
        name: "interaction_id",
        type: "system_variable",
        value: { variable_name: "interaction_id" },
      });
    }
    const user = (n: string, field: string) => cfg(n).body.find((b) => b.name === field);
    for (const [n, field] of [
      ["clickai_business_context", "caller_number"],
      ["book_appointment", "customer_phone"],
      ["request_callback", "caller_number"],
      ["record_call_outcome", "caller_number"],
    ] as const)
      assert.deepEqual(user(n, field), {
        name: field,
        type: "system_variable",
        value: { variable_name: "user_identifier" },
      });
    assert.doesNotMatch(JSON.stringify(defs), /sarvam_variables|@Interaction ID/);
  });

  test("timeouts, failure messages, reply templates and variable saving", () => {
    assert.deepEqual(
      SIX.map((n) => cfg(n).timeout_seconds),
      [10, 10, 10, 20, 10, 10],
    );
    for (const n of [
      "get_business_info",
      "check_availability",
      "book_appointment",
      "request_callback",
    ])
      assert.ok(cfg(n).on_failure, n);
    for (const n of [
      "get_business_info",
      "check_availability",
      "book_appointment",
      "request_callback",
    ])
      assert.ok(cfg(n).resp_template, n);
    assert.equal(cfg("clickai_business_context").save_to_variables!.length, 21);
    assert.equal(cfg("get_business_info").save_to_variables!.length, 20);
  });

  test("optional booking fields match what the backend handles", () => {
    const field = (n: string, f: string) =>
      (cfg(n).body as { name: string; required?: boolean }[]).find((b) => b.name === f)!;
    assert.equal(field("check_availability", "date").required, true);
    assert.equal(field("check_availability", "service_name").required, false);
    assert.equal(field("book_appointment", "time").required, true);
    assert.equal(field("book_appointment", "customer_name").required, false);
    assert.equal(field("request_callback", "reason").required, true);
  });

  test("no authentication, secret or customer data in any definition", () => {
    const text = JSON.stringify(defs);
    assert.doesNotMatch(text, /"auth"|secret_id|Bearer [A-Za-z0-9]{12}|Smile|dental/i);
    for (const d of defs) assert.equal("auth" in d.connectorConfig, false, d.name);
  });

  test("reply templates and endpoints equal the verified package", () => {
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "..", "docs", "sarvam-master-agent-package.json"), "utf8"),
    ) as { agent: { tools: { name: string; url: string; responseTemplate?: string }[] } };
    for (const n of ["check_availability", "book_appointment"]) {
      const t = pkg.agent.tools.find((x) => x.name === n)!;
      assert.equal(cfg(n).resp_template, t.responseTemplate, n);
      assert.equal(cfg(n).url, t.url, n);
    }
  });
});

describe("master reference and prompt", () => {
  test("defaults to the committed master version 2; the environment can override", () => {
    assert.equal(DEFAULT_MASTER_AGENT_APP_ID, "ClickAI-Mas-002f42d7-604f");
    assert.equal(DEFAULT_MASTER_AGENT_VERSION, 2);
    const before = { ...process.env };
    try {
      delete process.env["SARVAM_MASTER_AGENT_APP_ID"];
      delete process.env["SARVAM_MASTER_AGENT_VERSION"];
      assert.equal(masterAgentAppId(), "ClickAI-Mas-002f42d7-604f");
      assert.equal(masterAgentVersion(), 2);
      process.env["SARVAM_MASTER_AGENT_APP_ID"] = "Other-master";
      process.env["SARVAM_MASTER_AGENT_VERSION"] = "5";
      assert.equal(masterAgentAppId(), "Other-master");
      assert.equal(masterAgentVersion(), 5);
      process.env["SARVAM_MASTER_AGENT_VERSION"] = "banana";
      assert.equal(masterAgentVersion(), 2);
    } finally {
      for (const k of ["SARVAM_MASTER_AGENT_APP_ID", "SARVAM_MASTER_AGENT_VERSION"])
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k]!;
    }
  });

  test("the Sarvam-safe prompt drops exactly the six rejected bullets (the master's 10,085 characters)", () => {
    const full = buildSarvamAgentPrompt({
      role: "inbound",
      tools: [...MASTER_AGENT_TOOLS],
      healthcare: false,
    });
    const safe = sarvamSafePrompt(full);
    assert.equal(safe.removed, 6);
    assert.equal(safe.text.length, 10085);
    assert.doesNotMatch(safe.text, /Reply in the language the person is speaking/);
    assert.match(safe.text, /## Guardrails/);
    assert.equal(sarvamSafePrompt(safe.text).removed, 0, "idempotent");
  });

  test("the work order clones the COMMITTED master version, with the customer's voice and languages", async () => {
    const { order } = await openOrder();
    assert.deepEqual(order.master, {
      agentId: "Master-agent",
      version: 2,
      source: "committed_version",
    });
    const c = order.clone.configureAgent;
    assert.equal(c.clone_from, "Master-agent");
    assert.equal(c.clone_version, 2);
    assert.match(c.name, /^clickai-org_new-agent_ne/);
    assert.equal(
      c.config?.text_to_speech_config.internal_id,
      "01a0cf17-12bd-7de3-9df0-f607db604d52",
    );
    assert.deepEqual(c.config?.language_config.supported_languages, ["English", "Hindi"]);
    assert.doesNotMatch(JSON.stringify(order), /draft/i.source ? /"clone_version":null/ : /x/);
  });

  test("tool recreation is part of the order: all six, enabled by the customer's capabilities", async () => {
    const enquiry = await openOrder({ capture_lead: true });
    assert.deepEqual(
      enquiry.order.tools.map((t) => t.name),
      SIX,
    );
    const on = (o: typeof enquiry.order) =>
      Object.fromEntries(o.tools.map((t) => [t.name, t.enabled]));
    assert.deepEqual(on(enquiry.order), {
      clickai_business_context: true,
      get_business_info: true,
      check_availability: false,
      book_appointment: false,
      request_callback: true,
      record_call_outcome: true,
    });
    const booking = await openOrder({ calendar_book: true, capture_lead: true });
    assert.equal(on(booking.order)["book_appointment"], true);
    assert.match(booking.order.instructions.join(" "), /Recreate all six tools/);
    assert.match(booking.order.instructions.join(" "), /BEFORE committing/);
  });
});

describe("the tool-authentication checkpoint", () => {
  test("report_tools_created parks the job with the agent id; nothing is deployed or activated", async () => {
    const { db, d, id } = await openOrder();
    const dep = pipeline(db);
    const r = await call(db, d, "report_tools_created", reportArgs(id));
    assert.equal(r.isError, false, JSON.stringify(r.body));
    assert.equal(r.body.status, "recorded");
    assert.equal(runRow(db)["status"], "waiting");
    assert.equal(runRow(db)["failure_code"], "TOOL_AUTH_PENDING");
    assert.equal(runRow(db)["current_step"], "waiting_for_tool_authentication");
    assert.equal(runRow(db)["sarvam_agent_id"], "Cust-agent-1");
    assert.equal(runRow(db)["current_job_step"], "authorizing_tools");
    assert.equal(events(db, "agent_tools_created").length, 1);
    assert.equal(num(db, "num_new")["status"], "provisioning", "never active while pending");
    assert.equal(dep.calls.create, 0);
    assert.equal(
      db.tables["agent_configs"]![0]!["sarvam_app_id"],
      null,
      "no version registered yet",
    );
    const list = await listWorkOrders(db.client);
    assert.equal(list[0]!.stage, "needs_tool_authentication");
    assert.equal(list[0]!.agentId, "Cust-agent-1");
    const view = await loadActivationView(db.client, ORG);
    assert.equal(view.phase, "waiting");
    assert.notEqual(view.phase, "completed");
    assert.doesNotMatch(JSON.stringify(view), /Cust-agent-1|credential|Sarvam/i);
  });

  test("the pending job can be resumed any number of times without progressing", async () => {
    const { db, d, id } = await openOrder();
    await call(db, d, "report_tools_created", reportArgs(id));
    const dep = pipeline(db);
    for (let i = 0; i < 3; i++) await runWith(db, dep, { force: true });
    assert.equal(runRow(db)["status"], "waiting");
    assert.equal(dep.calls.create, 0);
    assert.equal(num(db, "num_new")["status"], "provisioning");
    assert.equal(db.tables["provisioning_runs"]!.length, 1, "one job throughout");
  });

  test("submit before the tools were reported is refused: the checkpoint cannot be skipped", async () => {
    const { db, d, id, order } = await openOrder();
    const r = await call(db, d, "submit_agent_result", {
      workOrderId: id,
      agentId: "Cust-agent-1",
      version: 3,
      fingerprint: order.fingerprint,
      toolAuth: bearer,
    });
    assert.equal(r.body.error, "conflict");
    assert.match(r.body.message, /report_tools_created/);
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_id"], null);
    assert.equal(num(db, "num_new")["status"], "provisioning");
  });

  test("a committed version without credentials on every tool is refused, naming the tools", async () => {
    const { db, d, id, order } = await openOrder();
    await call(db, d, "report_tools_created", reportArgs(id));
    const partial = SIX.map((name, i) => ({ name, authType: i < 3 ? "bearer" : "none" }));
    const r = await call(db, d, "submit_agent_result", {
      workOrderId: id,
      agentId: "Cust-agent-1",
      version: 3,
      fingerprint: order.fingerprint,
      toolAuth: partial,
    });
    assert.equal(r.body.error, "conflict");
    assert.match(r.body.message, /book_appointment/);
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_id"], null);
    assert.equal(num(db, "num_new")["status"], "provisioning");
    assert.equal(runRow(db)["status"], "waiting");
  });

  test("evidence for fewer or different tools is invalid", async () => {
    const { db, d, id, order } = await openOrder();
    await call(db, d, "report_tools_created", reportArgs(id));
    const r = await call(db, d, "submit_agent_result", {
      workOrderId: id,
      agentId: "Cust-agent-1",
      version: 3,
      fingerprint: order.fingerprint,
      toolAuth: bearer.slice(0, 5),
    });
    assert.equal(r.body.error, "invalid");
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_id"], null);
  });

  test("resume after the credentials: the SAME job registers the committed version, deploys once and activates", async () => {
    const { db, d, id, order } = await openOrder();
    await call(db, d, "report_tools_created", reportArgs(id));
    assert.equal(runRow(db)["status"], "waiting");
    const done = await call(db, d, "submit_agent_result", {
      workOrderId: id,
      agentId: "Cust-agent-1",
      version: 3,
      fingerprint: order.fingerprint,
      toolAuth: bearer,
    });
    assert.deepEqual(done.body, { status: "registered", jobResumed: true });
    assert.equal(db.tables["provisioning_runs"]!.length, 1, "same job");
    assert.equal(runRow(db)["status"], "succeeded");
    assert.equal(num(db, "num_new")["status"], "active");
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_version"], 3);
    assert.equal(events(db, "tool_auth_confirmed").length, 1);
    const confirmed = events(db, "tool_auth_confirmed")[0]!["detail"] as { tools: unknown[] };
    assert.equal(confirmed.tools.length, 6);
    assert.doesNotMatch(JSON.stringify(events(db)), /Bearer [A-Za-z0-9]{12}|secret_id/);
    // Idempotent: submitting again changes nothing and deploys nothing more.
    const again = await call(db, d, "submit_agent_result", {
      workOrderId: id,
      agentId: "Cust-agent-1",
      version: 3,
      fingerprint: order.fingerprint,
      toolAuth: bearer,
    });
    assert.equal(again.body.status, "already_registered");
    assert.equal(events(db, "tool_auth_confirmed").length, 1);
  });

  test("a NEW committed version needs its own confirmation: the old one never satisfies the gate", async () => {
    const db = waitingWorld();
    await runWith(db);
    db.tables["agent_configs"]![0]!["sarvam_app_id"] = "Cust-agent-1";
    db.tables["agent_configs"]![0]!["sarvam_app_version"] = 4;
    Object.assign(db.tables["agent_voice_language_settings"]![0]!, {
      status: "applied",
      applied_sarvam_app_id: "Cust-agent-1",
      applied_sarvam_app_version: 4,
    });
    db.tables["provisioning_run_events"] = [
      { organization_id: ORG, event: "agent_tools_created", detail: { appId: "Cust-agent-1" } },
      {
        organization_id: ORG,
        event: "tool_auth_confirmed",
        detail: { appId: "Cust-agent-1", version: 3 },
      },
    ];
    const r = await runWith(db, pipeline(db), { force: true });
    assert.equal(r.result?.state, "waiting_for_tool_authentication");
    assert.equal(num(db, "num_new")["status"], "provisioning");
  });
});

describe("report_tools_created validation and idempotency", () => {
  test("only the committed master version, the right master, and exactly the six tools", async () => {
    const { db, d, id } = await openOrder();
    const bad = async (over: Record<string, unknown>) =>
      (await call(db, d, "report_tools_created", reportArgs(id, over))).body;
    assert.equal(
      (await bad({ clonedFrom: { agentId: "Master-agent", version: 3 } })).error,
      "conflict",
    );
    assert.equal(
      (await bad({ clonedFrom: { agentId: "Some-other-agent", version: 2 } })).error,
      "conflict",
    );
    assert.equal(
      (await bad({ agentId: "Master-agent" })).error,
      "conflict",
      "the master is never a customer agent",
    );
    assert.equal(
      (await bad({ tools: SIX.slice(0, 5) })).error,
      "invalid",
      "partial tool creation is not reportable",
    );
    assert.equal((await bad({ tools: [...SIX.slice(0, 5), "send_reminder"] })).error, "invalid");
    assert.equal(events(db, "agent_tools_created").length, 0, "nothing recorded for any refusal");
    assert.equal(runRow(db)["current_step"], "waiting_for_agent");
  });

  test("recovery from partial tool creation: the complete report is accepted once the missing tool exists", async () => {
    const { db, d, id } = await openOrder();
    const partial = await call(
      db,
      d,
      "report_tools_created",
      reportArgs(id, { tools: SIX.slice(0, 4) }),
    );
    assert.equal(partial.isError, true);
    const full = await call(db, d, "report_tools_created", reportArgs(id));
    assert.equal(full.body.status, "recorded");
    assert.equal(events(db, "agent_tools_created").length, 1);
  });

  test("the same agent again is a no-op; a second, different agent is refused (no duplicate agents)", async () => {
    const { db, d, id } = await openOrder();
    await call(db, d, "report_tools_created", reportArgs(id));
    const again = await call(db, d, "report_tools_created", reportArgs(id));
    assert.equal(again.body.status, "already_reported");
    assert.equal(events(db, "agent_tools_created").length, 1);
    const other = await call(
      db,
      d,
      "report_tools_created",
      reportArgs(id, { agentId: "Cust-agent-2" }),
    );
    assert.equal(other.body.error, "conflict");
    assert.match(other.body.message, /Cust-agent-1/);
    assert.equal(runRow(db)["sarvam_agent_id"], "Cust-agent-1");
  });

  test("another customer's agent can never be reported", async () => {
    const { db, d, id } = await openOrder();
    const r = await call(db, d, "report_tools_created", reportArgs(id, { agentId: "Other-app" }));
    assert.equal(r.body.error, "conflict");
    assert.match(r.body.message, /another customer/);
    assert.equal(db.tables["agent_configs"]![1]!["sarvam_app_id"], "Other-app");
  });
});

describe("isolation and live protection", () => {
  test("one customer's events never satisfy or trigger another customer's checkpoint", async () => {
    const db = waitingWorld();
    db.tables["provisioning_run_events"] = [
      { organization_id: OTHER, event: "agent_tools_created", detail: { appId: "Cust-agent-1" } },
      {
        organization_id: OTHER,
        event: "tool_auth_confirmed",
        detail: { appId: "Cust-agent-1", version: 3 },
      },
    ];
    assert.deepEqual(
      await toolAuthStatus(db.client, { organizationId: ORG, appId: "Cust-agent-1", version: 3 }),
      { required: false, confirmed: false },
    );
    assert.deepEqual(
      await toolAuthStatus(db.client, { organizationId: OTHER, appId: "Cust-agent-1", version: 3 }),
      { required: true, confirmed: true },
    );
  });

  test("a live number and a hand-registered agent are never gated", async () => {
    // A live customer: agent registered by hand (no bridge events), number already active.
    const db = world({ numberStatus: "active", deploymentId: "dep-new" });
    Object.assign(db.tables["phone_numbers"]![0]!, {
      inbound_enabled: true,
      verified_deployment_id: "dep-new",
      verified_sarvam_app_id: "Customer-app-1",
      verified_sarvam_app_version: 1,
      deployment_verified_at: "2026-11-14T10:00:00Z",
    });
    const r = await runProvisioningPipeline(db.client, ORG, deps(db).d);
    assert.notEqual(r.state, "waiting_for_tool_authentication");
    // Even with bridge events on file, a LIVE number is only re-verified, never parked.
    db.tables["provisioning_run_events"] = [
      { organization_id: ORG, event: "agent_tools_created", detail: { appId: "Customer-app-1" } },
    ];
    const live = await runProvisioningPipeline(db.client, ORG, deps(db).d);
    assert.notEqual(live.state, "waiting_for_tool_authentication");
    assert.equal(
      num(db, "num_other")["provider_deployment_id"],
      "dep-other",
      "other tenant untouched",
    );
  });

  test("the sweep resumes a tool-authentication job only once an agent version is registered", async () => {
    const { db, d, id } = await openOrder();
    await call(db, d, "report_tools_created", reportArgs(id));
    const started: string[] = [];
    const sweep = () =>
      sweepProvisioningRetries(db.client, {
        now: NOW,
        run: async (_a, i) => {
          started.push(i.organizationId);
          return { runId: id, claimed: true, status: "succeeded", result: null };
        },
      });
    await sweep();
    assert.deepEqual(started, [], "waiting on the credentials: nothing to resume");
    db.tables["agent_configs"]![0]!["sarvam_app_id"] = "Cust-agent-1";
    await sweep();
    assert.deepEqual(started, [ORG]);
  });
});

describe("what the customer and the admin see", () => {
  test("the job has an explicit 'securing connections' step; the customer message is generic", async () => {
    assert.ok(JOB_STEP_KEYS.includes("authorizing_tools"));
    assert.ok(
      JOB_STEP_KEYS.indexOf("authorizing_tools") > JOB_STEP_KEYS.indexOf("verifying_agent"),
    );
    assert.ok(
      JOB_STEP_KEYS.indexOf("authorizing_tools") < JOB_STEP_KEYS.indexOf("creating_deployment"),
    );
    const { db, d, id } = await openOrder();
    await call(db, d, "report_tools_created", reportArgs(id));
    const row = runRow(db) as Parameters<typeof customerJobView>[0] & Record<string, unknown>;
    const view = customerJobView(row, false);
    assert.equal(view.currentStep, "authorizing_tools");
    assert.equal(view.steps.find((s) => s.key === "authorizing_tools")!.status, "waiting");
    assert.equal(view.steps.find((s) => s.key === "creating_deployment")!.status, "pending");
    assert.match(view.message, /securing/i);
  });
});
