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
 * REAL-PostgreSQL coverage for 20261120090000_dual_agent_provisioning.sql:
 * the outbound agent pair is complete or empty, an outbound agent can never
 * be the same or another customer's inbound agent (or the reverse), two
 * customers cannot share an outbound agent, credentials carry a role with one
 * active credential per agent and role, existing rows are untouched, the
 * migration is re-runnable and its rollback removes exactly what it added.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261120090000_dual_agent_provisioning.sql";
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const ROLLBACK = readFileSync(
  join(migrationsDir, "../../docs/production-rollback-20261120090000-dual-agent-provisioning.sql"),
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
const ORG_B = randomUUID();
const AGENT_B = randomUUID();
const CRED = randomUUID();
const hash = (c: string) => c.repeat(64);

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
    INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG_B}', 'Other', '${OWNER}');
    INSERT INTO public.businesses (id, organization_id, name) VALUES ('${ORG_B}', '${ORG_B}', 'Other');
    INSERT INTO public.agent_configs (id, organization_id, business_id, sarvam_app_id, sarvam_app_version)
      VALUES ('${AGENT_B}', '${ORG_B}', '${ORG_B}', 'App-B', 2);
    INSERT INTO public.sarvam_applications (name, employee_type, sarvam_app_id, sarvam_app_version)
      VALUES ('Shared', 'receptionist', 'Shared-1', 1);
    INSERT INTO public.sarvam_agent_integrations (id, organization_id, agent_config_id, token_hash, token_prefix)
      VALUES ('${CRED}', '${ORG}', '${AGENT}', '${hash("a")}', 'cai_sv_aaaa');
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

describe("dual-agent provisioning schema", () => {
  test("existing rows are untouched: no outbound agent, existing credential is inbound", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      rows(`SELECT coalesce(sarvam_outbound_app_id, '-') || '|' || sarvam_app_id
              FROM public.agent_configs WHERE id = '${AGENT}';`),
      ["-|App-1"],
    );
    assert.deepEqual(
      rows(`SELECT role FROM public.sarvam_agent_integrations WHERE id = '${CRED}';`),
      ["inbound"],
    );
  });

  test("the outbound agent id and version are set or cleared together, never half", (t) => {
    if (!ready(t)) return;
    const set = (v: string) => `UPDATE public.agent_configs SET ${v} WHERE id = '${AGENT}';`;
    fails(set(`sarvam_outbound_app_version = 1`), /agent_configs_outbound_agent_complete/);
    fails(set(`sarvam_outbound_app_id = 'Out-1'`), /agent_configs_outbound_agent_complete/);
    fails(
      set(`sarvam_outbound_app_id = ' ', sarvam_outbound_app_version = 1`),
      /agent_configs_outbound_agent_complete/,
    );
    fails(
      set(`sarvam_outbound_app_id = 'Out-1', sarvam_outbound_app_version = 0`),
      /agent_configs_outbound_agent_complete/,
    );
    rows(set(`sarvam_outbound_app_id = 'Out-1', sarvam_outbound_app_version = 1`));
    rows(set(`sarvam_outbound_app_id = NULL, sarvam_outbound_app_version = NULL`));
  });

  test("an outbound agent is never an inbound agent, of this or any customer", (t) => {
    if (!ready(t)) return;
    const reg = (agent: string, app: string) =>
      `UPDATE public.agent_configs SET sarvam_outbound_app_id = '${app}', sarvam_outbound_app_version = 1 WHERE id = '${agent}';`;
    fails(reg(AGENT, "App-1"), /SARVAM_OUTBOUND_AGENT_IS_INBOUND/);
    fails(reg(AGENT, "App-B"), /SARVAM_OUTBOUND_AGENT_IN_USE_AS_INBOUND/);
    fails(reg(AGENT, "Shared-1"), /SARVAM_OUTBOUND_AGENT_IN_USE_AS_INBOUND/);
    rows(reg(AGENT, "Out-A"));
    // Another customer can neither register the same outbound agent...
    fails(reg(AGENT_B, "Out-A"), /idx_agent_configs_sarvam_outbound_app_id/);
    // ...nor map it as their inbound agent.
    fails(
      `UPDATE public.agent_configs SET sarvam_app_id = 'Out-A' WHERE id = '${AGENT_B}';`,
      /SARVAM_INBOUND_AGENT_IS_AN_OUTBOUND_AGENT/,
    );
    rows(
      `UPDATE public.agent_configs SET sarvam_outbound_app_id = NULL, sarvam_outbound_app_version = NULL WHERE id = '${AGENT}';`,
    );
  });

  test("credentials: role is inbound or outbound; one active per agent and role", (t) => {
    if (!ready(t)) return;
    const insert = (id: string, c: string, role: string, status = "active") =>
      `INSERT INTO public.sarvam_agent_integrations (id, organization_id, agent_config_id, token_hash, token_prefix, role, status)
         VALUES ('${id}', '${ORG}', '${AGENT}', '${hash(c)}', 'cai_sv_${c.repeat(4)}', '${role}', '${status}');`;
    fails(insert(randomUUID(), "b", "admin"), /sarvam_agent_integrations_role_check/);
    fails(
      insert(randomUUID(), "c", "inbound"),
      /idx_sarvam_agent_integrations_one_active_per_role/,
    );
    const out = randomUUID();
    rows(insert(out, "d", "outbound"));
    fails(
      insert(randomUUID(), "e", "outbound"),
      /idx_sarvam_agent_integrations_one_active_per_role/,
    );
    rows(insert(randomUUID(), "f", "outbound", "disabled"));
    // An outbound credential stays bound to its own customer's agent.
    fails(
      `UPDATE public.sarvam_agent_integrations SET agent_config_id = '${AGENT_B}' WHERE id = '${out}';`,
      /SARVAM_INTEGRATION_AGENT_ORG_MISMATCH/,
    );
  });

  test("the rollback disables outbound credentials and removes exactly what was added", (t) => {
    if (!ready(t)) return;
    rows(
      `UPDATE public.agent_configs SET sarvam_outbound_app_id = 'Out-A', sarvam_outbound_app_version = 3 WHERE id = '${AGENT}';`,
    );
    const recorded = execSql!(
      `INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261120090000') ON CONFLICT DO NOTHING;`,
    );
    assert.equal(recorded.status, 0, recorded.stderr);
    const r = execSql!(ROLLBACK);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      rows(`SELECT count(*) FROM information_schema.columns
             WHERE table_schema = 'public'
               AND ((table_name = 'agent_configs'
                     AND column_name IN ('sarvam_outbound_app_id', 'sarvam_outbound_app_version',
                                         'sarvam_outbound_registered_at', 'sarvam_outbound_registered_by'))
                 OR (table_name = 'sarvam_agent_integrations' AND column_name = 'role'));`),
      ["0"],
    );
    assert.deepEqual(
      rows(`SELECT status || ':' || count(*) FROM public.sarvam_agent_integrations
             WHERE agent_config_id = '${AGENT}' GROUP BY status ORDER BY status;`),
      ["active:1", "disabled:2"],
    );
    assert.deepEqual(
      rows(
        `SELECT sarvam_app_id || ' v' || sarvam_app_version FROM public.agent_configs WHERE id = '${AGENT}';`,
      ),
      ["App-1 v5"],
    );
    // The original one-active-per-agent rule is back.
    fails(
      `INSERT INTO public.sarvam_agent_integrations (organization_id, agent_config_id, token_hash, token_prefix)
         VALUES ('${ORG}', '${AGENT}', '${hash("9")}', 'cai_sv_9999');`,
      /idx_sarvam_agent_integrations_one_active/,
    );
    const history = execSql!(
      `\\pset format unaligned\n\\pset tuples_only on\nSELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261120090000';`,
    );
    assert.equal(history.status, 0, history.stderr);
    assert.match(history.stdout, /^0$/m, "the history row is removed (read as the owner)");

    const reapplied = execSql!(
      `BEGIN;\n${readFileSync(join(migrationsDir, MIGRATION), "utf8")}\nCOMMIT;`,
    );
    assert.equal(reapplied.status, 0, reapplied.stderr);
    assert.deepEqual(
      rows(`SELECT role FROM public.sarvam_agent_integrations WHERE id = '${CRED}';`),
      ["inbound"],
    );
  });
});
