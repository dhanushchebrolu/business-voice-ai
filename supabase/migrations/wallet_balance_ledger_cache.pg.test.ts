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
 * REAL-PostgreSQL coverage for 20261111090100_wallet_balance_ledger_cache.sql:
 * the running balance follows every ledger insert and delete, the ledger is
 * append-only, a call is debited at most once, and balance reads keep their
 * access rules.
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
    readFileSync(join(migrationsDir, "20261111090100_wallet_balance_ledger_cache.sql"), "utf8"),
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

const cached = (org: string) =>
  rows(
    `SELECT coalesce((SELECT balance FROM public.wallet_balances WHERE organization_id = '${org}')::text, 'none');`,
  )[0];
const summed = (org: string) =>
  rows(
    `SELECT coalesce(sum(amount), 0)::text FROM public.wallet_transactions WHERE organization_id = '${org}';`,
  )[0];

describe("running balance", () => {
  test("backfilled, and follows inserts from any writer", (t) => {
    if (!ready(t)) return;
    assert.equal(cached(ORG), "1000");
    rows(
      `INSERT INTO public.wallet_transactions (organization_id, amount, kind, description) VALUES ('${ORG}', 250, 'topup', 'admin');`,
    );
    assert.equal(cached(ORG), summed(ORG));
    assert.equal(cached(ORG), "1250");
  });

  test("debit_wallet_for_call charges once and reports the running balance", (t) => {
    if (!ready(t)) return;
    const call = randomUUID();
    const debit = `SELECT applied || '|' || already_applied || '|' || balance FROM public.debit_wallet_for_call('${ORG}', '${call}', 400, 'call');`;
    assert.deepEqual(asService(debit), ["true|false|850"]);
    assert.deepEqual(asService(debit), ["true|true|850"], "a retry is a no-op");
    assert.equal(cached(ORG), summed(ORG));
    assert.deepEqual(
      asService(
        `SELECT public.wallet_can_afford('${ORG}', 850) || '|' || public.wallet_can_afford('${ORG}', 851);`,
      ),
      ["true|false"],
    );
  });

  test("a second call_usage row for the same call is rejected by the database", (t) => {
    if (!ready(t)) return;
    const call = randomUUID();
    const insert = `INSERT INTO public.wallet_transactions (organization_id, amount, kind, description, reference) VALUES ('${ORG}', -1, 'call_usage', 'x', '${call}');`;
    rows(insert);
    const again = execSql!(insert);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /idx_wallet_tx_call_usage_ref/);
  });

  test("ledger rows cannot be edited; deletes keep the balance exact", (t) => {
    if (!ready(t)) return;
    const edit = execSql!(
      `UPDATE public.wallet_transactions SET amount = 999999 WHERE organization_id = '${ORG}';`,
    );
    assert.notEqual(edit.status, 0);
    assert.match(edit.stderr, /WALLET_LEDGER_IMMUTABLE/);
    rows(
      `DELETE FROM public.wallet_transactions WHERE organization_id = '${ORG}' AND kind = 'topup' AND description = 'admin';`,
    );
    assert.equal(cached(ORG), summed(ORG));
  });

  test("an empty wallet reads as zero", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      asService(
        `SELECT public.wallet_can_afford('${EMPTY_ORG}', 1) || '|' || public.wallet_can_afford('${EMPTY_ORG}', 0);`,
      ),
      ["false|true"],
    );
  });
});

describe("unchanged access rules", () => {
  test("members see their balance, non-members see none, customers cannot read the cache table", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      asUser(STRANGER, `SELECT coalesce(public.wallet_balance('${ORG}')::text, 'NULL');`),
      ["NULL"],
    );
    assert.deepEqual(asUser(OWNER, `SELECT public.wallet_balance('${ORG}')::text;`), [summed(ORG)]);
    const r = execSql!(`SET ROLE authenticated;\nSELECT * FROM public.wallet_balances;`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /permission denied/);
  });
});
