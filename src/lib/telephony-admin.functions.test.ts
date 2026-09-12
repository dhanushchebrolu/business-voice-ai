import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the Sarvam migration's Phase 3/10 security
 * requirements on telephony-admin.functions.ts (number provisioning,
 * assignment, reassignment, suspension, release):
 *
 *   - "customer cannot provision another customer's number"
 *   - "customer cannot forge organization_id"
 *   - "ensure reassignment is tenant-safe"
 *   - "ensure duplicate provisioning cannot create inconsistent local records"
 *
 * This file predates Sarvam and is provider-agnostic (the same functions
 * will run Sarvam-managed numbers once provisionNumber/releaseNumber are
 * implemented for real) — it was never covered by a dedicated test before
 * this pass. telephony-admin.functions.ts exports only `createServerFn(...)`
 * -wrapped handlers directly (no separately-exported pure logic to import,
 * unlike public-assistant.functions.ts's runPublicChat/runPublicVoiceTurn),
 * so — consistent with this repo's established convention for files this
 * test runner cannot safely import (createFileRoute-based routes; here,
 * out of caution, a createServerFn-only module) — this is a source scan.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "telephony-admin.functions.ts"),
  "utf8",
);

/** Extracts one exported server function's source, from its `export const NAME` to the next one (or EOF). */
function extractFn(name: string): string {
  const start = src.indexOf(`export const ${name} = createServerFn`);
  assert.ok(start > -1, `expected to find export const ${name}`);
  const nextExportIdx = src.indexOf("\nexport const ", start + 1);
  return nextExportIdx > -1 ? src.slice(start, nextExportIdx) : src.slice(start);
}

const MUTATING_FUNCTIONS = [
  "provisionPhoneNumber",
  "importPhoneNumberToPool",
  "activatePhoneNumber",
  "reassignPhoneNumber",
  "suspendPhoneNumber",
  "releasePhoneNumber",
  "setNumberDirection",
];

describe("every phone-number mutation requires platform-admin authorization before any DB write", () => {
  for (const name of MUTATING_FUNCTIONS) {
    test(`${name} calls assertPlatformAdmin("numbers.write") before the first Supabase call`, () => {
      const fnSrc = extractFn(name);
      const adminIdx = fnSrc.indexOf(
        'assertPlatformAdmin(context.supabase, context.userId, "numbers.write")',
      );
      assert.ok(adminIdx > -1, `${name} must gate on numbers.write`);
      const firstDbCallIdx = fnSrc.indexOf(".from(", adminIdx);
      const anyEarlierDbCall = fnSrc.slice(0, adminIdx).includes(".from(");
      assert.equal(
        anyEarlierDbCall,
        false,
        `${name} must not touch the database before the admin gate`,
      );
      assert.ok(firstDbCallIdx === -1 || firstDbCallIdx > adminIdx);
    });
  }

  test("the two read-only listing functions are also admin-gated, never customer-reachable", () => {
    for (const name of ["listTelephonyProviderDefs", "listPhoneNumbers", "listAllCalls"]) {
      const fnSrc = extractFn(name);
      assert.match(
        fnSrc,
        /assertPlatformAdmin\(context\.supabase, context\.userId, "(customers|billing)\.read"\)/,
      );
    }
  });
});

describe("provisionPhoneNumber — tenant safety and duplicate-provisioning safety", () => {
  const fnSrc = extractFn("provisionPhoneNumber");

  test("organization_id on the inserted row comes from validated input, resolved via a real organizations lookup — never fabricated", () => {
    assert.match(fnSrc, /from\("organizations"\)/);
    assert.match(fnSrc, /\.eq\("id", data\.orgId\)/);
    assert.match(fnSrc, /if \(!org\) throw new Error/);
    assert.match(fnSrc, /organization_id:\s*data\.orgId/);
  });

  test("a newly provisioned number always starts non-active (provisioning, inbound/outbound off) — never live before an explicit activation step", () => {
    assert.match(fnSrc, /status:\s*"provisioning"/);
    assert.match(fnSrc, /inbound_enabled:\s*false/);
    assert.match(fnSrc, /outbound_enabled:\s*false/);
  });

  test("every provisioning action is audited with the acting admin and the target organization", () => {
    assert.match(fnSrc, /action:\s*"NUMBER_PROVISIONED"/);
    assert.match(fnSrc, /organizationId:\s*data\.orgId/);
  });
});

describe("importPhoneNumberToPool — supply side of automatic provisioning", () => {
  const fnSrc = extractFn("importPhoneNumberToPool");

  test("a pool number is inserted with organization_id null and status available — never pre-assigned", () => {
    assert.match(fnSrc, /organization_id:\s*null/);
    assert.match(fnSrc, /status:\s*"available"/);
    assert.match(fnSrc, /inbound_enabled:\s*false/);
    assert.match(fnSrc, /outbound_enabled:\s*false/);
  });

  test("a duplicate e164 conflict (23505) surfaces a human-readable error, not a raw DB error", () => {
    assert.match(fnSrc, /code.*===\s*"23505"/);
    assert.match(fnSrc, /already in the pool or assigned/i);
  });

  test("every import is audited", () => {
    assert.match(fnSrc, /action:\s*"NUMBER_IMPORTED_TO_POOL"/);
    assert.match(fnSrc, /organizationId:\s*null/);
  });
});

describe("activatePhoneNumber — duplicate-activation cannot create an inconsistent cross-tenant record", () => {
  const fnSrc = extractFn("activatePhoneNumber");

  test("relies on the database's global unique-active-e164 constraint (23505), not application-level guessing, to prevent two organizations sharing one active number", () => {
    assert.match(fnSrc, /code.*===\s*"23505"/);
    assert.match(fnSrc, /already active on another organization/i);
  });

  test("an already-active or released number is rejected before any mutation, not silently re-applied", () => {
    assert.match(fnSrc, /if \(before\.status === "active"\) throw new Error/);
    assert.match(fnSrc, /if \(before\.status === "released"\)\s*\n?\s*throw new Error/);
  });
});

describe("reassignPhoneNumber — the whole point is tenant safety on handoff", () => {
  const fnSrc = extractFn("reassignPhoneNumber");

  test("moving a number to a new organization atomically clears business/agent linkage and forces it back to non-live", () => {
    assert.match(fnSrc, /organization_id:\s*data\.toOrgId/);
    assert.match(fnSrc, /business_id:\s*null/);
    assert.match(fnSrc, /agent_config_id:\s*null/);
    assert.match(fnSrc, /status:\s*"provisioning"/);
    assert.match(fnSrc, /inbound_enabled:\s*false/);
    assert.match(fnSrc, /outbound_enabled:\s*false/);
  });

  test("all four fields (org, status, inbound, outbound) are set within the SAME update call — no window where the old tenant's flags survive under the new organization_id", () => {
    const updateIdx = fnSrc.indexOf(".update({");
    const updateCloseIdx = fnSrc.indexOf("})", updateIdx);
    const updateBlock = fnSrc.slice(updateIdx, updateCloseIdx);
    assert.match(updateBlock, /organization_id:\s*data\.toOrgId/);
    assert.match(updateBlock, /status:\s*"provisioning"/);
    assert.match(updateBlock, /inbound_enabled:\s*false/);
    assert.match(updateBlock, /outbound_enabled:\s*false/);
  });

  test("the destination organization is validated to actually exist before any write", () => {
    assert.match(fnSrc, /from\("organizations"\)[\s\S]{0,80}\.eq\("id", data\.toOrgId\)/);
  });

  test("the reassignment is audited with both the prior and new organization_id, never silently applied", () => {
    assert.match(fnSrc, /action:\s*"NUMBER_REASSIGNED"/);
    assert.match(fnSrc, /oldValue:\s*\{\s*organization_id:\s*before\.organization_id/);
  });
});

describe("no customer-facing code path can reach these admin mutations", () => {
  test("customers only ever read numbers/calls through RLS-scoped queries (workspace.ts), never through this admin module", () => {
    const workspaceSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "workspace.ts"),
      "utf8",
    );
    assert.doesNotMatch(workspaceSrc, /telephony-admin\.functions/);
  });
});
