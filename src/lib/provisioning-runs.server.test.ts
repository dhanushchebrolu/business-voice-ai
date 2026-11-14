import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import { runProvisioning, runStatusFor, STALE_RUNNING_MS } from "./provisioning-runs.server.ts";
import type { ProvisionOrganizationResult } from "./provisioning-orchestrator.server.ts";

const ACTIVE = new Set(["pending", "running", "waiting"]);
const runsUnique = {
  table: "provisioning_runs",
  // Mirrors idx_provisioning_runs_one_active.
  key: (r: Record<string, unknown>) =>
    ACTIVE.has(r["status"] as string) ? (r["organization_id"] as string) : null,
};

const result = (
  state: ProvisionOrganizationResult["state"],
  extra: Partial<ProvisionOrganizationResult> = {},
) =>
  ({
    organizationId: "org_1",
    phoneNumberId: "num_1",
    numberClaimedNow: false,
    deploymentCreatedNow: false,
    note: `state ${state}`,
    state,
    ...extra,
  }) satisfies ProvisionOrganizationResult;

describe("runStatusFor", () => {
  test("maps orchestrator states onto run statuses", () => {
    assert.equal(runStatusFor(result("active")), "succeeded");
    assert.equal(runStatusFor(result("failed")), "failed");
    for (const s of [
      "waiting_for_agent",
      "waiting_for_connection",
      "waiting_for_number",
      "provisioning",
    ] as const)
      assert.equal(runStatusFor(result(s)), "waiting");
  });
});

describe("runProvisioning", () => {
  test("creates one run, records the step, and resumes the same run next time", async () => {
    const db = memorySupabase({ uniques: [runsUnique] });
    let calls = 0;
    const orchestrate = async () => {
      calls++;
      return result("waiting_for_agent");
    };
    const first = await runProvisioning(
      db.client,
      { organizationId: "org_1", trigger: "setup_fee" },
      orchestrate,
    );
    assert.equal(first.claimed, true);
    assert.equal(first.status, "waiting");
    const second = await runProvisioning(
      db.client,
      { organizationId: "org_1", trigger: "phone_service_fee" },
      async () => {
        calls++;
        return result("active", { deploymentId: "dep_1" });
      },
    );
    assert.equal(second.runId, first.runId, "the active run is resumed, not duplicated");
    assert.equal(calls, 2);
    const runs = db.tables["provisioning_runs"]!;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!["status"], "succeeded");
    assert.equal(runs[0]!["attempts"], 2);
    assert.equal(runs[0]!["sarvam_deployment_id"], "dep_1");
    assert.ok(runs[0]!["finished_at"]);
    assert.equal(
      runs[0]!["trigger"],
      "setup_fee",
      "the trigger of the run that started it is kept",
    );
  });

  test("a finished run lets the next trigger start a new run", async () => {
    const db = memorySupabase({ uniques: [runsUnique] });
    await runProvisioning(db.client, { organizationId: "org_1", trigger: "setup_fee" }, async () =>
      result("failed"),
    );
    const again = await runProvisioning(
      db.client,
      { organizationId: "org_1", trigger: "admin_retry" },
      async () => result("waiting_for_number"),
    );
    const runs = db.tables["provisioning_runs"]!;
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!["status"], "failed");
    assert.ok(runs[0]!["last_error"]);
    assert.equal(again.status, "waiting");
  });

  test("a run already running is not worked on in parallel", async () => {
    const db = memorySupabase({
      uniques: [runsUnique],
      tables: {
        provisioning_runs: [
          {
            id: "run_1",
            organization_id: "org_1",
            trigger: "setup_fee",
            status: "running",
            attempts: 1,
            updated_at: new Date().toISOString(),
          },
        ],
      },
    });
    let called = false;
    const r = await runProvisioning(
      db.client,
      { organizationId: "org_1", trigger: "setup_fee" },
      async () => {
        called = true;
        return result("active");
      },
    );
    assert.equal(r.claimed, false);
    assert.equal(called, false);
    assert.equal(db.tables["provisioning_runs"]!.length, 1);
  });

  test("a stale running run (crashed attempt) is reclaimed", async () => {
    const old = new Date(Date.now() - STALE_RUNNING_MS - 60_000).toISOString();
    const db = memorySupabase({
      uniques: [runsUnique],
      tables: {
        provisioning_runs: [
          {
            id: "run_1",
            organization_id: "org_1",
            trigger: "setup_fee",
            status: "running",
            attempts: 1,
            updated_at: old,
          },
        ],
      },
    });
    const r = await runProvisioning(
      db.client,
      { organizationId: "org_1", trigger: "admin_retry" },
      async () => result("waiting_for_agent"),
    );
    assert.equal(r.claimed, true);
    assert.equal(db.tables["provisioning_runs"]![0]!["attempts"], 2);
  });

  test("a database error is thrown, never reported as success", async () => {
    const db = memorySupabase({ uniques: [runsUnique] });
    db.failNext("provisioning_runs", "insert", { message: "connection reset" });
    await assert.rejects(
      runProvisioning(db.client, { organizationId: "org_1", trigger: "setup_fee" }, async () =>
        result("active"),
      ),
      { message: "connection reset" },
    );
  });

  test("losing the insert race reuses the winner's run", async () => {
    const db = memorySupabase({ uniques: [runsUnique] });
    // Two callers at once: both see no run, both insert; one hits the unique index.
    const [a, b] = await Promise.all([
      runProvisioning(db.client, { organizationId: "org_1", trigger: "setup_fee" }, async () =>
        result("waiting_for_agent"),
      ),
      runProvisioning(db.client, { organizationId: "org_1", trigger: "setup_fee" }, async () =>
        result("waiting_for_agent"),
      ),
    ]);
    assert.equal(a.runId, b.runId);
    assert.equal(db.tables["provisioning_runs"]!.length, 1);
  });
});
