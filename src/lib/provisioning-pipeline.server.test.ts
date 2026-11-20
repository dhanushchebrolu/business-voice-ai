import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import {
  runProvisioningPipeline,
  type DeploymentView,
  type PipelineDeps,
} from "./provisioning-pipeline.server.ts";
import { runProvisioning } from "./provisioning-runs.server.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";

const ORG = "org_new";
const OTHER = "org_other";

function snapshot(caps: Record<string, boolean> = { capture_lead: true }): AgentSnapshot {
  return {
    business: {
      name: "New Clinic",
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
      capabilities: caps,
      primary_language: "en-IN",
      extra_languages: [],
      multilingual: true,
      voice_id: "ritu",
      speaking_pace: 1,
      greetings: {},
      transfer_number: null,
      after_hours_behavior: "take_message",
    },
  };
}

/**
 * A customer at the end of onboarding: business + agent, connection, assigned
 * number, inbound credential, and (unless outbound: false) the separate
 * outbound agent with its own credential.
 */
function world(
  over: {
    appId?: string | null;
    numberStatus?: string;
    deploymentId?: string | null;
    outbound?: false | "no_agent" | "inbound_agent";
  } = {},
) {
  const outboundAppId =
    over.outbound === false || over.outbound === "no_agent"
      ? null
      : over.outbound === "inbound_agent"
        ? "Customer-app-1"
        : "Customer-out-1";
  return memorySupabase({
    uniques: [
      {
        table: "provisioning_runs",
        key: (r) =>
          ["pending", "running", "waiting"].includes(r["status"] as string)
            ? (r["organization_id"] as string)
            : null,
      },
    ],
    tables: {
      organizations: [
        { id: ORG, lifecycle_status: "setup_paid" },
        { id: OTHER, lifecycle_status: "active" },
      ],
      agent_configs: [
        {
          id: "agent_new",
          organization_id: ORG,
          business_id: "biz_new",
          sarvam_app_id: over.appId === undefined ? "Customer-app-1" : over.appId,
          sarvam_app_version: 1,
          sarvam_outbound_app_id: outboundAppId,
          sarvam_outbound_app_version: outboundAppId ? 1 : null,
        },
        {
          id: "agent_other",
          organization_id: OTHER,
          business_id: "biz_other",
          sarvam_app_id: "Other-app",
          sarvam_app_version: 4,
        },
      ],
      telephony_connections: [
        // One shared Sarvam/Vobiz connection, registered for both customers.
        {
          id: "conn_new",
          organization_id: ORG,
          provider: "sarvam",
          provider_connection_id: "conn-shared",
        },
        {
          id: "conn_other",
          organization_id: OTHER,
          provider: "sarvam",
          provider_connection_id: "conn-shared",
        },
      ],
      phone_numbers: [
        {
          id: "num_new",
          e164: "+917900000002",
          status: over.numberStatus ?? "provisioning",
          provider: "sarvam",
          organization_id: ORG,
          connection_id: null,
          agent_config_id: null,
          provider_deployment_id: over.deploymentId ?? null,
          inbound_enabled: false,
          sarvam_number_confirmed_at: "2026-11-14T09:00:00Z",
        },
        {
          id: "num_other",
          e164: "+917900000001",
          status: "active",
          provider: "sarvam",
          organization_id: OTHER,
          connection_id: "conn_other",
          agent_config_id: "agent_other",
          provider_deployment_id: "dep-other",
          inbound_enabled: true,
        },
      ],
      sarvam_agent_integrations: [
        {
          id: "int_new",
          agent_config_id: "agent_new",
          status: "active",
          expires_at: null,
          role: "inbound",
        },
        ...(over.outbound === false
          ? []
          : [
              {
                id: "int_new_out",
                agent_config_id: "agent_new",
                status: "active",
                expires_at: null,
                role: "outbound",
              },
            ]),
      ],
      agent_voice_language_settings: [
        {
          id: "vl_new",
          organization_id: ORG,
          agent_config_id: "agent_new",
          default_language: "English",
          allowed_languages: ["English", "Hindi"],
          auto_language_switch: true,
          // Simran - Hinglish Support Agent (v4)
          sarvam_voice_internal_id: "01a0cf17-12bd-7de3-9df0-f607db604d52",
          status: "applied",
          applied_sarvam_app_id: "Customer-app-1",
          applied_sarvam_app_version: 1,
        },
      ],
    },
  });
}

/**
 * Mocked Sarvam deployment API with state, following the documented
 * behaviour: a created deployment starts "active"; PUT status pauses or
 * resumes it; PATCH (via the sync) changes app_version. `deployment`
 * overrides are applied on every read (a deployment stuck that way).
 */
function deps(
  db: ReturnType<typeof world>,
  over: Partial<PipelineDeps> & {
    deployment?: Partial<DeploymentView>;
    initialStatus?: string;
    resumeFails?: boolean;
  } = {},
) {
  const calls = { create: 0, get: 0, pause: 0, resume: 0, sync: 0, log: [] as string[] };
  const sarvam = {
    status: over.initialStatus ?? "active",
    appId: "Customer-app-1",
    appVersion: 1 as number | null,
  };
  const { deployment, initialStatus, resumeFails, ...rest } = over;
  void initialStatus;
  const d: PipelineDeps = {
    loadSnapshot: async () => snapshot(),
    createDeployment: async (_admin, { phoneNumberIds }) => {
      calls.create++;
      calls.log.push("create");
      sarvam.status = "active";
      const row = db.tables["phone_numbers"]!.find((n) => n["id"] === phoneNumberIds[0])!;
      row["provider_deployment_id"] = "dep-new";
      return { deploymentId: "dep-new", outcome: "created" };
    },
    getDeployment: async (id) => {
      calls.get++;
      calls.log.push("get");
      return {
        deploymentId: id,
        appId: sarvam.appId,
        appVersion: sarvam.appVersion,
        status: sarvam.status,
        phoneNumbers: ["+917900000002"],
        webhookUrlConfigured: true,
        ...deployment,
      };
    },
    setDeploymentStatus: async (_id, action) => {
      calls.log.push(action);
      if (action === "pause") {
        calls.pause++;
        sarvam.status = "paused";
      } else {
        calls.resume++;
        if (resumeFails) throw new Error("Sarvam is temporarily unavailable. Please retry.");
        sarvam.status = "active";
      }
    },
    syncDeployments: async () => {
      calls.sync++;
      calls.log.push("sync");
      sarvam.appVersion = Number(db.tables["agent_configs"]![0]!["sarvam_app_version"]);
    },
    masterAgentAppId: "Master-agent",
    now: () => new Date("2026-11-14T10:00:00Z"),
    ...rest,
  };
  return { d, calls, sarvam };
}

const num = (db: ReturnType<typeof world>, id: string) =>
  db.tables["phone_numbers"]!.find((n) => n["id"] === id)!;

describe("provisioning pipeline — the ten steps", () => {
  test("happy path: deploys, verifies both sides, activates inbound only, advances lifecycle", async () => {
    const db = world();
    const { d, calls } = deps(db);
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "active", r.note);
    assert.equal(r.step, 12, "inbound live (10) and the outbound agent registered (11-12)");
    assert.equal(calls.create, 1);
    assert.equal(r.deploymentId, "dep-new");
    assert.ok(r.deploymentVerifiedAt);
    const n = num(db, "num_new");
    assert.equal(n["status"], "active");
    assert.equal(n["inbound_enabled"], true);
    assert.equal(n["outbound_enabled"], undefined, "outbound is never switched on here");
    assert.equal(n["connection_id"], "conn_new", "linked to the customer's own connection row");
    assert.equal(n["agent_config_id"], "agent_new");
    assert.equal(db.tables["organizations"]![0]!["lifecycle_status"], "provisioning");
    assert.ok(r.generatedConfig?.fingerprint);
    assert.equal(n["verified_deployment_id"], "dep-new");
    assert.equal(n["verified_sarvam_app_id"], "Customer-app-1");
    assert.equal(n["verified_sarvam_app_version"], 1);
    assert.deepEqual(
      calls.log,
      ["create", "get", "pause", "get", "resume", "get"],
      "created (active) -> paused -> verified -> resumed -> read back",
    );
  });

  test("onboarding gaps stop at step 1 with the missing capability data", async () => {
    const db = world();
    const { d } = deps(db, {
      loadSnapshot: async () => ({ ...snapshot({ calendar_book: true }), services: [] }),
    });
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "waiting_for_onboarding");
    assert.match(r.note, /Appointment booking is on but needs at least one active service/);
    assert.equal(num(db, "num_new")["status"], "provisioning", "nothing activated");
  });

  test("no assigned number stops at step 2 (no pool claim, nothing bought)", async () => {
    const db = world();
    db.tables["phone_numbers"] = db.tables["phone_numbers"]!.filter(
      (n) => n["organization_id"] !== ORG,
    );
    const r = await runProvisioningPipeline(db.client, ORG, deps(db).d);
    assert.equal(r.state, "waiting_for_number");
  });

  test("no live integration credential stops at step 4", async () => {
    const db = world();
    db.tables["sarvam_agent_integrations"]![0]!["expires_at"] = "2026-11-01T00:00:00Z";
    const r = await runProvisioningPipeline(db.client, ORG, deps(db).d);
    assert.equal(r.state, "waiting_for_integration_credential");
  });

  test("no registered Sarvam agent stops at step 5; the master template itself is refused at step 6", async () => {
    const waiting = world({ appId: null });
    assert.equal(
      (await runProvisioningPipeline(waiting.client, ORG, deps(waiting).d)).state,
      "waiting_for_agent",
    );
    const master = world({ appId: "Master-agent" });
    const r = await runProvisioningPipeline(master.client, ORG, deps(master).d);
    assert.equal(r.state, "failed");
    assert.match(r.note, /universal master agent/);
  });
});

describe("deployment verification (steps 8-9) — the number is activated only after both pass", () => {
  const cases: [string, Partial<DeploymentView>, RegExp][] = [
    ["paused deployment", { status: "paused" }, /status is paused/],
    ["wrong agent", { appId: "Someone-else" }, /runs agent Someone-else/],
    ["stale version", { appVersion: 0 }, /runs version 0/],
    ["no result webhook", { webhookUrlConfigured: false }, /webhook is not configured/],
    ["number not routed", { phoneNumbers: ["+917900000009"] }, /does not route/],
  ];
  for (const [name, deployment, pattern] of cases)
    test(name, async () => {
      const db = world();
      const r = await runProvisioningPipeline(db.client, ORG, deps(db, { deployment }).d);
      assert.equal(r.state, "verification_failed");
      assert.match(r.note, pattern);
      assert.equal(num(db, "num_new")["status"], "provisioning");
      assert.equal(num(db, "num_new")["inbound_enabled"], false);
    });

  test("Sarvam unreachable during verification is a verification failure, not activation", async () => {
    const db = world();
    const r = await runProvisioningPipeline(
      db.client,
      ORG,
      deps(db, {
        getDeployment: async () => {
          throw new Error("timeout");
        },
      }).d,
    );
    assert.equal(r.state, "verification_failed");
    assert.equal(num(db, "num_new")["status"], "provisioning");
  });

  test("a failed deployment create reports step 7 and activates nothing", async () => {
    const db = world();
    const r = await runProvisioningPipeline(
      db.client,
      ORG,
      deps(db, {
        createDeployment: async () => {
          throw new Error("400 from Sarvam");
        },
      }).d,
    );
    assert.equal(r.state, "failed");
    assert.equal(r.step, 7);
    assert.equal(num(db, "num_new")["status"], "provisioning");
  });
});

describe("tenant isolation", () => {
  test("only this customer's number, connection row and agent are touched; the other customer is unchanged", async () => {
    const db = world();
    const before = JSON.stringify(db.tables["phone_numbers"]!.find((n) => n["id"] === "num_other"));
    await runProvisioningPipeline(db.client, ORG, deps(db).d);
    assert.equal(
      JSON.stringify(db.tables["phone_numbers"]!.find((n) => n["id"] === "num_other")),
      before,
    );
    assert.equal(db.tables["organizations"]![1]!["lifecycle_status"], "active");
  });

  test("a number already on a deployment but linked to another connection or agent is not relinked", async () => {
    const db = world({ deploymentId: "dep-old" });
    num(db, "num_new")["agent_config_id"] = "agent_other";
    const r = await runProvisioningPipeline(db.client, ORG, deps(db).d);
    assert.equal(r.state, "failed");
    assert.equal(num(db, "num_new")["agent_config_id"], "agent_other");
  });
});

describe("voice and language (Phase 4A)", () => {
  const vl = (db: ReturnType<typeof world>) => db.tables["agent_voice_language_settings"]![0]!;

  test("no saved voice/language stops at step 3, before any deployment", async () => {
    const db = world();
    db.tables["agent_voice_language_settings"] = [];
    const { d, calls } = deps(db);
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "waiting_for_voice_language");
    assert.equal(r.step, 3);
    assert.equal(calls.create, 0);
  });

  test("invalid saved settings (legacy v3.1 voice) stop at step 3 with the reason", async () => {
    const db = world();
    vl(db)["sarvam_voice_internal_id"] = "01a0cf16-5db4-7924-a37d-8f3bb1234d7c";
    const r = await runProvisioningPipeline(db.client, ORG, deps(db).d);
    assert.equal(r.state, "waiting_for_voice_language");
    assert.match(r.note, /legacy v3\.1/);
  });

  test("settings saved but not applied, or applied to another version, stop at step 6", async () => {
    for (const patch of [
      { status: "pending", applied_sarvam_app_id: null, applied_sarvam_app_version: null },
      { status: "applied", applied_sarvam_app_id: "Customer-app-1", applied_sarvam_app_version: 7 },
      // Same version number, different Sarvam agent (Phase 5): not applied.
      { status: "applied", applied_sarvam_app_id: "Old-copy-app", applied_sarvam_app_version: 1 },
    ]) {
      const db = world();
      Object.assign(vl(db), patch);
      const { d, calls } = deps(db);
      const r = await runProvisioningPipeline(db.client, ORG, d);
      assert.equal(r.state, "waiting_for_voice_language", JSON.stringify(patch));
      assert.equal(r.step, 6);
      assert.equal(calls.create, 0, "no deployment before the voice is applied");
      assert.equal(num(db, "num_new")["status"], "provisioning");
    }
  });

  test("another customer's settings row is never used", async () => {
    const db = world();
    vl(db)["organization_id"] = OTHER;
    const r = await runProvisioningPipeline(db.client, ORG, deps(db).d);
    assert.equal(r.state, "failed");
  });

  test("the generated config carries the voice, languages and exact Sarvam settings", async () => {
    const db = world();
    const r = await runProvisioningPipeline(db.client, ORG, deps(db).d);
    assert.equal(r.state, "active");
    const v = r.generatedConfig!.voiceLanguage!;
    assert.equal(v.defaultLanguage, "English");
    assert.deepEqual(v.sarvamConfig.language_config.supported_languages, ["English", "Hindi"]);
    assert.equal(
      v.sarvamConfig.text_to_speech_config.internal_id,
      "01a0cf17-12bd-7de3-9df0-f607db604d52",
    );
  });
});

describe("retries", () => {
  test("re-running after success creates nothing new and stays active", async () => {
    const db = world();
    const { d, calls } = deps(db);
    await runProvisioningPipeline(db.client, ORG, d);
    const again = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(again.state, "active");
    assert.equal(calls.create, 1, "the recorded deployment is reused, never duplicated");
  });

  test("a run waiting for the manual Sarvam step resumes to active once the agent is registered", async () => {
    const db = world({ appId: null });
    const { d } = deps(db);
    const first = await runProvisioning(
      db.client,
      { organizationId: ORG, trigger: "setup_fee" },
      (a, o) => runProvisioningPipeline(a, o, d),
    );
    assert.equal(first.status, "waiting");
    db.tables["agent_configs"]![0]!["sarvam_app_id"] = "Customer-app-1";
    const second = await runProvisioning(
      db.client,
      { organizationId: ORG, trigger: "admin_retry" },
      (a, o) => runProvisioningPipeline(a, o, d),
    );
    assert.equal(second.runId, first.runId);
    assert.equal(second.status, "succeeded");
    const run = db.tables["provisioning_runs"]![0]!;
    assert.equal(run["attempts"], 2);
    assert.ok(run["agent_config_fingerprint"]);
    assert.ok(run["deployment_verified_at"]);
    assert.equal(run["sarvam_deployment_id"], "dep-new");
  });

  test("a verification failure ends the run as failed; a retry starts a fresh run and can succeed", async () => {
    const db = world();
    const bad = deps(db, { deployment: { status: "paused" } }).d;
    const first = await runProvisioning(
      db.client,
      { organizationId: ORG, trigger: "setup_fee" },
      (a, o) => runProvisioningPipeline(a, o, bad),
    );
    assert.equal(first.status, "failed");
    const good = deps(db).d;
    const second = await runProvisioning(
      db.client,
      { organizationId: ORG, trigger: "admin_retry" },
      (a, o) => runProvisioningPipeline(a, o, good),
    );
    assert.notEqual(second.runId, first.runId);
    assert.equal(second.status, "succeeded");
  });

  test("an unexpected database error marks the run failed (retryable), never stuck running", async () => {
    const db = world();
    db.failNext("phone_numbers", "update", { message: "write failed" });
    await assert.rejects(
      runProvisioning(db.client, { organizationId: ORG, trigger: "setup_fee" }, (a, o) =>
        runProvisioningPipeline(a, o, deps(db).d),
      ),
      { message: "write failed" },
    );
    const run = db.tables["provisioning_runs"]![0]!;
    assert.equal(run["status"], "failed");
    assert.equal(run["last_error"], "write failed");
  });
});

describe("Phase 5: safe activation order and provider failures (mocked Sarvam)", () => {
  test("the ClickAI number is never ACTIVE before the resumed deployment is read back and verified", async () => {
    const db = world();
    let statusAtResume: unknown = "unset";
    const base = deps(db);
    const d: PipelineDeps = {
      ...base.d,
      setDeploymentStatus: async (id, action) => {
        if (action === "resume") statusAtResume = num(db, "num_new")["status"];
        await base.d.setDeploymentStatus(id, action);
      },
    };
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "active");
    assert.equal(statusAtResume, "provisioning", "still inactive in ClickAI when Sarvam resumes");
  });

  test("verified ids are saved while the number stays inactive; a failed resume keeps it inactive and re-pauses", async () => {
    const db = world();
    const { d, calls } = deps(db, { resumeFails: true });
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "verification_failed");
    assert.equal(r.step, 10);
    const n = num(db, "num_new");
    assert.equal(n["status"], "provisioning");
    assert.equal(n["inbound_enabled"], false);
    assert.equal(n["verified_deployment_id"], "dep-new", "verification persisted, number inactive");
    assert.ok(calls.pause >= 2, "paused after create and re-paused after the failed resume");
  });

  test("read-back after resume showing another agent leaves the number inactive and clears verification", async () => {
    const db = world();
    const base = deps(db);
    let resumed = false;
    const d: PipelineDeps = {
      ...base.d,
      setDeploymentStatus: async (id, action) => {
        if (action === "resume") resumed = true;
        await base.d.setDeploymentStatus(id, action);
      },
      getDeployment: async (id) => {
        const v = await base.d.getDeployment(id);
        return resumed ? { ...v, appId: "Someone-else" } : v;
      },
    };
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "verification_failed");
    assert.match(r.note, /runs agent Someone-else/);
    const n = num(db, "num_new");
    assert.equal(n["status"], "provisioning");
    assert.equal(n["verified_deployment_id"], null);
  });

  test("read-back returning a different deployment id is refused", async () => {
    const db = world();
    const base = deps(db);
    let resumed = false;
    const d: PipelineDeps = {
      ...base.d,
      setDeploymentStatus: async (id, action) => {
        if (action === "resume") resumed = true;
        await base.d.setDeploymentStatus(id, action);
      },
      getDeployment: async (id) => {
        const v = await base.d.getDeployment(id);
        return resumed ? { ...v, deploymentId: "dep-imposter" } : v;
      },
    };
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "verification_failed");
    assert.match(r.note, /returned deployment dep-imposter/);
    assert.equal(num(db, "num_new")["status"], "provisioning");
  });

  test("an unconfirmed number never reaches deployment creation (no rent, buy or claim)", async () => {
    const db = world();
    num(db, "num_new")["sarvam_number_confirmed_at"] = null;
    const { d, calls } = deps(db);
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "waiting_for_number_confirmation");
    assert.equal(r.step, 2);
    assert.equal(calls.create, 0);
    assert.equal(calls.get, 0);
  });

  test("a definite Sarvam refusal on create stops at manual_action_required (no blind retry)", async () => {
    for (const status of [400, 404, 422]) {
      const db = world();
      const { d } = deps(db, {
        createDeployment: async () => {
          throw Object.assign(new Error(`Sarvam rejected the request (${status}).`), {
            status,
            outcomeUnknown: false,
          });
        },
      });
      const r = await runProvisioningPipeline(db.client, ORG, d);
      assert.equal(r.state, "manual_action_required", String(status));
      assert.equal(r.step, 7);
      assert.equal(num(db, "num_new")["status"], "provisioning");
    }
  });

  test("a number already routed by another deployment needs manual action", async () => {
    const db = world();
    const { d } = deps(db, {
      createDeployment: async () => {
        throw new Error(
          "Sarvam already routes +917900000002 through deployment dep-x (agent Other). Resolve that deployment in Sarvam first; no duplicate was created.",
        );
      },
    });
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "manual_action_required");
  });

  test("a provider timeout or rate limit on create is a retryable failure, and the retry adopts instead of duplicating", async () => {
    for (const [status, message] of [
      [503, "Sarvam did not respond in time. Please retry."],
      [429, "Sarvam rate-limited this request. Please retry shortly. Sarvam asked to wait 30s."],
    ] as const) {
      const db = world();
      let attempt = 0;
      const base = deps(db);
      const d: PipelineDeps = {
        ...base.d,
        createDeployment: async (admin, params) => {
          attempt++;
          if (attempt === 1)
            throw Object.assign(new Error(message), { status, outcomeUnknown: true });
          // The first request had in fact reached Sarvam: the helper adopts it.
          const row = db.tables["phone_numbers"]!.find(
            (n) => n["id"] === params.phoneNumberIds[0],
          )!;
          row["provider_deployment_id"] = "dep-new";
          void admin;
          return { deploymentId: "dep-new", outcome: "adopted" };
        },
      };
      const first = await runProvisioningPipeline(db.client, ORG, d);
      assert.equal(first.state, "failed", String(status));
      assert.equal(first.step, 7);
      assert.match(first.note, status === 429 ? /wait 30s/ : /in time/);
      const second = await runProvisioningPipeline(db.client, ORG, d);
      assert.equal(second.state, "active");
      assert.equal(second.deploymentCreatedNow, false, "adopted, not duplicated");
      assert.deepEqual(
        base.calls.log.filter((a) => a === "pause" || a === "resume"),
        ["pause", "resume"],
        "the adopted deployment was paused until verified, then resumed",
      );
    }
  });

  test("a stale version on the deployment is synced (state preserved) before verification", async () => {
    const db = world();
    const { d, calls, sarvam } = deps(db);
    await runProvisioningPipeline(db.client, ORG, d);
    db.tables["agent_configs"]![0]!["sarvam_app_version"] = 2;
    db.tables["agent_voice_language_settings"]![0]!["applied_sarvam_app_version"] = 2;
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "active", r.note);
    assert.equal(calls.sync, 1);
    assert.equal(sarvam.appVersion, 2);
    assert.equal(num(db, "num_new")["verified_sarvam_app_version"], 2);
  });

  test("a legacy deployment (not ClickAI-provisioned) on a number that is not live: stop, never pause or resume", async () => {
    const db = world({ deploymentId: "dep-legacy" });
    num(db, "num_new")["connection_id"] = "conn_new";
    num(db, "num_new")["agent_config_id"] = "agent_new";
    num(db, "num_new")["sarvam_number_confirmed_at"] = null;
    const { d, calls } = deps(db);
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "manual_action_required", r.note);
    assert.match(r.note, /not created through ClickAI's confirmed-number flow/);
    assert.equal(calls.pause + calls.resume + calls.get, 0, "Sarvam was not touched");
    assert.equal(num(db, "num_new")["status"], "provisioning");
  });

  test("an already-live number re-verified with a version mismatch loses its verified mapping (gate closes)", async () => {
    const db = world();
    const { d } = deps(db);
    await runProvisioningPipeline(db.client, ORG, d);
    const { d: bad } = deps(db, {
      deployment: { appVersion: 9 },
      syncDeployments: async () => {
        throw new Error("Sarvam is temporarily unavailable. Please retry.");
      },
    });
    const r = await runProvisioningPipeline(db.client, ORG, bad);
    assert.equal(r.state, "verification_failed");
    assert.equal(num(db, "num_new")["verified_deployment_id"], null);
  });

  test("duplicate activation requests start one run only", async () => {
    const db = world();
    const { d, calls } = deps(db);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        runProvisioning(db.client, { organizationId: ORG, trigger: "customer_activate" }, (a, o) =>
          runProvisioningPipeline(a, o, d),
        ),
      ),
    );
    assert.equal(results.filter((r) => r.claimed).length, 1);
    assert.equal(calls.create, 1);
  });

  test("end to end (mocked Sarvam): waiting for each manual step, then live", async () => {
    const db = world({ appId: null });
    num(db, "num_new")["sarvam_number_confirmed_at"] = null;
    db.tables["agent_voice_language_settings"]![0]!["status"] = "pending";
    const { d, calls } = deps(db);
    const go = () =>
      runProvisioning(db.client, { organizationId: ORG, trigger: "customer_activate" }, (a, o) =>
        runProvisioningPipeline(a, o, d),
      );
    assert.equal((await go()).result?.state, "waiting_for_number_confirmation");
    num(db, "num_new")["sarvam_number_confirmed_at"] = "2026-11-14T09:30:00Z";
    assert.equal((await go()).result?.state, "waiting_for_agent");
    db.tables["agent_configs"]![0]!["sarvam_app_id"] = "Customer-app-1";
    assert.equal((await go()).result?.state, "waiting_for_voice_language");
    Object.assign(db.tables["agent_voice_language_settings"]![0]!, { status: "applied" });
    const last = await go();
    assert.equal(last.status, "succeeded");
    assert.equal(last.result?.state, "active");
    assert.equal(calls.create, 1);
    assert.equal(num(db, "num_new")["status"], "active");
  });
});

describe("Phase 5 fix 2: reusing an existing deployment safely (mocked Sarvam)", () => {
  const recorded = (db: ReturnType<typeof world>, dep = "dep-new") => {
    Object.assign(num(db, "num_new"), {
      provider_deployment_id: dep,
      connection_id: "conn_new",
      agent_config_id: "agent_new",
    });
  };

  test("reused ACTIVE deployment serving this customer's live number is never paused; re-verified only", async () => {
    const db = world({ numberStatus: "active", deploymentId: "dep-new" });
    recorded(db);
    num(db, "num_new")["inbound_enabled"] = true;
    num(db, "num_new")["sarvam_number_confirmed_at"] = null; // a legacy live customer
    const { d, calls } = deps(db);
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "active", r.note);
    assert.equal(calls.pause + calls.resume, 0);
    assert.equal(num(db, "num_new")["verified_deployment_id"], "dep-new");
  });

  test("reused deployment also recorded for ANOTHER customer's active number: stop, nothing touched", async () => {
    const db = world();
    recorded(db, "dep-other");
    const { d, calls } = deps(db);
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "manual_action_required");
    assert.match(r.note, /also recorded for 1 other ClickAI number/);
    assert.equal(calls.pause + calls.resume + calls.get, 0);
    assert.equal(num(db, "num_other")["status"], "active", "the other customer is untouched");
  });

  test("reused PAUSED deployment of a ClickAI-provisioned number: not paused again, resumed only after verification", async () => {
    const db = world();
    recorded(db);
    const { d, calls } = deps(db, { initialStatus: "paused" });
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "active", r.note);
    assert.equal(calls.pause, 0);
    assert.deepEqual(calls.log, ["get", "resume", "get"]);
    assert.equal(r.verification?.actual.statusBeforeRun, "paused", "original state recorded");
  });

  test("reused ACTIVE deployment of a ClickAI-provisioned number that is not live: paused, pause confirmed, then verified", async () => {
    const db = world();
    recorded(db);
    const { d, calls } = deps(db, { initialStatus: "active" });
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "active", r.note);
    assert.deepEqual(calls.log, ["get", "pause", "get", "resume", "get"]);
    assert.equal(r.verification?.actual.statusBeforeRun, "active");
  });

  test("a pause Sarvam accepts but does not apply: stop for a person, number stays inactive", async () => {
    const db = world();
    recorded(db);
    const { d } = deps(db, { deployment: { status: "active" } });
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "manual_action_required");
    assert.match(r.note, /still reports active after pausing/);
    assert.equal(num(db, "num_new")["status"], "provisioning");
  });

  test("an unexpected Sarvam status stops for a person", async () => {
    const db = world();
    recorded(db);
    const { d } = deps(db, { deployment: { status: "deleting" } });
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "manual_action_required");
  });

  test("multiple assigned numbers: stop at step 2, no deployment work at all", async () => {
    const db = world();
    db.tables["phone_numbers"]!.push({
      id: "num_second",
      e164: "+917900000003",
      status: "provisioning",
      provider: "sarvam",
      organization_id: ORG,
      connection_id: null,
      agent_config_id: null,
      provider_deployment_id: null,
      inbound_enabled: false,
      sarvam_number_confirmed_at: "2026-11-14T09:00:00Z",
    });
    const { d, calls } = deps(db);
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "manual_action_required");
    assert.equal(r.step, 2);
    assert.match(r.note, /2 Sarvam numbers/);
    assert.equal(calls.create + calls.get, 0);
  });
});

describe("dual-agent provisioning: the outbound agent (steps 11-12)", () => {
  test("inbound goes live even without the outbound agent; the run waits for its credential", async () => {
    const db = world({ outbound: false });
    const { d, calls } = deps(db);
    const r = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(r.state, "waiting_for_outbound_credential", r.note);
    assert.equal(r.step, 11);
    assert.match(r.note, /\+917900000002 is live/);
    assert.equal(num(db, "num_new")["status"], "active", "inbound is not held back");
    assert.equal(calls.create, 1);
  });

  test("with the outbound credential but no outbound agent, the run waits for the operator", async () => {
    const db = world({ outbound: "no_agent" });
    const r = await runProvisioningPipeline(db.client, ORG, deps(db).d);
    assert.equal(r.state, "waiting_for_outbound_agent", r.note);
    assert.equal(r.step, 12);
    assert.match(r.note, /outbound template/);
  });

  test("an outbound agent that is the inbound agent or a master template fails the run", async () => {
    const same = world({ outbound: "inbound_agent" });
    const r1 = await runProvisioningPipeline(same.client, ORG, deps(same).d);
    assert.equal(r1.state, "failed");
    assert.equal(r1.step, 12);
    const master = world();
    master.tables["agent_configs"]![0]!["sarvam_outbound_app_id"] = "Outbound-master";
    const r2 = await runProvisioningPipeline(
      master.client,
      ORG,
      deps(master, { outboundMasterAgentAppId: "Outbound-master" }).d,
    );
    assert.equal(r2.state, "failed");
    assert.match(r2.note, /master template/);
  });

  test("an expired or inbound-role credential does not count as the outbound credential", async () => {
    const db = world();
    const out = db.tables["sarvam_agent_integrations"]!.find((r) => r["id"] === "int_new_out")!;
    out["expires_at"] = "2026-11-01T00:00:00Z";
    const r = await runProvisioningPipeline(db.client, ORG, deps(db).d);
    assert.equal(r.state, "waiting_for_outbound_credential");
    out["expires_at"] = null;
    out["role"] = "inbound";
    out["status"] = "disabled";
    const again = await runProvisioningPipeline(db.client, ORG, deps(db).d);
    assert.equal(again.state, "waiting_for_outbound_credential");
  });

  test("partial success then retry: the live inbound side is only re-read, never recreated", async () => {
    const db = world({ outbound: "no_agent" });
    const { d, calls } = deps(db);
    const first = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(first.state, "waiting_for_outbound_agent");
    assert.equal(calls.create, 1);
    const resumesAfterFirst = calls.resume;

    // The operator registers the outbound agent; the next run completes.
    Object.assign(db.tables["agent_configs"]![0]!, {
      sarvam_outbound_app_id: "Customer-out-1",
      sarvam_outbound_app_version: 2,
    });
    const second = await runProvisioningPipeline(db.client, ORG, d);
    assert.equal(second.state, "active", second.note);
    assert.equal(second.step, 12);
    assert.match(second.note, /Customer-out-1 v2/);
    assert.equal(calls.create, 1, "no second deployment");
    assert.equal(calls.resume, resumesAfterFirst, "the live deployment is not resumed again");
    assert.equal(num(db, "num_new")["status"], "active");
    assert.equal(db.tables["agent_configs"]![0]!["sarvam_app_id"], "Customer-app-1");
  });

  test("registering the outbound agent never switches outbound calling on", async () => {
    const db = world();
    const r = await runProvisioningPipeline(db.client, ORG, deps(db).d);
    assert.equal(r.state, "active");
    assert.match(r.note, /outbound calling stays off/);
    const agent = db.tables["agent_configs"]![0]!;
    assert.equal(agent["sarvam_outbound_ready_app_id"], undefined);
    assert.equal(num(db, "num_new")["outbound_enabled"], undefined);
  });
});
