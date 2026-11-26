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
 * REAL-PostgreSQL coverage for 20261204090000 (bridge tokens scoped to one customer, job and
 * role): legacy tokens are revoked, an unscoped or cross-customer token cannot exist live,
 * one live token per job and role, re-runnable, and the rollback revokes before dropping.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const NEW = "20261204090000_operator_bridge_token_scope.sql";
const ROLLBACK = join(
  migrationsDir,
  "..",
  "..",
  "docs",
  "production-rollback-20261204090000-operator-bridge-token-scope.sql",
);
const EARLIER = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f) && f < NEW)
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

const OWNER = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const RUN_A = randomUUID();
const RUN_B = randomUUID();

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregisterSignalCleanup: (() => void) | null = null;

const run = (sql: string) =>
  execSql!(`\\pset format unaligned\n\\pset tuples_only on\nSET ROLE service_role;\n${sql}`);
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
const apply = (path: string) => execSql!(`BEGIN;\n${readFileSync(path, "utf8")}\nCOMMIT;`);

/** A live token row as the application inserts it. */
const insert = (org: string | null, runId: string | null, role: string | null, hash: string) => {
  const v = (x: string | null) => (x === null ? "NULL" : `'${x}'`);
  return `INSERT INTO public.operator_bridge_tokens
      (token_hash, token_prefix, created_by, expires_at, organization_id, run_id, agent_role)
    VALUES ('${hash}', 'cbr_abcd', '${OWNER}', now() + interval '1 hour', ${v(org)}, ${v(runId)}, ${v(role)});`;
};

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
    const applied = apply(join(migrationsDir, file));
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  const seed = execSql(`
    INSERT INTO auth.users (id) VALUES ('${OWNER}');
    INSERT INTO public.organizations (id, name, owner_id) VALUES
      ('${ORG_A}', 'A Dental', '${OWNER}'), ('${ORG_B}', 'B Dental', '${OWNER}');
    INSERT INTO public.provisioning_runs (id, organization_id, trigger, status) VALUES
      ('${RUN_A}', '${ORG_A}', 'customer_activate', 'waiting'),
      ('${RUN_B}', '${ORG_B}', 'customer_activate', 'waiting');
    INSERT INTO public.operator_bridge_tokens (token_hash, token_prefix, created_by, expires_at)
      VALUES ('legacy', 'cbr_old', '${OWNER}', now() + interval '8 hours');
  `);
  if (seed.status !== 0) {
    setupFailure = `seed failed: ${seed.stderr}`;
    return;
  }
  for (const pass of [1, 2]) {
    const applied = apply(join(migrationsDir, NEW));
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

describe("20261204090000 operator bridge token scope", () => {
  test("a token issued before the migration is revoked", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      rows(
        `SELECT (revoked_at IS NOT NULL)::text FROM public.operator_bridge_tokens WHERE token_hash = 'legacy';`,
      ),
      ["true"],
    );
    // And it cannot be brought back to life without a scope.
    fails(
      `UPDATE public.operator_bridge_tokens SET revoked_at = NULL WHERE token_hash = 'legacy';`,
      /operator_bridge_tokens_scoped/,
    );
  });

  test("a live token must name customer, job and a known role", (t) => {
    if (!ready(t)) return;
    fails(insert(null, RUN_A, "inbound", "n1"), /operator_bridge_tokens_scoped/);
    fails(insert(ORG_A, null, "inbound", "n2"), /operator_bridge_tokens_scoped/);
    fails(insert(ORG_A, RUN_A, null, "n3"), /operator_bridge_tokens_scoped/);
    fails(insert(ORG_A, RUN_A, "admin", "n4"), /operator_bridge_tokens_role/);
  });

  test("the job must belong to the token's customer", (t) => {
    if (!ready(t)) return;
    fails(insert(ORG_A, RUN_B, "inbound", "x1"), /operator_bridge_tokens_run_of_customer/);
    rows(insert(ORG_B, RUN_B, "inbound", "x2"));
    fails(
      `UPDATE public.operator_bridge_tokens SET organization_id = '${ORG_A}' WHERE token_hash = 'x2';`,
      /operator_bridge_tokens_run_of_customer/,
    );
  });

  test("one live token per job and role; revoking frees the place", (t) => {
    if (!ready(t)) return;
    rows(insert(ORG_A, RUN_A, "inbound", "a1"));
    fails(insert(ORG_A, RUN_A, "inbound", "a2"), /idx_operator_bridge_tokens_one_live/);
    rows(insert(ORG_A, RUN_A, "outbound", "a3"));
    rows(`UPDATE public.operator_bridge_tokens SET revoked_at = now() WHERE token_hash = 'a1';`);
    rows(insert(ORG_A, RUN_A, "inbound", "a4"));
  });

  test("single use is decided by the row: a second consume matches nothing", (t) => {
    if (!ready(t)) return;
    const consume = `UPDATE public.operator_bridge_tokens SET revoked_at = now()
      WHERE token_hash = 'a4' AND revoked_at IS NULL RETURNING token_hash;`;
    assert.deepEqual(
      rows(consume).filter((l) => l === "a4"),
      ["a4"],
    );
    assert.deepEqual(
      rows(consume).filter((l) => l === "a4"),
      [],
    );
  });

  test("a customer's browser cannot read or write tokens", (t) => {
    if (!ready(t)) return;
    for (const role of ["anon", "authenticated"]) {
      const r = execSql!(`SET ROLE ${role};\nSELECT * FROM public.operator_bridge_tokens;`);
      assert.notEqual(r.status, 0, role);
      assert.match(r.stderr, /permission denied/);
    }
  });

  test("deleting a job removes its tokens", (t) => {
    if (!ready(t)) return;
    const gone = execSql!(`DELETE FROM public.provisioning_runs WHERE id = '${RUN_B}';`);
    assert.equal(gone.status, 0, gone.stderr);
    assert.deepEqual(
      rows(`SELECT count(*)::text FROM public.operator_bridge_tokens WHERE run_id = '${RUN_B}';`),
      ["0"],
    );
  });

  test("the rollback revokes every token before dropping the scope, and is re-runnable", (t) => {
    if (!ready(t)) return;
    rows(insert(ORG_A, RUN_A, "inbound", "live-at-rollback"));
    for (const pass of [1, 2]) {
      const r = apply(ROLLBACK);
      assert.equal(r.status, 0, `pass ${pass}: ${r.stderr}`);
    }
    assert.deepEqual(
      rows(`SELECT count(*)::text FROM public.operator_bridge_tokens WHERE revoked_at IS NULL;`),
      ["0"],
    );
    assert.deepEqual(
      rows(
        `SELECT count(*)::text FROM information_schema.columns
          WHERE table_name = 'operator_bridge_tokens' AND column_name IN ('organization_id','run_id','agent_role');`,
      ),
      ["0"],
    );
  });
});
