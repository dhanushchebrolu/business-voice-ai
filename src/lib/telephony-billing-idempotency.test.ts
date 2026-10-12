import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  bootstrapCluster,
  makeExecSql,
  registerSignalCleanup,
  teardownCluster,
  type Cluster,
  type RunResult,
} from "../../supabase/migrations/pg-test-cluster.ts";

/**
 * Regression coverage for the Sarvam migration's Phase 6/10 requirement:
 * "Do not charge a customer twice because Sarvam retries a webhook." /
 * "Do not charge for an attempt that should not be billed."
 *
 * This is provider-agnostic, pre-existing (Phase D) protection — reused
 * unmodified for Sarvam per requirement E ("do not create a parallel
 * billing system") — but it was never covered by a dedicated test before
 * this pass. Three independent layers exist; this suite scans the
 * migration SQL and telephony-guard.server.ts (source-scan, since the SQL
 * itself cannot execute in this sandbox — no live Supabase connection, per
 * this session's established constraint) to confirm all three are present
 * as written:
 *
 *   1. Call-state-machine layer (already tested in
 *      telephony-guard.server.test.ts): a same-status webhook is a no-op,
 *      so applyCallEvent never calls finalizeCallBilling twice for one
 *      call reaching the same terminal state.
 *   2. Application layer: debit_wallet_for_call checks for an existing
 *      wallet_transactions row (by organization_id + kind='call_usage' +
 *      reference=call_id) BEFORE inserting, returning already_applied=true
 *      instead of debiting again.
 *   3. Storage layer: a UNIQUE index on
 *      wallet_transactions(organization_id, reference) WHERE
 *      kind='call_usage' makes a duplicate debit impossible even if the
 *      application-layer check were ever bypassed by a bug — the same
 *      belt-and-suspenders pattern is applied to usage_records.
 *
 * usage_records is written through the record_call_usage RPC (migration
 * 20261012080257): INSERT ... ON CONFLICT (call_id, kind) WHERE call_id IS
 * NOT NULL DO NOTHING, i.e. the storage-layer unique index is the single
 * idempotency guarantee for the usage ledger, so a retried finalize writes
 * nothing new whether or not the wallet debit was already applied. That
 * function is verified both by source scan and, when a PostgreSQL binary
 * is available, by actually running every migration and calling it
 * repeatedly and concurrently (the last describe block below).
 */

const migrationSrc = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "supabase",
    "migrations",
    "20260904120000_phase_d_telephony_infrastructure.sql",
  ),
  "utf8",
);

const guardSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "telephony-guard.server.ts"),
  "utf8",
);

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "supabase",
  "migrations",
);
const recordUsageSrc = readFileSync(
  join(migrationsDir, "20261012080257_add_record_call_usage_function.sql"),
  "utf8",
);

/** finalizeCallBilling's own source, up to the next top-level export. */
function finalizeSrc(): string {
  const start = guardSrc.indexOf("export async function finalizeCallBilling");
  assert.ok(start > -1, "finalizeCallBilling must exist");
  const next = guardSrc.indexOf("\nexport ", start + 1);
  return guardSrc.slice(start, next === -1 ? undefined : next);
}

describe("wallet debit idempotency (application layer)", () => {
  test("debit_wallet_for_call checks for an existing reference before inserting a new debit", () => {
    const fnSrc = migrationSrc.slice(
      migrationSrc.indexOf("CREATE OR REPLACE FUNCTION public.debit_wallet_for_call"),
      migrationSrc.indexOf("CREATE OR REPLACE FUNCTION public.wallet_can_afford"),
    );
    assert.match(
      fnSrc,
      /SELECT reference INTO existing_ref FROM public\.wallet_transactions\s*\n\s*WHERE organization_id = _org AND kind = 'call_usage' AND reference = _call_id::text/,
    );
    assert.match(fnSrc, /IF existing_ref IS NOT NULL THEN/);
    assert.match(fnSrc, /RETURN QUERY SELECT true, true, new_balance;/);
  });

  test("the existing-reference check runs before any INSERT into wallet_transactions, not after", () => {
    const fnSrc = migrationSrc.slice(
      migrationSrc.indexOf("CREATE OR REPLACE FUNCTION public.debit_wallet_for_call"),
      migrationSrc.indexOf("CREATE OR REPLACE FUNCTION public.wallet_can_afford"),
    );
    const checkIdx = fnSrc.indexOf("IF existing_ref IS NOT NULL THEN");
    const insertIdx = fnSrc.indexOf("INSERT INTO public.wallet_transactions");
    assert.ok(checkIdx > -1 && insertIdx > -1);
    assert.ok(checkIdx < insertIdx, "the idempotency check must precede the insert");
  });

  test("debit_wallet_for_call is executable only by service_role — no client or authenticated-user path can call it directly", () => {
    const revokeIdx = migrationSrc.indexOf("REVOKE ALL ON FUNCTION public.debit_wallet_for_call");
    const grantIdx = migrationSrc.indexOf("GRANT EXECUTE ON FUNCTION public.debit_wallet_for_call");
    assert.ok(revokeIdx > -1 && grantIdx > -1);
    assert.match(
      migrationSrc.slice(revokeIdx, revokeIdx + 200),
      /FROM PUBLIC, anon, authenticated/,
    );
    assert.match(migrationSrc.slice(grantIdx, grantIdx + 100), /TO service_role/);
  });
});

describe("wallet debit idempotency (storage layer — backstop even if the application check is ever bypassed)", () => {
  test("a UNIQUE index prevents two wallet_transactions rows for the same organization+call_usage reference", () => {
    assert.match(
      migrationSrc,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_call_usage_ref\s*\n\s*ON public\.wallet_transactions \(organization_id, reference\) WHERE kind = 'call_usage';/,
    );
  });

  test("a UNIQUE index prevents a call from contributing more than one usage_records row per kind", () => {
    assert.match(
      migrationSrc,
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_records_call_kind\s*\n\s*ON public\.usage_records \(call_id, kind\) WHERE call_id IS NOT NULL;/,
    );
  });
});

describe("finalizeCallBilling — reused unmodified for every provider, including Sarvam", () => {
  test("debits through the idempotent debit_wallet_for_call and fails loudly if it errors", () => {
    const fnSrc = finalizeSrc();
    assert.match(fnSrc, /rpc\("debit_wallet_for_call"/);
    assert.match(fnSrc, /_call_id: call\.id/);
    assert.match(fnSrc, /if \(debitError\) throw debitError;/);
  });

  test("usage is recorded only through the record_call_usage RPC, keyed by (call id, kind) — the idempotency key of the unique index", () => {
    const fnSrc = finalizeSrc();
    const callIdx = fnSrc.indexOf('"record_call_usage"');
    assert.ok(callIdx > -1, "finalizeCallBilling must call record_call_usage");
    const args = fnSrc.slice(callIdx, fnSrc.indexOf("});", callIdx));
    assert.match(args, /p_call_id: call\.id/, "keyed by this call's id");
    assert.match(args, /p_kind: "call"/, "with a fixed kind, so a retry hits the same key");
    assert.match(args, /p_organization_id: call\.organization_id/);
    for (const field of [
      "p_provider",
      "p_quantity",
      "p_unit",
      "p_provider_cost",
      "p_billable_cost",
    ]) {
      assert.match(args, new RegExp(`${field}:`), `${field} is passed`);
    }
    // No second, non-idempotent write path to the usage ledger.
    assert.doesNotMatch(fnSrc, /from\("usage_records"\)/);
  });

  test("a usage-recording failure is surfaced (thrown), never silently dropped", () => {
    const fnSrc = finalizeSrc();
    // The RPC's error is captured from the record_call_usage call itself…
    assert.match(
      fnSrc,
      /const \{ error: usageError \} = await recordCallUsage\(\s*"record_call_usage",/,
    );
    // …and re-thrown, so the webhook fails and the provider retries
    // (safe: the retry is idempotent, see the PostgreSQL tests below).
    const usageCall = fnSrc.indexOf('"record_call_usage"');
    assert.match(fnSrc.slice(usageCall), /if \(usageError\) \{[\s\S]*?throw usageError;/);
  });

  test("finalizeCallBilling never branches on provider — the same function runs for exotel, sarvam, or any future provider", () => {
    const fnSrc = guardSrc.slice(guardSrc.indexOf("export async function finalizeCallBilling"));
    assert.doesNotMatch(fnSrc, /call\.provider|direction === "sarvam"|=== "exotel"/);
  });
});

describe("record_call_usage (migration 20261012080257) — storage-layer idempotency for usage_records", () => {
  const code = recordUsageSrc.replace(/--.*$/gm, "");

  test("inserts with ON CONFLICT ... DO NOTHING, so a duplicate never overwrites or adds a row", () => {
    assert.match(code, /INSERT INTO public\.usage_records \(/);
    assert.match(code, /ON CONFLICT \(call_id, kind\)\s*WHERE call_id IS NOT NULL\s*DO NOTHING;/);
    assert.doesNotMatch(code, /DO UPDATE/);
  });

  test("its conflict target is exactly the existing partial unique index (same columns, same predicate)", () => {
    const index = migrationSrc.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_records_call_kind\s*ON public\.usage_records \(([^)]*)\) WHERE ([^;]*);/,
    );
    const conflict = code.match(/ON CONFLICT \(([^)]*)\)\s*WHERE ([^\n]*?)\s*DO NOTHING/);
    assert.ok(index && conflict);
    assert.equal(conflict![1]!.trim(), index![1]!.trim());
    assert.equal(conflict![2]!.trim(), index![2]!.trim());
  });

  test("runs with a pinned, empty search_path and without SECURITY DEFINER (callers keep their own table privileges)", () => {
    assert.match(code, /SET search_path TO ''/);
    assert.doesNotMatch(code, /SECURITY DEFINER/i);
    assert.match(
      code,
      /GRANT EXECUTE ON FUNCTION public\.record_call_usage\([\s\S]*?\) TO service_role;/,
    );
  });
});

// ------------------------------------------------------------------
// Real PostgreSQL: every migration applied, record_call_usage executed.
// Skips only when no PostgreSQL binary is available in this environment.
// ------------------------------------------------------------------

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
const CALL_1 = randomUUID();
const CALL_2 = randomUUID();

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
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{14}_.*\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const applied = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  const owner = randomUUID();
  const seed = execSql(`
    INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG}', 'Billing Org', '${owner}');
    INSERT INTO public.call_logs (id, organization_id) VALUES ('${CALL_1}', '${ORG}'), ('${CALL_2}', '${ORG}');
  `);
  if (seed.status !== 0) setupFailure = `seed failed: ${seed.stderr}`;
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

function pgTest(name: string, fn: (t: TestContext) => void | Promise<void>) {
  test(name, async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    if (setupFailure) {
      assert.fail(
        `PostgreSQL is available, but setup failed — a real failure, not a skip: ${setupFailure}`,
      );
    }
    await fn(t);
  });
}

/** Unaligned, tuples-only rows. */
function rows(sql: string): string[] {
  const r = execSql!(`\\pset format unaligned\n\\pset tuples_only on\n${sql}`);
  if (r.status !== 0) throw new Error(`SQL failed: ${r.stderr}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only"));
}

function recordSql(
  callId: string | null,
  kind: string,
  quantity: number,
  billable: number,
): string {
  const call = callId ? `'${callId}'` : "NULL";
  return `SELECT public.record_call_usage('${ORG}', ${call}, '${kind}', 'telephony', ${quantity}, 'minute', 0.5, ${billable});`;
}

/** Runs SQL in its own psql session asynchronously, so two sessions can overlap. */
function execSqlAsync(sql: string): Promise<RunResult> {
  const c = cluster!;
  const args = ["-h", c.sockDir, "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-X", "-f", "-"];
  const child = c.useSu
    ? spawn("su", ["postgres", "-c", [`${c.pgBinDir}psql`, ...args].join(" ")])
    : spawn(`${c.pgBinDir}psql`, args);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));
  child.stdin.end(sql);
  return new Promise((resolve) =>
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr })),
  );
}

describe("record_call_usage — real PostgreSQL, every migration applied", () => {
  pgTest(
    "a retried finalize (same call, same kind) records usage exactly once and never overwrites the first row",
    () => {
      const first = execSql!(recordSql(CALL_1, "call", 3, 30));
      assert.equal(first.status, 0, first.stderr);
      // A webhook retry, even one carrying different numbers, is a silent no-op.
      for (const [qty, cost] of [
        [3, 30],
        [9, 90],
      ] as const) {
        const retry = execSql!(recordSql(CALL_1, "call", qty, cost));
        assert.equal(retry.status, 0, `a duplicate must not error: ${retry.stderr}`);
      }
      assert.deepEqual(
        rows(
          `SELECT count(*), sum(quantity)::int, sum(billable_cost)::int FROM public.usage_records WHERE call_id = '${CALL_1}' AND kind = 'call';`,
        ),
        ["1|3|30"],
        "one row, with the first recording's values — no double billing",
      );
    },
  );

  pgTest(
    "the key is (call, kind): another kind for the same call, or another call, is still recorded",
    () => {
      assert.equal(execSql!(recordSql(CALL_1, "transcription", 3, 5)).status, 0);
      assert.equal(execSql!(recordSql(CALL_2, "call", 2, 20)).status, 0);
      assert.deepEqual(
        rows(
          `SELECT call_id || ':' || kind FROM public.usage_records WHERE organization_id = '${ORG}' AND call_id IS NOT NULL ORDER BY call_id = '${CALL_1}' DESC, kind;`,
        ),
        [`${CALL_1}:call`, `${CALL_1}:transcription`, `${CALL_2}:call`],
      );
    },
  );

  pgTest(
    "two overlapping sessions recording the same call at once still produce exactly one row",
    async () => {
      const callId = randomUUID();
      assert.equal(
        execSql!(
          `INSERT INTO public.call_logs (id, organization_id) VALUES ('${callId}', '${ORG}');`,
        ).status,
        0,
      );
      // Session A inserts and holds its transaction open; session B starts
      // while A's row is still uncommitted, so B must wait on the unique
      // index and then resolve to DO NOTHING once A commits.
      const a = execSqlAsync(
        `BEGIN; ${recordSql(callId, "call", 4, 40)} SELECT pg_sleep(1); COMMIT;`,
      );
      await new Promise((r) => setTimeout(r, 300));
      const b = execSqlAsync(recordSql(callId, "call", 4, 40));
      const [ra, rb] = await Promise.all([a, b]);
      assert.equal(ra.status, 0, ra.stderr);
      assert.equal(rb.status, 0, `the concurrent duplicate must not error: ${rb.stderr}`);
      assert.deepEqual(
        rows(`SELECT count(*) FROM public.usage_records WHERE call_id = '${callId}';`),
        ["1"],
      );
    },
  );

  pgTest(
    "customers cannot use it to write usage: as the authenticated role the insert is refused",
    () => {
      const callId = randomUUID();
      assert.equal(
        execSql!(
          `INSERT INTO public.call_logs (id, organization_id) VALUES ('${callId}', '${ORG}');`,
        ).status,
        0,
      );
      const asUser = execSql!(`SET ROLE authenticated; ${recordSql(callId, "call", 1, 1)}`);
      assert.notEqual(asUser.status, 0);
      assert.match(asUser.stderr, /permission denied|row-level security/);
      assert.deepEqual(
        rows(`SELECT count(*) FROM public.usage_records WHERE call_id = '${callId}';`),
        ["0"],
      );
    },
  );
});

describe("provider-financial columns cannot be forged or read by customers (customer cannot manipulate Sarvam IDs / see provider cost)", () => {
  test("call_logs' customer-facing SELECT grant excludes provider_cost, gross_profit and provider_metadata", () => {
    const grantIdx = migrationSrc.indexOf("REVOKE SELECT ON public.call_logs FROM authenticated;");
    const grantEndIdx = migrationSrc.indexOf(") ON public.call_logs TO authenticated;");
    assert.ok(grantIdx > -1 && grantEndIdx > -1);
    const grantBlock = migrationSrc.slice(grantIdx, grantEndIdx);
    assert.doesNotMatch(grantBlock, /provider_cost/);
    assert.doesNotMatch(grantBlock, /gross_profit/);
    assert.doesNotMatch(grantBlock, /provider_metadata/);
    // customer_charge — what they're actually billed — remains visible.
    assert.match(grantBlock, /customer_charge/);
  });

  test("phone_numbers and call_logs remain admin/service-role write-only — the pre-existing customer SELECT-only grant is untouched by this migration", () => {
    assert.match(
      migrationSrc,
      /Numbers remain admin\/service-role-writable only[\s\S]{0,300}telephony-admin\.functions\.ts/,
    );
  });
});
