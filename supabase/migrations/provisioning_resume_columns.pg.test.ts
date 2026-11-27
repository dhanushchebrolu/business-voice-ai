import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
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
import { BUSINESS_SETUP, WAITED_ON } from "../../src/lib/provisioning-runs.server.ts";

/**
 * The provisioning sweep decides what is news from the tables in WAITED_ON and BUSINESS_SETUP.
 * Its unit tests use an in-memory database that accepts any column name, so this checks every
 * one against the real schema, read as the service role. A wrong name would stop the sweep.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
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
  for (const file of MIGRATIONS) {
    const applied = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

describe("the sweep's change detection matches the real schema", () => {
  for (const watched of [...WAITED_ON, ...BUSINESS_SETUP])
    test(`${watched.table}: ${watched.columns.join(", ")}`, (t) => {
      if (setupFailure) assert.fail(setupFailure);
      if (skipReason) return t.skip(skipReason);
      const columns = ["id", "organization_id", ...watched.columns].join(", ");
      const filter = watched.only
        ? `WHERE ${watched.only[0]} IN (${watched.only[1].map((v) => `'${v}'`).join(", ")})`
        : "";
      const result = execSql!(
        `SET ROLE service_role;\nSELECT ${columns} FROM public.${watched.table} ${filter} ORDER BY id LIMIT 1;`,
      );
      assert.equal(result.status, 0, result.stderr);
    });
});
