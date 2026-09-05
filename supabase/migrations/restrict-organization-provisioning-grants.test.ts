import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

/**
 * Static/textual guard rail for the self-provisioning fix (Section 9 of the
 * live Klyro Ai database security review): the original schema migration
 * granted `authenticated` INSERT on organizations and INSERT/UPDATE/DELETE
 * on organization_members, with RLS policies that let a signed-in user
 * create their own organization, join any organization as a member, and
 * promote/demote/remove members of an organization they already have an
 * 'owner'/'admin' role on — all directly from the browser client, bypassing
 * the admin-provisioned-only lifecycle.
 *
 * There is no live Postgres instance in this environment (no Supabase
 * project is connected here), so this cannot prove runtime RLS/grant
 * enforcement by actually attempting these operations as an authenticated
 * user. What it *can* prove, and does:
 *   1. The new migration actually contains the required REVOKEs and
 *      DROP POLICYs (so a future edit that silently removes either half of
 *      the fix fails this test).
 *   2. The two migrations this fix depends on were not edited to "solve"
 *      this a different way (this fix must be forward-only).
 *   3. No application source file performs an INSERT into organizations, or
 *      an INSERT/UPDATE/DELETE/UPSERT into organization_members, through the
 *      customer-facing `supabase` client — only through the service-role
 *      `supabaseAdmin` client, which is not subject to these grants.
 *
 * Real enforcement should still be confirmed by attempting these operations
 * as a real authenticated (non-service-role) session against the live
 * Klyro Ai database before relying on this fix in production.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(migrationsDir, "..", "..");
const srcDir = join(repoRoot, "src");

const NEW_MIGRATION = join(
  migrationsDir,
  "20260905100000_restrict_organization_provisioning_grants.sql",
);
const ORIGINAL_SCHEMA_MIGRATION = join(
  migrationsDir,
  "20260829120932_c8cdfc97-92e1-4fd0-b400-793aaddbbbc1.sql",
);
const SIGNUP_FIX_MIGRATION = join(
  migrationsDir,
  "20260902091500_signup_no_longer_auto_provisions_workspace.sql",
);

function readSql(path: string): string {
  return readFileSync(path, "utf8");
}

test("new migration revokes authenticated INSERT on organizations", () => {
  const sql = readSql(NEW_MIGRATION);
  assert.match(sql, /REVOKE\s+INSERT\s+ON\s+public\.organizations\s+FROM\s+authenticated/i);
});

test("new migration drops the 'owner creates org' self-provisioning policy", () => {
  const sql = readSql(NEW_MIGRATION);
  assert.match(sql, /DROP POLICY IF EXISTS "owner creates org" ON public\.organizations/i);
});

test("new migration revokes authenticated INSERT/UPDATE/DELETE on organization_members", () => {
  const sql = readSql(NEW_MIGRATION);
  assert.match(
    sql,
    /REVOKE\s+INSERT,\s*UPDATE,\s*DELETE\s+ON\s+public\.organization_members\s+FROM\s+authenticated/i,
  );
});

test("new migration drops the self-join and self-service member management policies", () => {
  const sql = readSql(NEW_MIGRATION);
  assert.match(sql, /DROP POLICY IF EXISTS "self join own org" ON public\.organization_members/i);
  assert.match(
    sql,
    /DROP POLICY IF EXISTS "admins manage members" ON public\.organization_members/i,
  );
  assert.match(
    sql,
    /DROP POLICY IF EXISTS "admins remove members" ON public\.organization_members/i,
  );
});

test("new migration does not touch legitimate SELECT/UPDATE access", () => {
  const sql = readSql(NEW_MIGRATION);
  assert.doesNotMatch(
    sql,
    /DROP POLICY[^\n]*"members read own orgs"/i,
    "org read access for members must remain intact",
  );
  assert.doesNotMatch(
    sql,
    /DROP POLICY[^\n]*"members read membership"/i,
    "membership read access must remain intact",
  );
  assert.doesNotMatch(
    sql,
    /DROP POLICY[^\n]*"admins update org"/i,
    "the narrow, column-restricted organizations UPDATE path must remain intact",
  );
  assert.doesNotMatch(
    sql,
    /REVOKE[^\n]*UPDATE[^\n]*public\.organizations/i,
    "organizations UPDATE grant (already column-restricted) must not be revoked here",
  );
});

test("new migration does not modify service_role access", () => {
  const sql = readSql(NEW_MIGRATION);
  assert.doesNotMatch(sql, /REVOKE[^\n]*service_role/i);
});

test("the original schema migration was not edited (fix is forward-only)", () => {
  const sql = readSql(ORIGINAL_SCHEMA_MIGRATION);
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE ON public\.organizations TO authenticated;/,
    "original organizations grant must be untouched — this fix must not edit old migrations",
  );
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.organization_members TO authenticated;/,
    "original organization_members grant must be untouched — this fix must not edit old migrations",
  );
  assert.match(sql, /CREATE POLICY "owner creates org"/);
  assert.match(sql, /CREATE POLICY "self join own org"/);
});

test("the signup fix migration was not edited (fix is forward-only)", () => {
  const sql = readSql(SIGNUP_FIX_MIGRATION);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.handle_new_user\(\)/);
  assert.doesNotMatch(
    sql,
    /INSERT INTO public\.organizations/i,
    "handle_new_user must still only insert a profile row",
  );
});

// --- application code scan -------------------------------------------------

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if ([".ts", ".tsx"].includes(extname(entry)) && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// Matches `<clientVar>.from("organizations" | 'organization_members')
// .<method>(` across the whitespace/newlines this codebase formats these
// chained calls with.
const CALL_PATTERN =
  /(\w+)\s*\.from\(\s*["'](organizations|organization_members)["']\s*\)\s*\.(insert|update|delete|upsert|select)\s*\(/g;

interface Call {
  file: string;
  client: string;
  table: string;
  method: string;
}

function scanAllCalls(): Call[] {
  const calls: Call[] = [];
  for (const file of listSourceFiles(srcDir)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(CALL_PATTERN)) {
      calls.push({ file, client: m[1], table: m[2], method: m[3] });
    }
  }
  return calls;
}

test("no source file inserts into organizations through the non-admin client", () => {
  const offenders = scanAllCalls().filter(
    (c) => c.table === "organizations" && c.method === "insert" && c.client !== "supabaseAdmin",
  );
  assert.deepEqual(
    offenders,
    [],
    `found organizations INSERT via a non-admin client: ${JSON.stringify(offenders)}`,
  );
});

test("no source file inserts/updates/deletes/upserts organization_members through the non-admin client", () => {
  const offenders = scanAllCalls().filter(
    (c) =>
      c.table === "organization_members" &&
      ["insert", "update", "delete", "upsert"].includes(c.method) &&
      c.client !== "supabaseAdmin",
  );
  assert.deepEqual(
    offenders,
    [],
    `found organization_members write via a non-admin client: ${JSON.stringify(offenders)}`,
  );
});

test("at least one legitimate admin (service-role) write path still exists for each table", () => {
  const calls = scanAllCalls();
  assert.ok(
    calls.some(
      (c) => c.table === "organizations" && c.method === "insert" && c.client === "supabaseAdmin",
    ),
    "expected createClientAccount's admin-only organizations INSERT to still be present",
  );
  assert.ok(
    calls.some(
      (c) =>
        c.table === "organization_members" && c.method === "upsert" && c.client === "supabaseAdmin",
    ),
    "expected the invitation-acceptance admin-only organization_members upsert to still be present",
  );
});

test("the scan found the expected read-only customer call sites (sanity check on the scan itself)", () => {
  const calls = scanAllCalls();
  const customerReads = calls.filter(
    (c) => c.table === "organization_members" && c.client === "supabase" && c.method === "select",
  );
  assert.ok(
    customerReads.length > 0,
    "expected to find at least one customer-facing organization_members SELECT — if this is 0, the scan pattern itself is broken, not the app",
  );
});
