#!/usr/bin/env node
/**
 * Database hot-path load test for ClickAI's multi-tenant schema, against a
 * real, throwaway PostgreSQL (never Supabase, never production):
 *
 *   node scripts/loadtest/db-hotpaths.mjs --port 55432 [--tenants 2000] [--seconds 10] [--clients 16]
 *
 * Creates database `clickai_loadtest` on the given server (dropping any
 * previous copy), applies the Supabase stand-in and EVERY migration in
 * supabase/migrations, seeds N tenants, then runs pgbench scenarios against
 * the real functions and indexes production uses:
 *
 *   spread_settle   call settlement (debit_wallet_for_call) across many tenants
 *   hot_settle      every client settling calls for ONE tenant (row-lock bound)
 *   dup_settle      every client settling the SAME call: must debit exactly once
 *   dial_reserve    every client reserving the same destination: exactly one wins
 *   webhook_dedupe  duplicate provider events: one row per event id
 *   afford_L        wallet_can_afford latency for a tenant with an L-row ledger
 *   rls_member      a member reading their call log under RLS (tenant isolation)
 *   service_read    the same read as the service role (no RLS): the overhead
 *
 * and correctness checks (exactly-once settlement, single reservation, no
 * cross-tenant rows under RLS). Prints a JSON summary. Needs psql and
 * pgbench (PostgreSQL 15+) on PATH or in C:\Program Files\PostgreSQL\<v>\bin.
 * Local numbers are lower bounds for Supabase (no network, no pooler).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..", "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const PORT = arg("port", "5432");
const HOST = arg("host", "localhost");
const TENANTS = Number(arg("tenants", "2000"));
const SECONDS = Number(arg("seconds", "10"));
const CLIENTS = Number(arg("clients", "16"));
const DB = "clickai_loadtest";
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(HOST)) {
  console.error("refusing: this load test only runs against a local throwaway server");
  process.exit(1);
}

function pgBin(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  if (spawnSync(exe, ["--version"]).status === 0) return exe;
  const root = "C:\\Program Files\\PostgreSQL";
  if (existsSync(root)) {
    for (const v of readdirSync(root).sort((a, b) => Number(b) - Number(a))) {
      const p = join(root, v, "bin", exe);
      if (existsSync(p)) return p;
    }
  }
  throw new Error(`${name} not found`);
}
const PSQL = pgBin("psql");
const PGBENCH = pgBin("pgbench");
const conn = (db) => ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db];

function psql(db, sql) {
  const r = spawnSync(PSQL, [...conn(db), "-v", "ON_ERROR_STOP=1", "-qAt", "-f", "-"], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr.slice(0, 2000)}`);
  return r.stdout.trim();
}

const work = mkdtempSync(join(tmpdir(), "clickai-loadtest-"));
function pgbench(name, script, { clients = CLIENTS, seconds = SECONDS } = {}) {
  const file = join(work, `${name}.sql`);
  writeFileSync(file, script);
  const r = spawnSync(
    PGBENCH,
    [
      ...conn(DB),
      "-n",
      "-c",
      String(clients),
      "-j",
      String(Math.min(clients, 8)),
      "-T",
      String(seconds),
      "-f",
      file,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const out = `${r.stdout}\n${r.stderr}`;
  const num = (re) => Number(re.exec(out)?.[1] ?? NaN);
  const result = {
    scenario: name,
    clients,
    seconds,
    tps: Math.round(num(/tps = ([\d.]+) \(without initial connection time\)/)),
    latency_ms_avg: num(/latency average = ([\d.]+) ms/),
    failed: num(/number of failed transactions: (\d+)/) || 0,
    transactions: num(/number of transactions actually processed: (\d+)/),
  };
  if (r.status !== 0 || Number.isNaN(result.tps)) result.error = out.slice(-1500);
  return result;
}

// 1. Fresh database with the Supabase stand-in and every migration.
psql("postgres", `DROP DATABASE IF EXISTS ${DB};\nCREATE DATABASE ${DB};`);
const pgTest = readFileSync(
  join(repo, "supabase/migrations/wallet_service_role_balance.pg.test.ts"),
  "utf8",
);
const standin = /const SUPABASE_STANDIN = `([\s\S]*?)`;/.exec(pgTest)[1];
// Roles are server-wide: create them once, then the rest of the stand-in per database.
const roles = [...standin.matchAll(/^CREATE ROLE ([^;]+);$/gm)].map((m) => m[1]);
for (const r of roles) {
  psql(DB, `DO $$BEGIN CREATE ROLE ${r}; EXCEPTION WHEN duplicate_object THEN NULL; END$$;`);
}
psql(DB, standin.replace(/^CREATE ROLE [^;]+;$/gm, ""));
const migrations = readdirSync(join(repo, "supabase/migrations"))
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
for (const f of migrations)
  psql(DB, `BEGIN;\n${readFileSync(join(repo, "supabase/migrations", f), "utf8")}\nCOMMIT;`);

// 2. Seed tenants: owner user, membership, business, agent, Sarvam number, wallet top-up, 20 calls each.
psql(
  DB,
  `
CREATE TABLE lt_orgs (n int PRIMARY KEY, id uuid NOT NULL, owner uuid NOT NULL);
INSERT INTO lt_orgs SELECT g, gen_random_uuid(), gen_random_uuid() FROM generate_series(1, ${TENANTS}) g;
INSERT INTO auth.users (id, email) SELECT owner, 'lt' || n || '@example.test' FROM lt_orgs;
INSERT INTO public.organizations (id, name, owner_id) SELECT id, 'Tenant ' || n, owner FROM lt_orgs;
INSERT INTO public.organization_members (organization_id, user_id) SELECT id, owner FROM lt_orgs;
INSERT INTO public.businesses (organization_id, name) SELECT id, 'Biz ' || n FROM lt_orgs;
INSERT INTO public.agent_configs (organization_id, business_id) SELECT b.organization_id, b.id FROM public.businesses b;
INSERT INTO public.phone_numbers (organization_id, e164, provider, status, outbound_enabled)
  SELECT id, '+9170' || lpad(n::text, 8, '0'), 'sarvam', 'active', true FROM lt_orgs;
INSERT INTO public.wallet_transactions (organization_id, amount, kind, description)
  SELECT id, 1000000, 'topup', 'seed' FROM lt_orgs;
INSERT INTO public.call_logs (organization_id, provider, direction, status, started_at)
  SELECT o.id, 'sarvam', 'outbound', 'completed', now() - (c || ' minutes')::interval
  FROM lt_orgs o, generate_series(1, 20) c;
ANALYZE;
`,
);

const results = [];
const orgOf = (n) => `(SELECT id FROM lt_orgs WHERE n = ${n})`;

results.push(
  pgbench(
    "spread_settle",
    `\\set n random(1, ${TENANTS})\nSELECT * FROM public.debit_wallet_for_call((SELECT id FROM lt_orgs WHERE n = :n), gen_random_uuid(), 400, 'lt');\n`,
  ),
);
results.push(
  pgbench(
    "hot_settle",
    `SELECT * FROM public.debit_wallet_for_call(${orgOf(1)}, gen_random_uuid(), 400, 'lt');\n`,
  ),
);

const dupCall = "00000000-0000-4000-8000-000000000001";
results.push(
  pgbench(
    "dup_settle",
    `SELECT * FROM public.debit_wallet_for_call(${orgOf(2)}, '${dupCall}', 400, 'lt');\n`,
    { seconds: 5 },
  ),
);
const dupDebits = Number(
  psql(DB, `SELECT count(*) FROM public.wallet_transactions WHERE reference = '${dupCall}';`),
);

results.push(
  pgbench(
    "dial_reserve",
    `INSERT INTO public.call_logs (organization_id, provider, direction, status, destination_number, started_at) VALUES (${orgOf(3)}, 'sarvam', 'outbound', 'initiated', '+919000000001', now()) ON CONFLICT DO NOTHING;\n`,
    { seconds: 5 },
  ),
);
const reservations = Number(
  psql(
    DB,
    `SELECT count(*) FROM public.call_logs WHERE destination_number = '+919000000001' AND status = 'initiated';`,
  ),
);

results.push(
  pgbench(
    "webhook_dedupe",
    `\\set e random(1, 1000)\nINSERT INTO public.webhook_events (provider, event_id, payload) VALUES ('sarvam', 'evt-' || :e, '{}') ON CONFLICT DO NOTHING;\n`,
    { seconds: 5 },
  ),
);
const webhookRows = Number(
  psql(DB, `SELECT count(*) FROM public.webhook_events WHERE provider = 'sarvam';`),
);

// Affordability latency as one tenant's ledger grows (single client = pure latency).
const ledger = [];
let have = 1;
for (const size of [100, 10_000, 100_000]) {
  psql(
    DB,
    `INSERT INTO public.wallet_transactions (organization_id, amount, kind, description, reference)
    SELECT ${orgOf(4)}, -1, 'call_usage', 'lt', gen_random_uuid()::text FROM generate_series(1, ${size - have});
    ANALYZE public.wallet_transactions;`,
  );
  have = size;
  const r = pgbench(`afford_${size}`, `SELECT public.wallet_can_afford(${orgOf(4)}, 400);\n`, {
    clients: 1,
    seconds: 5,
  });
  ledger.push({ ledger_rows: size, latency_ms_avg: r.latency_ms_avg, tps: r.tps });
}

// Tenant isolation under RLS: overhead and correctness.
const member = `\\set n random(1, ${TENANTS})
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', (SELECT owner::text FROM lt_orgs WHERE n = :n), false);
SELECT count(*) FROM public.call_logs WHERE organization_id = (SELECT id FROM lt_orgs WHERE n = :n);
RESET ROLE;
`;
// lt_orgs is a harness table: let the authenticated role read it for the lookup.
psql(DB, "GRANT SELECT ON lt_orgs TO authenticated;");
results.push(pgbench("rls_member", member));
results.push(
  pgbench(
    "service_read",
    `\\set n random(1, ${TENANTS})\nSELECT count(*) FROM public.call_logs WHERE organization_id = (SELECT id FROM lt_orgs WHERE n = :n);\n`,
  ),
);
const leak = psql(
  DB,
  `SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', (SELECT owner::text FROM lt_orgs WHERE n = 5), false);
SELECT count(*) FILTER (WHERE organization_id <> (SELECT id FROM lt_orgs WHERE n = 5)) || '/' || count(*) FROM public.call_logs;`,
)
  .split("\n")
  .pop();

// Every cached balance must equal its ledger sum (when the cache exists).
const hasCache = psql(DB, "SELECT to_regclass('public.wallet_balances') IS NOT NULL;") === "t";
const balanceMismatches = hasCache
  ? Number(
      psql(
        DB,
        `SELECT count(*) FROM (SELECT organization_id, SUM(amount) s FROM public.wallet_transactions GROUP BY 1) l
      FULL JOIN public.wallet_balances b USING (organization_id) WHERE COALESCE(l.s, 0) <> COALESCE(b.balance, 0);`,
      ),
    )
  : null;

const summary = {
  server: `PostgreSQL local ${HOST}:${PORT}`,
  tenants: TENANTS,
  migrations: migrations.length,
  results,
  wallet_affordability_by_ledger_size: ledger,
  correctness: {
    duplicate_settlement_debits: dupDebits,
    concurrent_reservations_won: reservations,
    webhook_rows_for_1000_event_ids: webhookRows,
    rls_other_tenant_rows_visible_over_total_visible: leak,
    wallet_balance_cache_mismatches: balanceMismatches,
  },
};
console.log(JSON.stringify(summary, null, 2));
rmSync(work, { recursive: true, force: true });
const ok =
  dupDebits === 1 &&
  reservations === 1 &&
  webhookRows <= 1000 &&
  leak.startsWith("0/") &&
  !balanceMismatches;
process.exit(ok && results.every((r) => !r.error) ? 0 : 1);
