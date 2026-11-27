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
 * The deployment creation lock (sarvam-inbound-deployment.server.ts) is a compare-and-swap on
 * phone_numbers.updated_at. It holds only if the real schema moves updated_at on every write,
 * so a second writer holding the old value changes nothing. The unit tests' in-memory database
 * cannot show that.
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

const OWNER = randomUUID();
const ORG = randomUUID();
const NUMBER = randomUUID();

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregisterSignalCleanup: (() => void) | null = null;

function rows(sql: string): string[] {
  const r = execSql!(
    `\\pset format unaligned\n\\pset tuples_only on\nSET ROLE service_role;\n${sql}`,
  );
  if (r.status !== 0) throw new Error(`SQL failed: ${r.stderr}\n${sql}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only") && l !== "SET",
    );
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
  const steps = [
    SUPABASE_STANDIN,
    ...MIGRATIONS.map((f) => `BEGIN;\n${readFileSync(join(migrationsDir, f), "utf8")}\nCOMMIT;`),
    `INSERT INTO auth.users (id) VALUES ('${OWNER}');
     INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG}', 'A', '${OWNER}');
     INSERT INTO public.phone_numbers (id, organization_id, e164, provider, status)
       VALUES ('${NUMBER}', '${ORG}', '+917900000009', 'sarvam', 'provisioning');`,
  ];
  for (const [i, sql] of steps.entries()) {
    const applied = execSql(sql);
    if (applied.status !== 0) {
      setupFailure = `setup step ${i} failed: ${applied.stderr}`;
      return;
    }
  }
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

describe("deployment lock compare-and-swap on the real schema", () => {
  test("only the first writer holding a given updated_at wins", (t: TestContext) => {
    if (setupFailure) assert.fail(setupFailure);
    if (skipReason) return t.skip(skipReason);
    const [seen] = rows(
      `SELECT updated_at::text FROM public.phone_numbers WHERE id = '${NUMBER}';`,
    );
    const take = (token: string) =>
      rows(
        `WITH w AS (
           UPDATE public.phone_numbers
              SET metadata = jsonb_build_object('deployment_lock', jsonb_build_object('token', '${token}'))
            WHERE id = '${NUMBER}' AND updated_at = '${seen}'
           RETURNING 1)
         SELECT count(*)::text FROM w;`,
      )[0];
    assert.equal(take("first"), "1");
    assert.equal(take("second"), "0", "the row changed, so the old value no longer matches");
    assert.equal(
      rows(
        `SELECT metadata->'deployment_lock'->>'token' FROM public.phone_numbers WHERE id = '${NUMBER}';`,
      )[0],
      "first",
    );
  });
});
