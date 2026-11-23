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
 * REAL-PostgreSQL coverage for 20261123090000_campaign_creation_idempotency.sql:
 * one campaign per (organization, idempotency key); NULL keys (existing rows,
 * keyless creates) never conflict; the same key in another organization is a
 * separate campaign; existing rows are untouched; the migration is re-runnable
 * and its rollback removes exactly the index and the column.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261123090000_campaign_creation_idempotency.sql";
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const ROLLBACK = readFileSync(
  join(
    migrationsDir,
    "../../docs/production-rollback-20261123090000-campaign-creation-idempotency.sql",
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

const OWNER = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const LEGACY = randomUUID();
const INDEX = "idx_campaigns_org_idempotency_key";

function ready(t: TestContext): boolean {
  if (setupFailure) assert.fail(setupFailure);
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}

function insert(org: string, key: string | null, name = "C"): RunResult {
  return execSql!(
    `INSERT INTO public.campaigns (id, organization_id, name, idempotency_key)
     VALUES ('${randomUUID()}', '${org}', '${name}', ${key === null ? "NULL" : `'${key}'`});`,
  );
}
/** The query's single value (tuples only, unaligned: psql's default adds headers and "(1 row)"). */
const scalar = (sql: string) =>
  execSql!(`\\pset format unaligned\n\\pset tuples_only on\n${sql}`)
    .stdout.trim()
    .split("\n")
    .pop();
const count = (where: string) =>
  Number(scalar(`SELECT count(*) FROM public.campaigns WHERE ${where};`));

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
  // An existing campaign from before the migration, and two organizations.
  const seed = execSql(`INSERT INTO auth.users (id) VALUES ('${OWNER}');
    INSERT INTO public.organizations (id, name, owner_id) VALUES
      ('${ORG_A}', 'A', '${OWNER}'), ('${ORG_B}', 'B', '${OWNER}');
    INSERT INTO public.campaigns (id, organization_id, name) VALUES ('${LEGACY}', '${ORG_A}', 'Legacy');`);
  if (seed.status !== 0) {
    setupFailure = `seed failed: ${seed.stderr}`;
    return;
  }
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

describe("campaign creation idempotency index", () => {
  test("existing campaigns are untouched: their key is NULL", (t) => {
    if (!ready(t)) return;
    assert.equal(count(`id = '${LEGACY}' AND idempotency_key IS NULL AND name = 'Legacy'`), 1);
  });

  test("one campaign per organization and key; the violation names the index", (t) => {
    if (!ready(t)) return;
    const key = `cmp_${randomUUID().replace(/-/g, "")}`;
    assert.equal(insert(ORG_A, key).status, 0);
    const again = insert(ORG_A, key);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, new RegExp(INDEX));
    assert.equal(count(`organization_id = '${ORG_A}' AND idempotency_key = '${key}'`), 1);
  });

  test("the same key in another organization is a separate campaign", (t) => {
    if (!ready(t)) return;
    const key = `cmp_${randomUUID().replace(/-/g, "")}`;
    assert.equal(insert(ORG_A, key).status, 0);
    assert.equal(insert(ORG_B, key).status, 0);
  });

  test("NULL keys and repeated names never conflict", (t) => {
    if (!ready(t)) return;
    for (let i = 0; i < 3; i++) assert.equal(insert(ORG_A, null, "Same name").status, 0);
  });

  test("the index is partial and unique on (organization_id, idempotency_key)", (t) => {
    if (!ready(t)) return;
    const def = execSql!(`SELECT indexdef FROM pg_indexes WHERE indexname = '${INDEX}';`).stdout;
    assert.match(def, /UNIQUE INDEX/);
    assert.match(def, /\(organization_id, idempotency_key\)/);
    assert.match(def, /WHERE \(idempotency_key IS NOT NULL\)/);
  });
});

describe("rollback", () => {
  test("removes exactly the index and the column; re-applying restores them", (t) => {
    if (!ready(t)) return;
    assert.equal(execSql!(ROLLBACK).status, 0);
    const column = () =>
      scalar(
        `SELECT count(*) FROM information_schema.columns WHERE table_name = 'campaigns' AND column_name = 'idempotency_key';`,
      );
    assert.equal(column(), "0");
    assert.equal(count(`id = '${LEGACY}'`), 1, "no campaign is removed");
    const reapplied = execSql!(
      `BEGIN;\n${readFileSync(join(migrationsDir, MIGRATION), "utf8")}\nCOMMIT;`,
    );
    assert.equal(reapplied.status, 0, reapplied.stderr);
    assert.equal(column(), "1");
  });
});
