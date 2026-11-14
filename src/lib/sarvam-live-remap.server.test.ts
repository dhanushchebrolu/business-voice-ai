import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import type { DeploymentView } from "./provisioning-pipeline.server.ts";
import { findLiveNumber, remapLiveAgent, type LiveRemapDeps } from "./sarvam-live-remap.server.ts";
import { checkInboundAdmission } from "./sarvam-inbound-admission.server.ts";

/**
 * Live re-verification (Phase 5 fix 1). A customer already live on Sarvam
 * (like a legacy customer with no voice settings or new onboarding) keeps
 * business data across a version change: Sarvam is moved and read back
 * first, and ClickAI's mapping + verified fields change only after that
 * passes. Mocked Sarvam only.
 */

const ORG = "org_live";
const DEP = "dep-live";

function world(over: { verified?: boolean; numbers?: Record<string, unknown>[] } = {}) {
  const verified = over.verified ?? true;
  return memorySupabase({
    tables: {
      organizations: [{ id: ORG, lifecycle_status: "active" }],
      agent_configs: [
        {
          id: "agent_live",
          organization_id: ORG,
          sarvam_app_id: "Live-app",
          sarvam_app_version: 5,
          sarvam_application_id: null,
        },
      ],
      // No agent_voice_language_settings, no onboarding data: not needed here.
      phone_numbers: over.numbers ?? [
        {
          id: "num_live",
          e164: "+917900000005",
          status: "active",
          provider: "sarvam",
          organization_id: ORG,
          agent_config_id: "agent_live",
          inbound_enabled: true,
          provider_deployment_id: DEP,
          verified_deployment_id: verified ? DEP : null,
          verified_sarvam_app_id: verified ? "Live-app" : null,
          verified_sarvam_app_version: verified ? 5 : null,
          deployment_verified_at: verified ? "2026-11-14T08:00:00Z" : null,
          admission_blocked_at: null,
        },
      ],
    },
  });
}

/** A stateful mocked Sarvam deployment. */
function sarvam(
  over: {
    patchFails?: boolean;
    patchLandsOn?: number;
    readFailsAfterPatch?: boolean;
    rollbackFails?: boolean;
    readFails?: boolean;
    view?: Partial<DeploymentView>;
  } = {},
) {
  const state = { version: 5, status: "active", patches: [] as number[] };
  let patched = false;
  const deps: LiveRemapDeps = {
    getDeployment: async (id) => {
      if (over.readFails || (patched && over.readFailsAfterPatch))
        throw new Error("Sarvam did not respond in time. Please retry.");
      return {
        deploymentId: id,
        appId: "Live-app",
        appVersion: state.version,
        status: state.status,
        phoneNumbers: ["+917900000005"],
        webhookUrlConfigured: true,
        ...over.view,
      };
    },
    setDeploymentAppVersion: async (_id, v) => {
      state.patches.push(v);
      if (patched && over.rollbackFails) throw new Error("Sarvam is temporarily unavailable.");
      patched = true;
      if (over.patchFails) throw new Error("Sarvam rejected the request (422).");
      state.version = v === 5 ? 5 : (over.patchLandsOn ?? v);
    },
    masterAgentAppId: "Master-agent",
    now: () => new Date("2026-11-14T12:00:00Z"),
  };
  return { deps, state };
}

const number = (db: ReturnType<typeof world>) => db.tables["phone_numbers"]![0]!;
const agent = (db: ReturnType<typeof world>) => db.tables["agent_configs"]![0]!;
const live = async (db: ReturnType<typeof world>) =>
  (await findLiveNumber(db.client as never, ORG, "agent_live"))!;
const remap = async (
  db: ReturnType<typeof world>,
  deps: LiveRemapDeps,
  version: number,
  appId = "Live-app",
) =>
  remapLiveAgent(
    db.client as never,
    {
      organizationId: ORG,
      agentConfigId: "agent_live",
      number: await live(db),
      appId,
      appVersion: version,
    },
    deps,
  );
const admitted = async (db: ReturnType<typeof world>) =>
  (
    await checkInboundAdmission(db.client as never, {
      organizationId: ORG,
      agentConfigId: "agent_live",
    })
  ).admitted;

describe("successful mapping", () => {
  test("moves Sarvam first, verifies the read-back, then saves mapping and verified fields; business data keeps flowing", async () => {
    const db = world();
    const { deps, state } = sarvam();
    assert.equal(await admitted(db), true);
    const r = await remap(db, deps, 6);
    assert.equal(r.outcome, "verified", r.detail);
    assert.deepEqual(state.patches, [6]);
    assert.equal(agent(db)["sarvam_app_version"], 6);
    assert.equal(number(db)["verified_sarvam_app_version"], 6);
    assert.equal(number(db)["verified_deployment_id"], DEP);
    assert.equal(await admitted(db), true, "no lasting interruption for the live customer");
  });

  test("same version = plain re-verification: no Sarvam write; works for a legacy customer never verified before", async () => {
    const db = world({ verified: false });
    const { deps, state } = sarvam();
    assert.equal(await admitted(db), false, "never verified: blocked");
    const r = await remap(db, deps, 5);
    assert.equal(r.outcome, "verified");
    assert.deepEqual(state.patches, [], "read only");
    assert.equal(number(db)["verified_sarvam_app_version"], 5);
    assert.equal(await admitted(db), true);
  });
});

describe("failed verification keeps the old mapping and verification", () => {
  test("Sarvam refuses the version change: mapping unchanged, Sarvam confirmed on the old version, still admitted", async () => {
    const db = world();
    const { deps, state } = sarvam({ patchFails: true });
    const r = await remap(db, deps, 6);
    assert.equal(r.outcome, "rolled_back");
    assert.match(r.detail, /422/);
    assert.equal(state.version, 5);
    assert.equal(agent(db)["sarvam_app_version"], 5);
    assert.equal(number(db)["verified_sarvam_app_version"], 5);
    assert.equal(await admitted(db), true);
  });

  test("mismatched version on read-back (Sarvam reports another version): rolled back to the old one and confirmed", async () => {
    const db = world();
    const { deps, state } = sarvam({ patchLandsOn: 7 });
    const r = await remap(db, deps, 6);
    assert.equal(r.outcome, "rolled_back");
    assert.match(r.detail, /runs version 7, not 6/);
    assert.deepEqual(state.patches, [6, 5], "put back on v5");
    assert.equal(state.version, 5);
    assert.equal(agent(db)["sarvam_app_version"], 5, "ClickAI mapping never moved");
    assert.equal(number(db)["verified_sarvam_app_version"], 5);
    assert.equal(await admitted(db), true);
  });

  test("new version without its result webhook is not accepted", async () => {
    const db = world();
    const { deps } = sarvam();
    const d: LiveRemapDeps = {
      ...deps,
      getDeployment: async (id) => {
        const v = await deps.getDeployment(id);
        return v.appVersion === 6 ? { ...v, webhookUrlConfigured: false } : v;
      },
    };
    const r = await remap(db, d, 6);
    assert.equal(r.outcome, "rolled_back");
    assert.equal(agent(db)["sarvam_app_version"], 5);
  });
});

describe("rollback that cannot be confirmed fails closed", () => {
  test("Sarvam unreadable after the change and the rollback: verified fields cleared, mapping unchanged, data blocked", async () => {
    const db = world();
    const { deps } = sarvam({ readFailsAfterPatch: true });
    const r = await remap(db, deps, 6);
    assert.equal(r.outcome, "blocked");
    assert.equal(agent(db)["sarvam_app_version"], 5);
    assert.equal(number(db)["verified_deployment_id"], null);
    assert.equal(await admitted(db), false, "never marks an unverified mapping valid");
  });

  test("version changed but rollback refused: cannot confirm v5, so blocked", async () => {
    const db = world();
    const { deps, state } = sarvam({ patchLandsOn: 7, rollbackFails: true });
    const r = await remap(db, deps, 6);
    assert.equal(r.outcome, "blocked");
    assert.equal(state.version, 7);
    assert.equal(number(db)["verified_deployment_id"], null);
    assert.equal(await admitted(db), false);
  });
});

describe("refusals that change nothing", () => {
  test("Sarvam unreadable before any change: throws, nothing written anywhere", async () => {
    const db = world();
    const { deps, state } = sarvam({ readFails: true });
    await assert.rejects(remap(db, deps, 6), /nothing was changed/);
    assert.deepEqual(state.patches, []);
    assert.equal(number(db)["verified_sarvam_app_version"], 5);
    assert.equal(await admitted(db), true);
  });

  test("a different Sarvam agent is refused for a live customer (needs a new deployment)", async () => {
    const db = world();
    const { deps, state } = sarvam();
    await assert.rejects(
      remap(db, deps, 1, "Other-app"),
      /only move to another version of its own/,
    );
    assert.deepEqual(state.patches, []);
    assert.equal(agent(db)["sarvam_app_id"], "Live-app");
  });

  test("a paused live deployment is not touched: reported, existing verification kept", async () => {
    const db = world();
    const { deps, state } = sarvam({ view: { status: "paused" } });
    const r = await remap(db, deps, 6);
    assert.equal(r.outcome, "rolled_back");
    assert.match(r.detail, /status is paused/);
    assert.deepEqual(state.patches, []);
  });

  test("the deployment no longer matches the saved mapping (other agent): verification cleared, nothing moved", async () => {
    const db = world();
    const { deps, state } = sarvam({ view: { appId: "Someone-else" } });
    const r = await remap(db, deps, 6);
    assert.equal(r.outcome, "blocked");
    assert.deepEqual(state.patches, []);
    assert.equal(number(db)["verified_deployment_id"], null);
  });
});

describe("which customers use this path", () => {
  test("only a live number qualifies; a provisioning number is left to the pipeline", async () => {
    const db = world();
    number(db)["status"] = "provisioning";
    assert.equal(await findLiveNumber(db.client as never, ORG, "agent_live"), null);
  });

  test("a live customer with a second Sarvam number must be sorted out by hand", async () => {
    const db = world();
    db.tables["phone_numbers"]!.push({
      id: "num_extra",
      e164: "+917900000006",
      status: "provisioning",
      provider: "sarvam",
      organization_id: ORG,
      agent_config_id: null,
    });
    await assert.rejects(
      findLiveNumber(db.client as never, ORG, "agent_live"),
      /more than one Sarvam number/,
    );
  });
});
