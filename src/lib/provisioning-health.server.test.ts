import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeOverallReadiness, type ProvisioningCheck } from "./provisioning-health.server.ts";

/**
 * Regression coverage for the customer-provisioning readiness gate ("never
 * blindly set ACTIVE"). Two things are tested differently, matching this
 * codebase's established convention (see feature-gate.server.test.ts):
 *
 *   1. computeOverallReadiness is pure business logic (no DB) — tested
 *      directly and exhaustively.
 *   2. checkProvisioningReadiness itself dynamically imports supabaseAdmin
 *      (like every other admin-side function in this codebase — see
 *      sarvam-admin.functions.ts, admin-clients.functions.ts) and there is
 *      no live Supabase instance in this sandbox to execute it against, so
 *      its query shape and handoverClient's wiring are proven via source
 *      scan instead — the same approach already used for
 *      sarvam-admin.functions.test.ts / telephony-admin.functions.test.ts.
 */

function check(status: ProvisioningCheck["status"]): ProvisioningCheck {
  return { key: "k", label: "L", status, detail: "d" };
}

describe("computeOverallReadiness — precedence: any fail beats any warning beats all-pass", () => {
  test("all pass -> healthy", () => {
    assert.equal(computeOverallReadiness([check("pass"), check("pass")]), "healthy");
  });

  test("empty checks -> healthy (vacuously — no failing/warning check exists)", () => {
    assert.equal(computeOverallReadiness([]), "healthy");
  });

  test("one warning, rest pass -> warning", () => {
    assert.equal(computeOverallReadiness([check("pass"), check("warning")]), "warning");
  });

  test("one fail, rest pass -> blocked", () => {
    assert.equal(computeOverallReadiness([check("pass"), check("fail")]), "blocked");
  });

  test("a fail alongside a warning -> blocked (fail always wins)", () => {
    assert.equal(
      computeOverallReadiness([check("pass"), check("warning"), check("fail")]),
      "blocked",
    );
  });
});

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "provisioning-health.server.ts"),
  "utf8",
);

describe("checkProvisioningReadiness — structural checks (query shape / no fake success)", () => {
  test("reuses checkFeatureAccess (the canonical resolver) rather than re-querying feature_locked() itself", () => {
    assert.match(src, /checkFeatureAccess\(orgId, "phone"\)/);
    assert.match(src, /checkFeatureAccess\(orgId, "dashboard"\)/);
    assert.doesNotMatch(src, /\.rpc\(\s*["']feature_locked["']/);
  });

  test("treats suspended/cancelled/archived lifecycle as a failing lock check", () => {
    assert.match(
      src,
      /org\.lifecycle_status === "suspended" \|\|\s*\n?\s*org\.lifecycle_status === "cancelled" \|\|\s*\n?\s*org\.lifecycle_status === "archived"/,
    );
  });

  test("payment check accepts either a verified setup_paid_at OR an explicit admin override, matching handoverClient's original rule", () => {
    assert.match(src, /Boolean\(org\.setup_paid_at\) \|\| org\.payment_override === true/);
  });

  test("membership check queries organization_members with a real count, not just presence of the query itself", () => {
    assert.match(src, /\.from\("organization_members"\)/);
    assert.match(src, /count:\s*"exact",\s*head:\s*true/);
  });

  test("phone check only counts numbers with status active — not any row", () => {
    assert.match(src, /n\.status === "active"/);
  });

  test("agent check reuses the same 'active_version > 0' signal workspace.ts's agentStatusLabel already uses, not a new heuristic", () => {
    assert.match(src, /agent\.active_version && agent\.active_version > 0/);
  });

  test("Sarvam deployment gap is a warning, never a hard fail — must not block Exotel or not-yet-Sarvam-mapped customers", () => {
    const deploymentBlockIdx = src.indexOf('key: "deployment"');
    assert.ok(deploymentBlockIdx > -1);
    const block = src.slice(deploymentBlockIdx, deploymentBlockIdx + 300);
    assert.match(block, /"warning"\s*:\s*"pass"/);
    assert.doesNotMatch(block, /"fail"/);
  });

  test("an unknown org returns overall blocked with an explicit workspace-not-found check, never a silent pass", () => {
    assert.match(src, /if \(!org\)/);
    const notFoundIdx = src.indexOf("if (!org)");
    const block = src.slice(notFoundIdx, notFoundIdx + 300);
    assert.match(block, /overall:\s*"blocked"/);
    assert.match(block, /status:\s*"fail"/);
  });
});

const adminClientsSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "admin-clients.functions.ts"),
  "utf8",
);

describe("handoverClient — readiness gate is a real hard block, never bypassed", () => {
  function extractFn(name: string): string {
    const start = adminClientsSrc.indexOf(`export const ${name} = createServerFn`);
    assert.ok(start > -1, `expected to find export const ${name}`);
    const nextExportIdx = adminClientsSrc.indexOf("\nexport const ", start + 1);
    return nextExportIdx > -1
      ? adminClientsSrc.slice(start, nextExportIdx)
      : adminClientsSrc.slice(start);
  }

  test("handoverClient calls checkProvisioningReadiness and collects every failing check before deciding", () => {
    const fnSrc = extractFn("handoverClient");
    assert.match(fnSrc, /checkProvisioningReadiness\(data\.orgId\)/);
    assert.match(fnSrc, /check\.status === "fail"/);
  });

  test("the readiness check runs, and any failing reason is collected, BEFORE the lifecycle_status is ever written to 'active'", () => {
    const fnSrc = extractFn("handoverClient");
    const readinessIdx = fnSrc.indexOf("checkProvisioningReadiness(data.orgId)");
    const activeWriteIdx = fnSrc.indexOf('lifecycle_status: "active"');
    assert.ok(readinessIdx > -1 && activeWriteIdx > -1);
    assert.ok(
      readinessIdx < activeWriteIdx,
      "readiness must be evaluated before the organization is ever written to active",
    );
  });

  test("a non-empty reasons list throws and audits HANDOVER_REJECTED before any write, never silently proceeds", () => {
    const fnSrc = extractFn("handoverClient");
    const rejectIdx = fnSrc.indexOf("if (reasons.length)");
    const auditRejectIdx = fnSrc.indexOf('action: "HANDOVER_REJECTED"');
    const throwIdx = fnSrc.indexOf("throw new Error(reasons.join");
    const activeWriteIdx = fnSrc.indexOf('lifecycle_status: "active"');
    assert.ok(rejectIdx > -1 && auditRejectIdx > -1 && throwIdx > -1 && activeWriteIdx > -1);
    assert.ok(rejectIdx < auditRejectIdx && auditRejectIdx < throwIdx);
    assert.ok(throwIdx < activeWriteIdx, "the throw must precede the active write in source order");
  });

  test("getProvisioningReadiness is read-only (customers.read) and delegates to the same checkProvisioningReadiness — no parallel readiness logic", () => {
    const fnSrc = extractFn("getProvisioningReadiness");
    assert.match(
      fnSrc,
      /assertPlatformAdmin\(context\.supabase, context\.userId, "customers\.read"\)/,
    );
    assert.match(fnSrc, /return checkProvisioningReadiness\(data\.orgId\)/);
  });
});
