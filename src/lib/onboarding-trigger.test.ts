import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  processRazorpayPlatformEvent,
  type RazorpayEvent,
} from "./payments/razorpay-platform-webhook.server.ts";
import {
  SETUP_INCOMPLETE_MESSAGE,
  loadActivationView,
  startVoiceActivation,
} from "./voice-activation.server.ts";
import { businessSetupProblems, runProvisioningPipeline } from "./provisioning-pipeline.server.ts";
import {
  runProvisioning,
  sweepProvisioningRetries,
  type RunProvisioningInput,
} from "./provisioning-runs.server.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import { ORG, snapshot, world, deps, num } from "./provisioning-test-world.test-helper.ts";

/**
 * The customer journey's trigger: payment opens the dashboard and starts nothing; saving
 * details starts nothing; the customer's submission of a COMPLETE business setup starts one
 * provisioning job. Real webhook processor, activation, runner, pipeline and sweep; mocks only.
 */

type World = ReturnType<typeof world>;
type Admin = Parameters<typeof runProvisioning>[0];
const NOW = new Date("2026-11-27T10:00:00Z");
const LATER = new Date("2026-11-27T12:00:00Z");

/** A customer who has paid; `business` is what they have saved so far. */
function paidCustomer(over: Parameters<typeof world>[0] = {}) {
  const db = world(over);
  let saved: AgentSnapshot = snapshot();
  const d = deps(db, { loadSnapshot: async () => saved });
  let clock = NOW;
  const runner = (a: Admin, i: RunProvisioningInput) =>
    runProvisioning(
      a,
      i,
      (x, o, h) => runProvisioningPipeline(x, o, d.d, h.onStep),
      () => clock,
    );
  return {
    db,
    d,
    runner,
    save: (change: (s: AgentSnapshot) => void) => {
      const next = structuredClone(saved);
      change(next);
      saved = next;
    },
    submit: () =>
      startVoiceActivation(
        db.client,
        { orgId: ORG, userId: "owner_1" },
        runner,
        () => NOW,
        d.d.loadSnapshot,
      ),
    sweep: (now = LATER) => {
      clock = now;
      return sweepProvisioningRetries(db.client, { now, run: runner });
    },
  };
}
const runs = (db: World) => db.tables["provisioning_runs"] ?? [];
const lifecycle = (db: World) => db.tables["organizations"]![0]!["lifecycle_status"];
const providerCalls = (c: ReturnType<typeof paidCustomer>) => c.d.calls.log.length;
/** A business that switched booking on but has no service or opening hours yet. */
const incomplete = (s: AgentSnapshot) => {
  s.agent.capabilities = { calendar_book: true };
  s.services = [];
  s.hours = [];
};
const complete = (s: AgentSnapshot) => Object.assign(s, snapshot());

const capture = (c: ReturnType<typeof paidCustomer>, purpose: string) => {
  const client = c.db.client as unknown as { rpc: unknown };
  client.rpc = async () => ({
    data: { found: true, organization_id: ORG, purpose, payment_id: "pay_row_1" },
    error: null,
  });
  const event: RazorpayEvent = {
    event: "payment.captured",
    payload: {
      payment: { entity: { id: "pay_1", order_id: "order_1", amount: 1, currency: "INR" } },
    },
  };
  return processRazorpayPlatformEvent(c.db.client, event);
};

describe("payment never starts provisioning", () => {
  for (const purpose of ["setup_fee", "phone_service_fee", "monthly_plan"])
    for (const [state, change] of [
      ["before business details", incomplete],
      ["with complete details not yet submitted", complete],
    ] as const)
      test(`${purpose} ${state}: no job, no Sarvam call, and the sweep finds nothing`, async () => {
        const c = paidCustomer();
        c.save(change);
        await capture(c, purpose);
        await c.sweep();
        assert.deepEqual(runs(c.db), []);
        assert.equal(providerCalls(c), 0);
        assert.equal(lifecycle(c.db), "setup_paid");
        assert.equal(num(c.db, "num_new")["status"], "provisioning");
      });

  test("a live customer's payment does not run their provisioning again", async () => {
    const c = paidCustomer();
    await c.submit();
    const jobs = JSON.stringify(runs(c.db));
    const calls = providerCalls(c);
    await capture(c, "phone_service_fee");
    assert.equal(JSON.stringify(runs(c.db)), jobs);
    assert.equal(providerCalls(c), calls);
  });
});

describe("saving details never starts provisioning", () => {
  test("any number of saves, complete or not, followed by sweeps: no job", async () => {
    const c = paidCustomer();
    for (const change of [incomplete, complete, incomplete, complete]) {
      c.save(change);
      c.db.tables["agent_configs"]![0]!["updated_at"] = new Date().toISOString();
      await c.sweep();
    }
    assert.deepEqual(runs(c.db), []);
    assert.equal(providerCalls(c), 0);
  });

  test("the setup wizard and the business page cannot start it", () => {
    for (const page of ["app.onboarding.tsx", "app.business.tsx"]) {
      const source = readFileSync(new URL(`../routes/${page}`, import.meta.url), "utf8");
      assert.doesNotMatch(source, /activateMyNumber|runProvisioning|provisioning_runs/, page);
    }
  });
});

describe("an incomplete submission is refused", () => {
  const cases: [string, (c: ReturnType<typeof paidCustomer>) => void, RegExp][] = [
    ["no business profile", (c) => (c.db.tables["agent_configs"] = []), /business profile/],
    [
      "no business behind the agent",
      (c) => (c.db.tables["agent_configs"]![0]!["business_id"] = null),
      /business profile/,
    ],
    ["no category", (c) => c.save((s) => (s.business.business_type = " ")), /category/],
    ["no business name", (c) => c.save((s) => (s.business.name = "")), /name is missing/],
    ["booking without services or hours", (c) => c.save(incomplete), /needs/],
  ];
  for (const [name, arrange, reason] of cases)
    test(name, async () => {
      const c = paidCustomer();
      arrange(c);
      const view = await c.submit();
      assert.equal(view.message, SETUP_INCOMPLETE_MESSAGE);
      assert.match(view.missing!.join(" "), reason);
      assert.equal(view.busy, false);
      assert.deepEqual(runs(c.db), []);
      assert.equal(providerCalls(c), 0);
      assert.equal(lifecycle(c.db), "setup_paid");
    });

  test("voice and languages are the team's step, not a reason to refuse", async () => {
    const c = paidCustomer();
    c.db.tables["agent_voice_language_settings"] = [];
    assert.deepEqual(await businessSetupProblems(c.db.client, ORG, c.d.d.loadSnapshot), []);
    const view = await c.submit();
    assert.equal(view.missing, undefined);
    assert.equal(runs(c.db)[0]!["current_step"], "waiting_for_voice_language");
  });

  test("an unfinished job that the sweep retries provisions nothing while setup is incomplete", async () => {
    const c = paidCustomer();
    c.save(incomplete);
    c.db.tables["provisioning_runs"] = [
      {
        id: "run_old",
        organization_id: ORG,
        trigger: "setup_fee",
        status: "pending",
        attempts: 1,
        next_attempt_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      },
    ];
    await c.sweep();
    assert.equal(runs(c.db)[0]!["current_step"], "waiting_for_onboarding");
    assert.equal(providerCalls(c), 0);
    assert.equal(lifecycle(c.db), "setup_paid", "not marked as being set up");
  });
});

describe("submitting a complete setup", () => {
  test("starts one job as the customer's own request and sets the customer up", async () => {
    const c = paidCustomer();
    const view = await c.submit();
    assert.equal(view.missing, undefined);
    assert.equal(runs(c.db).length, 1);
    assert.equal(runs(c.db)[0]!["trigger"], "customer_activate");
    assert.equal(num(c.db, "num_new")["status"], "active");
    assert.equal(lifecycle(c.db), "provisioning");
  });

  test("before a number is assigned: the job waits for one, and continues when checked again", async () => {
    const c = paidCustomer();
    const spare = num(c.db, "num_new");
    c.db.tables["phone_numbers"] = c.db.tables["phone_numbers"]!.filter((n) => n !== spare);
    const first = await c.submit();
    assert.equal(first.phase, "waiting");
    assert.equal(runs(c.db)[0]!["current_step"], "waiting_for_number");
    assert.equal(providerCalls(c), 0);
    c.db.tables["phone_numbers"]!.push(spare);
    await c.submit();
    assert.equal(runs(c.db).length, 1, "the same job");
    assert.equal(num(c.db, "num_new")["status"], "active");
  });

  test("five submissions at once make one job and one deployment", async () => {
    const c = paidCustomer();
    await Promise.all(Array.from({ length: 5 }, () => c.submit()));
    assert.equal(runs(c.db).length, 1);
    assert.equal(c.d.calls.create, 1);
  });

  test("submitting again while waiting, or after going live, adds nothing", async () => {
    const c = paidCustomer({ appId: null, outbound: false });
    await c.submit();
    await c.submit();
    assert.equal(runs(c.db).length, 1);
    assert.equal(runs(c.db)[0]!["current_step"], "waiting_for_agent");

    const live = paidCustomer();
    await live.submit();
    const calls = providerCalls(live);
    assert.equal((await live.submit()).phase, "completed");
    assert.equal(runs(live.db).length, 1);
    assert.equal(providerCalls(live), calls);
  });

  test("the subscribed plan changes nothing about the job", async () => {
    const outcomes = [];
    for (const plan of ["starter", "growth", "professional", "business", "trial"]) {
      const c = paidCustomer();
      c.db.tables["subscriptions"] = [{ organization_id: ORG, plan }];
      await c.submit();
      const job = runs(c.db)[0]!;
      outcomes.push(
        JSON.stringify([job["status"], job["current_step"], c.d.calls.log, lifecycle(c.db)]),
      );
    }
    assert.equal(new Set(outcomes).size, 1);
  });
});

describe("recovery", () => {
  test("refused, completed by the customer, then accepted", async () => {
    const c = paidCustomer();
    c.save(incomplete);
    assert.ok((await c.submit()).missing?.length);
    c.save(complete);
    assert.equal((await c.submit()).missing, undefined);
    assert.equal(runs(c.db).length, 1);
    assert.equal(num(c.db, "num_new")["status"], "active");
  });

  test("a provider failure is retried on the same job without a second deployment", async () => {
    const c = paidCustomer();
    const read = c.d.d.getDeployment;
    let down = true;
    c.d.d.getDeployment = async (id) => {
      if (down) throw new Error("Sarvam is temporarily unavailable.");
      return read(id);
    };
    await c.submit();
    assert.equal(runs(c.db)[0]!["status"], "pending");
    down = false;
    await c.sweep(new Date("2026-11-28T10:00:00Z"));
    assert.equal(runs(c.db).length, 1);
    assert.equal(c.d.calls.create, 1);
    assert.equal(num(c.db, "num_new")["status"], "active");
  });

  test("an older payment-created job becomes the customer's own on submission", async () => {
    const c = paidCustomer({ appId: null, outbound: false });
    c.db.tables["provisioning_runs"] = [
      {
        id: "run_old",
        organization_id: ORG,
        trigger: "setup_fee",
        status: "waiting",
        attempts: 1,
        current_step: "waiting_for_onboarding",
        step_states: {},
      },
    ];
    await c.sweep();
    assert.equal(runs(c.db)[0]!["attempts"], 1, "untouched until the customer submits");
    await c.submit();
    assert.deepEqual(
      [runs(c.db).length, runs(c.db)[0]!["id"], runs(c.db)[0]!["trigger"]],
      [1, "run_old", "customer_activate"],
    );
    // Now the sweep continues it when the agent is registered.
    Object.assign(c.db.tables["agent_configs"]![0]!, {
      sarvam_app_id: "Customer-app-1",
      updated_at: new Date().toISOString(),
    });
    assert.equal((await c.sweep()).agentRegistered, 1);
  });

  test("an incomplete resubmission leaves an existing job as it was", async () => {
    const c = paidCustomer({ appId: null, outbound: false });
    await c.submit();
    const before = JSON.stringify(runs(c.db));
    c.save(incomplete);
    assert.ok((await c.submit()).missing?.length);
    assert.equal(JSON.stringify(runs(c.db)), before);
    assert.equal((await loadActivationView(c.db.client, ORG)).phase, "waiting");
  });
});

describe("the dashboard", () => {
  const page = readFileSync(new URL("../routes/app.numbers.tsx", import.meta.url), "utf8");
  test("offers the submission before and after a number is assigned, and says what is missing", () => {
    assert.match(page, /submission\("Activate number"\)/);
    assert.match(page, /submission\("Submit setup"\)/);
    assert.match(page, /result\.missing\.join/);
  });
});
