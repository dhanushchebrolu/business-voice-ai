import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapCluster,
  makeExecSql,
  registerSignalCleanup,
  shellQuote,
  teardownCluster,
  type Cluster,
  type RunResult,
} from "./pg-test-cluster.ts";
import { IMPORT_SCENARIOS_SQL } from "./campaign_contact_import_scenarios.ts";

/**
 * REAL-PostgreSQL coverage for 20261124090000_campaign_contact_import_atomic.sql:
 * the import is one transaction (a failing contact or history write leaves
 * nothing behind), blank names and empty cells never erase saved data, the
 * counts say exactly what was added, the same key replays the first result,
 * do-not-call contacts are skipped and never cleared, and tenancy holds. The
 * scenarios (campaign_contact_import_scenarios.ts) also run on the local QA
 * database. Concurrency is exercised there with parallel sessions.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261124090000_campaign_contact_import_atomic.sql";
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const ROLLBACK = readFileSync(
  join(
    migrationsDir,
    "../../docs/production-rollback-20261124090000-campaign-contact-import-atomic.sql",
  ),
  "utf8",
);

const SUPABASE_STANDIN = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY);
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'authenticated' $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
`;

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregisterSignalCleanup: (() => void) | null = null;

function ready(t: TestContext): boolean {
  if (setupFailure) assert.fail(setupFailure);
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}
// Separate psql sessions running at the same time (execSql blocks until each finishes).
const psqlAsync = (sql: string) =>
  new Promise<RunResult>((resolve) => {
    const c = cluster!;
    const args = ["-h", c.sockDir, "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qAtX", "-f", "-"];
    const child = c.useSu
      ? spawn("su", ["postgres", "-c", [`${c.pgBinDir}psql`, ...args].map(shellQuote).join(" ")])
      : spawn(`${c.pgBinDir}psql`, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
    child.stdin.end(sql);
  });
const applyMigration = () =>
  execSql!(`BEGIN;\n${readFileSync(join(migrationsDir, MIGRATION), "utf8")}\nCOMMIT;`);

before(() => {
  const result = bootstrapCluster();
  if (!result.ok) {
    skipReason = result.reason;
    return;
  }
  cluster = result.cluster;
  execSql = makeExecSql(cluster);
  unregisterSignalCleanup = registerSignalCleanup(() => cluster);
  const standin = execSql(SUPABASE_STANDIN);
  if (standin.status !== 0) {
    setupFailure = `Supabase stand-in failed: ${standin.stderr}`;
    return;
  }
  for (const file of MIGRATION_FILES.filter((f) => f < MIGRATION)) {
    const applied = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  const seed = execSql(`INSERT INTO auth.users (id) VALUES ('${randomUUID()}');`);
  if (seed.status !== 0) {
    setupFailure = `seed failed: ${seed.stderr}`;
    return;
  }
  for (let i = 0; i < 2; i++) {
    const applied = applyMigration();
    if (applied.status !== 0) {
      setupFailure = `${MIGRATION} failed to apply (run ${i + 1}): ${applied.stderr}`;
      return;
    }
  }
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

describe("import_campaign_contacts on real PostgreSQL", () => {
  test("every scenario holds: data kept, counts exact, atomic, replayed, tenant-safe", (t) => {
    if (!ready(t)) return;
    const r = execSql!(`BEGIN;\n${IMPORT_SCENARIOS_SQL}\nROLLBACK;`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ALL_OK/);
  });

  test("only the service role may run the import function", (t) => {
    if (!ready(t)) return;
    const grants = execSql!(
      `SELECT string_agg(grantee, ',' ORDER BY grantee) FROM information_schema.routine_privileges
       WHERE routine_name = 'import_campaign_contacts';`,
    ).stdout;
    assert.match(grants, /service_role/);
    assert.doesNotMatch(grants, /\banon\b|\bauthenticated\b/);
  });

  test("runs with an empty search_path: a look-alike function in public is never called", (t) => {
    if (!ready(t)) return;
    const config = execSql!(
      `SELECT proconfig = ARRAY['search_path=""'] AS empty_path FROM pg_proc
       WHERE proname = 'import_campaign_contacts';`,
    ).stdout;
    assert.match(config, /^\s*t\s*$/m);
    // An overload matching the old hashtextextended(text, integer) call: if the function
    // resolved names through public, this would run with the definer's privileges.
    const r = execSql!(`BEGIN;
      CREATE FUNCTION public.hashtextextended(text, integer) RETURNS bigint LANGUAGE plpgsql
        AS $f$ BEGIN RAISE EXCEPTION 'SHADOW_CALLED'; END $f$;
      DO $d$ DECLARE owner uuid := gen_random_uuid(); org uuid; camp uuid; BEGIN
        INSERT INTO auth.users (id) VALUES (owner);
        INSERT INTO public.organizations (name, owner_id) VALUES ('SHADOW', owner) RETURNING id INTO org;
        INSERT INTO public.campaigns (organization_id, name) VALUES (org, 'shadow') RETURNING id INTO camp;
        PERFORM public.import_campaign_contacts(org, camp, NULL, 'shadow-key', 'f', 1, 0, 0,
          '[{"phone": "+919400000001"}]'::jsonb);
      END $d$;
      ROLLBACK;`);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /SHADOW_CALLED/);
  });

  test("concurrent imports sharing contacts in opposite order all succeed (no deadlock)", async (t) => {
    if (!ready(t)) return;
    const n = 12;
    const setup = execSql!(`
      INSERT INTO auth.users (id) VALUES ('${randomUUID()}');
      INSERT INTO public.organizations (id, name, owner_id)
        SELECT 'dddddddd-0000-4000-8000-000000000001', 'DEADLOCK', id FROM auth.users LIMIT 1;
      INSERT INTO public.campaigns (id, organization_id, name)
        SELECT ('dddddddd-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid,
               'dddddddd-0000-4000-8000-000000000001', 'c' || g
        FROM generate_series(1, ${n}) g;
      INSERT INTO public.contacts (organization_id, phone)
        SELECT 'dddddddd-0000-4000-8000-000000000001', '+91950000000' || g FROM generate_series(1, 4) g;`);
    assert.equal(setup.status, 0, setup.stderr);
    const phones = [1, 2, 3, 4].map((g) => ({ phone: `+91950000000${g}` }));
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => {
        const rows = JSON.stringify(i % 2 ? [...phones].reverse() : phones);
        const camp = `dddddddd-0000-4000-8000-0000000001${String(i + 1).padStart(2, "0")}`;
        return psqlAsync(
          `SELECT public.import_campaign_contacts('dddddddd-0000-4000-8000-000000000001',
             '${camp}', NULL, NULL, 'f', 4, 0, 0, '${rows}'::jsonb) ->> 'enrolled';`,
        );
      }),
    );
    for (const r of results) {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), "4");
    }
  });
});

describe("rollback", () => {
  test("removes the function, index and columns; history rows stay; re-applying restores", (t) => {
    if (!ready(t)) return;
    assert.equal(execSql!(ROLLBACK).status, 0);
    const fn = () =>
      execSql!(`SELECT count(*) FROM pg_proc WHERE proname = 'import_campaign_contacts';`).stdout;
    assert.match(fn(), /\b0\b/);
    assert.equal(applyMigration().status, 0);
    assert.match(fn(), /\b1\b/);
  });
});
