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
import {
  CLAIM_SCENARIOS_SQL,
  claimSql,
  COMPLETED_PATCH,
  finalizeSql,
  fixtureSql,
} from "./webhook_event_claim_lease_scenarios.ts";

/**
 * REAL-PostgreSQL coverage for 20261126090000_webhook_event_claim_lease.sql:
 * fault injection at every crash boundary (receipt, claim, before/after the
 * status write, after finalization), fencing of a stale processor (it can
 * neither write the call nor complete the event), operator decisions kept,
 * the attempt cap, legacy stuck rows, other webhook_events users untouched;
 * and genuinely concurrent psql sessions for duplicate deliveries, takeover
 * races, a takeover waiting on an in-flight fenced write, and finalization
 * racing recovery. The same SQL runs on the local QA database.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261126090000_webhook_event_claim_lease.sql";
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const ROLLBACK = readFileSync(
  join(
    migrationsDir,
    "../../docs/production-rollback-20261126090000-webhook-event-claim-lease.sql",
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fresh organization + initiated Sarvam outbound call with a known attempt id. */
function fixture() {
  const p = { org: randomUUID(), call: randomUUID(), attempt: `att_${randomUUID().slice(0, 12)}` };
  rows(fixtureSql(p));
  return p;
}
const expireClaim = (attempt: string) =>
  rows(
    `UPDATE public.webhook_events SET claimed_at = claimed_at - interval '121 seconds' WHERE provider = 'sarvam' AND event_id = '${attempt}';`,
  );
const ledger = (p: { org: string; call: string }) =>
  one(
    `SELECT count(*) || ':' || coalesce(sum(amount), 0) FROM public.wallet_transactions WHERE organization_id = '${p.org}' AND kind = 'call_usage' AND reference = '${p.call}';`,
  );

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

describe("fault injection at each boundary (one session)", () => {
  test("receipt, takeover, fencing, finalization, operator, cap, legacy rows, shared table", (t) => {
    if (!ready(t)) return;
    const r = execSql!(`BEGIN;\nSET ROLE service_role;\n${CLAIM_SCENARIOS_SQL}\nROLLBACK;`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr + r.stdout, /ALL_OK 8/);
  });
});

describe("genuinely concurrent sessions", () => {
  test("8 simultaneous deliveries of a new event: exactly one claims it", async (t) => {
    if (!ready(t)) return;
    const p = fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => runAsync(claimSql(p.attempt))),
    );
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const kinds = results.map((r) => (JSON.parse(r.stdout.trim()) as { result: string }).result);
    assert.equal(kinds.filter((k) => k === "claimed").length, 1);
    assert.equal(kinds.filter((k) => k === "in_progress").length, 7);
  });

  test("8 simultaneous recoveries of an abandoned claim: exactly one takes it over", async (t) => {
    if (!ready(t)) return;
    const p = fixture();
    rows(claimSql(p.attempt));
    expireClaim(p.attempt);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => runAsync(claimSql(p.attempt))),
    );
    const parsed = results.map((r) => JSON.parse(r.stdout.trim()) as Record<string, unknown>);
    const won = parsed.filter((x) => x["result"] === "claimed");
    assert.equal(won.length, 1);
    assert.equal(won[0]!["attempt"], 2);
    assert.equal(
      one(`SELECT attempts FROM public.webhook_events WHERE event_id = '${p.attempt}';`),
      "2",
    );
  });

  test("a takeover waits for an in-flight fenced write, then finds the call final", async (t) => {
    if (!ready(t)) return;
    const p = fixture();
    const t1 = JSON.parse(one(claimSql(p.attempt))).token as string;
    expireClaim(p.attempt);
    // The original processor is mid-write (holding the event row) when recovery arrives.
    const original = runAsync(
      `BEGIN;\nSELECT public.apply_call_event_fenced('sarvam', '${p.attempt}', '${t1}', '${p.call}', ${COMPLETED_PATCH});\nSELECT pg_sleep(1.5);\nCOMMIT;`,
    );
    await sleep(400);
    const started = Date.now();
    const recovery = await runAsync(claimSql(p.attempt));
    const waitedMs = Date.now() - started;
    const first = await original;
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^applied$/m);
    const claim = JSON.parse(recovery.stdout.trim()) as { result: string; token: string };
    assert.equal(claim.result, "claimed");
    assert.ok(waitedMs >= 700, `the takeover waited for the write (${waitedMs} ms)`);
    assert.equal(
      one(
        `SELECT public.apply_call_event_fenced('sarvam', '${p.attempt}', '${claim.token}', '${p.call}', '{"status":"failed"}'::jsonb);`,
      ),
      "already_final",
    );
    assert.equal(one(`SELECT status FROM public.call_logs WHERE id = '${p.call}';`), "completed");
  });

  test("a processor that lost its claim writes nothing, even racing the new holder", async (t) => {
    if (!ready(t)) return;
    const p = fixture();
    const t1 = JSON.parse(one(claimSql(p.attempt))).token as string;
    expireClaim(p.attempt);
    const t2 = JSON.parse(one(claimSql(p.attempt))).token as string;
    const [stale, current] = await Promise.all([
      runAsync(
        `SELECT public.apply_call_event_fenced('sarvam', '${p.attempt}', '${t1}', '${p.call}', '{"status":"failed"}'::jsonb);`,
      ),
      runAsync(
        `SELECT public.apply_call_event_fenced('sarvam', '${p.attempt}', '${t2}', '${p.call}', ${COMPLETED_PATCH});`,
      ),
    ]);
    assert.equal(stale.stdout.trim(), "claim_lost");
    assert.equal(current.stdout.trim(), "applied");
    assert.equal(one(`SELECT status FROM public.call_logs WHERE id = '${p.call}';`), "completed");
    // Nor can it complete the event.
    assert.equal(
      one(
        `WITH u AS (UPDATE public.webhook_events SET processed_at = now() WHERE event_id = '${p.attempt}' AND claim_token = '${t1}' RETURNING 1) SELECT count(*) FROM u;`,
      ),
      "0",
    );
  });

  test("finalization racing recovery and repeated recovery: one ledger row, one charge", async (t) => {
    if (!ready(t)) return;
    const p = fixture();
    const tok = JSON.parse(one(claimSql(p.attempt))).token as string;
    one(
      `SELECT public.apply_call_event_fenced('sarvam', '${p.attempt}', '${tok}', '${p.call}', ${COMPLETED_PATCH});`,
    );
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runAsync(finalizeSql(p.call))),
    );
    const outcomes = results.map((r) => r.stdout.trim());
    assert.equal(outcomes.filter((o) => o.startsWith("applied")).length, 1, outcomes.join(" | "));
    for (let i = 0; i < 3; i++) assert.equal(one(finalizeSql(p.call)), "no_lease");
    assert.equal(ledger(p), "1:-1200");
    assert.equal(
      one(`SELECT customer_charge FROM public.call_logs WHERE id = '${p.call}';`),
      "1200",
    );
  });
});

describe("rollback", () => {
  test("drops the functions and columns; re-applying restores them", (t) => {
    if (!ready(t)) return;
    assert.equal(execSql!(ROLLBACK).status, 0);
    assert.equal(
      one(
        "SELECT count(*) FROM pg_proc WHERE proname IN ('claim_webhook_event','apply_call_event_fenced');",
      ),
      "0",
    );
    assert.equal(
      one(
        "SELECT count(*) FROM information_schema.columns WHERE table_name = 'webhook_events' AND column_name IN ('claim_token','claimed_at','attempts');",
      ),
      "0",
    );
    assert.equal(applyMigration().status, 0);
    assert.equal(
      one(
        "SELECT count(*) FROM pg_proc WHERE proname IN ('claim_webhook_event','apply_call_event_fenced');",
      ),
      "2",
    );
  });
});
