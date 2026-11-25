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

describe("20261203090000 voice provisioning job", () => {
  test("an existing run keeps its data and gets safe defaults", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      rows(
        `SELECT status, step_states::text, max_attempts::text, coalesce(failure_code, '-'),
                coalesce(retryable::text, '-'), coalesce(next_attempt_at::text, '-')
           FROM public.provisioning_runs WHERE id = '${OLD_RUN}';`,
      ),
      ["failed|{}|5|-|-|-"],
    );
  });

  test("never two active jobs for one number, even across organizations", (t) => {
    if (!ready(t)) return;
    rows(
      `INSERT INTO public.provisioning_runs (organization_id, trigger, status, phone_number_id)
         VALUES ('${ORG_A}', 'customer_activate', 'running', '${NUMBER}');`,
    );
    fails(
      `INSERT INTO public.provisioning_runs (organization_id, trigger, status, phone_number_id)
         VALUES ('${ORG_B}', 'customer_activate', 'pending', '${NUMBER}');`,
      /idx_provisioning_runs_one_active_number/,
    );
    // Finished jobs may share the number (history).
    rows(
      `INSERT INTO public.provisioning_runs (organization_id, trigger, status, phone_number_id, finished_at)
         VALUES ('${ORG_B}', 'admin_retry', 'failed', '${NUMBER}', now());`,
    );
    rows(`DELETE FROM public.provisioning_runs WHERE status = 'running';`);
  });

  test("retry bounds are enforced", (t) => {
    if (!ready(t)) return;
    fails(
      `UPDATE public.provisioning_runs SET max_attempts = 0 WHERE id = '${OLD_RUN}';`,
      /max_attempts/,
    );
    fails(
      `UPDATE public.provisioning_runs SET max_attempts = 99 WHERE id = '${OLD_RUN}';`,
      /max_attempts/,
    );
  });

  test("the event trail is service-role only and append-only", (t) => {
    if (!ready(t)) return;
    rows(
      `INSERT INTO public.provisioning_run_events (run_id, organization_id, step, event)
         VALUES ('${OLD_RUN}', '${ORG_A}', 'validating', 'started');`,
    );
    for (const role of ["anon", "authenticated"]) {
      const r = execSql!(`SET ROLE ${role};\nSELECT count(*) FROM public.provisioning_run_events;`);
      assert.notEqual(r.status, 0, role);
      assert.match(r.stderr, /permission denied/);
    }
    // Append-only for the service role: no UPDATE or DELETE grant.
    fails(`UPDATE public.provisioning_run_events SET event = 'x';`, /permission denied/);
    fails(`DELETE FROM public.provisioning_run_events;`, /permission denied/);
  });

  test("operator bridge tokens are short-lived, hash-unique and service-role only", (t) => {
    if (!ready(t)) return;
    rows(
      `INSERT INTO public.operator_bridge_tokens (token_hash, token_prefix, created_by, expires_at)
         VALUES ('h1', 'cbr_abcd', '${OWNER}', now() + interval '8 hours');`,
    );
    fails(
      `INSERT INTO public.operator_bridge_tokens (token_hash, token_prefix, created_by, expires_at)
         VALUES ('h2', 'cbr_abcd', '${OWNER}', now() + interval '48 hours');`,
      /operator_bridge_tokens_short_lived/,
    );
    fails(
      `INSERT INTO public.operator_bridge_tokens (token_hash, token_prefix, created_by, expires_at)
         VALUES ('h1', 'cbr_abcd', '${OWNER}', now() + interval '1 hour');`,
      /operator_bridge_tokens_token_hash_key/,
    );
    rows(`UPDATE public.operator_bridge_tokens SET revoked_at = now() WHERE token_hash = 'h1';`);
    fails(`DELETE FROM public.operator_bridge_tokens;`, /permission denied/);
    for (const role of ["anon", "authenticated"]) {
      const r = execSql!(`SET ROLE ${role};
SELECT count(*) FROM public.operator_bridge_tokens;`);
      assert.notEqual(r.status, 0, role);
      assert.match(r.stderr, /permission denied/);
    }
  });

  test("the rollback refuses while events exist, then removes only what the migration added", (t) => {
    if (!ready(t)) return;
    const sql = readFileSync(ROLLBACK, "utf8");
    const refused = execSql!(`BEGIN;\n${sql}\nCOMMIT;`);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /ROLLBACK_REFUSED/);
    const done = execSql!(`BEGIN;\nSET LOCAL rollback.discard_job_data = 'yes';\n${sql}\nCOMMIT;`);
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(
      rows(
        `SELECT count(*)::text FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'provisioning_runs' AND column_name = 'step_states';`,
      ),
      ["0"],
    );
    assert.deepEqual(
      rows(`SELECT count(*)::text FROM public.provisioning_runs WHERE id = '${OLD_RUN}';`),
      ["1"],
    );
  });
});
