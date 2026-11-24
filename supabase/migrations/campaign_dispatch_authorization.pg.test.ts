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
 * REAL-PostgreSQL coverage for 20261129090000_campaign_dispatch_authorization.sql:
 * every workspace starts with campaign calling off; a customer (authenticated,
 * through the RLS policies that let them create and edit their organization)
 * can never turn it on, by insert or update, while their other edits still
 * work; ClickAI (service role) can; and the rollback removes it all.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261129090000_campaign_dispatch_authorization.sql";
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const ROLLBACK = readFileSync(
  join(
    migrationsDir,
    "../../docs/production-rollback-20261129090000-campaign-dispatch-authorization.sql",
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

const OWNER = "11111111-0000-4000-8000-0000000000aa";
const ORG = "aaaaaaaa-0000-4000-8000-0000000000aa";
const setup = `
  INSERT INTO auth.users (id) VALUES ('${OWNER}') ON CONFLICT DO NOTHING;
  INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG}', 'Dispatch Auth Test', '${OWNER}') ON CONFLICT DO NOTHING;
  INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ('${ORG}', '${OWNER}', 'owner') ON CONFLICT DO NOTHING;`;
/**
 * As the workspace owner through the API role (RLS applies), in a transaction
 * that rolls back. `grant` first gives the API role a privilege it does not
 * have today (as the owner, in the same rolled-back transaction), to prove the
 * trigger on its own: a future grant must still not let customers set the flag.
 */
const asOwner = (sql: string, grant = "") =>
  execSql!(
    `BEGIN;\n${grant}\nSET LOCAL ROLE authenticated;\nSET LOCAL request.jwt.claim.sub = '${OWNER}';\n${sql}\nROLLBACK;`,
  );
const flag = () =>
  execSql!(`SELECT campaign_dispatch_enabled FROM public.organizations WHERE id = '${ORG}';`)
    .stdout;

describe("campaign calling is enabled per workspace by ClickAI only", () => {
  test("every workspace starts with campaign calling off", (t) => {
    if (!ready(t)) return;
    assert.equal(execSql!(setup).status, 0);
    assert.match(flag(), /\bf\b/);
    const def = execSql!(
      `SELECT is_nullable || ':' || column_default FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'campaign_dispatch_enabled';`,
    ).stdout;
    assert.match(def, /NO:false/);
  });

  test("the owner can still edit their workspace's profile, but cannot turn campaign calling on", (t) => {
    if (!ready(t)) return;
    const enableSql = `UPDATE public.organizations SET campaign_dispatch_enabled = true WHERE id = '${ORG}';`;
    const rename = asOwner(`UPDATE public.organizations SET name = 'Renamed' WHERE id = '${ORG}';`);
    assert.equal(rename.status, 0, rename.stderr);
    // Layer 1 (today): the API role has no UPDATE privilege on this column.
    const viaApi = asOwner(enableSql);
    assert.notEqual(viaApi.status, 0);
    assert.match(viaApi.stderr, /permission denied/);
    // Layer 2: even with the privilege granted, the trigger refuses.
    const withGrant = asOwner(
      enableSql,
      "GRANT UPDATE (campaign_dispatch_enabled) ON public.organizations TO authenticated;",
    );
    assert.notEqual(withGrant.status, 0);
    assert.match(withGrant.stderr, /enabled by ClickAI support/);
    assert.match(flag(), /\bf\b/);
  });

  test("a customer cannot create a workspace with campaign calling on", (t) => {
    if (!ready(t)) return;
    const sneaky = `INSERT INTO public.organizations (name, owner_id, campaign_dispatch_enabled) VALUES ('Sneaky', '${OWNER}', true);`;
    // Layer 1 (today): the API role cannot insert organizations at all.
    const viaApi = asOwner(sneaky);
    assert.notEqual(viaApi.status, 0);
    assert.match(viaApi.stderr, /permission denied/);
    // Layer 2: with INSERT granted, the trigger still refuses the flag but allows a plain workspace.
    const grant = "GRANT INSERT ON public.organizations TO authenticated;";
    const withGrant = asOwner(sneaky, grant);
    assert.notEqual(withGrant.status, 0);
    assert.match(withGrant.stderr, /enabled by ClickAI support/);
    const plain = asOwner(
      `INSERT INTO public.organizations (name, owner_id) VALUES ('Plain', '${OWNER}');`,
      grant,
    );
    // A plain workspace is not the trigger's business: whatever refuses it (today, the
    // existing row-level security, since customers never create workspaces directly) is not
    // the campaign-calling guard.
    assert.doesNotMatch(plain.stderr, /enabled by ClickAI support/);
  });

  test("ClickAI (service role) can turn it on and off", (t) => {
    if (!ready(t)) return;
    const on = execSql!(
      `SET ROLE service_role; UPDATE public.organizations SET campaign_dispatch_enabled = true WHERE id = '${ORG}';`,
    );
    assert.equal(on.status, 0, on.stderr);
    assert.match(flag(), /\bt\b/);
    // Once on, the owner still cannot turn it off either: ClickAI manages it.
    const off = asOwner(
      `UPDATE public.organizations SET campaign_dispatch_enabled = false WHERE id = '${ORG}';`,
    );
    assert.notEqual(off.status, 0);
    assert.equal(
      execSql!(
        `SET ROLE service_role; UPDATE public.organizations SET campaign_dispatch_enabled = false WHERE id = '${ORG}';`,
      ).status,
      0,
    );
  });
});

describe("rollback", () => {
  test("removes the trigger, function and column; re-applying restores them", (t) => {
    if (!ready(t)) return;
    assert.equal(execSql!(ROLLBACK).status, 0);
    const col = () =>
      execSql!(
        `SELECT count(*) FROM information_schema.columns WHERE table_name = 'organizations' AND column_name = 'campaign_dispatch_enabled';`,
      ).stdout;
    assert.match(col(), /\b0\b/);
    assert.match(
      execSql!(`SELECT count(*) FROM pg_proc WHERE proname = 'guard_campaign_dispatch_enabled';`)
        .stdout,
      /\b0\b/,
    );
    assert.equal(applyMigration().status, 0);
    assert.match(col(), /\b1\b/);
  });
});
