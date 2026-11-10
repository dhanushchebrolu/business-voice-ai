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
 * REAL-PostgreSQL coverage for 20261110100000_wallet_service_role_balance.sql:
 * wallet_can_afford and debit_wallet_for_call, called as service_role (the
 * server's role, which has no auth.uid()), must see the real ledger balance,
 * while wallet_balance keeps hiding balances from non-members.
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

const ORG = randomUUID();
const EMPTY_ORG = randomUUID();
const OWNER = randomUUID();
const STRANGER = randomUUID();

function rows(sql: string): string[] {
  const result = execSql!(`\\pset format unaligned\n\\pset tuples_only on\n${sql}`);
  if (result.status !== 0) throw new Error(`SQL failed: ${result.stderr}\n${sql}`);
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only"));
}

const asService = (sql: string) => rows(`SET ROLE service_role;\n${sql}`);
const asUser = (user: string, sql: string) =>
  rows(
    `SET ROLE authenticated;\nSELECT set_config('request.jwt.claim.sub', '${user}', false);\n${sql}`,
  ).slice(1);

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
  for (const file of MIGRATION_FILES) {
    const applied = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  const again = execSql(
    readFileSync(join(migrationsDir, "20261110100000_wallet_service_role_balance.sql"), "utf8"),
  );
  if (again.status !== 0) {
    setupFailure = `re-applying the migration failed: ${again.stderr}`;
    return;
  }
  const seed = execSql(`
    INSERT INTO public.organizations (id, name, owner_id) VALUES
      ('${ORG}', 'Wallet Org', '${OWNER}'), ('${EMPTY_ORG}', 'Empty Org', '${OWNER}');
    INSERT INTO public.organization_members (organization_id, user_id) VALUES ('${ORG}', '${OWNER}');
    INSERT INTO public.wallet_transactions (organization_id, amount, kind, description)
      VALUES ('${ORG}', 1000, 'topup', 'seed');
  `);
  if (seed.status !== 0) setupFailure = `seed failed: ${seed.stderr}`;
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

describe("service_role sees the real balance", () => {
  test("wallet_can_afford: true at or under the balance, false above it, false for an empty wallet", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      asService(`SELECT public.wallet_can_afford('${ORG}', 400);
                 SELECT public.wallet_can_afford('${ORG}', 1000);
                 SELECT public.wallet_can_afford('${ORG}', 1001);
                 SELECT public.wallet_can_afford('${EMPTY_ORG}', 1);
                 SELECT public.wallet_can_afford('${EMPTY_ORG}', 0);`),
      ["t", "t", "f", "f", "t"],
    );
  });

  test("debit_wallet_for_call reports the real balance and charges a call once", (t) => {
    if (!ready(t)) return;
    const call = randomUUID();
    const debit = `SELECT applied || '|' || already_applied || '|' || coalesce(balance::text, 'NULL')
                   FROM public.debit_wallet_for_call('${ORG}', '${call}', 400, 'call');`;
    assert.deepEqual(asService(debit), ["true|false|600"]);
    assert.deepEqual(asService(debit), ["true|true|600"], "a retry is a no-op");
    assert.deepEqual(
      rows(`SELECT count(*) FROM public.wallet_transactions WHERE reference = '${call}';`),
      ["1"],
    );
    assert.deepEqual(asService(`SELECT public.wallet_can_afford('${ORG}', 601);`), ["f"]);
  });
});

describe("unchanged access rules", () => {
  test("wallet_balance still hides balances from non-members and shows members theirs", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      asUser(STRANGER, `SELECT coalesce(public.wallet_balance('${ORG}')::text, 'NULL');`),
      ["NULL"],
    );
    const [balance] = asUser(OWNER, `SELECT public.wallet_balance('${ORG}');`);
    assert.match(balance!, /^\d+$/);
  });

  test("customers (authenticated) still cannot call the server-only wallet functions", (t) => {
    if (!ready(t)) return;
    for (const sql of [
      `SELECT public.wallet_can_afford('${ORG}', 1);`,
      `SELECT * FROM public.debit_wallet_for_call('${ORG}', '${randomUUID()}', 1, 'x');`,
    ]) {
      const r = execSql!(
        `SET ROLE authenticated;\nSELECT set_config('request.jwt.claim.sub', '${OWNER}', false);\n${sql}`,
      );
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /permission denied/);
    }
  });
});
