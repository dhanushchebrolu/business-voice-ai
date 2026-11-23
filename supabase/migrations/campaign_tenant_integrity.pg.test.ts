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
import { TENANT_SCENARIOS_SQL } from "./campaign_tenant_integrity_scenarios.ts";

/**
 * REAL-PostgreSQL coverage for 20261125090000_campaign_tenant_integrity.sql:
 * memberships and import history can only link records of one organization
 * (cross-tenant inserts and updates fail with foreign_key_violation); same-
 * organization rows, the import function and campaign deletion keep working;
 * the migration is re-runnable, keeps one key per table pair (Data API embeds),
 * and its rollback restores the original single-column keys.
 * The scenarios (campaign_tenant_integrity_scenarios.ts) also run on the
 * local QA database.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261125090000_campaign_tenant_integrity.sql";
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const ROLLBACK = readFileSync(
  join(
    migrationsDir,
    "../../docs/production-rollback-20261125090000-campaign-tenant-integrity.sql",
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

const COMPOSITE_FKS = [
  "campaign_contacts_campaign_id_fkey",
  "campaign_contacts_contact_id_fkey",
  "campaign_uploads_campaign_id_fkey",
];
// Composite (two-column) and validated: the single-column originals count as 0.
const constraintCount = () =>
  execSql!(
    `SELECT count(*) FROM pg_constraint WHERE convalidated AND array_length(conkey, 1) = 2 AND conname IN (${COMPOSITE_FKS.map((c) => `'${c}'`).join(",")});`,
  ).stdout;

describe("campaign tenant integrity on real PostgreSQL", () => {
  test("cross-organization links are refused; same-organization work, import and cascade still work", (t) => {
    if (!ready(t)) return;
    const r = execSql!(`BEGIN;\n${TENANT_SCENARIOS_SQL}\nROLLBACK;`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ALL_OK/);
  });

  test("all three composite keys exist and are validated", (t) => {
    if (!ready(t)) return;
    assert.match(constraintCount(), /\b3\b/);
  });
});

// PostgREST embeds (contacts(*), campaign_contacts(count)) need exactly one key per table pair.
const relationshipCounts = () =>
  execSql!(
    `SELECT string_agg(conrelid::regclass || '>' || confrelid::regclass || '=' || n, ',' ORDER BY conrelid::regclass::text, confrelid::regclass::text) FROM (SELECT conrelid, confrelid, count(*) n FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text IN ('campaign_contacts','campaign_uploads') AND confrelid::regclass::text IN ('campaigns','contacts') GROUP BY 1, 2) x;`,
  ).stdout;
const ONE_KEY_PER_PAIR =
  /campaign_contacts>campaigns=1,campaign_contacts>contacts=1,campaign_uploads>campaigns=1/;

describe("Data API compatibility", () => {
  test("one foreign key per table pair, so embeds stay unambiguous", (t) => {
    if (!ready(t)) return;
    assert.match(relationshipCounts(), ONE_KEY_PER_PAIR);
  });
});

describe("rollback", () => {
  test("puts back the single-column keys; re-applying restores the composite ones", (t) => {
    if (!ready(t)) return;
    assert.equal(execSql!(ROLLBACK).status, 0);
    assert.match(constraintCount(), /\b0\b/);
    assert.match(relationshipCounts(), ONE_KEY_PER_PAIR);
    assert.equal(applyMigration().status, 0);
    assert.match(constraintCount(), /\b3\b/);
  });
});
