import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrapCluster,
  makeExecSql,
  registerSignalCleanup,
  teardownCluster,
  type Cluster,
  type RunResult,
} from "./pg-test-cluster.ts";

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const NEW = "20261203090000_voice_provisioning_job.sql";
const ROLLBACK = join(
  migrationsDir,
  "..",
  "..",
  "docs",
  "production-rollback-20261203090000-voice-provisioning-job.sql",
);
const EARLIER = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f) && f !== NEW)
  .sort();

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

/**
 * REAL-PostgreSQL coverage for 20261203090000 (automated provisioning job):
 * existing runs survive with safe defaults, never two active jobs for one
 * number, the event trail is service-role only, retry bounds are enforced,
 * the migration is re-runnable and the rollback is guarded.
 */

const OWNER = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const NUMBER = randomUUID();
const OLD_RUN = randomUUID();
const LIVE_NUMBER = randomUUID();

function run(sql: string): RunResult {
  return execSql!(`\\pset format unaligned\n\\pset tuples_only on\nSET ROLE service_role;\n${sql}`);
}
function rows(sql: string): string[] {
  const r = run(sql);
  if (r.status !== 0) throw new Error(`SQL failed: ${r.stderr}\n${sql}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only") && l !== "SET",
    );
}
const fails = (sql: string, pattern: RegExp) => {
  const r = run(sql);
  assert.notEqual(r.status, 0, sql);
  assert.match(r.stderr, pattern);
};
function ready(t: TestContext): boolean {
  if (setupFailure) assert.fail(setupFailure);
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}
const applyNew = () =>
  execSql!(`BEGIN;\n${readFileSync(join(migrationsDir, NEW), "utf8")}\nCOMMIT;`);

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
    setupFailure = `Supabase auth/role stand-in failed: ${standin.stderr}`;
    return;
  }
  for (const file of EARLIER) {
    const applied = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  const seed = execSql(`
    INSERT INTO auth.users (id) VALUES ('${OWNER}');
    INSERT INTO public.organizations (id, name, owner_id) VALUES
      ('${ORG_A}', 'A Dental', '${OWNER}'), ('${ORG_B}', 'B Dental', '${OWNER}');
    INSERT INTO public.phone_numbers (id, organization_id, e164, provider, status)
      VALUES ('${NUMBER}', '${ORG_A}', '+917900000009', 'sarvam', 'provisioning');
    INSERT INTO public.provisioning_runs (id, organization_id, trigger, status, finished_at)
      VALUES ('${OLD_RUN}', '${ORG_A}', 'setup_fee', 'failed', now());
  `);
  if (seed.status !== 0) {
    setupFailure = `seed failed: ${seed.stderr}`;
    return;
  }
  const prep = execSql(`
    INSERT INTO public.phone_numbers (id, organization_id, e164, provider, status, inbound_enabled, outbound_enabled)
      VALUES ('${LIVE_NUMBER}', '${ORG_B}', '+917900000010', 'sarvam', 'active', true, true);
    ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN name text, ADD COLUMN statements text[];
    INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261202090000', 'customer_outbound_concurrency');
    INSERT INTO public.platform_settings (key, value) VALUES
      ('outbound.calling_paused', '{"enabled": false}'::jsonb),
      ('billing.payment_required', '{"enabled": false}'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  `);
  if (prep.status !== 0) setupFailure = `gate prerequisites failed: ${prep.stderr}`;
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

/**
 * Rehearsal of the production gate scripts (docs/gate-outbound-*-20261203090000.sql,
 * built by scripts/build-gate-outbound-package.mjs) on a DISPOSABLE cluster built
 * with that cluster's own system identifier. Production is never touched.
 */
/** As the database owner (the service role cannot read supabase_migrations). */
const owner = (sql: string): string[] => {
  const r = execSql!(`\\pset format unaligned\n\\pset tuples_only on\n${sql}`);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only"));
};

describe("gate scripts for 20261203090000 (disposable cluster rehearsal)", () => {
  let dir = "";
  const script = (kind: string) =>
    readFileSync(join(dir, `gate-outbound-${kind}-20261203090000.sql`), "utf8");
  before(() => {
    if (skipReason || setupFailure) return;
    const sys = rows(`SELECT system_identifier::text FROM pg_control_system();`)[0]!;
    dir = mkdtempSync(join(tmpdir(), "gate-"));
    const b = spawnSync(
      process.execPath,
      [
        join(migrationsDir, "..", "..", "scripts", "build-gate-outbound-package.mjs"),
        "20261203090000",
        "--system-id",
        sys,
        "--database",
        rows(`SELECT current_database();`)[0]!,
        "--out",
        dir,
      ],
      { encoding: "utf8" },
    );
    if (b.status !== 0) setupFailure = `gate build failed: ${b.stderr}`;
  });

  test("a wrong database identity is refused before any change", (t) => {
    if (!ready(t)) return;
    const wrong = script("execute").replace(
      /IS DISTINCT FROM '\d+' THEN/,
      "IS DISTINCT FROM '1' THEN",
    );
    const r = execSql!(`BEGIN;\n${wrong}\nCOMMIT;`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /WRONG_DATABASE/);
    assert.deepEqual(
      rows(
        `SELECT count(*)::text FROM information_schema.tables WHERE table_name = 'provisioning_run_events';`,
      ),
      ["0"],
    );
  });

  const fingerprint = () =>
    owner(
      `SELECT md5(coalesce((SELECT string_agg(to_jsonb(n)::text, '|' ORDER BY id) FROM public.phone_numbers n), '') ||
              coalesce((SELECT string_agg(to_jsonb(s)::text, '|' ORDER BY key) FROM public.platform_settings s), ''));`,
    )[0];

  test("an unrelated outbound-enabled live number does NOT block the additive migration", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      owner(`SELECT outbound_enabled::text FROM public.phone_numbers WHERE id = '${LIVE_NUMBER}';`),
      ["true"],
    );
    const before = fingerprint();
    const r = execSql!(`BEGIN;\n${script("execute")}\nCOMMIT;`);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(script("execute"), /outbound safety state/);
    // No number and no outbound/payment setting was touched.
    assert.equal(fingerprint(), before);
    assert.deepEqual(
      owner(
        `SELECT status || ':' || outbound_enabled::text FROM public.phone_numbers WHERE id = '${LIVE_NUMBER}';`,
      ),
      ["active:true"],
    );
    // Put the database back to "before" for the remaining tests (rollback is rehearsed last).
    const back = execSql!(`BEGIN;\n${script("rollback")}\nCOMMIT;`);
    assert.equal(back.status, 0, back.stderr);
    assert.equal(fingerprint(), before);
  });

  test("conflicting objects, duplicate active jobs and a wrong history position are still refused", (t) => {
    if (!ready(t)) return;
    // An object of the migration already exists.
    owner(`ALTER TABLE public.provisioning_runs ADD COLUMN failure_code text;`);
    let r = execSql!(`BEGIN;\n${script("execute")}\nCOMMIT;`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /OBJECTS_ALREADY_EXIST/);
    owner(`ALTER TABLE public.provisioning_runs DROP COLUMN failure_code;`);
    // Two active jobs for one number (the new unique index could not be built).
    owner(
      `INSERT INTO public.provisioning_runs (organization_id, trigger, status, phone_number_id)
         VALUES ('${ORG_A}', 'customer_activate', 'waiting', '${NUMBER}'), ('${ORG_B}', 'customer_activate', 'waiting', '${NUMBER}');`,
    );
    r = execSql!(`BEGIN;\n${script("execute")}\nCOMMIT;`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /OBJECTS_ALREADY_EXIST/);
    owner(`DELETE FROM public.provisioning_runs WHERE status = 'waiting';`);
    // The history is not at the expected previous migration.
    owner(`INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('29991231000000');`);
    r = execSql!(`BEGIN;\n${script("execute")}\nCOMMIT;`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /UNEXPECTED_HISTORY/);
    owner(`DELETE FROM supabase_migrations.schema_migrations WHERE version = '29991231000000';`);
    // A tampered migration text is caught by the recorded-text check (checksum in the header is informational).
    assert.match(script("execute"), /GATE_20261203090000_CHECK: recorded migration text differs/);
    assert.match(script("execute"), /SET LOCAL lock_timeout = '5s'/);
  });

  test("execute applies the migration, records history and keeps existing data", (t) => {
    if (!ready(t)) return;
    const r = execSql!(`BEGIN;\n${script("execute")}\nCOMMIT;`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"applied" : "20261203090000"/);
    assert.match(r.stdout, /"existing_data_unchanged" : true/);
    assert.deepEqual(
      owner(
        `SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '20261203090000';`,
      ),
      ["20261203090000|voice_provisioning_job"],
    );
    assert.deepEqual(rows(`SELECT status FROM public.provisioning_runs WHERE id = '${OLD_RUN}';`), [
      "failed",
    ]);
  });

  test("execute refuses to run twice", (t) => {
    if (!ready(t)) return;
    const r = execSql!(`BEGIN;\n${script("execute")}\nCOMMIT;`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /UNEXPECTED_HISTORY/);
  });

  test("verify reports all_pass, read only", (t) => {
    if (!ready(t)) return;
    const r = execSql!(script("verify"));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"all_pass" : true/);
    assert.match(r.stdout, /"transaction_read_only" : "on"/);
  });

  test("rollback removes only the migration's objects and its history row", (t) => {
    if (!ready(t)) return;
    const r = execSql!(`BEGIN;\n${script("rollback")}\nCOMMIT;`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"objects_absent" : true/);
    assert.deepEqual(
      owner(
        `SELECT count(*)::text FROM supabase_migrations.schema_migrations WHERE version = '20261203090000';`,
      ),
      ["0"],
    );
    assert.deepEqual(rows(`SELECT status FROM public.provisioning_runs WHERE id = '${OLD_RUN}';`), [
      "failed",
    ]);
  });
});
