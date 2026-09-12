import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Coverage for the phone number pool migration (Task #91 of the Sarvam
 * provisioning work): organization_id becomes nullable, 'available' and
 * 'reserved' are added to the status CHECK, and pool-specific uniqueness/
 * index support is added. There is no live Postgres instance in this
 * environment (see grant-org-client-id-seq-usage.test.ts's doc comment for
 * why every migration test here is a source scan, not an execution test).
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const NEW_MIGRATION = join(migrationsDir, "20260912160000_phone_number_pool.sql");
const PHASE_D_MIGRATION = join(
  migrationsDir,
  "20260904120000_phase_d_telephony_infrastructure.sql",
);

function readSql(path: string): string {
  return readFileSync(path, "utf8");
}

test("organization_id is made nullable, not dropped or renamed", () => {
  const sql = readSql(NEW_MIGRATION);
  assert.match(
    sql,
    /ALTER TABLE public\.phone_numbers\s*\n\s*ALTER COLUMN organization_id DROP NOT NULL;/,
  );
});

test("adds reserved_at, mirroring the existing purchased_at/released_at columns", () => {
  const sql = readSql(NEW_MIGRATION);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS reserved_at timestamptz;/);
});

test("widens the status CHECK to include 'available' and 'reserved' without dropping any existing allowed value", () => {
  const sql = readSql(NEW_MIGRATION);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS phone_numbers_status_check/);
  const constraintMatch = sql.match(
    /ADD CONSTRAINT phone_numbers_status_check\s*\n\s*CHECK \(status IN \(([\s\S]*?)\)\);/,
  );
  assert.ok(constraintMatch, "expected a new phone_numbers_status_check CHECK constraint");
  const allowedValues = constraintMatch![1]!;
  for (const value of [
    "available",
    "reserved",
    "pending",
    "provisioning",
    "active",
    "suspended",
    "released",
    "failed",
  ]) {
    assert.match(
      allowedValues,
      new RegExp(`'${value}'`),
      `expected '${value}' to remain/become allowed`,
    );
  }
});

test("prevents two unclaimed pool numbers from sharing the same e164", () => {
  const sql = readSql(NEW_MIGRATION);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_numbers_e164_unclaimed\s*\n\s*ON public\.phone_numbers \(e164\) WHERE organization_id IS NULL;/,
  );
});

test("adds a pool-lookup index scoped to available+unclaimed rows", () => {
  const sql = readSql(NEW_MIGRATION);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_phone_numbers_pool_available/);
  assert.match(sql, /WHERE status = 'available' AND organization_id IS NULL;/);
});

test("does not touch RLS policies — pool visibility relies on is_org_member(NULL) already being false", () => {
  const sql = readSql(NEW_MIGRATION);
  assert.doesNotMatch(sql, /CREATE POLICY|DROP POLICY|ALTER POLICY/i);
});

test("the Phase D migration (which first added the status CHECK) was not edited — this fix is additive/forward-only", () => {
  const sql = readSql(PHASE_D_MIGRATION);
  assert.match(
    sql,
    /CHECK \(status IN \('pending', 'provisioning', 'active', 'suspended', 'released', 'failed'\)\)/,
  );
});
