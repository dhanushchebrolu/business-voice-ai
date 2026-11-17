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

/**
 * REAL-PostgreSQL coverage for 20261117180000_agent_outbound_ready.sql: the
 * two outbound-ready columns are set or cleared together, existing agents are
 * untouched (NULL), the migration is re-runnable, and its rollback document
 * removes exactly what it added.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261117180000_agent_outbound_ready.sql";
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const ROLLBACK = readFileSync(
  join(migrationsDir, "../../docs/production-rollback-20261117180000-agent-outbound-ready.sql"),
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

const OWNER = randomUUID();
const ORG = randomUUID();
const AGENT = randomUUID();

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
  // Every migration up to (not including) this one, then seed an existing agent.
  for (const file of MIGRATION_FILES.filter((f) => f < MIGRATION)) {
    const applied = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  const seed = execSql(`
    INSERT INTO auth.users (id) VALUES ('${OWNER}');
    INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG}', 'Clinic', '${OWNER}');
    INSERT INTO public.businesses (id, organization_id, name) VALUES ('${ORG}', '${ORG}', 'Clinic');
    INSERT INTO public.agent_configs (id, organization_id, business_id, sarvam_app_id, sarvam_app_version)
      VALUES ('${AGENT}', '${ORG}', '${ORG}', 'App-1', 5);
  `);
  if (seed.status !== 0) {
    setupFailure = `seed failed: ${seed.stderr}`;
    return;
  }
  // Applied twice: it must be re-runnable.
  for (let i = 0; i < 2; i++) {
    const applied = execSql(
      `BEGIN;\n${readFileSync(join(migrationsDir, MIGRATION), "utf8")}\nCOMMIT;`,
    );
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

describe("agent_configs outbound-ready columns", () => {
  test("existing agents start not confirmed (both NULL)", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      rows(`SELECT coalesce(sarvam_outbound_ready_app_id, '-') || '|' || coalesce(sarvam_outbound_ready_version::text, '-')
              FROM public.agent_configs WHERE id = '${AGENT}';`),
      ["-|-"],
    );
  });

  test("app id and version are set or cleared together, never half", (t) => {
    if (!ready(t)) return;
    fails(
      `UPDATE public.agent_configs SET sarvam_outbound_ready_version = 5 WHERE id = '${AGENT}';`,
      /agent_configs_outbound_ready_complete/,
    );
    fails(
      `UPDATE public.agent_configs SET sarvam_outbound_ready_app_id = 'App-1' WHERE id = '${AGENT}';`,
      /agent_configs_outbound_ready_complete/,
    );
    fails(
      `UPDATE public.agent_configs SET sarvam_outbound_ready_app_id = ' ', sarvam_outbound_ready_version = 5 WHERE id = '${AGENT}';`,
      /agent_configs_outbound_ready_complete/,
    );
    fails(
      `UPDATE public.agent_configs SET sarvam_outbound_ready_app_id = 'App-1', sarvam_outbound_ready_version = 0 WHERE id = '${AGENT}';`,
      /agent_configs_outbound_ready_complete/,
    );
    rows(
      `UPDATE public.agent_configs SET sarvam_outbound_ready_app_id = 'App-1', sarvam_outbound_ready_version = 5 WHERE id = '${AGENT}';`,
    );
    rows(
      `UPDATE public.agent_configs SET sarvam_outbound_ready_app_id = NULL, sarvam_outbound_ready_version = NULL WHERE id = '${AGENT}';`,
    );
  });

  test("the rollback removes exactly the two columns and the check; the agent row survives", (t) => {
    if (!ready(t)) return;
    rows(
      `INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261117180000') ON CONFLICT DO NOTHING;`,
    );
    const r = execSql!(ROLLBACK);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      rows(`SELECT count(*) FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'agent_configs'
               AND column_name IN ('sarvam_outbound_ready_app_id', 'sarvam_outbound_ready_version');`),
      ["0"],
    );
    assert.deepEqual(
      rows(
        `SELECT sarvam_app_id || ' v' || sarvam_app_version FROM public.agent_configs WHERE id = '${AGENT}';`,
      ),
      ["App-1 v5"],
    );
    assert.deepEqual(
      rows(
        `SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261117180000';`,
      ),
      ["0"],
    );
  });
});
