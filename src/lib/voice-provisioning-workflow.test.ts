import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runProvisioningPipeline, type PipelineDeps } from "./provisioning-pipeline.server.ts";
import { runProvisioning, sweepProvisioningRetries } from "./provisioning-runs.server.ts";
import { loadActivationView, startVoiceActivation } from "./voice-activation.server.ts";
import {
  ensureCustomerAgent,
  customerAgentName,
  type AgentProvisioner,
  type ProviderError,
} from "./sarvam-agent-provisioner.server.ts";
import { MAX_AUTOMATIC_ATTEMPTS } from "./voice-provisioning-job.ts";
import { ORG, OTHER, snapshot, world, deps, num } from "./provisioning-test-world.test-helper.ts";

/**
 * The automated Voice AI provisioning job end to end, against an in-memory
 * database and MOCKED Sarvam (no provider is ever called). What these prove is
 * ClickAI's own orchestration: idempotency, retries, step state, isolation and
 * "never active before every check passes". Live provider behaviour is NOT
 * verified here (see docs/voice-ai-provisioning-workflow.md).
 */

type World = ReturnType<typeof world>;
const NOW = new Date("2026-11-25T10:00:00Z");
const run0 = (db: World, d: PipelineDeps, over: { force?: boolean; now?: () => Date } = {}) =>
  runProvisioning(
    db.client,
    { organizationId: ORG, trigger: "customer_activate", ...(over.force ? { force: true } : {}) },
    (a, o, hooks) => runProvisioningPipeline(a, o, d, hooks.onStep),
    over.now ?? (() => NOW),
  );
const runRow = (db: World, i = 0) => db.tables["provisioning_runs"]![i]!;
const events = (db: World) =>
  (db.tables["provisioning_run_events"] ?? []).map((e) => `${e["event"]}:${e["step"] ?? ""}`);
const notActive = (db: World) =>
  assert.notEqual(num(db, "num_new")["status"], "active", "the number must stay inactive");

/** A mock Sarvam agent API. */
function agentApi(over: Partial<AgentProvisioner> = {}) {
  const calls = { find: 0, create: 0, configure: 0, verify: 0 };
  let created: string | null = null;
  const p: AgentProvisioner = {
    supported: true,
    findAgentByName: async () => {
      calls.find++;
      return created ? { appId: created, version: null } : null;
    },
    createAgent: async () => {
      calls.create++;
      created = "Cust-agent-1";
      return { appId: created };
    },
    configureAgent: async () => {
      calls.configure++;
      return { version: 2 };
    },
    verifyAgent: async () => {
      calls.verify++;
      return { ok: true, detail: "" };
    },
    ...over,
  };
  return { p, calls, setCreated: (id: string) => (created = id) };
}
const withAgent = (db: World, p: AgentProvisioner, extra: Partial<PipelineDeps> = {}) => {
  // The mocked deployment reports the customer's new agent at the version configured above.
  const base = deps(db, { deployment: { appId: "Cust-agent-1", appVersion: 2 }, ...extra });
  base.d.ensureAgent = (admin, ctx) => ensureCustomerAgent(admin, ctx, p);
  return base;
};
const noAgentWorld = () => {
  const db = world({ appId: null });
  const vl = db.tables["agent_voice_language_settings"]![0]!;
  Object.assign(vl, {
    status: "draft",
    applied_sarvam_app_id: null,
    applied_sarvam_app_version: null,
  });
  db.tables["agent_configs"]![0]!["sarvam_app_version"] = null;
  return db;
};
const err = (message: string, e: Partial<ProviderError>) => Object.assign(new Error(message), e);

describe("valid activation", () => {
  test("completes every step in order, records state, and only then activates the number", async () => {
    const db = world();
    const { d, calls } = deps(db);
    const r = await run0(db, d);
    assert.equal(r.status, "succeeded");
    const run = runRow(db);
    assert.equal(run["current_job_step"], "complete");
    assert.equal(run["last_checkpoint"], "complete");
    assert.equal(run["failure_code"], null);
    const states = run["step_states"] as Record<string, { status: string }>;
    for (const k of [
      "validating",
      "preparing",
      "creating_agent",
      "verifying_agent",
      "creating_deployment",
      "verifying_deployment",
      "connecting_number",
      "verifying_number",
      "activating",
      "complete",
    ])
      assert.equal(states[k]?.status, "done", k);
    assert.equal(num(db, "num_new")["status"], "active");
    assert.equal(calls.create, 1);
    assert.deepEqual(
      events(db).filter((e) => e.startsWith("step_started")),
      [
        "step_started:validating",
        "step_started:preparing",
        "step_started:creating_agent",
        "step_started:verifying_agent",
        "step_started:creating_deployment",
        "step_started:verifying_deployment",
        "step_started:connecting_number",
        "step_started:verifying_number",
        "step_started:activating",
      ],
      "progress is the real order of work",
    );
    assert.ok(events(db).includes("started:"));
    assert.ok(events(db).includes("succeeded:complete"));
    const view = await loadActivationView(db.client, ORG);
    assert.equal(view.phase, "completed");
    assert.equal(view.numberMasked, "••••0002");
  });
});

describe("validation stops before any provider work", () => {
  test("invalid onboarding (no agent/business yet)", async () => {
    const db = world();
    db.tables["agent_configs"]![0]!["business_id"] = null;
    const { d, calls } = deps(db);
    const r = await run0(db, d);
    assert.equal(r.status, "waiting");
    assert.equal(runRow(db)["failure_code"], "ONBOARDING_INCOMPLETE");
    assert.equal(runRow(db)["current_job_step"], "validating");
    assert.equal(calls.create, 0);
    notActive(db);
  });

  test("missing business info for an enabled capability", async () => {
    const db = world();
    const { d, calls } = deps(db, {
      loadSnapshot: async () => ({ ...snapshot({ calendar_book: true }), services: [] }),
    });
    await run0(db, d);
    assert.equal(runRow(db)["failure_code"], "ONBOARDING_INCOMPLETE");
    assert.equal(calls.create, 0);
    notActive(db);
  });

  test("invalid / missing business category", async () => {
    const db = world();
    const { d } = deps(db, {
      loadSnapshot: async () => {
        const s = snapshot();
        s.business.business_type = "  ";
        return s;
      },
    });
    const r = await run0(db, d);
    assert.equal(r.status, "waiting");
    assert.match(String(runRow(db)["note"]), /category is missing/);
    notActive(db);
  });

  test("missing phone number", async () => {
    const db = world();
    db.tables["phone_numbers"] = db.tables["phone_numbers"]!.filter(
      (n) => n["organization_id"] !== ORG,
    );
    const r = await run0(db, deps(db).d);
    assert.equal(r.status, "waiting");
    assert.equal(runRow(db)["failure_code"], "NUMBER_NOT_ASSIGNED");
  });

  test("a number that belongs to another tenant is never used or touched", async () => {
    const db = world();
    // ORG has no number of its own; the only number belongs to OTHER and is live.
    db.tables["phone_numbers"] = db.tables["phone_numbers"]!.filter(
      (n) => n["organization_id"] !== ORG,
    );
    const before = JSON.stringify(num(db, "num_other"));
    const { d, calls } = deps(db);
    await run0(db, d);
    assert.equal(runRow(db)["failure_code"], "NUMBER_NOT_ASSIGNED");
    assert.equal(calls.create, 0);
    assert.equal(JSON.stringify(num(db, "num_other")), before);
  });

  test("a deployment already recorded for another customer's number stops for a person", async () => {
    const db = world({ deploymentId: "dep-other" });
    const r = await run0(db, deps(db).d);
    assert.equal(r.status, "failed");
    assert.equal(runRow(db)["failure_code"], "NUMBER_UNUSABLE");
    assert.equal(runRow(db)["retryable"], false);
    notActive(db);
  });

  test("a suspended number is a permanent failure", async () => {
    const db = world({ numberStatus: "suspended" });
    await run0(db, deps(db).d);
    assert.equal(runRow(db)["failure_code"], "NUMBER_UNUSABLE");
    assert.equal(runRow(db)["status"], "failed");
  });
});

describe("agent creation (mocked provider API)", () => {
  test("unsupported provider: waits honestly, nothing faked", async () => {
    const db = noAgentWorld();
    const { d, calls } = deps(db); // no ensureAgent: Sarvam has no documented create API
    const r = await run0(db, d);
    assert.equal(r.status, "waiting");
    assert.equal(runRow(db)["failure_code"], "PROVIDER_CAPABILITY_UNVERIFIED");
    assert.equal(runRow(db)["current_job_step"], "creating_agent");
    assert.equal(calls.create, 0);
    const view = await loadActivationView(db.client, ORG);
    assert.equal(view.phase, "waiting");
    assert.doesNotMatch(view.message, /Sarvam/);
    notActive(db);
  });

  test("create → configure → verify → register → deploy → activate", async () => {
    const db = noAgentWorld();
    const api = agentApi();
    const { d } = withAgent(db, api.p);
    const r = await run0(db, d);
    assert.equal(r.status, "succeeded", String(runRow(db)["note"]));
    assert.deepEqual([api.calls.create, api.calls.configure, api.calls.verify], [1, 1, 1]);
    const agent = db.tables["agent_configs"]![0]!;
    assert.equal(agent["sarvam_app_id"], "Cust-agent-1");
    assert.equal(agent["sarvam_app_version"], 2);
    const vl = db.tables["agent_voice_language_settings"]![0]!;
    assert.equal(vl["status"], "applied");
    assert.equal(vl["applied_sarvam_app_id"], "Cust-agent-1");
    assert.equal(runRow(db)["sarvam_agent_id"], "Cust-agent-1");
    assert.equal(num(db, "num_new")["status"], "active");
  });

  test("definite create refusal is permanent", async () => {
    const db = noAgentWorld();
    const api = agentApi({
      createAgent: async () => {
        throw err("bad template", { status: 400, outcomeUnknown: false });
      },
    });
    const r = await run0(db, withAgent(db, api.p).d);
    assert.equal(r.status, "failed");
    assert.equal(runRow(db)["failure_code"], "AGENT_CREATE_FAILED");
    assert.equal(runRow(db)["retryable"], false);
    assert.equal(runRow(db)["next_attempt_at"], null, "no endless retry of a permanent failure");
    notActive(db);
  });

  test("timeout with nothing created: retry later, never recreate blindly", async () => {
    const db = noAgentWorld();
    const api = agentApi({
      createAgent: async () => {
        throw err("timeout", { outcomeUnknown: true });
      },
    });
    const r = await run0(db, withAgent(db, api.p).d);
    assert.equal(r.status, "pending");
    assert.equal(runRow(db)["failure_code"], "AGENT_CREATE_AMBIGUOUS");
    assert.ok(runRow(db)["next_attempt_at"], "a retry is scheduled");
    assert.equal(api.calls.find, 2, "looked the agent up again after the lost answer");
  });

  test("timeout but the agent exists: it is adopted and nothing is created twice", async () => {
    const db = noAgentWorld();
    const api = agentApi();
    api.p.createAgent = async () => {
      api.calls.create++;
      api.setCreated("Cust-agent-1"); // the provider did create it; the answer was lost
      throw err("timeout", { outcomeUnknown: true });
    };
    const r = await run0(db, withAgent(db, api.p).d);
    assert.equal(r.status, "succeeded", String(runRow(db)["note"]));
    assert.equal(api.calls.create, 1);
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_id"], "Cust-agent-1");
  });

  test("a retry after an ambiguous timeout looks first and finds the agent", async () => {
    const db = noAgentWorld();
    const api = agentApi();
    let first = true;
    const realCreate = api.p.createAgent;
    api.p.createAgent = async (i) => {
      if (first) {
        first = false;
        api.calls.create++;
        api.setCreated("Cust-agent-1");
        throw err("timeout", { outcomeUnknown: true });
      }
      return realCreate(i);
    };
    // The first attempt's follow-up lookup also fails, so the outcome stays ambiguous.
    let lookups = 0;
    const realFind = api.p.findAgentByName;
    api.p.findAgentByName = async (n) => {
      lookups++;
      if (lookups === 2) throw err("lookup timeout", { outcomeUnknown: true });
      return realFind(n);
    };
    const { d } = withAgent(db, api.p);
    assert.equal((await run0(db, d)).status, "pending");
    const second = await run0(db, d, { force: true });
    assert.equal(second.status, "succeeded", String(runRow(db)["note"]));
    assert.equal(api.calls.create, 1, "exactly one agent was ever created");
  });

  test("configuration failure: permanent for a refusal, retried for a 5xx", async () => {
    const dbA = noAgentWorld();
    const a = agentApi({
      configureAgent: async () => {
        throw err("invalid voice", { status: 422, outcomeUnknown: false });
      },
    });
    await run0(dbA, withAgent(dbA, a.p).d);
    assert.equal(runRow(dbA)["failure_code"], "AGENT_CONFIG_FAILED");
    assert.equal(runRow(dbA)["status"], "failed");
    assert.equal(runRow(dbA)["current_job_step"], "configuring_agent");
    notActive(dbA);

    const dbB = noAgentWorld();
    const b = agentApi({
      configureAgent: async () => {
        throw err("unavailable", { status: 503 });
      },
    });
    await run0(dbB, withAgent(dbB, b.p).d);
    assert.equal(runRow(dbB)["status"], "pending");
    assert.equal(runRow(dbB)["retryable"], true);
    notActive(dbB);
  });

  test("agent verification failure is retried and the agent is not registered", async () => {
    const db = noAgentWorld();
    const api = agentApi({ verifyAgent: async () => ({ ok: false, detail: "tools differ" }) });
    await run0(db, withAgent(db, api.p).d);
    assert.equal(runRow(db)["failure_code"], "AGENT_VERIFY_FAILED");
    assert.equal(runRow(db)["current_job_step"], "verifying_agent");
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_id"], null, "not registered");
    notActive(db);
  });

  test("a master template is never mapped to a customer", async () => {
    const db = noAgentWorld();
    const api = agentApi({
      findAgentByName: async () => ({ appId: "Master-agent", version: 1 }),
    });
    await run0(db, withAgent(db, api.p).d);
    assert.equal(runRow(db)["failure_code"], "AGENT_MAPPING_INVALID");
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_id"], null);
  });

  test("the agent name is deterministic per customer", () => {
    assert.equal(customerAgentName("12345678-aaaa", "abcdef12-bbbb"), "clickai-12345678-abcdef12");
  });
});

describe("deployment, mapping and verification", () => {
  test("deployment creation failure is retried; a definite refusal is permanent", async () => {
    const db = world();
    const { d } = deps(db, {
      createDeployment: async () => {
        throw err("Sarvam unavailable", { status: 503 });
      },
    });
    const r = await run0(db, d);
    assert.equal(r.status, "pending");
    assert.equal(runRow(db)["failure_code"], "DEPLOYMENT_CREATE_FAILED");
    assert.equal(runRow(db)["current_job_step"], "creating_deployment");
    notActive(db);

    const db2 = world();
    const { d: d2 } = deps(db2, {
      createDeployment: async () => {
        throw Object.assign(new Error("number unknown"), { status: 404, outcomeUnknown: false });
      },
    });
    await run0(db2, d2);
    assert.equal(runRow(db2)["status"], "failed");
    assert.equal(runRow(db2)["failure_code"], "PROVIDER_ACTION_REQUIRED");
    assert.equal(runRow(db2)["retryable"], false);
  });

  test("deployment verification failure (wrong agent version) names the exact step", async () => {
    const db = world();
    const { d } = deps(db, { deployment: { appVersion: 9 } });
    const r = await run0(db, d);
    assert.equal(r.status, "pending");
    assert.equal(runRow(db)["failure_code"], "DEPLOYMENT_VERIFY_FAILED");
    assert.equal(runRow(db)["current_job_step"], "verifying_deployment");
    const states = runRow(db)["step_states"] as Record<string, { status: string }>;
    assert.equal(states["verifying_deployment"]!.status, "failed");
    assert.equal(states["verifying_number"], undefined);
    notActive(db);
  });

  test("number mapping failure: Sarvam does not route the assigned number", async () => {
    const db = world();
    const { d } = deps(db, { deployment: { phoneNumbers: ["+919999999999"] } });
    await run0(db, d);
    assert.equal(runRow(db)["failure_code"], "NUMBER_MAPPING_FAILED");
    assert.equal(runRow(db)["current_job_step"], "verifying_number");
    assert.equal(
      num(db, "num_new")["verified_deployment_id"] ?? null,
      null,
      "nothing marked verified",
    );
    notActive(db);
  });

  test("mapping success: the number points at this customer's deployment only", async () => {
    const db = world();
    await run0(db, deps(db).d);
    const n = num(db, "num_new");
    assert.equal(n["provider_deployment_id"], "dep-new");
    assert.equal(n["verified_deployment_id"], "dep-new");
    assert.equal(n["organization_id"], ORG);
    assert.equal(num(db, "num_other")["provider_deployment_id"], "dep-other");
  });
});

describe("retry, recovery and idempotency", () => {
  test("partial provider success: the deployment is adopted on retry, never created twice", async () => {
    const db = world();
    const first = deps(db, { resumeFails: true });
    const r1 = await run0(db, first.d);
    assert.equal(r1.status, "pending", "resume failed after the deployment existed");
    assert.equal(first.calls.create, 1);
    assert.equal(runRow(db)["last_checkpoint"], "verifying_number");
    notActive(db);
    const second = deps(db, { initialStatus: "paused" });
    const r2 = await run0(db, second.d, { force: true });
    assert.equal(r2.status, "succeeded", String(runRow(db)["note"]));
    assert.equal(second.calls.create, 0, "the existing deployment was reused");
    assert.equal(db.tables["provisioning_runs"]!.length, 1, "same job resumed, not a new one");
    assert.equal(runRow(db)["attempts"], 2);
    assert.equal(num(db, "num_new")["status"], "active");
  });

  test("a scheduled retry waits for its time; an admin retry runs now", async () => {
    const db = world();
    await run0(db, deps(db, { deployment: { appVersion: 9 } }).d);
    assert.equal(runRow(db)["status"], "pending");
    const early = await run0(db, deps(db).d);
    assert.equal(early.claimed, false);
    const admin = await run0(db, deps(db).d, { force: true });
    assert.equal(admin.claimed, true);
    assert.equal(admin.status, "succeeded");
    const later = new Date(NOW.getTime() + 24 * 3600_000);
    const db2 = world();
    await run0(db2, deps(db2, { deployment: { appVersion: 9 } }).d);
    const due = await run0(db2, deps(db2).d, { now: () => later });
    assert.equal(due.status, "succeeded", "the automatic retry ran once due");
  });

  test("retries are bounded: then the job stops, retryable by hand, with an exact code", async () => {
    const db = world();
    const bad = deps(db, { deployment: { appVersion: 9 } }).d;
    let last = await run0(db, bad);
    for (let i = 1; i < MAX_AUTOMATIC_ATTEMPTS; i++) last = await run0(db, bad, { force: true });
    assert.equal(last.status, "failed");
    assert.equal(runRow(db)["failure_code"], "RETRIES_EXHAUSTED");
    assert.equal(runRow(db)["retryable"], true);
    assert.equal(runRow(db)["next_attempt_at"], null);
    assert.equal(runRow(db)["attempts"], MAX_AUTOMATIC_ATTEMPTS);
    notActive(db);
    // The customer's "Try again" starts a fresh job that resumes from real state and succeeds.
    const view = await loadActivationView(db.client, ORG);
    assert.equal(view.phase, "failed");
    assert.equal(view.canRetry, true);
    const good = deps(db, { initialStatus: "paused" }).d;
    const after = await startVoiceActivation(db.client, { orgId: ORG, userId: "u1" }, (a, i) =>
      runProvisioning(
        a,
        i,
        (x, o, h) => runProvisioningPipeline(x, o, good, h.onStep),
        () => NOW,
      ),
    );
    assert.equal(after.phase, "completed");
    assert.equal(db.tables["provisioning_runs"]!.length, 2, "history kept: old job + new job");
  });

  test("a permanent failure is not retried by the sweeper and shows no retry button", async () => {
    const db = world({ deploymentId: "dep-other" });
    await run0(db, deps(db).d);
    const view = await loadActivationView(db.client, ORG);
    assert.equal(view.phase, "failed");
    assert.equal(view.canRetry, false);
    assert.equal(runRow(db)["next_attempt_at"], null);
  });

  test("idempotent reprocessing: running again after success changes nothing", async () => {
    const db = world();
    const d = deps(db);
    await run0(db, d.d);
    const snapshotBefore = JSON.stringify(db.tables["phone_numbers"]);
    const again = await run0(db, d.d);
    assert.equal(again.status, "succeeded");
    assert.equal(d.calls.create, 1, "no second deployment");
    assert.equal(d.calls.pause, 1, "a live number is never paused again");
    assert.equal(
      JSON.stringify(db.tables["phone_numbers"]).replace(
        /"(deployment_verified_at|updated_at)":"[^"]*"/g,
        "",
      ),
      snapshotBefore.replace(/"(deployment_verified_at|updated_at)":"[^"]*"/g, ""),
    );
    assert.equal(db.tables["phone_numbers"]!.filter((n) => n["status"] === "active").length, 2);
  });
});

describe("duplicate clicks and concurrency", () => {
  test("two simultaneous clicks start one job and one deployment", async () => {
    const db = world();
    const d = deps(db);
    const start = () =>
      startVoiceActivation(db.client, { orgId: ORG, userId: "u1" }, (a, i) =>
        runProvisioning(
          a,
          i,
          (x, o, h) => runProvisioningPipeline(x, o, d.d, h.onStep),
          () => NOW,
        ),
      );
    const [a, b] = await Promise.all([start(), start()]);
    assert.equal(db.tables["provisioning_runs"]!.length, 1);
    assert.equal(d.calls.create, 1);
    assert.ok([a, b].some((v) => v.phase === "completed"));
    assert.equal(num(db, "num_new")["status"], "active");
  });

  test("five concurrent requests (clicks, retries, webhooks) never duplicate work", async () => {
    const db = world();
    const d = deps(db);
    const results = await Promise.all(Array.from({ length: 5 }, () => run0(db, d.d)));
    assert.equal(db.tables["provisioning_runs"]!.length, 1);
    assert.equal(d.calls.create, 1);
    assert.equal(results.filter((r) => r.claimed).length, 1, "exactly one worker held the job");
  });

  test("a click while the job is running is a no-op that reports the real step", async () => {
    const db = world();
    let seen: Awaited<ReturnType<typeof loadActivationView>> | null = null;
    let second: Awaited<ReturnType<typeof startVoiceActivation>> | null = null;
    const d = deps(db);
    const inner = d.d.createDeployment;
    d.d.createDeployment = async (a, p) => {
      seen = await loadActivationView(db.client, ORG);
      second = await startVoiceActivation(db.client, { orgId: ORG, userId: "u1" }, () => {
        throw new Error("must not start a second run");
      });
      return inner(a, p);
    };
    await run0(db, d.d);
    assert.equal(seen!.phase, "running", "progress comes from the backend, not the browser");
    assert.equal(seen!.busy, true);
    assert.equal(seen!.currentStep, "creating_deployment");
    const byKey = Object.fromEntries(seen!.steps.map((s) => [s.key, s.status]));
    assert.equal(byKey["validating"], "done");
    assert.equal(byKey["creating_agent"], "done");
    assert.equal(byKey["creating_deployment"], "running");
    assert.equal(byKey["verifying_deployment"], "pending");
    assert.equal(byKey["complete"], "pending");
    assert.equal(second!.busy, true);
    assert.equal(d.calls.create, 1);
  });

  test("an already live number: a click starts nothing", async () => {
    const db = world();
    await run0(db, deps(db).d);
    const view = await startVoiceActivation(db.client, { orgId: ORG, userId: "u1" }, () => {
      throw new Error("must not run");
    });
    assert.equal(view.phase, "completed");
  });
});

describe("tenant isolation and safe views", () => {
  test("a customer's view never includes another tenant's job or number", async () => {
    const db = world();
    await run0(db, deps(db).d);
    db.tables["provisioning_runs"]!.push({
      id: "run_other",
      organization_id: OTHER,
      status: "failed",
      attempts: 3,
      current_job_step: "creating_deployment",
      step_states: {},
      customer_message: "other tenant message",
      retryable: false,
      created_at: "2099-01-01T00:00:00Z",
    });
    const mine = await loadActivationView(db.client, ORG);
    assert.equal(mine.phase, "completed");
    assert.doesNotMatch(JSON.stringify(mine), /other tenant|7900000001|dep-other/);
    const theirs = await loadActivationView(db.client, OTHER);
    assert.equal(theirs.phase, "failed", "their own job, from their own rows");
    assert.equal(theirs.message, "other tenant message");
    assert.equal(theirs.numberMasked, "••••0001");
  });

  test("the customer view carries no provider ids, secrets or full phone numbers", async () => {
    const db = world();
    await run0(db, deps(db, { deployment: { appVersion: 9 } }).d);
    const view = await loadActivationView(db.client, ORG);
    const text = JSON.stringify(view);
    assert.doesNotMatch(text, /dep-new|Customer-app|7900000002|Sarvam|token/i);
  });

  test("stored diagnostics are sanitized", async () => {
    const db = world();
    const { d } = deps(db, {
      createDeployment: async () => {
        throw err("failed https://api.sarvam.ai/x?token=abc123 Bearer sk-secret-value-123", {
          status: 500,
        });
      },
    });
    await run0(db, d);
    const text = JSON.stringify(runRow(db)["diagnostics"]) + String(runRow(db)["last_error"]);
    assert.doesNotMatch(text, /abc123|sk-secret|https:/);
  });
});

describe("the number is never activated unless every step passed", () => {
  const scenarios: [string, () => Promise<World>][] = [
    [
      "wrong agent version",
      async () => {
        const db = world();
        await run0(db, deps(db, { deployment: { appVersion: 9 } }).d);
        return db;
      },
    ],
    [
      "webhook missing",
      async () => {
        const db = world();
        await run0(db, deps(db, { deployment: { webhookUrlConfigured: false } }).d);
        return db;
      },
    ],
    [
      "routes another number",
      async () => {
        const db = world();
        await run0(db, deps(db, { deployment: { phoneNumbers: ["+910000000000"] } }).d);
        return db;
      },
    ],
    [
      "resume fails",
      async () => {
        const db = world();
        await run0(db, deps(db, { resumeFails: true }).d);
        return db;
      },
    ],
    [
      "unsupported agent step",
      async () => {
        const db = noAgentWorld();
        await run0(db, deps(db).d);
        return db;
      },
    ],
  ];
  for (const [name, build] of scenarios)
    test(name, async () => {
      const db = await build();
      notActive(db);
      assert.notEqual(runRow(db)["status"], "succeeded");
      assert.equal(num(db, "num_new")["inbound_enabled"], false);
    });
});

describe("admin visibility", () => {
  test("queue states: retrying and stuck are distinguished", async () => {
    const { queueStatus } = await import("./provisioning-view.ts");
    assert.equal(
      queueStatus({
        status: "pending",
        current_step: null,
        attempts: 1,
        next_attempt_at: "2026-01-01T00:00:00Z",
      }),
      "retrying",
    );
    assert.equal(
      queueStatus(
        { status: "running", current_step: null, updated_at: "2026-01-01T00:00:00Z" },
        new Date("2026-01-01T01:00:00Z").getTime(),
      ),
      "stuck",
    );
    assert.equal(queueStatus({ status: "failed", current_step: null }), "failed");
  });
});

describe("scheduled sweep and retry bound", () => {
  const sweep = (db: World, now = NOW) => {
    const started: string[] = [];
    return sweepProvisioningRetries(db.client, {
      now,
      run: async (_a, i) => {
        started.push(`${i.organizationId}:${i.trigger}`);
        return { runId: "r", claimed: true, status: "succeeded", result: null };
      },
    }).then((r) => ({ ...r, started }));
  };

  test("a due retry is resumed; a future one is not", async () => {
    const db = world();
    await run0(db, deps(db, { deployment: { appVersion: 9 } }).d);
    assert.equal((await sweep(db)).started.length, 0, "not due yet");
    const later = new Date(NOW.getTime() + 24 * 3600_000);
    assert.deepEqual((await sweep(db, later)).started, [`${ORG}:customer_activate`]);
  });

  test("a crashed (stale running) job is picked up", async () => {
    const db = world();
    await run0(db, deps(db).d);
    Object.assign(runRow(db), { status: "running", finished_at: null });
    runRow(db)["updated_at"] = new Date(NOW.getTime() - 3600_000).toISOString();
    const r = await sweep(db);
    assert.equal(r.stuck, 1);
    assert.equal(r.started.length, 1);
  });

  test("a customer job waiting for the agent continues once the agent is registered, not before", async () => {
    const db = noAgentWorld();
    await run0(db, deps(db).d);
    assert.equal(runRow(db)["status"], "waiting");
    assert.equal((await sweep(db)).started.length, 0, "still no agent");
    Object.assign(db.tables["agent_configs"]![0]!, {
      sarvam_app_id: "Hand-made-1",
      sarvam_app_version: 1,
    });
    assert.deepEqual((await sweep(db)).started, [`${ORG}:customer_activate`]);
  });

  test("a waiting job started by another trigger is never resumed automatically", async () => {
    const db = noAgentWorld();
    await run0(db, deps(db).d);
    runRow(db)["trigger"] = "setup_fee";
    Object.assign(db.tables["agent_configs"]![0]!, {
      sarvam_app_id: "Hand-made-1",
      sarvam_app_version: 1,
    });
    assert.equal((await sweep(db)).started.length, 0);
  });

  test("clicks that only found the job waiting do not use up the retry bound", async () => {
    const db = noAgentWorld();
    for (let i = 0; i < MAX_AUTOMATIC_ATTEMPTS + 2; i++)
      await run0(db, deps(db).d, { force: true });
    assert.equal(runRow(db)["status"], "waiting");
    // One transient failure afterwards is still retried, not declared exhausted.
    Object.assign(db.tables["agent_configs"]![0]!, {
      sarvam_app_id: "Customer-app-1",
      sarvam_app_version: 1,
    });
    const vl = db.tables["agent_voice_language_settings"]![0]!;
    Object.assign(vl, {
      status: "applied",
      applied_sarvam_app_id: "Customer-app-1",
      applied_sarvam_app_version: 1,
    });
    await run0(db, deps(db, { deployment: { appVersion: 9 } }).d, { force: true });
    assert.equal(runRow(db)["status"], "pending");
    assert.equal(runRow(db)["failure_code"], "DEPLOYMENT_VERIFY_FAILED");
  });
});
