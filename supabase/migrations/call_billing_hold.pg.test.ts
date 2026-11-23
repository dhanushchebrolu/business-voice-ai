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
 * REAL-PostgreSQL coverage for 20261128090000_call_billing_hold.sql (F3):
 * a held call is never billed (apply_call_billing refuses even when asked
 * directly), its reservation keeps counting, verify_call_duration releases it
 * once under concurrency and billing then charges once; the fenced status
 * write can set the hold; the rollback refuses while calls are held and
 * restores the earlier functions.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261128090000_call_billing_hold.sql";
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const ROLLBACK = readFileSync(
  join(migrationsDir, "../../docs/production-rollback-20261128090000-call-billing-hold.sql"),
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
const heldCall = () => {
  const id = randomUUID();
  rows(`INSERT INTO public.call_logs (id, organization_id, provider, direction, status, destination_number, started_at, billing_cap_minutes, billing_rate_per_minute)
        VALUES ('${id}', '${ORG}', 'sarvam', 'outbound', 'initiated', '+9155599${String(Math.floor(Math.random() * 90000) + 10000)}', now(), 5, 400);
        UPDATE public.call_logs SET status = 'completed', billing_hold = 'duration_unknown' WHERE id = '${id}';`);
  return id;
};
const billOnce = (id: string) =>
  `SELECT coalesce((SELECT public.apply_call_billing('${id}', t, 1200, 900, 'INR', 3, 'x') FROM (SELECT public.claim_call_finalization('${id}', 120) AS t) x WHERE t IS NOT NULL), 'no_lease');`;
const ledger = (id: string) =>
  rows(
    `SELECT count(*) || ':' || coalesce(sum(amount), 0) FROM public.wallet_transactions WHERE kind = 'call_usage' AND reference = '${id}';`,
  ).at(-1);

describe("billing hold on real PostgreSQL", () => {
  test("setup", (t) => {
    if (!ready(t)) return;
    rows(`RESET ROLE; INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG}', 'QA HOLD', (SELECT id FROM auth.users LIMIT 1));
          INSERT INTO public.wallet_transactions (organization_id, amount, kind) VALUES ('${ORG}', 100000, 'topup');`);
  });

  test("a held call is never billed, even if billing is asked for directly", (t) => {
    if (!ready(t)) return;
    const id = heldCall();
    assert.equal(
      rows(`SELECT finalization_state FROM public.call_logs WHERE id = '${id}';`).at(-1),
      "pending",
    );
    const r = execSql!(`SET ROLE service_role;\n${billOnce(id)}`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /BILLING_ON_HOLD/);
    assert.equal(ledger(id), "0:0");
  });

  test("5 concurrent verifications: one releases the hold; billing then charges once", async (t) => {
    if (!ready(t)) return;
    const id = heldCall();
    const rs = await Promise.all(
      [95, 400, 120, 61, 30].map((s) =>
        runAsync(`SELECT public.verify_call_duration('${id}', ${s});`),
      ),
    );
    const out = rs.map((r) => r.stdout.trim());
    assert.equal(out.filter((o) => o === "verified").length, 1, out.join(","));
    assert.equal(out.filter((o) => o === "not_on_hold").length, 4);
    const bills = await Promise.all(Array.from({ length: 3 }, () => runAsync(billOnce(id))));
    assert.equal(bills.filter((b) => b.stdout.trim() === "applied").length, 1);
    assert.equal(ledger(id), "1:-1200");
    assert.equal(rows(`SELECT public.verify_call_duration('${id}', 50);`).at(-1), "not_on_hold");
  });

  test("invalid verified durations are refused; non-held calls are untouched", (t) => {
    if (!ready(t)) return;
    const id = heldCall();
    for (const s of [0, -1, 86401])
      assert.match(
        execSql!(`SET ROLE service_role; SELECT public.verify_call_duration('${id}', ${s});`)
          .stderr,
        /between 1 and 86400/,
      );
    const plain = randomUUID();
    rows(
      `INSERT INTO public.call_logs (id, organization_id, provider, direction, status, started_at) VALUES ('${plain}', '${ORG}', 'sarvam', 'outbound', 'completed', now());`,
    );
    assert.equal(rows(`SELECT public.verify_call_duration('${plain}', 60);`).at(-1), "not_on_hold");
  });

  test("the fenced status write can set the hold", (t) => {
    if (!ready(t)) return;
    const id = randomUUID();
    rows(
      `INSERT INTO public.call_logs (id, organization_id, provider, direction, status, started_at) VALUES ('${id}', '${ORG}', 'sarvam', 'outbound', 'initiated', now());`,
    );
    const tok = JSON.parse(
      rows(
        `SELECT public.claim_webhook_event('sarvam', 'att_${id}', 'completed', '{}'::jsonb, 120, 10);`,
      ).at(-1)!,
    ).token;
    assert.equal(
      rows(
        `SELECT public.apply_call_event_fenced('sarvam', 'att_${id}', '${tok}', '${id}', '{"status":"completed","billing_hold":"duration_unknown"}'::jsonb);`,
      ).at(-1),
      "applied",
    );
    assert.equal(
      rows(`SELECT billing_hold FROM public.call_logs WHERE id = '${id}';`).at(-1),
      "duration_unknown",
    );
  });
});

describe("rollback", () => {
  test("refuses while calls are held; once none are, restores the earlier functions and drops the column", (t) => {
    if (!ready(t)) return;
    assert.notEqual(execSql!(ROLLBACK).status, 0, "held calls block the rollback");
    rows("UPDATE public.call_logs SET billing_hold = NULL WHERE billing_hold IS NOT NULL;");
    assert.equal(execSql!(ROLLBACK).status, 0);
    assert.equal(
      rows(
        "SELECT count(*) FROM information_schema.columns WHERE table_name = 'call_logs' AND column_name = 'billing_hold';",
      ).at(-1),
      "0",
    );
    assert.equal(
      rows("SELECT count(*) FROM pg_proc WHERE proname = 'verify_call_duration';").at(-1),
      "0",
    );
    assert.equal(
      rows(
        "SELECT prosrc LIKE '%billing_hold%' FROM pg_proc WHERE proname = 'apply_call_billing';",
      ).at(-1),
      "f",
    );
    assert.equal(applyMigration().status, 0);
  });
});
