import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression coverage for the pre-activation feature-default leak found
 * during live Klyro Ai database verification: feature_locked() fell through
 * to the platform-wide `features.defaults` (which unlocks phone, voice,
 * chatbot, whatsapp, campaigns and appointments) for ANY organization
 * lacking an explicit lock/entitlement/override — including one that has
 * never paid (not_provisioned, setup_payment_pending, setup_paid,
 * provisioning, ready), because nothing in that fallback step checked
 * lifecycle_status.
 *
 * There is no live Postgres instance in this environment (no Supabase
 * project is connected here), so this cannot execute the real SQL function
 * and prove its return values directly. Two complementary things are done
 * instead, and both are needed — neither alone would catch every
 * regression:
 *
 *   1. `resolveFeatureLocked()` below is a line-for-line TypeScript mirror
 *      of the fixed function's precedence, used to exercise the specified
 *      12 scenarios as genuine behavioral test cases (a pure text match
 *      can't tell you the LOGIC is right, only that certain tokens are
 *      present).
 *   2. `structuralAssertions` tests tie that mirror to the actual migration
 *      SQL text — confirming the checks appear in the right order and nothing
 *      required was silently dropped — so the mirror can't silently drift
 *      from the real function and give false confidence.
 *
 * Real enforcement should still be confirmed by calling
 * `feature_locked(org_id, feature)` as a real authenticated session against
 * the live Klyro Ai database for organizations in each lifecycle state
 * before relying on this fix in production.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  migrationsDir,
  "20260907090000_enforce_lifecycle_gate_before_feature_defaults.sql",
);
const PHASE_B_PATH = join(
  migrationsDir,
  "20260902080000_phase_b_entitlements_and_payment_control.sql",
);
const RESTRICT_ORG_COLUMNS_PATH = join(
  migrationsDir,
  "20260902090000_restrict_organizations_customer_update_columns.sql",
);

function readSql(path: string): string {
  return readFileSync(path, "utf8");
}

// --- 1. Behavioral mirror of the fixed feature_locked() precedence --------

type LifecycleStatus =
  | "not_provisioned"
  | "setup_payment_pending"
  | "setup_paid"
  | "provisioning"
  | "ready"
  | "active"
  | "suspended"
  | "cancelled"
  | "archived";

interface FeatureLockedInput {
  lifecycle: LifecycleStatus;
  feature: string;
  explicitLock?: boolean; // organization_feature_locks.locked, undefined = no row
  hasEntitlement?: boolean; // active organization_entitlements row for this feature
  paymentEnforced?: boolean; // platform_settings 'billing.payment_required'.enabled, default true
  orgOverride?: boolean; // organizations.payment_override, default false
  featureDefault?: boolean; // platform_settings 'features.defaults'[feature], default true (locked)
}

/** Mirrors 20260907090000_enforce_lifecycle_gate_before_feature_defaults.sql exactly. */
function resolveFeatureLocked(input: FeatureLockedInput): boolean {
  const {
    lifecycle,
    feature,
    explicitLock,
    hasEntitlement = false,
    paymentEnforced = true,
    orgOverride = false,
    featureDefault = true,
  } = input;

  if (lifecycle === "suspended" || lifecycle === "cancelled" || lifecycle === "archived") {
    return true;
  }
  if (explicitLock === true) return true;
  if (hasEntitlement) return false;
  if (explicitLock === false) return false;
  if (paymentEnforced !== true || orgOverride === true) return false;

  // The lifecycle gate under test.
  if (feature !== "dashboard" && lifecycle !== "active") return true;

  return featureDefault;
}

// --- 2. The 12 required regression scenarios -------------------------------

test("1. setup_payment_pending + no entitlement => locked", () => {
  assert.equal(
    resolveFeatureLocked({ lifecycle: "setup_payment_pending", feature: "phone" }),
    true,
  );
});

test("2. setup_paid + no entitlement => locked", () => {
  assert.equal(resolveFeatureLocked({ lifecycle: "setup_paid", feature: "voice" }), true);
});

test("3. provisioning + no entitlement => locked", () => {
  assert.equal(resolveFeatureLocked({ lifecycle: "provisioning", feature: "chatbot" }), true);
});

test("4. ready + no entitlement => locked", () => {
  assert.equal(resolveFeatureLocked({ lifecycle: "ready", feature: "whatsapp" }), true);
});

test("5. active + no entitlement + billing enforcement => follows intended default behavior", () => {
  // features.defaults has phone/voice/chatbot/whatsapp/campaigns/appointments
  // all unlocked (featureDefault: false) and dashboard also unlocked.
  assert.equal(
    resolveFeatureLocked({
      lifecycle: "active",
      feature: "phone",
      paymentEnforced: true,
      featureDefault: false,
    }),
    false,
    "active org with no entitlement still gets the platform default, unchanged from before this fix",
  );
  // And if a future admin flips a feature's platform default to locked,
  // an active org with no entitlement/override must still respect it.
  assert.equal(
    resolveFeatureLocked({
      lifecycle: "active",
      feature: "campaigns",
      paymentEnforced: true,
      featureDefault: true,
    }),
    true,
  );
});

test("6. active entitlement => unlocked", () => {
  assert.equal(
    resolveFeatureLocked({
      lifecycle: "setup_payment_pending",
      feature: "phone",
      hasEntitlement: true,
    }),
    false,
    "an explicit, admin-only entitlement unlocks a feature even before activation",
  );
  assert.equal(
    resolveFeatureLocked({ lifecycle: "active", feature: "phone", hasEntitlement: true }),
    false,
  );
});

test("7. suspended => locked", () => {
  assert.equal(
    resolveFeatureLocked({ lifecycle: "suspended", feature: "phone", hasEntitlement: true }),
    true,
    "customer-level lock overrides even an active entitlement",
  );
});

test("8. cancelled => locked", () => {
  assert.equal(resolveFeatureLocked({ lifecycle: "cancelled", feature: "voice" }), true);
});

test("9. archived => locked", () => {
  assert.equal(resolveFeatureLocked({ lifecycle: "archived", feature: "chatbot" }), true);
});

test("10. payment_override behavior remains intentional and admin-controlled", () => {
  // payment_override is customer-unwritable (see restrict-org-columns
  // assertion below); when an admin sets it, it unlocks features even
  // pre-activation — this is the "explicit authorized payment_override"
  // exception the required lifecycle gate calls for.
  assert.equal(
    resolveFeatureLocked({
      lifecycle: "setup_payment_pending",
      feature: "phone",
      orgOverride: true,
    }),
    false,
  );
  assert.equal(
    resolveFeatureLocked({ lifecycle: "ready", feature: "voice", orgOverride: true }),
    false,
  );
  // But a suspended org is still fully locked even with an override set —
  // the customer-level lock is checked first and wins.
  assert.equal(
    resolveFeatureLocked({ lifecycle: "suspended", feature: "phone", orgOverride: true }),
    true,
  );
});

test("11. customer cannot update lifecycle_status/payment_override", () => {
  // This migration does not touch organizations' UPDATE grant at all — the
  // narrow customer-editable column list from
  // 20260902090000_restrict_organizations_customer_update_columns.sql must
  // still be exactly what's granted, and it must not include
  // lifecycle_status or payment_override (or any other admin/provisioning
  // field).
  const sql = readSql(RESTRICT_ORG_COLUMNS_PATH);
  const grantMatch = sql.match(/GRANT UPDATE\s*\(([\s\S]*?)\)\s*ON public\.organizations/);
  assert.ok(grantMatch, "expected to find the organizations UPDATE column grant");
  const columns = grantMatch![1]
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  for (const forbidden of [
    "lifecycle_status",
    "payment_override",
    "payment_override_reason",
    "payment_override_by",
    "payment_override_at",
    "client_id",
    "account_status",
    "locked_reason",
    "locked_at",
    "locked_by",
    "setup_paid_at",
    "activated_at",
    "archived_at",
    "crm_stage",
    "internal_notes",
    "assigned_admin_id",
    "owner_id",
    "created_by_admin",
    "next_billing_at",
  ]) {
    assert.ok(!columns.includes(forbidden), `${forbidden} must not be customer-updatable`);
  }

  const newMigrationSql = readSql(MIGRATION_PATH);
  assert.doesNotMatch(
    newMigrationSql,
    /GRANT\s+UPDATE\s+ON\s+public\.organizations/i,
    "this migration must not touch the organizations UPDATE grant at all",
  );
});

test("12. existing admin/service-role provisioning remains functional", () => {
  const sql = readSql(MIGRATION_PATH);
  // service_role is never subject to authenticated's REVOKE/GRANT and is
  // untouched here; confirm this migration doesn't attempt to change it,
  // and doesn't touch organization_entitlements/organization_feature_locks
  // write access (those remain service_role-only exactly as Phase B left
  // them — see the entitlement table's grants, unmodified by this file).
  assert.doesNotMatch(sql, /REVOKE[^\n]*service_role/i);
  assert.doesNotMatch(sql, /GRANT[^\n]*organization_entitlements[^\n]*(authenticated|anon)/i);
  assert.doesNotMatch(sql, /GRANT[^\n]*organization_feature_locks[^\n]*(authenticated|anon)/i);
});

// --- 3. Structural assertions tying the mirror to the real SQL ------------

test("the migration replaces feature_locked() (CREATE OR REPLACE, not a new function)", () => {
  const sql = readSql(MIGRATION_PATH);
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION public\.feature_locked\(_org uuid, _feature text\)/,
  );
});

test("the customer-level lifecycle lock (suspended/cancelled/archived) is preserved and still checked first", () => {
  const sql = readSql(MIGRATION_PATH);
  assert.match(sql, /'suspended',\s*'cancelled',\s*'archived'/);
  const lockIdx = sql.indexOf("customer_locked := org_lifecycle IN");
  const gateIdx = sql.indexOf("org_lifecycle IS DISTINCT FROM 'active'");
  assert.ok(lockIdx > -1 && gateIdx > -1 && lockIdx < gateIdx);
});

test("the entitlement check still happens before the new lifecycle gate (admin grants still unlock pre-activation)", () => {
  const sql = readSql(MIGRATION_PATH);
  const entitlementIdx = sql.indexOf("INTO has_entitlement");
  const gateIdx = sql.indexOf("org_lifecycle IS DISTINCT FROM 'active'");
  assert.ok(entitlementIdx > -1 && gateIdx > -1 && entitlementIdx < gateIdx);
});

test("the payment_override / global-enforcement check still happens before the new lifecycle gate", () => {
  const sql = readSql(MIGRATION_PATH);
  const overrideIdx = sql.indexOf("org_override IS TRUE THEN RETURN false");
  const gateIdx = sql.indexOf("org_lifecycle IS DISTINCT FROM 'active'");
  assert.ok(overrideIdx > -1 && gateIdx > -1 && overrideIdx < gateIdx);
});

test("the new lifecycle gate excludes 'dashboard' and comes right before the features.defaults lookup", () => {
  const sql = readSql(MIGRATION_PATH);
  assert.match(
    sql,
    /_feature\s*<>\s*'dashboard'\s+AND\s+org_lifecycle\s+IS\s+DISTINCT\s+FROM\s+'active'/,
  );
  const gateIdx = sql.indexOf("org_lifecycle IS DISTINCT FROM 'active'");
  const defaultsIdx = sql.indexOf("WHERE key = 'features.defaults'");
  assert.ok(gateIdx > -1 && defaultsIdx > -1 && gateIdx < defaultsIdx);
});

test("the migration does not edit the Phase B migration it fixes (forward-only)", () => {
  const sql = readSql(PHASE_B_PATH);
  // The original (pre-fix) function body must still be present, byte for
  // byte, in the Phase B migration — this fix must only add a new
  // CREATE OR REPLACE in a later migration, never rewrite history.
  assert.match(
    sql,
    /SELECT COALESCE\(\(value->_feature\)::text::boolean, true\) INTO def\s*\n\s*FROM public\.platform_settings WHERE key = 'features\.defaults';\s*\n\s*RETURN COALESCE\(def, true\);/,
  );
});

test("the migration grants EXECUTE back to authenticated (RPC callers keep working)", () => {
  const sql = readSql(MIGRATION_PATH);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION public\.feature_locked\(uuid, text\) TO authenticated;/,
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION public\.feature_locked\(uuid, text\) FROM PUBLIC, anon;/,
  );
});
