import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
 * REAL-PostgreSQL coverage for 20261127090000_wallet_ledger_integrity.sql:
 * one usage charge per call even from concurrent writers (the existing
 * unique index), a call charge must name its call, admin adjustments are
 * unique per request id under concurrency, keyless ledger writers (top-ups,
 * refunds, other adjustments) are unaffected, and the rollback works.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261127090000_wallet_ledger_integrity.sql";
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const ROLLBACK = readFileSync(
  join(migrationsDir, "../../docs/production-rollback-20261127090000-wallet-ledger-integrity.sql"),
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

/** One value per line, as service_role. */
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
const one = (sql: string) => rows(sql).at(-1) ?? "";

/** A real, independent psql process, so statements genuinely run at the same time. */
function runAsync(sql: string): Promise<RunResult> {
  return new Promise((resolve) => {
    if (!cluster) {
      resolve({ status: 1, stdout: "", stderr: "cluster not ready" });
      return;
    }
    const args = [
      "-h",
      cluster.sockDir,
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-qAtX",
      "-f",
      "-",
    ];
    const child = cluster.useSu
      ? spawn("su", ["postgres", "-c", [`${cluster.pgBinDir}psql`, ...args].join(" ")])
      : spawn(`${cluster.pgBinDir}psql`, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
    child.stdin.write(`SET ROLE service_role;\n${sql}`);
    child.stdin.end();
  });
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

const ORG = randomUUID();
const KEY = () => `req_${randomUUID().replace(/-/g, "")}`;
const adjustSql = (key: string, amount = 2500) =>
  `WITH x AS (INSERT INTO public.wallet_transactions (organization_id, amount, kind, description, idempotency_key) VALUES ('${ORG}', ${amount}, 'manual_adjustment', 'QA', '${key}') RETURNING 1) SELECT 'inserted' FROM x;`;
const results = (rs: RunResult[]) => ({
  inserted: rs.filter((r) => r.stdout.trim() === "inserted").length,
  unique: rs.filter((r) => /duplicate key value/.test(r.stderr)).length,
});

describe("wallet ledger integrity on real PostgreSQL", () => {
  test("setup", (t) => {
    if (!ready(t)) return;
    rows(
      `RESET ROLE; INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG}', 'QA LEDGER', (SELECT id FROM auth.users LIMIT 1));`,
    );
  });

  test("8 concurrent charges for one call (raw inserts and debit_wallet_for_call): one ledger row", async (t) => {
    if (!ready(t)) return;
    const call = randomUUID();
    // A raw insert holds the call's unique-index entry and then waits for the organization
    // row (foreign-key check) that debit_wallet_for_call holds while it waits for that
    // entry: PostgreSQL aborts one of them with "deadlock detected" (40P01), which leaves
    // nothing behind and is retried, as any client would. Production writes call charges
    // only through debit_wallet_for_call, so it never mixes the two paths.
    const retryDeadlock = async (sql: string): Promise<RunResult> => {
      for (let attempt = 1; ; attempt++) {
        const r = await runAsync(sql);
        if (attempt === 3 || !/deadlock detected/.test(r.stderr)) return r;
      }
    };
    const rs = await Promise.all([
      ...Array.from({ length: 4 }, () =>
        retryDeadlock(
          `INSERT INTO public.wallet_transactions (organization_id, amount, kind, description, reference) VALUES ('${ORG}', -1200, 'call_usage', 'x', '${call}');`,
        ),
      ),
      ...Array.from({ length: 4 }, () =>
        retryDeadlock(
          `SELECT already_applied FROM public.debit_wallet_for_call('${ORG}', '${call}', 1200, 'x');`,
        ),
      ),
    ]);
    assert.equal(
      rows(
        `SELECT count(*) || ':' || sum(amount) FROM public.wallet_transactions WHERE kind = 'call_usage' AND reference = '${call}';`,
      ).at(-1),
      "1:-1200",
    );
    for (const r of rs) assert.ok(r.status === 0 || /duplicate key value/.test(r.stderr), r.stderr);
  });

  test("a call charge must name its call; refunds and other kinds for that call are not blocked", (t) => {
    if (!ready(t)) return;
    const r = execSql!(
      `SET ROLE service_role; INSERT INTO public.wallet_transactions (organization_id, amount, kind) VALUES ('${ORG}', -1, 'call_usage');`,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /wallet_tx_call_usage_has_reference/);
    const call = randomUUID();
    rows(
      `INSERT INTO public.wallet_transactions (organization_id, amount, kind, reference) VALUES ('${ORG}', -1200, 'call_usage', '${call}'), ('${ORG}', 1200, 'refund', '${call}'), ('${ORG}', 600, 'manual_adjustment', '${call}');`,
    );
  });

  test("10 concurrent posts of one adjustment request: one row; keyless rows unlimited", async (t) => {
    if (!ready(t)) return;
    const key = KEY();
    const r = results(
      await Promise.all(Array.from({ length: 10 }, () => runAsync(adjustSql(key)))),
    );
    assert.deepEqual(r, { inserted: 1, unique: 9 });
    assert.equal(
      rows(`SELECT count(*) FROM public.wallet_transactions WHERE idempotency_key = '${key}';`).at(
        -1,
      ),
      "1",
    );
    rows(
      `INSERT INTO public.wallet_transactions (organization_id, amount, kind) VALUES ('${ORG}', 100, 'topup'), ('${ORG}', 100, 'topup');`,
    );
    const bad = execSql!(
      `SET ROLE service_role; INSERT INTO public.wallet_transactions (organization_id, amount, kind, idempotency_key) VALUES ('${ORG}', 1, 'manual_adjustment', 'bad key!');`,
    );
    assert.match(bad.stderr, /wallet_tx_idempotency_key_format/);
  });
});

describe("rollback", () => {
  test("drops the column, CHECKs and index; keeps the call-usage index; re-applying restores them", (t) => {
    if (!ready(t)) return;
    assert.equal(execSql!(ROLLBACK).status, 0);
    assert.equal(
      rows(
        "SELECT count(*) FROM information_schema.columns WHERE table_name = 'wallet_transactions' AND column_name = 'idempotency_key';",
      ).at(-1),
      "0",
    );
    assert.equal(
      rows("SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_wallet_tx_call_usage_ref';").at(
        -1,
      ),
      "1",
    );
    assert.equal(applyMigration().status, 0);
    assert.equal(
      rows(
        "SELECT count(*) FROM pg_constraint WHERE conname = 'wallet_tx_call_usage_has_reference' AND convalidated;",
      ).at(-1),
      "1",
    );
  });
});
