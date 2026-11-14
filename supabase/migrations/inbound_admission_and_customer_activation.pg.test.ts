import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
const NEW = "20261114130000_inbound_admission_and_customer_activation.sql";
const ROLLBACK = join(
  migrationsDir,
  "..",
  "..",
  "docs",
  "production-rollback-20261114130000-inbound-admission.sql",
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
 * REAL-PostgreSQL coverage for 20261114130000: existing rows survive and
 * stay unverified (no backfill), a verified mapping is all-or-nothing, the
 * customer_activate trigger is accepted, the migration is re-runnable, and
 * the rollback script is guarded and restores the previous schema.
 */

const OWNER = randomUUID();
const SMILE = randomUUID();
const ABC = randomUUID();
const NUMBER = randomUUID();

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
  // Existing data from before the migration (a live number and a run).
  const seed = execSql(`
    INSERT INTO auth.users (id) VALUES ('${OWNER}');
    INSERT INTO public.organizations (id, name, owner_id) VALUES
      ('${SMILE}', 'Smile Dental', '${OWNER}'), ('${ABC}', 'ABC Dental', '${OWNER}');
    INSERT INTO public.phone_numbers (id, organization_id, e164, provider, status, provider_deployment_id, inbound_enabled)
      VALUES ('${NUMBER}', '${SMILE}', '+917900000001', 'sarvam', 'active', 'dep-smile', true);
    INSERT INTO public.provisioning_runs (organization_id, trigger) VALUES ('${SMILE}', 'setup_fee');
    INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261114130000');
  `);
  if (seed.status !== 0) {
    setupFailure = `seed failed: ${seed.stderr}`;
    return;
  }
  for (const pass of [1, 2]) {
    const applied = applyNew();
    if (applied.status !== 0) {
      setupFailure = `${NEW} failed on pass ${pass}: ${applied.stderr}`;
      return;
    }
  }
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

describe("20261114130000 inbound admission and customer activation", () => {
  test("existing rows are kept and stay unverified (no backfill)", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      rows(
        `SELECT e164, status, provider_deployment_id, inbound_enabled::text,
                coalesce(verified_deployment_id, '-'), coalesce(sarvam_number_confirmed_at::text, '-'),
                coalesce(admission_blocked_at::text, '-')
           FROM public.phone_numbers WHERE id = '${NUMBER}';`,
      ),
      ["+917900000001|active|dep-smile|true|-|-|-"],
    );
  });

  test("a verified mapping is all-or-nothing, with a positive version", (t) => {
    if (!ready(t)) return;
    fails(
      `UPDATE public.phone_numbers SET verified_deployment_id = 'dep-smile' WHERE id = '${NUMBER}';`,
      /phone_numbers_verified_mapping_complete/,
    );
    fails(
      `UPDATE public.phone_numbers SET verified_deployment_id = 'dep-smile', verified_sarvam_app_id = 'App',
         verified_sarvam_app_version = 0, deployment_verified_at = now() WHERE id = '${NUMBER}';`,
      /phone_numbers_verified_mapping_complete/,
    );
    rows(
      `UPDATE public.phone_numbers SET verified_deployment_id = 'dep-smile', verified_sarvam_app_id = 'App',
         verified_sarvam_app_version = 5, deployment_verified_at = now() WHERE id = '${NUMBER}';`,
    );
    rows(
      `UPDATE public.phone_numbers SET verified_deployment_id = NULL, verified_sarvam_app_id = NULL,
         verified_sarvam_app_version = NULL, deployment_verified_at = NULL WHERE id = '${NUMBER}';`,
    );
  });

  test("customer_activate is an allowed trigger; unknown triggers are still refused", (t) => {
    if (!ready(t)) return;
    rows(
      `INSERT INTO public.provisioning_runs (organization_id, trigger) VALUES ('${ABC}', 'customer_activate');`,
    );
    fails(
      `INSERT INTO public.provisioning_runs (organization_id, trigger, status, finished_at)
         VALUES ('${ABC}', 'bogus', 'failed', now());`,
      /provisioning_runs_trigger_check/,
    );
  });

  test("voice settings can record the Sarvam agent id they were applied to", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      rows(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'agent_voice_language_settings' AND column_name = 'applied_sarvam_app_id';`,
      ),
      ["YES"],
    );
  });

  test("rollback is blocked while customer_activate runs exist, then restores the old schema and keeps data", (t) => {
    if (!ready(t)) return;
    const script = readFileSync(ROLLBACK, "utf8");
    const blocked = execSql!(script);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /ROLLBACK_BLOCKED/);
    rows(`DELETE FROM public.provisioning_runs WHERE trigger = 'customer_activate';`);
    const ok = execSql!(script);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(
      rows(
        `SELECT count(*) FROM information_schema.columns
          WHERE table_name = 'phone_numbers'
            AND column_name IN ('verified_deployment_id', 'sarvam_number_confirmed_at', 'admission_blocked_at');`,
      ),
      ["0"],
    );
    assert.deepEqual(rows(`SELECT e164 FROM public.phone_numbers WHERE id = '${NUMBER}';`), [
      "+917900000001",
    ]);
    // The migrations table is not visible to service_role; read it as the owner.
    const history = execSql!(
      `\\pset format unaligned\n\\pset tuples_only on\nSELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261114130000';`,
    );
    assert.equal(history.status, 0, history.stderr);
    assert.match(history.stdout, /^0$/m);
    fails(
      `INSERT INTO public.provisioning_runs (organization_id, trigger) VALUES ('${ABC}', 'customer_activate');`,
      /provisioning_runs_trigger_check/,
    );
    // And the migration applies cleanly again afterwards.
    const again = applyNew();
    assert.equal(again.status, 0, again.stderr);
  });
});
