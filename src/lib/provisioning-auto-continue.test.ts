import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runProvisioningPipeline } from "./provisioning-pipeline.server.ts";
import {
  runProvisioning,
  sweepProvisioningRetries,
  type RunProvisioningInput,
} from "./provisioning-runs.server.ts";
import { startVoiceActivation } from "./voice-activation.server.ts";
import { listWorkOrders } from "./operator-bridge.server.ts";
import { CUSTOMER_PROBLEM, WAITING_STATES, classifyOutcome } from "./voice-provisioning-job.ts";
import { customerActivationStatus } from "./customer-activation-status.ts";
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
 * A customer's job continues by itself after each person's step: no Retry, only the minute
 * sweep. Real runner, pipeline and sweep against an in-memory database and a mocked Sarvam.
 * Each step changes rows the way the real action does; none of them calls the job.
 */

type World = ReturnType<typeof world>;
type Row = Record<string, unknown>;
type Admin = Parameters<typeof runProvisioning>[0];
const T0 = Date.parse("2026-11-28T10:00:00Z");

const table = (db: World, name: string) => (db.tables[name] ??= []);
const agent = (db: World) => table(db, "agent_configs")[0]!;
const number = (db: World) => num(db, "num_new");
const job = (db: World) => table(db, "provisioning_runs")[0]!;
const voice = (db: World) => table(db, "agent_voice_language_settings")[0]!;

/** A customer who has submitted a complete setup and for whom nobody has done anything yet. */
function untouched() {
  const db = world({ appId: null, outbound: false });
  const held = {
    voice: table(db, "agent_voice_language_settings").splice(0)[0]!,
    connection: table(db, "telephony_connections").splice(0, 1)[0]!,
    credential: table(db, "sarvam_agent_integrations").splice(0)[0]!,
  };
  Object.assign(number(db), { organization_id: null, sarvam_number_confirmed_at: null });
  return { db, held };
}

function harness(db: World, over: Parameters<typeof deps>[1] = {}) {
  let business = snapshot();
  const mock = deps(db, { loadSnapshot: async () => business, ...over });
  let minute = 0;
  const run = (a: Admin, i: RunProvisioningInput) =>
    runProvisioning(
      a,
      i,
      (x, o, h) => runProvisioningPipeline(x, o, mock.d, h.onStep),
      () => new Date(T0 + minute * 60_000),
    );
  const tick = () =>
    sweepProvisioningRetries(db.client, { now: new Date(T0 + ++minute * 60_000), run });
  return {
    db,
    mock,
    run,
    tick,
    setBusiness: (next: ReturnType<typeof snapshot>) => (business = next),
    submit: () =>
      startVoiceActivation(
        db.client,
        { orgId: ORG, userId: "owner_1" },
        run,
        () => new Date(T0),
        mock.d.loadSnapshot,
      ),
    /** Nothing changed: several sweep cycles leave the job exactly as it is. */
    async idle(label: string, cycles = 4) {
      const before = [job(db)["attempts"], job(db)["current_step"], mock.calls.log.length];
      for (let i = 0; i < cycles; i++) assert.equal((await tick()).processed, 0, label);
      assert.deepEqual(
        [job(db)["attempts"], job(db)["current_step"], mock.calls.log.length],
        before,
        label,
      );
    },
    /** One person's step, then sweeps only: exactly one resume, ending in `expected`. */
    async step(label: string, change: () => void, expected: string) {
      await this.idle(`${label}: before`);
      const attempts = Number(job(db)["attempts"]);
      change();
      assert.equal((await tick()).processed, 1, label);
      assert.equal(job(db)["current_step"], expected, `${label}: ${String(job(db)["note"])}`);
      assert.equal(job(db)["attempts"], attempts + 1, label);
      await this.idle(`${label}: after`);
    },
  };
}

/* The people's steps, as the real actions write them. */
const saveVoice = (db: World, held: Row) => () =>
  table(db, "agent_voice_language_settings").push({
    ...held,
    status: "pending",
    applied_sarvam_app_id: null,
    applied_sarvam_app_version: null,
  });
const assignNumber = (db: World) => () => (number(db)["organization_id"] = ORG);
const registerConnection = (db: World, held: Row) => () =>
  table(db, "telephony_connections").push(held);
const confirmNumber = (db: World) => () =>
  (number(db)["sarvam_number_confirmed_at"] = "2026-11-28T09:00:00Z");
const issueCredential = (db: World, held: Row) => () =>
  table(db, "sarvam_agent_integrations").push({ ...held, organization_id: ORG });
const registerAgent = (db: World) => () => {
  Object.assign(agent(db), { sarvam_app_id: "Customer-app-1", sarvam_app_version: 1 });
  Object.assign(voice(db), {
    status: "applied",
    applied_sarvam_app_id: "Customer-app-1",
    applied_sarvam_app_version: 1,
  });
};
const confirmInbound = (db: World) => () => confirmToolAuth(db, "Customer-app-1", 1);
const issueOutboundCredential = (db: World) => () =>
  table(db, "sarvam_agent_integrations").push({
    id: "int_out",
    organization_id: ORG,
    agent_config_id: "agent_new",
    status: "active",
    expires_at: null,
    role: "outbound",
  });
const registerOutbound = (db: World) => () =>
  Object.assign(agent(db), {
    sarvam_outbound_app_id: "Customer-out-1",
    sarvam_outbound_app_version: 1,
  });
const confirmOutbound = (db: World) => () =>
  confirmToolAuth(db, "Customer-out-1", 1, ORG, "outbound");

/** A job whose inbound number is live and which waits for the outbound agent's credentials. */
async function waitingForOutboundAuth() {
  const db = world({ outboundToolAuth: false });
  const h = harness(db);
  await h.submit();
  assert.equal(job(db)["current_step"], "waiting_for_outbound_tool_authentication");
  return h;
}

describe("a new customer goes from submission to live and complete without one Retry", () => {
  test("every inbound and outbound step continues the same job by itself", async () => {
    const { db, held } = untouched();
    const h = harness(db);
    await h.submit();
    assert.equal(job(db)["current_step"], "waiting_for_voice_language");

    await h.step("voice saved", saveVoice(db, held.voice), "waiting_for_number");
    await h.step("number assigned", assignNumber(db), "waiting_for_connection");
    await h.step(
      "connection registered",
      registerConnection(db, held.connection),
      "waiting_for_number_confirmation",
    );
    await h.step("number confirmed", confirmNumber(db), "waiting_for_integration_credential");
    await h.step("credential issued", issueCredential(db, held.credential), "waiting_for_agent");
    await h.step("agent registered", registerAgent(db), "waiting_for_tool_authentication");
    assert.notEqual(number(db)["status"], "active", "never live before the confirmation");
    await h.step("tools confirmed", confirmInbound(db), "waiting_for_outbound_credential");
    assert.deepEqual([number(db)["status"], number(db)["inbound_enabled"]], ["active", true]);
    const switches = () => [h.mock.calls.create, h.mock.calls.pause, h.mock.calls.resume];
    const atGoLive = switches();
    await h.step("outbound credential", issueOutboundCredential(db), "waiting_for_outbound_agent");
    await h.step(
      "outbound agent registered",
      registerOutbound(db),
      "waiting_for_outbound_tool_authentication",
    );
    await h.step("outbound tools confirmed", confirmOutbound(db), "active");

    assert.equal(job(db)["status"], "succeeded");
    assert.equal(table(db, "provisioning_runs").length, 1, "one job from start to end");
    assert.equal(h.mock.calls.create, 1, "one deployment");
    assert.deepEqual(switches(), atGoLive, "outbound steps never switch the live deployment");
    await h.idle("a finished job is never run again");
  });

  test("voice saved but not yet applied to the registered agent, then applied", async () => {
    const db = world({ outbound: false });
    Object.assign(voice(db), { status: "pending", applied_sarvam_app_id: null });
    const h = harness(db);
    await h.submit();
    assert.equal(job(db)["current_step"], "waiting_for_voice_language");
    await h.step(
      "marked applied",
      () =>
        Object.assign(voice(db), { status: "applied", applied_sarvam_app_id: "Customer-app-1" }),
      "waiting_for_outbound_credential",
    );
  });

  test("missing business setup: continues when the customer's data changes", async () => {
    const db = world({ outbound: false });
    const h = harness(db);
    h.setBusiness({ ...snapshot({ calendar_book: true }), services: [] });
    // The submission refuses an incomplete setup, so this is data removed after it.
    await h.run(db.client, { organizationId: ORG, trigger: "customer_activate" });
    assert.equal(job(db)["current_step"], "waiting_for_onboarding");
    await h.step(
      "service added",
      () => {
        h.setBusiness(snapshot());
        table(db, "services").push({
          id: "svc_1",
          organization_id: ORG,
          updated_at: "2026-11-28T09:30:00Z",
        });
      },
      "waiting_for_outbound_credential",
    );
  });

  test("a replaced credential and an admin's outbound confirmation count too", async () => {
    const h = await waitingForOutboundAuth();
    await h.step(
      "admin confirms the outbound tools",
      () =>
        table(h.db, "audit_logs").push({
          id: "audit_1",
          organization_id: ORG,
          action: "SARVAM_OUTBOUND_TOOL_AUTH_CONFIRMED",
          new_value: { app_id: "Customer-out-1", app_version: 1 },
          created_at: "2026-11-28T09:40:00Z",
        }),
      "active",
    );

    const db = world({ outbound: false });
    table(db, "sarvam_agent_integrations")[0]!["organization_id"] = ORG;
    table(db, "sarvam_agent_integrations")[0]!["status"] = "disabled";
    const again = harness(db);
    await again.submit();
    assert.equal(job(db)["current_step"], "waiting_for_integration_credential");
    await again.step(
      "new credential",
      () => {
        table(db, "sarvam_agent_integrations").push({
          id: "int_2",
          organization_id: ORG,
          agent_config_id: "agent_new",
          status: "active",
          expires_at: null,
          role: "inbound",
        });
      },
      "waiting_for_outbound_credential",
    );
  });

  test("the cases above cover every waiting state the job can report", () => {
    assert.deepEqual([...WAITING_STATES].sort(), [
      "waiting_for_agent",
      "waiting_for_connection",
      "waiting_for_integration_credential",
      "waiting_for_number",
      "waiting_for_number_confirmation",
      "waiting_for_onboarding",
      "waiting_for_outbound_agent",
      "waiting_for_outbound_credential",
      "waiting_for_outbound_tool_authentication",
      "waiting_for_tool_authentication",
      "waiting_for_voice_language",
    ]);
  });
});

describe("what never resumes a job", () => {
  for (const trigger of ["admin_retry", "setup_fee", "phone_service_fee"] as const)
    test(`a job started by ${trigger} stays where it is whatever changes`, async () => {
      const { db, held } = untouched();
      const h = harness(db);
      await h.run(db.client, { organizationId: ORG, trigger });
      saveVoice(db, held.voice)();
      assignNumber(db)();
      registerAgent(db)();
      await h.idle(trigger, 6);
      assert.equal(job(db)["attempts"], 1);
      assert.equal(h.mock.calls.create, 0);
    });

  test("writes by calls and by the job itself, and other customers' changes", async () => {
    const h = await waitingForOutboundAuth();
    table(h.db, "sarvam_agent_integrations")[0]!["last_used_at"] = "2026-11-28T11:00:00Z";
    Object.assign(agent(h.db), { status: "live", updated_at: "2026-11-28T11:00:00Z" });
    Object.assign(number(h.db), {
      deployment_verified_at: "2026-11-28T11:00:00Z",
      updated_at: "2026-11-28T11:00:00Z",
    });
    table(h.db, "agent_configs")[1]!["sarvam_app_version"] = 9;
    num(h.db, "num_other")["sarvam_number_confirmed_at"] = "2026-11-28T11:00:00Z";
    table(h.db, "telephony_connections").find((c) => c["organization_id"] === OTHER)![
      "provider_connection_id"
    ] = "conn-other-2";
    // Business edits matter only while a job waits for the business setup.
    table(h.db, "services").push({ id: "svc_9", organization_id: ORG, updated_at: "x" });
    await h.idle("unrelated writes", 6);
  });
});

describe("continuation keeps the job's safety rules", () => {
  test("two sweeps at once after a change: one attempt, one deployment", async () => {
    const db = world({ toolAuth: false, outbound: false });
    const h = harness(db);
    await h.submit();
    confirmInbound(db)();
    const results = await Promise.all([h.tick(), h.tick()]);
    assert.equal(
      results.reduce((n, r) => n + r.processed, 0),
      1,
    );
    assert.equal(job(db)["attempts"], 2);
    assert.equal(h.mock.calls.create, 1);
    assert.equal(table(db, "provisioning_runs").length, 1);
  });

  test("a change made while an attempt is running is picked up by the next sweep", async () => {
    const { db, held } = untouched();
    saveVoice(db, held.voice)();
    assignNumber(db)();
    registerConnection(db, held.connection)();
    const h = harness(db);
    await runProvisioning(
      db.client,
      { organizationId: ORG, trigger: "customer_activate" },
      async (a, o, hooks) => {
        const result = await runProvisioningPipeline(a, o, h.mock.d, hooks.onStep);
        confirmNumber(db)(); // after the pipeline read it, before the job is saved
        return result;
      },
      () => new Date(T0),
    );
    assert.equal(job(db)["current_step"], "waiting_for_number_confirmation");
    assert.equal((await h.tick()).processed, 1);
    assert.equal(job(db)["current_step"], "waiting_for_integration_credential");
  });

  test("a transient failure after a resume is retried with backoff, not lost", async () => {
    const db = world({ toolAuth: false, outbound: false });
    let down = true;
    const h = harness(db);
    const read = h.mock.d.getDeployment;
    h.mock.d.getDeployment = async (id) => {
      if (down) throw new Error("Sarvam is temporarily unavailable.");
      return read(id);
    };
    await h.submit();
    confirmInbound(db)();
    await h.tick();
    assert.equal(job(db)["status"], "pending");
    assert.ok(job(db)["next_attempt_at"]);
    assert.notEqual(number(db)["status"], "active");
    down = false;
    for (let i = 0; i < 3 && number(db)["status"] !== "active"; i++) await h.tick();
    assert.equal(number(db)["status"], "active");
    assert.equal(h.mock.calls.create, 1);
  });

  test("the waiting state is saved with the status, so a lost second write hides nothing", async () => {
    const db = world({ appId: null, outbound: false });
    const h = harness(db);
    const client = db.client as unknown as { from: (t: string) => Record<string, unknown> };
    const failing = {
      from(name: string) {
        const builder = client.from(name);
        if (name !== "provisioning_runs") return builder;
        const update = builder["update"] as (p: Row) => unknown;
        builder["update"] = (payload: Row) => {
          if ("phone_number_id" in payload) throw new Error("connection lost");
          return update(payload);
        };
        return builder;
      },
    } as unknown as Admin;
    await assert.rejects(
      h.run(failing, { organizationId: ORG, trigger: "customer_activate" }),
      /connection lost/,
    );
    assert.deepEqual(
      [job(db)["status"], job(db)["current_step"]],
      ["waiting", "waiting_for_agent"],
    );
    assert.equal((await listWorkOrders(db.client)).length, 1);
  });
});

describe("customer messages promise no notification", () => {
  test("nothing says the team was notified or that the customer will be told", () => {
    const states = [...WAITING_STATES, "failed", "verification_failed", "manual_action_required"];
    const messages = [
      CUSTOMER_PROBLEM,
      ...states.map((state) => customerActivationStatus(state).message),
      ...states.map((state) => {
        const o = classifyOutcome({ state, step: "activating", attempts: 5, maxAttempts: 5 });
        return o.kind === "succeeded" ? "" : o.customerMessage;
      }),
    ];
    for (const message of messages)
      assert.doesNotMatch(message, /notified|let you know|we will (email|message|contact)/i);
  });

  test("a customer is not told to choose voice settings only the team can set", () => {
    const o = classifyOutcome({
      state: "waiting_for_voice_language",
      step: "validating",
      attempts: 1,
      maxAttempts: 5,
    });
    assert.ok(o.kind === "waiting");
    assert.doesNotMatch(o.customerMessage, /^Choose|Voice & language/);
  });
});
