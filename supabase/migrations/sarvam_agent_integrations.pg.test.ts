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
 * REAL-PostgreSQL coverage for 20261111090300_sarvam_agent_integrations.sql:
 * credential uniqueness, one active credential per agent, the same-org
 * guard, one recorded outcome per Sarvam interaction, and no customer access.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();

const SUPABASE_STANDIN = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
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
const SMILE = randomUUID();
const ABC = randomUUID();
const SMILE_AGENT = randomUUID();
const ABC_AGENT = randomUUID();
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
    setupFailure = `Supabase auth/role stand-in failed: ${standin.stderr}`;
    return;
  }
  for (const file of [...MIGRATION_FILES, "20261111090300_sarvam_agent_integrations.sql"]) {
    // The new migration is applied twice: it must be re-runnable.
    const applied = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  const seed = execSql(`
    INSERT INTO public.organizations (id, name, owner_id) VALUES
      ('${SMILE}', 'Smile Dental', '${OWNER}'), ('${ABC}', 'ABC Dental', '${OWNER}');
    INSERT INTO public.businesses (id, organization_id, name) VALUES
      ('${SMILE}', '${SMILE}', 'Smile Dental'), ('${ABC}', '${ABC}', 'ABC Dental');
    INSERT INTO public.agent_configs (id, organization_id, business_id) VALUES
      ('${SMILE_AGENT}', '${SMILE}', '${SMILE}'), ('${ABC_AGENT}', '${ABC}', '${ABC}');
  `);
  if (seed.status !== 0) setupFailure = `seed failed: ${seed.stderr}`;
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

const integrate = (org: string, agent: string, h: string, status = "active") =>
  `INSERT INTO public.sarvam_agent_integrations (organization_id, agent_config_id, token_hash, token_prefix, status)
   VALUES ('${org}', '${agent}', '${h}', 'cai_sv_abcd', '${status}') RETURNING id;`;

describe("sarvam_agent_integrations", () => {
  let smileId = "";

  test("a credential may only point at an agent of its own organization", (t) => {
    if (!ready(t)) return;
    fails(integrate(SMILE, ABC_AGENT, hash("a")), /SARVAM_INTEGRATION_AGENT_ORG_MISMATCH/);
    smileId = rows(integrate(SMILE, SMILE_AGENT, hash("a")))[0]!;
    rows(integrate(ABC, ABC_AGENT, hash("b")));
    fails(
      `UPDATE public.sarvam_agent_integrations SET agent_config_id = '${ABC_AGENT}' WHERE id = '${smileId}';`,
      /SARVAM_INTEGRATION_AGENT_ORG_MISMATCH/,
    );
  });

  test("hashes are unique and well-formed; one active credential per agent", (t) => {
    if (!ready(t)) return;
    fails(integrate(SMILE, SMILE_AGENT, "not-a-hash", "disabled"), /check constraint/);
    fails(integrate(SMILE, SMILE_AGENT, hash("b"), "disabled"), /token_hash_key/);
    fails(integrate(SMILE, SMILE_AGENT, hash("c")), /one_active/);
    rows(integrate(SMILE, SMILE_AGENT, hash("d"), "disabled"));
    // Rotation in place keeps the row and only swaps the hash.
    rows(
      `UPDATE public.sarvam_agent_integrations SET token_hash = '${hash("e")}' WHERE id = '${smileId}';`,
    );
    assert.deepEqual(
      rows(
        `SELECT count(*) FROM public.sarvam_agent_integrations WHERE token_hash = '${hash("a")}';`,
      ),
      ["0"],
    );
  });

  test("an on-end outcome is stored once per interaction", (t) => {
    if (!ready(t)) return;
    const ev = (kind: string, interaction: string) =>
      `INSERT INTO public.sarvam_agent_events (integration_id, organization_id, kind, interaction_id, status)
       VALUES ('${smileId}', '${SMILE}', '${kind}', '${interaction}', 'ok');`;
    rows(ev("call_outcome", "i-1"));
    fails(ev("call_outcome", "i-1"), /one_outcome/);
    rows(ev("context", "i-1"));
    rows(ev("context", "i-1"));
    fails(ev("Bad Kind", "i-2"), /check constraint/);
  });

  test("customers and anonymous callers cannot read or write either table", (t) => {
    if (!ready(t)) return;
    for (const role of ["authenticated", "anon"])
      for (const sql of [
        `SELECT * FROM public.sarvam_agent_integrations;`,
        `SELECT * FROM public.sarvam_agent_events;`,
        `INSERT INTO public.sarvam_agent_events (integration_id, organization_id, kind, status) VALUES ('${smileId}', '${SMILE}', 'x_y', 'ok');`,
      ]) {
        const r = execSql!(`SET ROLE ${role};\n${sql}`);
        assert.notEqual(r.status, 0, `${role}: ${sql}`);
        assert.match(r.stderr, /permission denied/);
      }
  });
});
