import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runProvisioningPipeline, type PipelineDeps } from "./provisioning-pipeline.server.ts";
import {
  runProvisioning,
  sweepProvisioningRetries,
  type RunProvisioningInput,
} from "./provisioning-runs.server.ts";
import { loadActivationView, startVoiceActivation } from "./voice-activation.server.ts";
import { createInboundDeploymentForNumbers } from "./sarvam-inbound-deployment.server.ts";
import { ORG, OTHER, snapshot, world, deps, num } from "./provisioning-test-world.test-helper.ts";

/**
 * Safety of every path that can reach a customer's number or Sarvam deployment: an
 * administrator's Retry, the customer's Check again, the sweep, and manual deployment
 * creation. Real runner, activation, pipeline, sweep and deployment creation; the database
 * is in memory and Sarvam is a fake (nothing is ever sent to a provider).
 */

type World = ReturnType<typeof world>;
type Admin = Parameters<typeof runProvisioning>[0];
const T0 = Date.parse("2026-11-28T10:00:00Z");

const number = (db: World) => num(db, "num_new");
const job = (db: World) => db.tables["provisioning_runs"]![0]!;
const jobs = (db: World) => db.tables["provisioning_runs"] ?? [];
const state = (db: World) => {
  const n = number(db);
  return {
    status: n["status"],
    inbound: n["inbound_enabled"],
    deployment: n["provider_deployment_id"],
    connection: n["connection_id"],
    agent: n["agent_config_id"],
  };
};
/** Provider calls that change something at Sarvam. */
const changes = (log: string[]) => log.filter((c) => c !== "get");

function harness(db: World, over: Parameters<typeof deps>[1] = {}) {
  const mock = deps(db, over);
  let minute = 0;
  const run = (a: Admin, i: RunProvisioningInput) =>
    runProvisioning(
      a,
      i,
      (x, o, h) => runProvisioningPipeline(x, o, mock.d, h.onStep, h),
      () => new Date(T0 + minute * 60_000),
    );
  return {
    db,
    mock,
    run,
    adminRetry: () => run(db.client, { organizationId: ORG, trigger: "admin_retry", force: true }),
    checkAgain: () =>
      startVoiceActivation(
        db.client,
        { orgId: ORG, userId: "owner_1" },
        run,
        () => new Date(T0 + 3_600_000),
        mock.d.loadSnapshot,
      ),
    tick: () => sweepProvisioningRetries(db.client, { now: new Date(T0 + ++minute * 60_000), run }),
  };
}

/** A customer who is live (verified, answering) and whose outbound setup is still open. */
async function live(over: Parameters<typeof deps>[1] = {}) {
  const db = world({ outbound: false });
  const h = harness(db, over);
  await h.run(db.client, { organizationId: ORG, trigger: "customer_activate" });
  assert.deepEqual([number(db)["status"], number(db)["inbound_enabled"]], ["active", true]);
  return { ...h, before: h.mock.calls.log.length, state: state(db) };
}
const since = (h: { mock: { calls: { log: string[] } }; before: number }) =>
  h.mock.calls.log.slice(h.before);

describe("a switched-off number is never switched back on", () => {
  const offs: [string, (db: World) => void][] = [
    ["inbound switched off", (db) => (number(db)["inbound_enabled"] = false)],
    ["suspended", (db) => (number(db)["status"] = "suspended")],
  ];
  for (const [how, switchOff] of offs) {
    for (const [who, act] of [
      ["an administrator's Retry", (h: Awaited<ReturnType<typeof live>>) => h.adminRetry()],
      ["the customer's Check again", (h: Awaited<ReturnType<typeof live>>) => h.checkAgain()],
      ["the sweep", (h: Awaited<ReturnType<typeof live>>) => h.tick()],
    ] as const)
      test(`${how}: ${who} leaves it off and changes nothing at Sarvam`, async () => {
        const h = await live();
        switchOff(h.db);
        const off = state(h.db);
        // Something for a job to react to.
        h.db.tables["agent_configs"]![0]!["sarvam_outbound_app_id"] = "Customer-out-1";
        await act(h);
        assert.deepEqual(state(h.db), off);
        assert.deepEqual(changes(since(h)), []);
      });
  }

  test("the customer is told it is switched off and offered nothing to press", async () => {
    for (const [, switchOff] of offs) {
      const h = await live();
      switchOff(h.db);
      const attempts = job(h.db)["attempts"];
      const view = await h.checkAgain();
      assert.match(view.message, /switched off/i);
      assert.deepEqual([view.canRetry, view.busy, view.phase], [false, false, "failed"]);
      assert.deepEqual([jobs(h.db).length, job(h.db)["attempts"]], [1, attempts]);
      assert.deepEqual(await loadActivationView(h.db.client, ORG), view);
    }
  });

  for (const [how, switchOff] of [
    ["suspended", (db: World) => (number(db)["status"] = "suspended")],
    ["released", (db: World) => (number(db)["status"] = "released")],
  ] as const)
    test(`a number ${how} while an attempt is going live is not activated over it`, async () => {
      const db = world({ outbound: false });
      const base = deps(db);
      const h = harness(db, {
        setDeploymentStatus: async (id, action) => {
          await base.d.setDeploymentStatus(id, action);
          if (action === "resume") switchOff(db);
        },
        getDeployment: base.d.getDeployment,
        createDeployment: base.d.createDeployment,
      });
      await h.adminRetry();
      assert.equal(number(db)["status"], how);
      assert.notEqual(number(db)["inbound_enabled"], true);
    });
});

describe("a live deployment is never changed by a retry or recovery", () => {
  const drift = async () => {
    const h = await live();
    h.mock.sarvam.appVersion = 9; // changed in the Sarvam console
    return h;
  };

  test("an administrator's Retry over a changed deployment stops for a person", async () => {
    const h = await drift();
    await h.adminRetry();
    assert.deepEqual(changes(since(h)), []);
    assert.equal(h.mock.sarvam.appVersion, 9);
    assert.deepEqual(state(h.db), h.state);
    const last = jobs(h.db).at(-1)!;
    assert.deepEqual([last["status"], last["next_attempt_at"]], ["failed", null]);
  });

  test("the customer's Check again over a changed deployment changes nothing at Sarvam", async () => {
    const h = await drift();
    number(h.db)["verified_deployment_id"] = null; // so the click is not a no-op
    await h.checkAgain();
    assert.deepEqual(changes(since(h)), []);
    assert.deepEqual(state(h.db), h.state);
  });

  test("the automatic retry of an attempt a person started makes no Sarvam call", async () => {
    const h = await drift();
    Object.assign(job(h.db), {
      status: "pending",
      next_attempt_at: new Date(T0).toISOString(),
      diagnostics: { retryStreak: 1 },
    });
    await h.tick();
    assert.deepEqual(since(h), []);
    assert.deepEqual(state(h.db), h.state);
  });

  test("a crashed attempt's recovery makes no Sarvam call", async () => {
    const h = await drift();
    Object.assign(job(h.db), {
      status: "running",
      updated_at: new Date(T0 - 3_600_000).toISOString(),
    });
    await h.tick();
    assert.deepEqual(since(h), []);
  });

  test("a failed read is not retried by itself and withdraws nothing", async () => {
    let down = false;
    const db = world({ outbound: false });
    const base = deps(db);
    const h = harness(db, {
      getDeployment: async (id) => {
        if (down) throw new Error("Sarvam is temporarily unavailable.");
        return base.d.getDeployment(id);
      },
      createDeployment: base.d.createDeployment,
      setDeploymentStatus: base.d.setDeploymentStatus,
    });
    await h.run(db.client, { organizationId: ORG, trigger: "customer_activate" });
    const verified = number(db)["verified_deployment_id"];
    down = true;
    await h.adminRetry();
    const last = jobs(db).at(-1)!;
    assert.deepEqual([last["status"], last["next_attempt_at"]], ["failed", null]);
    assert.equal(number(db)["verified_deployment_id"], verified);
    assert.equal(number(db)["status"], "active");
  });

  test("a live number with no recorded deployment never gets one created", async () => {
    const h = await live();
    number(h.db)["provider_deployment_id"] = null;
    await h.adminRetry();
    assert.deepEqual(since(h), []);
    assert.equal(number(h.db)["provider_deployment_id"], null);
  });

  test("a live number is never re-linked to another connection or agent", async () => {
    const h = await live();
    Object.assign(number(h.db), { connection_id: null, provider_deployment_id: null });
    await h.adminRetry();
    assert.equal(number(h.db)["connection_id"], null);
    assert.deepEqual(since(h), []);
  });

  test("a verified live deployment is reused after one read", async () => {
    const h = await live();
    await h.adminRetry();
    assert.deepEqual(since(h), ["get"]);
    assert.deepEqual(state(h.db), h.state);
    assert.equal(number(h.db)["verified_deployment_id"], h.state.deployment);
  });

  test("a database failure midway leaves the live number as it was", async () => {
    const h = await live();
    (h.db as unknown as World).failNext("phone_numbers", "update", { message: "unavailable" });
    await h.adminRetry().catch(() => undefined);
    assert.deepEqual(state(h.db), h.state);
    assert.deepEqual(changes(since(h)), []);
  });

  test("a number made live by a person while an attempt runs is not paused", async () => {
    const db = world({ outbound: false });
    const base = deps(db);
    let first = true;
    const h = harness(db, {
      getDeployment: async (id) => {
        if (first) Object.assign(number(db), { status: "active", inbound_enabled: true });
        first = false;
        return base.d.getDeployment(id);
      },
      createDeployment: base.d.createDeployment,
      setDeploymentStatus: async (id, action) => {
        h.mock.calls.log.push(action);
        await base.d.setDeploymentStatus(id, action);
      },
    });
    await h.adminRetry();
    assert.deepEqual(
      h.mock.calls.log.filter((c) => c === "pause" || c === "resume"),
      [],
    );
    assert.deepEqual([number(db)["status"], number(db)["inbound_enabled"]], ["active", true]);
  });
});

/* ------------------------------------------------------------------ */
/* Deployment creation: the real function, against a fake Sarvam       */
/* ------------------------------------------------------------------ */

interface FakeDeployment {
  deployment_id: string;
  app_id: string;
  app_version: number;
  phone_numbers: string[];
  status: string;
}

describe("deployment creation takes one lock", () => {
  const ENV = {
    SARVAM_API_KEY: "sk_test_key",
    SARVAM_ORG_ID: "org_1",
    SARVAM_WORKSPACE_ID: "ws_1",
    TELEPHONY_WEBHOOK_BASE_URL: "https://clickai.example",
    SARVAM_WEBHOOK_SECRET: "whsec_test_0123456789abcdef0123456789",
  };
  let saved: Record<string, string | undefined>;
  let originalFetch: typeof fetch;
  let sarvam: { deployments: FakeDeployment[]; posts: number; failCreate: boolean };

  beforeEach(() => {
    saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ENV);
    originalFetch = globalThis.fetch;
    sarvam = { deployments: [], posts: 0, failCreate: false };
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      await new Promise((r) => setImmediate(r)); // a real call yields, so racers interleave
      if ((init?.method ?? "GET") === "GET") {
        const q = u.searchParams.get("search") ?? "";
        const items = sarvam.deployments.filter((d) => d.phone_numbers.includes(q));
        return new Response(JSON.stringify({ items }), { status: 200 });
      }
      sarvam.posts++;
      if (sarvam.failCreate) return new Response("{}", { status: 500 });
      const body = JSON.parse(String(init!.body)) as {
        app_id: string;
        app_version: number;
        connection_configs: { phone_numbers: string[] }[];
      };
      const created = {
        deployment_id: `dep-${sarvam.posts}`,
        app_id: body.app_id,
        app_version: body.app_version,
        phone_numbers: body.connection_configs[0]!.phone_numbers,
        status: "active",
      };
      sarvam.deployments.push(created);
      return new Response(JSON.stringify(created), { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  /** A number ready for its deployment (linked, confirmed, agent registered). */
  function ready() {
    const db = world({ outbound: false });
    Object.assign(number(db), { connection_id: "conn_new", agent_config_id: "agent_new" });
    return db;
  }
  const create = (db: World) =>
    createInboundDeploymentForNumbers(db.client, { phoneNumberIds: ["num_new"], name: "manual" });
  const provisioningDeps = (db: World): Partial<PipelineDeps> => ({
    loadSnapshot: async () => snapshot(),
    createDeployment: createInboundDeploymentForNumbers,
    getDeployment: async (id) => {
      const d = sarvam.deployments.find((x) => x.deployment_id === id)!;
      return {
        deploymentId: id,
        appId: d.app_id,
        appVersion: d.app_version,
        status: d.status,
        phoneNumbers: d.phone_numbers,
        webhookUrlConfigured: true,
      };
    },
    setDeploymentStatus: async (id, action) => {
      sarvam.deployments.find((x) => x.deployment_id === id)!.status =
        action === "pause" ? "paused" : "active";
    },
  });

  for (const racers of [2, 5])
    test(`${racers} manual creations at once make one deployment`, async () => {
      const db = ready();
      const results = await Promise.allSettled(Array.from({ length: racers }, () => create(db)));
      assert.equal(sarvam.posts, 1);
      assert.ok(results.some((r) => r.status === "fulfilled"));
      for (const r of results)
        if (r.status === "rejected") assert.match(String(r.reason), /Another change/);
      assert.equal(number(db)["provider_deployment_id"], "dep-1");
    });

  test("manual creation racing automatic provisioning makes one deployment", async () => {
    const db = ready();
    const h = harness(db, provisioningDeps(db));
    await Promise.allSettled([h.adminRetry(), create(db), create(db)]);
    assert.equal(sarvam.posts, 1);
    for (let i = 0; i < 4 && number(db)["status"] !== "active"; i++) await h.tick();
    assert.equal(sarvam.posts, 1);
    assert.equal(number(db)["status"], "active");
  });

  test("concurrent retries, a click and the sweep: one job, one deployment", async () => {
    const db = ready();
    const h = harness(db, provisioningDeps(db));
    await Promise.allSettled([h.adminRetry(), h.adminRetry(), h.checkAgain(), h.tick()]);
    assert.equal(jobs(db).length, 1);
    assert.equal(sarvam.posts, 1);
  });

  test("a failed creation releases the lock at once", async () => {
    const db = ready();
    sarvam.failCreate = true;
    await assert.rejects(create(db));
    sarvam.failCreate = false;
    assert.equal((await create(db)).outcome, "created");
  });

  test("a crashed holder blocks others only until its lock expires", async () => {
    const db = ready();
    const held = (until: number) => ({
      deployment_lock: { token: "crashed", until: new Date(until).toISOString() },
      note: "kept",
    });
    number(db)["metadata"] = held(Date.now() + 60_000);
    await assert.rejects(create(db), /Another change/);
    assert.equal(sarvam.posts, 0);
    number(db)["metadata"] = held(Date.now() - 1000);
    assert.equal((await create(db)).outcome, "created");
    assert.deepEqual(number(db)["metadata"], { note: "kept" });
  });

  test("created at Sarvam but not saved: the retry adopts it, never a second one", async () => {
    const db = ready();
    const client = db.client as unknown as { from: (t: string) => Record<string, unknown> };
    let fail = true;
    const flaky = {
      from(name: string) {
        const builder = client.from(name);
        const update = builder["update"] as (p: Record<string, unknown>) => unknown;
        builder["update"] = (payload: Record<string, unknown>) => {
          if (fail && "provider_deployment_id" in payload) {
            fail = false;
            throw new Error("connection lost");
          }
          return update(payload);
        };
        return builder;
      },
    } as unknown as Admin;
    await assert.rejects(
      createInboundDeploymentForNumbers(flaky, { phoneNumberIds: ["num_new"], name: "x" }),
      /connection lost/,
    );
    assert.equal((await create(db)).outcome, "adopted");
    assert.equal(sarvam.posts, 1);
  });

  for (const [how, off] of [
    ["suspended", { status: "suspended" }],
    ["switched off for inbound", { status: "active", inbound_enabled: false }],
    ["released", { status: "released" }],
  ] as const)
    test(`no deployment is created for a ${how} number`, async () => {
      const db = ready();
      Object.assign(number(db), off);
      await assert.rejects(create(db), /switched off|suspended|released/);
      assert.equal(sarvam.posts, 0);
    });

  test("one customer's number cannot be deployed on another's connection or agent", async () => {
    for (const wrong of [{ connection_id: "conn_other" }, { agent_config_id: "agent_other" }]) {
      const db = ready();
      Object.assign(number(db), wrong);
      await assert.rejects(create(db));
      assert.equal(sarvam.posts, 0);
      assert.equal(num(db, "num_other")["provider_deployment_id"], "dep-other");
    }
    const db = ready();
    await assert.rejects(
      createInboundDeploymentForNumbers(db.client, {
        phoneNumberIds: ["num_new", "num_other"],
        name: "mixed",
      }),
    );
    assert.equal(sarvam.posts, 0);
    assert.equal(
      db.tables["organizations"]!.find((o) => o["id"] === OTHER)!["lifecycle_status"],
      "active",
    );
  });
});
