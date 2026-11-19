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
 * REAL-PostgreSQL coverage for 20261119090000_outbound_call_admission.sql:
 * admit_single_outbound_call enforces idempotency, ownership, the per-customer
 * limits and the wallet check atomically, including under genuinely
 * concurrent requests (independent psql processes), and the migration is
 * re-runnable with a working rollback.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261119090000_outbound_call_admission.sql";
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const ROLLBACK = readFileSync(
  join(migrationsDir, "../../docs/production-rollback-20261119090000-outbound-call-admission.sql"),
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
// The platform's outbound_minute rule seeded by 20260902060038.
const RATE = 400;

function run(sql: string): RunResult {
  return execSql!(`\\pset format unaligned\n\\pset tuples_only on\nSET ROLE service_role;\n${sql}`);
}
function rows(sql: string): string[] {
  const r = run(sql);
  if (r.status !== 0) throw new Error(`SQL failed: ${r.stderr}\n${sql}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only") && l !== "SET",
    );
}
function ready(t: TestContext): boolean {
  if (setupFailure) assert.fail(setupFailure);
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}

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

interface Limits {
  inFlight?: number;
  perHour?: number;
  perDay?: number;
  perDestination?: number;
}
const admitSql = (
  org: Org,
  destination: string,
  key: string,
  limits: Limits = {},
  numberId = org.number,
) =>
  `SELECT public.admit_single_outbound_call('${org.id}', '${numberId}', '${destination}', '+917900000001', '${key}', ${limits.inFlight ?? 3}, ${limits.perHour ?? 30}, ${limits.perDay ?? 100}, ${limits.perDestination ?? 2});`;
function admit(...args: Parameters<typeof admitSql>): Record<string, unknown> {
  return JSON.parse(rows(admitSql(...args))[0]!) as Record<string, unknown>;
}
const key = () => `k_${randomUUID().replace(/-/g, "")}`;
let destinationSeq = 0;
const destination = () => `+9198765${String(++destinationSeq).padStart(5, "0")}`;

interface Org {
  id: string;
  number: string;
}
/** A fresh customer with one active Sarvam number and `balance` paise in the wallet. */
function newOrg(balance: number): Org {
  const org = { id: randomUUID(), number: randomUUID() };
  rows(`RESET ROLE;
    INSERT INTO public.organizations (id, name, owner_id) VALUES ('${org.id}', 'Clinic', '${OWNER}');
    INSERT INTO public.phone_numbers (id, organization_id, e164, provider, status, outbound_enabled)
      VALUES ('${org.number}', '${org.id}', '+9179${String(++destinationSeq).padStart(8, "0")}', 'sarvam', 'active', true);
    ${balance > 0 ? `INSERT INTO public.wallet_transactions (organization_id, amount, kind, description) VALUES ('${org.id}', ${balance}, 'topup', 'seed');` : ""}`);
  return org;
}
function priorCall(org: Org, status: string, extra: Record<string, string> = {}) {
  const cols = {
    organization_id: `'${org.id}'`,
    provider: "'sarvam'",
    direction: "'outbound'",
    status: `'${status}'`,
    destination_number: `'${destination()}'`,
    started_at: "now() - interval '5 minutes'",
    ...extra,
  };
  rows(
    `INSERT INTO public.call_logs (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")});`,
  );
}
const callCount = (org: Org) =>
  Number(rows(`SELECT count(*) FROM public.call_logs WHERE organization_id = '${org.id}';`)[0]);

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
  const seed = execSql(`INSERT INTO auth.users (id) VALUES ('${OWNER}');`);
  if (seed.status !== 0) {
    setupFailure = `seed failed: ${seed.stderr}`;
    return;
  }
  // Applied twice: it must be re-runnable.
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

describe("admit_single_outbound_call: one request at a time", () => {
  test("admits and reserves an initiated row carrying the key", (t) => {
    if (!ready(t)) return;
    const org = newOrg(10_000);
    const k = key();
    const to = destination();
    const r = admit(org, to, k);
    assert.equal(r["result"], "admitted");
    assert.deepEqual(
      rows(
        `SELECT status || '|' || destination_number || '|' || idempotency_key || '|' || phone_number_id FROM public.call_logs WHERE id = '${r["call_id"]}';`,
      ),
      [`initiated|${to}|${k}|${org.number}`],
    );
  });

  test("the same key returns the same call and writes nothing; reused for another number it is refused", (t) => {
    if (!ready(t)) return;
    const org = newOrg(10_000);
    const k = key();
    const to = destination();
    const first = admit(org, to, k);
    const again = admit(org, to, k);
    assert.equal(again["result"], "duplicate");
    assert.equal(again["call_id"], first["call_id"]);
    assert.equal(again["status"], "initiated");
    assert.equal(admit(org, destination(), k)["reason"], "idempotency_key_reused");
    assert.equal(callCount(org), 1);
  });

  test("keys are per customer: another customer's key never matches", (t) => {
    if (!ready(t)) return;
    const a = newOrg(10_000);
    const b = newOrg(10_000);
    const k = key();
    const to = destination();
    const ra = admit(a, to, k);
    const rb = admit(b, to, k);
    assert.equal(rb["result"], "admitted");
    assert.notEqual(rb["call_id"], ra["call_id"]);
  });

  test("another customer's number, a released number and invalid input are refused, nothing written", (t) => {
    if (!ready(t)) return;
    const a = newOrg(10_000);
    const b = newOrg(10_000);
    assert.equal(admit(a, destination(), key(), {}, b.number)["reason"], "number_not_owned");
    rows(`UPDATE public.phone_numbers SET status = 'released' WHERE id = '${a.number}';`);
    assert.equal(admit(a, destination(), key())["reason"], "number_not_owned");
    rows(`UPDATE public.phone_numbers SET status = 'active' WHERE id = '${a.number}';`);
    assert.equal(admit(a, "9876543210", key())["reason"], "invalid_destination");
    assert.equal(admit(a, destination(), "short")["reason"], "invalid_idempotency_key");
    assert.equal(
      admit(a, destination(), "bad key with spaces!!")["reason"],
      "invalid_idempotency_key",
    );
    assert.equal(callCount(a), 0);
  });

  test("calls not yet final, including unconfirmed ones, count toward the in-flight limit", (t) => {
    if (!ready(t)) return;
    const org = newOrg(10_000);
    priorCall(org, "initiated");
    priorCall(org, "outcome_unknown");
    priorCall(org, "completed");
    assert.equal(admit(org, destination(), key(), { inFlight: 3 })["result"], "admitted");
    assert.equal(admit(org, destination(), key(), { inFlight: 3 })["reason"], "in_flight_limit");
  });

  test("hourly, daily and per-destination limits", (t) => {
    if (!ready(t)) return;
    const org = newOrg(100_000);
    priorCall(org, "completed");
    priorCall(org, "no_answer", { started_at: "now() - interval '3 hours'" });
    assert.equal(admit(org, destination(), key(), { perHour: 1 })["reason"], "hourly_limit");
    assert.equal(admit(org, destination(), key(), { perDay: 2 })["reason"], "daily_limit");

    const person = destination();
    priorCall(org, "completed", { destination_number: `'${person}'` });
    priorCall(org, "no_answer", { destination_number: `'${person}'` });
    assert.equal(admit(org, person, key())["reason"], "destination_daily_limit");
    // A call to them more than 24 hours ago does not count.
    const other = destination();
    priorCall(org, "completed", {
      destination_number: `'${other}'`,
      started_at: "now() - interval '25 hours'",
    });
    priorCall(org, "completed", { destination_number: `'${other}'` });
    assert.equal(admit(org, other, key())["result"], "admitted");
  });

  test("campaign calls and starts that failed before dialling never count", (t) => {
    if (!ready(t)) return;
    const org = newOrg(10_000);
    const person = destination();
    for (let i = 0; i < 3; i++) {
      priorCall(org, "completed", {
        destination_number: `'${person}'`,
        campaign_id: "NULL",
        resolution_source: "'start_failure'",
      });
    }
    // campaign_id must reference a campaign; a campaign call is modelled by its own row.
    const campaign = randomUUID();
    rows(
      `RESET ROLE; INSERT INTO public.campaigns (id, organization_id, name) VALUES ('${campaign}', '${org.id}', 'C');`,
    );
    for (let i = 0; i < 3; i++) priorCall(org, "initiated", { campaign_id: `'${campaign}'` });
    assert.equal(
      admit(org, person, key(), { inFlight: 1, perHour: 1, perDestination: 1 })["result"],
      "admitted",
    );
  });

  test("the wallet must hold a minute for this call and one per call not yet final", (t) => {
    if (!ready(t)) return;
    const org = newOrg(2 * RATE);
    priorCall(org, "initiated");
    assert.equal(admit(org, destination(), key())["result"], "admitted");
    assert.equal(admit(org, destination(), key())["reason"], "insufficient_balance");
    // A customer whose outbound price is overridden to free needs no balance.
    const free = newOrg(0);
    rows(
      `RESET ROLE; INSERT INTO public.organization_pricing_overrides (organization_id, key, customer_amount) VALUES ('${free.id}', 'outbound_minute', 0);`,
    );
    assert.equal(admit(free, destination(), key())["result"], "admitted");
    // An override raising the price is what is checked, not the platform rule.
    const pricey = newOrg(RATE);
    rows(
      `RESET ROLE; INSERT INTO public.organization_pricing_overrides (organization_id, key, customer_amount) VALUES ('${pricey.id}', 'outbound_minute', ${RATE + 1});`,
    );
    assert.equal(admit(pricey, destination(), key())["reason"], "insufficient_balance");
    const broke = newOrg(0);
    assert.equal(admit(broke, destination(), key())["reason"], "insufficient_balance");
  });

  test("an unresolved call to the same number (any source) is reported, not raised", (t) => {
    if (!ready(t)) return;
    const org = newOrg(10_000);
    const person = destination();
    priorCall(org, "outcome_unknown", {
      destination_number: `'${person}'`,
      started_at: "now() - interval '30 hours'",
    });
    assert.equal(admit(org, person, key())["reason"], "destination_busy");
    assert.equal(callCount(org), 1);
  });

  test("only the service role may call it", (t) => {
    if (!ready(t)) return;
    const org = newOrg(10_000);
    const r = execSql!(`SET ROLE authenticated;\n${admitSql(org, destination(), key())}`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /permission denied/);
  });
});

describe("admit_single_outbound_call: genuinely concurrent requests", () => {
  test("8 simultaneous calls at an in-flight limit of 3: exactly 3 admitted", async (t) => {
    if (!ready(t)) return;
    const org = newOrg(100_000);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => runAsync(admitSql(org, destination(), key()))),
    );
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const parsed = results.map((r) => JSON.parse(r.stdout.trim()) as Record<string, unknown>);
    assert.equal(parsed.filter((p) => p["result"] === "admitted").length, 3);
    assert.ok(
      parsed
        .filter((p) => p["result"] !== "admitted")
        .every((p) => p["reason"] === "in_flight_limit"),
    );
    assert.equal(callCount(org), 3);
  });

  test("6 simultaneous submissions with one key (double clicks, retries): one call, one id", async (t) => {
    if (!ready(t)) return;
    const org = newOrg(100_000);
    const k = key();
    const to = destination();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => runAsync(admitSql(org, to, k))),
    );
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const parsed = results.map((r) => JSON.parse(r.stdout.trim()) as Record<string, unknown>);
    assert.equal(parsed.filter((p) => p["result"] === "admitted").length, 1);
    assert.equal(parsed.filter((p) => p["result"] === "duplicate").length, 5);
    assert.equal(new Set(parsed.map((p) => p["call_id"])).size, 1);
    assert.equal(callCount(org), 1);
  });

  test("simultaneous calls cannot overspend: a wallet for 2 minutes admits exactly 2", async (t) => {
    if (!ready(t)) return;
    const org = newOrg(2 * RATE);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        runAsync(admitSql(org, destination(), key(), { inFlight: 10 })),
      ),
    );
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const parsed = results.map((r) => JSON.parse(r.stdout.trim()) as Record<string, unknown>);
    assert.equal(parsed.filter((p) => p["result"] === "admitted").length, 2);
    assert.ok(
      parsed
        .filter((p) => p["result"] !== "admitted")
        .every((p) => p["reason"] === "insufficient_balance"),
    );
  });

  test("simultaneous calls to one person: one admitted, the rest refused cleanly", async (t) => {
    if (!ready(t)) return;
    const org = newOrg(100_000);
    const to = destination();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => runAsync(admitSql(org, to, key(), { inFlight: 10 }))),
    );
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const parsed = results.map((r) => JSON.parse(r.stdout.trim()) as Record<string, unknown>);
    assert.equal(parsed.filter((p) => p["result"] === "admitted").length, 1);
    assert.ok(
      parsed
        .filter((p) => p["result"] !== "admitted")
        .every((p) => p["reason"] === "destination_busy"),
    );
  });
});

describe("rollback", () => {
  test("removes exactly what the migration added; calls survive; re-applying restores it", (t) => {
    if (!ready(t)) return;
    const org = newOrg(10_000);
    const r1 = admit(org, destination(), key());
    const recorded = execSql!(
      `INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261119090000') ON CONFLICT DO NOTHING;`,
    );
    assert.equal(recorded.status, 0, recorded.stderr);
    const r = execSql!(ROLLBACK);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      rows(`SELECT count(*) FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'call_logs' AND column_name = 'idempotency_key';`),
      ["0"],
    );
    assert.deepEqual(
      rows(`SELECT count(*) FROM pg_proc WHERE proname = 'admit_single_outbound_call';`),
      ["0"],
    );
    assert.deepEqual(rows(`SELECT status FROM public.call_logs WHERE id = '${r1["call_id"]}';`), [
      "initiated",
    ]);
    const reapplied = execSql!(
      `BEGIN;\n${readFileSync(join(migrationsDir, MIGRATION), "utf8")}\nCOMMIT;`,
    );
    assert.equal(reapplied.status, 0, reapplied.stderr);
    assert.equal(admit(org, destination(), key())["result"], "admitted");
  });
});

describe("tenant isolation under row-level security", () => {
  test("a member of customer A sees only A's calls and cannot write, settle or read B's money", (t) => {
    if (!ready(t)) return;
    const a = newOrg(10_000);
    const b = newOrg(10_000);
    const userA = randomUUID();
    rows(`RESET ROLE;
      INSERT INTO auth.users (id) VALUES ('${userA}');
      INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ('${a.id}', '${userA}', 'owner');`);
    const callA = admit(a, destination(), key())["call_id"] as string;
    const callB = admit(b, destination(), key())["call_id"] as string;
    const asA = (sql: string) =>
      execSql!(
        `\\pset format unaligned\n\\pset tuples_only on\nSET ROLE authenticated;\nSET request.jwt.claim.sub = '${userA}';\n${sql}`,
      );
    const visible = asA(`SELECT id FROM public.call_logs WHERE id IN ('${callA}', '${callB}');`);
    assert.equal(visible.status, 0, visible.stderr);
    assert.match(visible.stdout, new RegExp(callA));
    assert.doesNotMatch(visible.stdout, new RegExp(callB), "B's call is invisible to A");

    // Customers never read the request id, write a call, admit or settle one.
    assert.notEqual(
      asA(`SELECT idempotency_key FROM public.call_logs WHERE id = '${callA}';`).status,
      0,
    );
    asA(`UPDATE public.call_logs SET status = 'completed' WHERE id IN ('${callA}', '${callB}');`);
    assert.deepEqual(
      rows(
        `SELECT status FROM public.call_logs WHERE id IN ('${callA}', '${callB}') ORDER BY status;`,
      ),
      ["initiated", "initiated"],
      "no customer write reaches either call",
    );
    for (const sql of [
      admitSql(b, destination(), key()),
      `SELECT * FROM public.debit_wallet_for_call('${b.id}', '${callB}', 100, 'x');`,
      `SELECT balance FROM public.wallet_balances WHERE organization_id = '${b.id}';`,
    ]) {
      const r = asA(sql);
      assert.notEqual(r.status, 0, sql);
      assert.match(r.stderr, /permission denied/, sql);
    }
    assert.equal(callCount(b), 1, "nothing was admitted for B");
  });
});
