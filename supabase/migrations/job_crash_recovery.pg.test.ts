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
 * Crash recovery across the job queue and call finalization, on REAL
 * PostgreSQL with every migration: a runner whose effect committed but who
 * died before acknowledging is re-run by another runner after its lease
 * expires, and the re-run must not charge, resolve or dial again. The dead
 * runner's late acknowledgement and its stale finalization token are refused.
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
  // In a transaction, as Supabase applies every migration (LOCK TABLE needs one).
  const again = execSql(
    `BEGIN;
${readFileSync(join(migrationsDir, "20261111090200_durable_job_queue.sql"), "utf8")}
COMMIT;`,
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

const one = (sql: string) => asService(sql)[0];
const CALL = randomUUID();

describe("crash after the effect, before the acknowledgement", () => {
  test("reconcile: the re-run sees a final call and resolves nothing; dedupe blocks a second resolution", (t) => {
    if (!ready(t)) return;
    rows(`INSERT INTO public.call_logs (id, organization_id, provider, direction, status, provider_call_id, destination_number, started_at)
          VALUES ('${CALL}', '${ORG}', 'sarvam', 'outbound', 'initiated', 'att-crash', '+919000000009', now() - interval '20 minutes');`);
    const job = one(
      `SELECT id FROM public.enqueue_job('sarvam.reconcile_call', '{"callId":"${CALL}"}', 'r:${CALL}', '${ORG}');`,
    )!;
    asService(`SELECT count(*) FROM public.claim_jobs('runner-1', 10, 60);`);
    // The resolution's effect commits (dedupe row + final status)...
    rows(`INSERT INTO public.webhook_events (provider, event_id, event_type, payload) VALUES ('sarvam', 'att-crash', 'completed', '{}');
          UPDATE public.call_logs SET status = 'completed', duration_seconds = 61, ended_at = now() WHERE id = '${CALL}';`);
    // ...and runner-1 dies without complete_job.
    assert.deepEqual(
      rows(`SELECT finalization_state FROM public.call_logs WHERE id = '${CALL}';`),
      ["pending"],
    );
    rows(`UPDATE public.jobs SET locked_until = now() - interval '1 second' WHERE id = '${job}';`);
    assert.deepEqual(
      asService(`SELECT attempts FROM public.claim_jobs('runner-2', 10, 60) WHERE id = '${job}';`),
      ["2"],
    );
    const dup = execSql!(
      `INSERT INTO public.webhook_events (provider, event_id, event_type, payload) VALUES ('sarvam', 'att-crash', 'completed', '{}');`,
    );
    assert.notEqual(dup.status, 0);
    assert.match(dup.stderr, /duplicate key/);
    assert.equal(one(`SELECT public.complete_job('${job}', 'runner-2', NULL);`), "t");
    assert.equal(one(`SELECT public.complete_job('${job}', 'runner-1', NULL);`), "f");
  });

  test("finalize: billing committed before the crash is not applied again; the stale lease is refused", (t) => {
    if (!ready(t)) return;
    const job = one(
      `SELECT id FROM public.enqueue_job('call.finalize', '{"callId":"${CALL}"}', 'f:${CALL}:0', '${ORG}');`,
    )!;
    asService(`SELECT count(*) FROM public.claim_jobs('runner-3', 10, 60);`);
    const token = one(`SELECT public.claim_call_finalization('${CALL}', 120);`)!;
    assert.equal(
      one(
        `SELECT public.apply_call_billing('${CALL}', '${token}', 800, 700, 'INR', 2, 'outbound call');`,
      ),
      "applied",
    );
    // runner-3 dies: no campaign step, no complete_call_finalization, no complete_job.
    rows(`UPDATE public.jobs SET locked_until = now() - interval '1 second' WHERE id = '${job}';
          UPDATE public.call_logs SET finalization_lease_expires_at = now() - interval '1 second' WHERE id = '${CALL}';`);
    asService(`SELECT count(*) FROM public.claim_jobs('runner-4', 10, 60);`);
    const token2 = one(`SELECT public.claim_call_finalization('${CALL}', 120);`)!;
    assert.equal(
      one(
        `SELECT public.apply_call_billing('${CALL}', '${token2}', 800, 700, 'INR', 2, 'outbound call');`,
      ),
      "already",
    );
    assert.equal(
      one(`SELECT public.apply_call_billing('${CALL}', '${token}', 800, 700, 'INR', 2, 'stale');`),
      "lease_lost",
    );
    asService(
      `SELECT public.apply_call_campaign_outcome('${CALL}', '${token2}', NULL, NULL, '{}'::jsonb, false, NULL, NULL);`,
    );
    assert.equal(one(`SELECT public.complete_call_finalization('${CALL}', '${token2}');`), "t");
    assert.equal(
      one(
        `SELECT public.complete_job('${job}', 'runner-4', NULL)::text || public.complete_job('${job}', 'runner-3', NULL)::text;`,
      ),
      "truefalse",
    );
    assert.equal(
      one(`SELECT coalesce(public.claim_call_finalization('${CALL}', 120)::text, 'none');`),
      "none",
    );
  });

  test("exactly one debit, one usage record, one charge; nothing redialled", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      rows(`SELECT count(*) FROM public.wallet_transactions WHERE reference = '${CALL}';`),
      ["1"],
    );
    assert.deepEqual(rows(`SELECT count(*) FROM public.usage_records WHERE call_id = '${CALL}';`), [
      "1",
    ]);
    assert.deepEqual(
      rows(
        `SELECT customer_charge || '|' || finalization_state FROM public.call_logs WHERE id = '${CALL}';`,
      ),
      ["800|done"],
    );
    assert.deepEqual(
      rows(`SELECT count(*) FROM public.call_logs WHERE destination_number = '+919000000009';`),
      ["1"],
    );
    assert.deepEqual(
      rows(
        `SELECT (SELECT balance FROM public.wallet_balances WHERE organization_id = '${ORG}') || '|' || (SELECT sum(amount) FROM public.wallet_transactions WHERE organization_id = '${ORG}');`,
      ),
      ["200|200"],
    );
  });
});
