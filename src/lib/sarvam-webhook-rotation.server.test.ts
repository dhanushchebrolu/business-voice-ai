import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SarvamTelephonyAdapter } from "./telephony/sarvam-provider.server.ts";
import { getDeployment } from "./telephony/sarvam-api-client.server.ts";
import {
  deploymentVerificationChecks,
  webhookAccepted,
  type DeploymentView,
} from "./provisioning-pipeline.server.ts";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import {
  loadRecoveryMarker,
  RECOVERY_MARKER_KEY,
  recoveryMarkerOf,
  redactWebhookSecrets,
  resumeAfterFailedRotation,
  rotateDeploymentWebhook,
  ROTATION_AUDIT_ACTIONS,
  RESUME_AUDIT_ACTIONS,
  type WebhookRotationDeps,
} from "./sarvam-webhook-rotation.server.ts";

/**
 * Sarvam webhook-token rotation (mocked Sarvam only). Test tokens below are
 * made-up strings, not real secrets.
 */

const OLD = "old-test-token-AAAAAAAAAAAAAAAAAAAAAAAA";
const NEW = "new-test-token-BBBBBBBBBBBBBBBBBBBBBBBB";
const BASE = "https://clickai.example/api/public/webhooks/telephony?provider=sarvam&verify_token=";
const adapter = (current: string | undefined, previous?: string) =>
  new SarvamTelephonyAdapter({
    inboundApiKey: "test-in",
    outboundApiKey: "test-out",
    orgId: "org_1",
    workspaceId: "ws_1",
    webhookSecret: current,
    previousWebhookSecret: previous,
  });
const accepts = (a: SarvamTelephonyAdapter, token: string | null) =>
  a.verifyWebhookSignature(
    "{}",
    {},
    new URL(token === null ? BASE.replace("&verify_token=", "") : BASE + encodeURIComponent(token)),
  );

describe("dual-token validation", () => {
  test("outside a rotation only the current token is accepted (unchanged behaviour)", () => {
    const a = adapter(OLD);
    assert.equal(accepts(a, OLD), true);
    assert.equal(accepts(a, NEW), false);
    assert.equal(accepts(a, "wrong"), false);
    assert.equal(accepts(a, ""), false);
    assert.equal(accepts(a, null), false, "missing token rejected");
  });

  test("grace period: the new (current) and old (previous) tokens are both accepted", () => {
    const a = adapter(NEW, OLD);
    assert.equal(accepts(a, NEW), true, "new token accepted");
    assert.equal(accepts(a, OLD), true, "old token accepted during the grace period");
    assert.equal(accepts(a, "invalid-token"), false, "invalid token rejected");
    assert.equal(accepts(a, null), false, "missing token rejected");
  });

  test("rotation complete (previous removed): the old token is rejected, the new one accepted", () => {
    const a = adapter(NEW);
    assert.equal(accepts(a, NEW), true);
    assert.equal(accepts(a, OLD), false);
  });

  test("a previous token alone never authenticates (no current secret = fail closed)", () => {
    const a = adapter(undefined, OLD);
    assert.equal(accepts(a, OLD), false);
  });

  test("an empty previous value adds nothing", () => {
    const a = adapter(NEW, "");
    assert.equal(accepts(a, ""), false);
    assert.equal(accepts(a, OLD), false);
  });

  test("token classification", () => {
    const a = adapter(NEW, OLD);
    assert.equal(a.webhookTokenStatus(NEW), "current");
    assert.equal(a.webhookTokenStatus(OLD), "previous");
    assert.equal(a.webhookTokenStatus("other"), "unknown");
    assert.equal(a.webhookTokenStatus(null), "none");
  });
});

describe("deployment reads never carry the token", () => {
  const fetchWith = (url: string | null) =>
    (async () =>
      new Response(
        JSON.stringify({
          deployment_id: "dep_1",
          app_id: "app_1",
          app_version: 5,
          status: "active",
          connection_configs: [{ connection_id: "c1", phone_numbers: ["+917900000061"] }],
          ...(url ? { webhook_config: { url } } : {}),
        }),
        { status: 200 },
      )) as typeof fetch;
  const cfg = (url: string | null) => ({
    apiKey: "test",
    orgId: "o",
    workspaceId: "w",
    fetchImpl: fetchWith(url),
  });

  test("the classifier sees the token; the returned object holds only the label", async () => {
    let seen: string | null = "unset";
    const d = await getDeployment(cfg(BASE + encodeURIComponent(OLD)), "dep_1", {
      classifyWebhookToken: (t) => {
        seen = t;
        return t === OLD ? "previous" : "unknown";
      },
    });
    assert.equal(seen, OLD);
    assert.equal(d.webhookTokenStatus, "previous");
    assert.equal(d.webhookUrlConfigured, true);
    assert.doesNotMatch(JSON.stringify(d), new RegExp(OLD));
    assert.doesNotMatch(JSON.stringify(d), /verify_token|clickai\.example/);
  });

  test("no webhook: classifier gets null; without a classifier nothing is added", async () => {
    const none = await getDeployment(cfg(null), "dep_1", {
      classifyWebhookToken: (t) => (t ? "x" : "none"),
    });
    assert.equal(none.webhookTokenStatus, "none");
    const plain = await getDeployment(cfg(BASE + OLD), "dep_1");
    assert.equal(plain.webhookTokenStatus, undefined);
  });

  test("the adapter classifies with its own secrets", async () => {
    const a = new SarvamTelephonyAdapter({
      inboundApiKey: "test-in",
      outboundApiKey: "test-out",
      orgId: "o",
      workspaceId: "w",
      webhookSecret: NEW,
      previousWebhookSecret: OLD,
      fetchImpl: fetchWith(BASE + encodeURIComponent(OLD)),
    });
    const d = await a.getDeployment("dep_1");
    assert.equal(d.webhookTokenStatus, "previous");
    assert.doesNotMatch(JSON.stringify(d), new RegExp(`${OLD}|${NEW}`));
  });
});

describe("verification requires a token ClickAI accepts", () => {
  const view = (t?: string): DeploymentView => ({
    deploymentId: "dep_1",
    appId: "app_1",
    appVersion: 5,
    status: "active",
    phoneNumbers: ["+917900000061"],
    webhookUrlConfigured: true,
    ...(t === undefined ? {} : { webhookTokenStatus: t }),
  });
  test("current and previous pass; unknown and none fail; unclassified keeps the old presence check", () => {
    assert.equal(webhookAccepted(view("current")), true);
    assert.equal(webhookAccepted(view("previous")), true);
    assert.equal(webhookAccepted(view("unknown")), false);
    assert.equal(
      webhookAccepted({ webhookUrlConfigured: false, webhookTokenStatus: "none" }),
      false,
    );
    assert.equal(webhookAccepted(view()), true);
  });
  test("the shared verification checks report an unaccepted token without revealing it", () => {
    const checks = deploymentVerificationChecks(
      view("unknown"),
      {
        deploymentId: "dep_1",
        appId: "app_1",
        appVersion: 5,
        e164: "+917900000061",
        organizationId: "org",
        wantActive: true,
      },
      { provider_deployment_id: "dep_1", organization_id: "org" },
    );
    const w = checks.find((c) => c.id === "webhook")!;
    assert.equal(w.ok, false);
    assert.match(w.detail, /token ClickAI does not accept/);
  });
});

describe("rotation workflow with a durable recovery marker (mocked Sarvam)", () => {
  const ORG = "org_a";
  const OTHER = "org_b";
  const T0 = "2026-11-14T10:00:00.000Z";
  const row = (over: Record<string, unknown>) => ({
    status: "active",
    inbound_enabled: true,
    provider: "sarvam",
    metadata: { unrelated_key: "kept" },
    updated_at: T0,
    ...over,
  });
  const numbersDefault = () => [
    row({ id: "n1", e164: "+917900000061", organization_id: ORG, provider_deployment_id: "dep_1" }),
    row({
      id: "n2",
      e164: "+917900000099",
      organization_id: OTHER,
      provider_deployment_id: "dep_2",
    }),
  ];
  const world = (numbers?: Record<string, unknown>[]) =>
    memorySupabase({ tables: { phone_numbers: numbers ?? numbersDefault() } });
  const markerOn = (db: ReturnType<typeof world>, id = "n1") =>
    recoveryMarkerOf(db.tables["phone_numbers"]!.find((n) => n["id"] === id)!["metadata"]);

  /** Stateful mocked Sarvam. `onPause` lets a test inspect the database mid-operation. */
  const sarvam = (
    over: {
      status?: string;
      token?: string;
      pauseFails?: boolean;
      pauseFailsButApplies?: boolean;
      updateFails?: boolean;
      resumeFails?: number;
      updateLeavesOld?: boolean;
      errorEchoesUrl?: boolean;
      readFailsAfterUpdate?: boolean;
      crashAfterPause?: boolean;
      onPause?: () => void;
    } = {},
  ) => {
    const s = {
      status: over.status ?? "active",
      token: over.token ?? "previous",
      log: [] as string[],
      resumeFailuresLeft: over.resumeFails ?? 0,
      updated: false,
    };
    const deps: WebhookRotationDeps = {
      getDeployment: async (id) => {
        s.log.push(`get:${id}`);
        if (over.readFailsAfterUpdate && s.updated) throw new Error("timeout");
        return {
          deploymentId: id,
          appId: "app_1",
          appVersion: 5,
          status: s.status,
          phoneNumbers: [id === "dep_1" ? "+917900000061" : "+917900000099"],
          webhookUrlConfigured: true,
          webhookTokenStatus: s.token,
        };
      },
      setDeploymentStatus: async (id, action) => {
        s.log.push(`${action}:${id}`);
        if (action === "pause") {
          over.onPause?.();
          if (over.pauseFailsButApplies) {
            s.status = "paused";
            throw new Error("Sarvam did not respond in time.");
          }
          if (over.pauseFails) throw new Error("Sarvam is temporarily unavailable.");
          s.status = "paused";
          if (over.crashAfterPause) throw new Error("WORKER_STOPPED");
        } else {
          if (s.resumeFailuresLeft > 0) {
            s.resumeFailuresLeft--;
            throw new Error("Sarvam is temporarily unavailable.");
          }
          s.status = "active";
        }
      },
      updateWebhook: async (id, webhook) => {
        s.log.push(`patch:${id}`);
        assert.equal(webhook.metadata["organization_id"], ORG);
        if (over.updateFails)
          throw new Error(
            over.errorEchoesUrl
              ? `Sarvam rejected the request as invalid. url ${webhook.url} not allowed`
              : "Sarvam rejected the request as invalid.",
          );
        if (s.status !== "paused") throw new Error("Only paused deployments can be edited");
        s.updated = true;
        if (!over.updateLeavesOld) s.token = "current";
      },
      webhookUrl: () => ({ ok: true, url: BASE + encodeURIComponent(NEW) }),
      now: () => new Date("2026-11-14T11:00:00Z"),
    };
    return { deps, s };
  };
  const run = (
    db: ReturnType<typeof world>,
    deps: WebhookRotationDeps,
    opts: { confirmPause?: boolean; org?: string } = {},
  ) =>
    rotateDeploymentWebhook(
      db.client as never,
      { organizationId: opts.org ?? ORG, confirmPause: opts.confirmPause ?? true },
      deps,
    );
  const resume = (db: ReturnType<typeof world>, deps: WebhookRotationDeps, org = ORG) =>
    resumeAfterFailedRotation(db.client as never, { organizationId: org }, deps);
  const noSecrets = (x: unknown) => {
    const t = JSON.stringify(x);
    assert.doesNotMatch(t, new RegExp(`${OLD}|${NEW}`));
    assert.doesNotMatch(t, /verify_token=(?!\[redacted\])/);
  };

  describe("happy paths", () => {
    test("rotates; the marker exists during the pause and is cleared after the confirmed restore; other metadata kept", async () => {
      const db = world();
      let markerDuringPause: unknown = "unset";
      const { deps, s } = sarvam({ onPause: () => (markerDuringPause = markerOn(db)) });
      const r = await run(db, deps);
      assert.equal(r.outcome, "rotated", r.detail);
      assert.deepEqual(s.log, [
        "get:dep_1",
        "pause:dep_1",
        "patch:dep_1",
        "resume:dep_1",
        "get:dep_1",
      ]);
      assert.equal(
        (markerDuringPause as { state: string }).state,
        "in_progress",
        "durable before the pause",
      );
      assert.equal(markerOn(db), null, "cleared after confirmation");
      assert.equal(
        (db.tables["phone_numbers"]![0]!["metadata"] as Record<string, unknown>)["unrelated_key"],
        "kept",
      );
      noSecrets(r);
    });

    test("already current is idempotent and never writes a marker", async () => {
      const db = world();
      const { deps, s } = sarvam({ token: "current" });
      for (let i = 0; i < 3; i++) assert.equal((await run(db, deps)).outcome, "already_current");
      assert.ok(s.log.every((l) => l.startsWith("get:")));
      assert.equal(markerOn(db), null);
    });

    test("paused deployment: edited, left paused, no marker needed", async () => {
      const db = world();
      const { deps, s } = sarvam({ status: "paused" });
      const r = await run(db, deps, { confirmPause: false });
      assert.equal(r.outcome, "rotated");
      assert.equal(s.status, "paused");
      assert.equal(markerOn(db), null);
    });

    test("without confirmation nothing is written anywhere", async () => {
      const db = world();
      const { deps, s } = sarvam();
      assert.equal((await run(db, deps, { confirmPause: false })).outcome, "needs_confirmation");
      assert.deepEqual(s.log, ["get:dep_1"]);
      assert.equal(markerOn(db), null);
    });
  });

  describe("database failures", () => {
    test("marker cannot be written (database error): nothing is paused", async () => {
      const db = world();
      const { deps: base, s } = sarvam();
      const deps: WebhookRotationDeps = {
        ...base,
        getDeployment: async (id) => {
          db.failNext("phone_numbers", "update", { message: "connection reset" });
          return base.getDeployment(id);
        },
      };
      const r = await run(db, deps);
      assert.equal(r.outcome, "refused");
      assert.equal(r.stage, "persist");
      assert.deepEqual(s.log, ["get:dep_1"], "no pause, no edit");
      assert.equal(s.status, "active");
    });

    test("marker cannot be written (row changed concurrently): nothing is paused", async () => {
      const db = world();
      const { deps, s } = sarvam();
      const d: WebhookRotationDeps = {
        ...deps,
        getDeployment: async (id) => {
          // Another writer touches the row between our read and our marker write.
          db.tables["phone_numbers"]![0]!["updated_at"] = "2026-11-14T10:00:05.000Z";
          return deps.getDeployment(id);
        },
      };
      const r = await run(db, d);
      assert.equal(r.outcome, "refused");
      assert.equal(r.stage, "persist");
      assert.ok(!s.log.includes("pause:dep_1"));
    });

    test("marker cannot be cleared after a confirmed rotation: NOT reported as rotated; recovery clears it", async () => {
      const db = world();
      const { deps } = sarvam();
      const d: WebhookRotationDeps = {
        ...deps,
        setDeploymentStatus: async (id, action) => {
          await deps.setDeploymentStatus(id, action);
          if (action === "resume")
            db.failNext("phone_numbers", "update", { message: "connection reset" });
        },
      };
      const r = await run(db, d);
      assert.equal(r.outcome, "failed");
      assert.equal(r.stage, "persist");
      assert.match(r.detail, /not marked complete/);
      assert.equal(
        markerOn(db)?.state,
        "in_progress",
        "marker still there: dashboard keeps showing recovery",
      );
      const rec = await resume(db, deps);
      assert.equal(rec.outcome, "already_resumed");
      assert.equal(rec.markerCleared, true);
      assert.equal(markerOn(db), null);
    });

    test("recovery confirms Sarvam but cannot clear the marker: failed, marker kept, retry succeeds", async () => {
      const db = world();
      const { deps } = sarvam({ resumeFails: 1 });
      await run(db, deps);
      const rec = await resume(db, {
        ...deps,
        getDeployment: async (id) => {
          db.failNext("phone_numbers", "update", { message: "connection reset" });
          return deps.getDeployment(id);
        },
      });
      assert.equal(rec.outcome, "failed");
      assert.equal(rec.stage, "persist");
      assert.notEqual(markerOn(db), null);
      assert.equal((await resume(db, deps)).outcome, "already_resumed");
      assert.equal(markerOn(db), null);
    });
  });

  describe("Worker restart and reload", () => {
    test("Worker stops after the pause: the marker survives; a fresh attempt refuses; the dashboard sees it; recovery restores", async () => {
      const db = world();
      const { deps, s } = sarvam({ crashAfterPause: true });
      // Simulates a Worker stopping mid-operation (the pause throws after taking effect).
      const r1 = await run(db, deps);
      assert.equal(r1.outcome, "recovery_required");
      assert.equal(s.status, "paused");
      // "Restart": nothing in memory survives; only the database row.
      const fresh = sarvam({ status: "paused", token: "previous" });
      const dashboard = await loadRecoveryMarker(db.client as never, ORG);
      assert.equal(dashboard?.deploymentId, "dep_1");
      assert.equal(dashboard?.originalStatus, "active");
      const again = await run(db, fresh.deps);
      assert.equal(again.outcome, "recovery_required");
      assert.equal(again.stage, "precondition");
      assert.deepEqual(fresh.s.log, [], "no Sarvam call while recovery is pending");
      const rec = await resume(db, fresh.deps);
      assert.equal(rec.outcome, "resumed", rec.detail);
      assert.equal(fresh.s.status, "active");
      assert.equal(await loadRecoveryMarker(db.client as never, ORG), null);
    });

    test("a marker left in_progress (crash before any outcome was recorded) still blocks and is shown", async () => {
      const db = world([
        row({
          id: "n1",
          e164: "+917900000061",
          organization_id: ORG,
          provider_deployment_id: "dep_1",
          metadata: {
            [RECOVERY_MARKER_KEY]: {
              deploymentId: "dep_1",
              originalStatus: "active",
              appId: "app_1",
              appVersion: 5,
              state: "in_progress",
              recordedAt: T0,
            },
          },
        }),
      ]);
      const { deps, s } = sarvam({ status: "active" });
      assert.equal((await run(db, deps)).outcome, "recovery_required");
      assert.ok(!s.log.includes("pause:dep_1"));
      // Recovery finds it already active (it never got paused): confirm and clear.
      const rec = await resume(db, deps);
      assert.equal(rec.outcome, "already_resumed");
      assert.equal(markerOn(db), null);
    });
  });

  describe("failures and retries", () => {
    test("resume fails after a successful pause and update: recovery_required, marker upgraded, never rotated", async () => {
      const db = world();
      const { deps, s } = sarvam({ resumeFails: 1 });
      const r = await run(db, deps);
      assert.equal(r.outcome, "recovery_required");
      assert.equal(r.stage, "resume");
      assert.equal(s.status, "paused");
      assert.equal(r.tokenStatusAfter, "current");
      assert.equal(markerOn(db)?.state, "recovery_required");
      noSecrets(r);
    });

    test("read-back fails after the pause: recovery_required (cannot confirm)", async () => {
      const db = world();
      const r = await run(db, sarvam({ readFailsAfterUpdate: true }).deps);
      assert.equal(r.outcome, "recovery_required");
      assert.notEqual(markerOn(db), null);
    });

    test("pause fails (no effect): failed, marker cleared, retry rotates", async () => {
      const db = world();
      const r1 = await run(db, sarvam({ pauseFails: true }).deps);
      assert.equal(r1.outcome, "failed");
      assert.equal(r1.stage, "pause");
      assert.equal(markerOn(db), null);
      assert.equal((await run(db, sarvam().deps)).outcome, "rotated");
    });

    test("pause errors but took effect: recovery_required, no edit attempted", async () => {
      const db = world();
      const { deps, s } = sarvam({ pauseFailsButApplies: true });
      const r = await run(db, deps);
      assert.equal(r.outcome, "recovery_required");
      assert.ok(!s.log.includes("patch:dep_1"));
      assert.notEqual(markerOn(db), null);
    });

    test("update fails: resumed, marker cleared, failed; retry rotates", async () => {
      const db = world();
      const first = sarvam({ updateFails: true });
      const r1 = await run(db, first.deps);
      assert.equal(r1.outcome, "failed");
      assert.equal(r1.stage, "update");
      assert.equal(first.s.status, "active");
      assert.equal(markerOn(db), null);
      assert.equal((await run(db, sarvam().deps)).outcome, "rotated");
    });

    test("read-back mismatch (old token): failed, marker cleared; retry edits again and rotates", async () => {
      const db = world();
      const { deps } = sarvam({ updateLeavesOld: true });
      const r1 = await run(db, deps);
      assert.equal(r1.outcome, "failed");
      assert.match(r1.detail, /read-back token is previous/);
      assert.equal(markerOn(db), null);
      assert.equal((await run(db, sarvam().deps)).outcome, "rotated");
    });

    test("after a resume failure: rotation refused, recovery resumes and clears, then rotation is idempotent", async () => {
      const db = world();
      const { deps, s } = sarvam({ resumeFails: 1 });
      assert.equal((await run(db, deps)).outcome, "recovery_required");
      const before = s.log.length;
      assert.equal((await run(db, deps)).outcome, "recovery_required");
      assert.equal(s.log.length, before, "no Sarvam call");
      const rec = await resume(db, deps);
      assert.equal(rec.outcome, "resumed");
      assert.equal(rec.markerCleared, true);
      assert.equal((await resume(db, deps)).outcome, "refused", "nothing left to recover");
      assert.equal((await run(db, deps)).outcome, "already_current");
    });

    test("a recovery whose own resume fails keeps the marker and can be retried", async () => {
      const db = world();
      const { deps, s } = sarvam({ resumeFails: 2 });
      await run(db, deps);
      const rec = await resume(db, deps);
      assert.equal(rec.outcome, "failed");
      assert.equal(s.status, "paused");
      assert.notEqual(markerOn(db), null);
      assert.equal((await resume(db, deps)).outcome, "resumed");
      assert.equal(markerOn(db), null);
    });

    test("provider errors echoing the URL are redacted", async () => {
      const db = world();
      const r = await run(db, sarvam({ updateFails: true, errorEchoesUrl: true }).deps);
      noSecrets(r);
      assert.match(r.detail, /webhook-url-redacted|\[redacted\]/);
    });

    test("redactWebhookSecrets strips tokens and webhook URLs", () => {
      const t = redactWebhookSecrets(`x ${BASE}${NEW} y verify_token=${OLD}&a=1`);
      assert.doesNotMatch(t, new RegExp(`${OLD}|${NEW}`));
    });
  });

  describe("recovery only clears after Sarvam confirms", () => {
    const withMarker = (status = "paused") => {
      const db = world();
      db.tables["phone_numbers"]![0]!["metadata"] = {
        [RECOVERY_MARKER_KEY]: {
          deploymentId: "dep_1",
          originalStatus: "active",
          appId: "app_1",
          appVersion: 5,
          state: "recovery_required",
          recordedAt: T0,
        },
      };
      return { db, ...sarvam({ status }) };
    };
    test("Sarvam unreadable: failed, marker kept", async () => {
      const { db, deps } = withMarker();
      const r = await resume(db, {
        ...deps,
        getDeployment: async () => {
          throw new Error("timeout");
        },
      });
      assert.equal(r.outcome, "failed");
      assert.notEqual(markerOn(db), null);
    });
    test("different agent/version on Sarvam: refused, not resumed, marker kept", async () => {
      const { db, deps, s } = withMarker();
      const r = await resume(db, {
        ...deps,
        getDeployment: async (id) => ({ ...(await deps.getDeployment(id)), appVersion: 4 }),
      });
      assert.equal(r.outcome, "refused");
      assert.ok(!s.log.some((l) => l.startsWith("resume")));
      assert.notEqual(markerOn(db), null);
    });
    test("resume accepted but read-back still paused: failed, marker kept", async () => {
      const { db, deps } = withMarker();
      const r = await resume(db, { ...deps, setDeploymentStatus: async () => undefined });
      assert.equal(r.outcome, "failed");
      assert.notEqual(markerOn(db), null);
    });
    test("a marker whose original state was paused is never auto-resumed", async () => {
      const { db, deps, s } = withMarker();
      (db.tables["phone_numbers"]![0]!["metadata"] as Record<string, Record<string, unknown>>)[
        RECOVERY_MARKER_KEY
      ]!["originalStatus"] = "paused";
      const r = await resume(db, deps);
      assert.equal(r.outcome, "refused");
      assert.ok(!s.log.some((l) => l.startsWith("resume")));
    });
  });

  describe("tenant isolation", () => {
    test("rotation touches only the named customer's own deployment", async () => {
      const db = world();
      const { deps, s } = sarvam();
      await run(db, deps, { org: ORG });
      assert.ok(s.log.every((l) => l.endsWith("dep_1")));
      assert.equal(markerOn(db, "n2"), null);
    });
    test("one customer's marker neither blocks nor is visible to another", async () => {
      const db = world();
      await run(db, sarvam({ resumeFails: 1 }).deps); // leaves a marker on org A
      assert.notEqual(markerOn(db, "n1"), null);
      assert.equal(await loadRecoveryMarker(db.client as never, OTHER), null);
      const b = sarvam();
      const deps: WebhookRotationDeps = {
        ...b.deps,
        updateWebhook: async (id, webhook) => {
          b.s.log.push(`patch:${id}`);
          assert.equal(webhook.metadata["organization_id"], OTHER);
          b.s.token = "current";
        },
      };
      const r = await run(db, deps, { org: OTHER });
      assert.equal(r.outcome, "rotated", r.detail);
      assert.equal(r.deploymentId, "dep_2");
    });
    test("another customer cannot resume or clear this customer's marker", async () => {
      const db = world();
      await run(db, sarvam({ resumeFails: 1 }).deps);
      const { deps, s } = sarvam({ status: "paused" });
      const r = await resume(db, deps, OTHER);
      assert.equal(r.outcome, "refused", "org B has no marker of its own");
      assert.deepEqual(s.log, []);
      assert.notEqual(markerOn(db, "n1"), null, "org A's marker untouched");
    });
  });

  test("refusals before any Sarvam request return an auditable result instead of throwing", async () => {
    const cases: [Record<string, unknown>[], RegExp][] = [
      [[], /0 Sarvam numbers/],
      [
        [
          row({
            id: "n1",
            e164: "+917900000061",
            organization_id: ORG,
            provider_deployment_id: "dep_1",
          }),
          row({
            id: "n3",
            e164: "+917900000062",
            status: "provisioning",
            organization_id: ORG,
            provider_deployment_id: null,
          }),
        ],
        /2 Sarvam numbers/,
      ],
      [
        [
          row({
            id: "n1",
            e164: "+917900000061",
            organization_id: ORG,
            provider_deployment_id: "dep_1",
          }),
          row({
            id: "n9",
            e164: "+917900000063",
            organization_id: OTHER,
            provider_deployment_id: "dep_1",
          }),
        ],
        /also recorded for another number/,
      ],
    ];
    for (const [numbers, pattern] of cases) {
      const { deps, s } = sarvam();
      const r = await run(world(numbers), deps);
      assert.equal(r.outcome, "refused");
      assert.match(r.detail, pattern);
      assert.deepEqual(s.log, []);
    }
    const { deps, s } = sarvam();
    const r = await run(world(), {
      ...deps,
      webhookUrl: () => ({ ok: false, reason: "webhook_secret_missing" }),
    });
    assert.equal(r.outcome, "refused");
    assert.deepEqual(s.log, []);
  });
});

describe("audit actions", () => {
  test("names are fixed identifiers with no URL or token material", () => {
    for (const a of [
      ...Object.values(ROTATION_AUDIT_ACTIONS),
      ...Object.values(RESUME_AUDIT_ACTIONS),
    ])
      assert.match(a, /^[A-Z_]+$/);
  });
});
