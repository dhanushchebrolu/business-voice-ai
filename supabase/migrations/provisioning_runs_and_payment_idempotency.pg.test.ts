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
 * REAL-PostgreSQL coverage for 20261114100000: existing connection and
 * number rows survive the migration unchanged; one Sarvam connection may be
 * registered for two organizations but not twice for one; one active
 * provisioning run per organization; record_razorpay_capture is idempotent
 * per payment, checks the amount, advances setup lifecycle forward only and
 * extends billing once; customers can reach neither the table nor the function.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const NEW_MIGRATION = "20261114100000_provisioning_runs_and_payment_idempotency.sql";

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

const OWNER = randomUUID();
const SMILE = randomUUID();
const ABC = randomUUID();
const SMILE_CONN = randomUUID();
const SMILE_NUMBER = randomUUID();

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
const fails = (sql: string, pattern: RegExp) => {
  const r = run(sql);
  assert.notEqual(r.status, 0, sql);
  assert.match(r.stderr, pattern);
};
function ready(t: TestContext): boolean {
  if (setupFailure) assert.fail(setupFailure);
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}

let snapshotBefore = "";
// Columns later migrations add (all nullable, empty for existing rows) are
// left out, so this still proves 20261114100000 changed no existing value.
const LATER_NUMBER_COLUMNS = [
  "sarvam_number_confirmed_at",
  "sarvam_number_confirmed_by",
  "verified_deployment_id",
  "verified_sarvam_app_id",
  "verified_sarvam_app_version",
  "deployment_verified_at",
  "admission_blocked_at",
  "admission_blocked_reason",
]
  .map((c) => `'${c}'`)
  .join(", ");
const SNAPSHOT_SQL = `SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
  SELECT to_jsonb(c)::text AS x FROM public.telephony_connections c
  UNION ALL SELECT (to_jsonb(n) - ARRAY[${LATER_NUMBER_COLUMNS}])::text FROM public.phone_numbers n) s;`;

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
  const apply = (file: string) => {
    const applied = execSql!(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
    return applied.status === 0;
  };
  // Everything before the new migration, then production-like rows, then the new migration (twice: re-runnable).
  for (const file of MIGRATION_FILES.filter((f) => f < NEW_MIGRATION)) if (!apply(file)) return;
  const seed = execSql(`
    INSERT INTO public.organizations (id, name, owner_id, lifecycle_status) VALUES
      ('${SMILE}', 'Smile Dental', '${OWNER}', 'not_provisioned'),
      ('${ABC}', 'ABC Dental', '${OWNER}', 'active');
    INSERT INTO public.telephony_connections (id, organization_id, provider, provider_connection_id, status)
      VALUES ('${SMILE_CONN}', '${SMILE}', 'sarvam', 'conn-shared', 'connected');
    INSERT INTO public.phone_numbers (id, organization_id, e164, provider, status, connection_id, provider_deployment_id)
      VALUES ('${SMILE_NUMBER}', '${SMILE}', '+917900000001', 'sarvam', 'active', '${SMILE_CONN}', 'dep-smile');
  `);
  if (seed.status !== 0) {
    setupFailure = `seed failed: ${seed.stderr}`;
    return;
  }
  snapshotBefore = execSql(`\\pset format unaligned\n\\pset tuples_only on\n${SNAPSHOT_SQL}`)
    .stdout.split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[0-9a-f]{32}$/.test(l))[0]!;
  for (const file of MIGRATION_FILES.filter((f) => f >= NEW_MIGRATION)) if (!apply(file)) return;
  apply(NEW_MIGRATION);
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

const order = (id: string, org: string, purpose: string, amount: number) =>
  `INSERT INTO public.payment_orders (organization_id, purpose, provider_order_id, amount, currency, status)
   VALUES ('${org}', '${purpose}', '${id}', ${amount}, 'INR', 'created');`;
const capture = (orderId: string, paymentId: string, amount: number) =>
  `SELECT public.record_razorpay_capture('${orderId}', '${paymentId}', ${amount}, 'INR', 'upi', '2026-11-14T10:00:00Z')::text;`;
const json = (sql: string) => JSON.parse(rows(sql)[0]!) as Record<string, unknown>;

describe("migration keeps existing data", () => {
  test("connection and number rows are unchanged", (t) => {
    if (!ready(t)) return;
    assert.ok(snapshotBefore, "snapshot taken before the migration");
    assert.deepEqual(rows(SNAPSHOT_SQL), [snapshotBefore]);
  });
});

describe("shared Sarvam connection", () => {
  test("another organization may register the same connection; one organization may not twice", (t) => {
    if (!ready(t)) return;
    rows(`INSERT INTO public.telephony_connections (organization_id, provider, provider_connection_id, status)
          VALUES ('${ABC}', 'sarvam', 'conn-shared', 'connected');`);
    fails(
      `INSERT INTO public.telephony_connections (organization_id, provider, provider_connection_id, status)
       VALUES ('${SMILE}', 'sarvam', 'conn-shared', 'connected');`,
      /idx_telephony_connections_org_provider_connection/,
    );
  });
});

describe("provisioning_runs", () => {
  test("one active run per organization; finished runs do not block a new one", (t) => {
    if (!ready(t)) return;
    const runId = rows(
      `INSERT INTO public.provisioning_runs (organization_id, trigger) VALUES ('${SMILE}', 'setup_fee') RETURNING id;`,
    )[0]!;
    fails(
      `INSERT INTO public.provisioning_runs (organization_id, trigger) VALUES ('${SMILE}', 'admin_retry');`,
      /idx_provisioning_runs_one_active/,
    );
    fails(
      `UPDATE public.provisioning_runs SET status = 'failed' WHERE id = '${runId}';`,
      /finished_when_terminal/,
    );
    rows(
      `UPDATE public.provisioning_runs SET status = 'failed', finished_at = now() WHERE id = '${runId}';`,
    );
    rows(
      `INSERT INTO public.provisioning_runs (organization_id, trigger) VALUES ('${SMILE}', 'admin_retry');`,
    );
    fails(
      `INSERT INTO public.provisioning_runs (organization_id, trigger) VALUES ('${ABC}', 'bogus');`,
      /check constraint/,
    );
  });
});

describe("20261114110000 agent config columns", () => {
  test("a run stores the generated config, its fingerprint and the verification time", (t) => {
    if (!ready(t)) return;
    const id = rows(
      `INSERT INTO public.provisioning_runs (organization_id, trigger, generated_agent_config, agent_config_fingerprint, deployment_verified_at)
       VALUES ('${ABC}', 'admin_retry', '{"templateVersion":1}'::jsonb, 'u1-0a1b2c3d', now()) RETURNING id;`,
    )[0]!;
    assert.deepEqual(
      rows(`SELECT agent_config_fingerprint FROM public.provisioning_runs WHERE id = '${id}';`),
      ["u1-0a1b2c3d"],
    );
    fails(
      `UPDATE public.provisioning_runs SET agent_config_fingerprint = 'x' WHERE id = '${id}';`,
      /check constraint/,
    );
    // 20261114120000: expected-vs-actual verification report.
    rows(
      `UPDATE public.provisioning_runs SET verification = '{"checks":[{"id":"status","ok":false}]}'::jsonb WHERE id = '${id}';`,
    );
    assert.deepEqual(
      rows(
        `SELECT verification->'checks'->0->>'id' FROM public.provisioning_runs WHERE id = '${id}';`,
      ),
      ["status"],
    );
  });
});

describe("record_razorpay_capture", () => {
  test("a setup fee delivered twice: one payment, one invoice, order paid, lifecycle advanced", (t) => {
    if (!ready(t)) return;
    rows(order("order_setup", SMILE, "setup_fee", 999900));
    const first = json(capture("order_setup", "pay_1", 999900));
    const second = json(capture("order_setup", "pay_1", 999900));
    assert.equal(first["first_capture"], true);
    assert.equal(second["first_capture"], false);
    assert.equal(first["payment_id"], second["payment_id"]);
    assert.deepEqual(
      rows(`SELECT count(*) FROM public.payments WHERE provider_payment_id = 'pay_1';`),
      ["1"],
    );
    assert.deepEqual(
      rows(`SELECT count(*) FROM public.invoices WHERE payment_id = '${first["payment_id"]}';`),
      ["1"],
    );
    assert.deepEqual(
      rows(`SELECT status FROM public.payment_orders WHERE provider_order_id = 'order_setup';`),
      ["paid"],
    );
    assert.deepEqual(
      rows(`SELECT lifecycle_status FROM public.organizations WHERE id = '${SMILE}';`),
      ["setup_paid"],
    );
  });

  test("never moves a further-along organization backwards", (t) => {
    if (!ready(t)) return;
    rows(order("order_abc_setup", ABC, "setup_fee", 999900));
    rows(capture("order_abc_setup", "pay_2", 999900));
    assert.deepEqual(
      rows(`SELECT lifecycle_status FROM public.organizations WHERE id = '${ABC}';`),
      ["active"],
    );
  });

  test("an amount mismatch records nothing", (t) => {
    if (!ready(t)) return;
    rows(order("order_phone", SMILE, "phone_service_fee", 150000));
    assert.equal(json(capture("order_phone", "pay_3", 100))["mismatch"], true);
    assert.deepEqual(
      rows(`SELECT count(*) FROM public.payments WHERE provider_payment_id = 'pay_3';`),
      ["0"],
    );
    assert.deepEqual(
      rows(`SELECT status FROM public.payment_orders WHERE provider_order_id = 'order_phone';`),
      ["created"],
    );
  });

  test("the monthly plan extends billing once per payment", (t) => {
    if (!ready(t)) return;
    rows(order("order_month", ABC, "monthly_plan", 499900));
    rows(capture("order_month", "pay_4", 499900));
    const once = rows(`SELECT next_billing_at FROM public.organizations WHERE id = '${ABC}';`);
    rows(capture("order_month", "pay_4", 499900));
    assert.deepEqual(
      rows(`SELECT next_billing_at FROM public.organizations WHERE id = '${ABC}';`),
      once,
    );
  });

  test("an unknown order is reported, not invented", (t) => {
    if (!ready(t)) return;
    assert.equal(json(capture("order_none", "pay_5", 1))["found"], false);
  });

  test("customers and anonymous callers can reach neither the runs table nor the function", (t) => {
    if (!ready(t)) return;
    for (const role of ["authenticated", "anon"])
      for (const sql of [
        `SELECT * FROM public.provisioning_runs;`,
        capture("order_setup", "pay_9", 999900),
      ]) {
        const r = execSql!(`SET ROLE ${role};\n${sql}`);
        assert.notEqual(r.status, 0, `${role}: ${sql}`);
        assert.match(r.stderr, /permission denied/);
      }
  });
});
