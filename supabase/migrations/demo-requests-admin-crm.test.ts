import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the demo-requests admin CRM migration
 * (20260911090000). Source-scanned — no live Postgres instance is available
 * in this environment (see restrict-organization-provisioning-grants.test.ts
 * for the same convention/rationale).
 *
 * The core invariant this protects: a public, unauthenticated "Book a demo"
 * submitter can insert name/email/phone/business_name/message ONLY — never
 * status/admin_notes/converted/organization_id, even by POSTing to
 * PostgREST directly instead of using the app's own form.
 */

const dir = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(dir, "20260911090000_demo_requests_admin_crm.sql"), "utf8");
const originalMigration = readFileSync(
  join(dir, "20260905080000_demo_requests_and_profile_preferences.sql"),
  "utf8",
);

describe("public INSERT is column-scoped to the fields the form actually collects", () => {
  test("the blanket table-level INSERT grant to anon/authenticated is revoked", () => {
    assert.match(sql, /REVOKE INSERT ON public\.demo_requests FROM anon, authenticated;/);
  });

  test("the replacement grant lists only name, email, phone, business_name, message", () => {
    const match = sql.match(
      /GRANT INSERT \(([^)]+)\) ON public\.demo_requests TO anon, authenticated;/,
    );
    assert.ok(match, "expected a column-scoped INSERT grant");
    const columns = match![1].split(",").map((c) => c.trim());
    assert.deepEqual(columns.sort(), ["business_name", "email", "message", "name", "phone"].sort());
    for (const forbidden of ["status", "admin_notes", "converted", "organization_id", "updated_at"]) {
      assert.equal(columns.includes(forbidden), false, `must not grant INSERT on ${forbidden}`);
    }
  });
});

describe("admin-only SELECT/UPDATE policies from the original migration are untouched", () => {
  test("the original migration is not edited (this fix is forward-only)", () => {
    assert.match(
      originalMigration,
      /CREATE POLICY "platform admins read demo requests" ON public\.demo_requests/,
    );
    assert.match(
      originalMigration,
      /CREATE POLICY "platform admins update demo requests" ON public\.demo_requests/,
    );
  });

  test("this migration does not DROP or replace either admin policy", () => {
    assert.doesNotMatch(sql, /DROP POLICY.*demo requests/i);
  });
});

describe("status is constrained to the canonical 5-value vocabulary", () => {
  test("a CHECK constraint enforces NEW/CONTACTED/DEMO_SCHEDULED/WON/LOST", () => {
    assert.match(
      sql,
      /CHECK \(status IN \('NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'WON', 'LOST'\)\)/,
    );
  });

  test("existing free-text status values are normalized before the constraint is added", () => {
    const constraintIdx = sql.indexOf("demo_requests_status_check");
    const normalizeIdx = sql.indexOf("UPDATE public.demo_requests SET status = 'NEW'");
    assert.ok(normalizeIdx > -1 && constraintIdx > -1);
    assert.ok(normalizeIdx < constraintIdx, "normalization must run before the CHECK is added");
  });
});

describe("conversion tracking", () => {
  test("organization_id is a nullable FK to organizations, not a required column (a request may never convert)", () => {
    assert.match(
      sql,
      /organization_id uuid REFERENCES public\.organizations\(id\) ON DELETE SET NULL/,
    );
  });

  test("converted=true always requires organization_id to be set", () => {
    assert.match(
      sql,
      /CHECK \(NOT converted OR organization_id IS NOT NULL\)/,
    );
  });
});
