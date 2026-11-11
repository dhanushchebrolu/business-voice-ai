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
 * REAL-PostgreSQL coverage for 20261111090200_durable_job_queue.sql:
 * idempotent enqueue, leasing, fencing, retry backoff, dead-lettering,
 * requeue, pruning, stats and grants. Concurrent claiming is measured by
 * scripts/loadtest/db-hotpaths.mjs (job_claim) with real parallel sessions.
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
const enqueue = (key: string, kind = "test.job", extra = "") =>
  one(
    `SELECT id || '|' || created FROM public.enqueue_job('${kind}', '{"n":1}', '${key}'${extra});`,
  )!;
const claim = (worker: string, limit = 10, lease = 60) =>
  asService(
    `SELECT id || '|' || kind || '|' || attempts FROM public.claim_jobs('${worker}', ${limit}, ${lease});`,
  );
const statusOf = (id: string) =>
  rows(`SELECT status || '|' || attempts FROM public.jobs WHERE id = '${id}';`)[0];

describe("job queue", () => {
  test("enqueue is idempotent on its key", (t) => {
    if (!ready(t)) return;
    const [id, created] = enqueue("idem-1").split("|");
    assert.equal(created, "true");
    assert.equal(enqueue("idem-1"), `${id}|false`);
    assert.deepEqual(rows(`SELECT count(*) FROM public.jobs WHERE idempotency_key = 'idem-1';`), [
      "1",
    ]);
  });

  test("a claimed job is leased to one runner; others cannot complete or fail it", (t) => {
    if (!ready(t)) return;
    const [id] = enqueue("lease-1", "test.lease").split("|");
    const claimed = claim("runner-a").filter((r) => r.startsWith(id!));
    assert.deepEqual(claimed, [`${id}|test.lease|1`]);
    assert.deepEqual(
      claim("runner-b").filter((r) => r.startsWith(id!)),
      [],
      "not claimable twice",
    );
    assert.equal(one(`SELECT public.complete_job('${id}', 'runner-b', NULL);`), "f");
    assert.equal(one(`SELECT public.fail_job('${id}', 'runner-b', 'x', true);`), "not_owner");
    assert.equal(one(`SELECT public.complete_job('${id}', 'runner-a', '{"ok":true}');`), "t");
    assert.equal(statusOf(id!), "succeeded|1");
  });

  test("an expired lease is re-claimed by another runner, and the old runner is fenced out", (t) => {
    if (!ready(t)) return;
    const [id] = enqueue("expire-1", "test.expire").split("|");
    claim("runner-a");
    rows(`UPDATE public.jobs SET locked_until = now() - interval '1 second' WHERE id = '${id}';`);
    assert.deepEqual(
      claim("runner-b").filter((r) => r.startsWith(id!)),
      [`${id}|test.expire|2`],
    );
    assert.equal(one(`SELECT public.complete_job('${id}', 'runner-a', NULL);`), "f");
    assert.equal(one(`SELECT public.complete_job('${id}', 'runner-b', NULL);`), "t");
  });

  test("failures back off, then dead-letter after max_attempts; a permanent failure dead-letters at once", (t) => {
    if (!ready(t)) return;
    const [id] = enqueue("retry-1", "test.retry", ", NULL, now(), 2").split("|");
    claim("r1");
    assert.equal(one(`SELECT public.fail_job('${id}', 'r1', 'boom', true);`), "queued");
    assert.equal(
      rows(
        `SELECT (run_at > now() + interval '25 seconds')::text FROM public.jobs WHERE id = '${id}';`,
      )[0],
      "true",
      "backed off ~30 s",
    );
    rows(`UPDATE public.jobs SET run_at = now() WHERE id = '${id}';`);
    claim("r2");
    assert.equal(one(`SELECT public.fail_job('${id}', 'r2', 'boom again', true);`), "dead");
    assert.equal(statusOf(id!), "dead|2");

    const [p] = enqueue("permanent-1", "test.permanent").split("|");
    claim("r3");
    assert.equal(one(`SELECT public.fail_job('${p}', 'r3', 'bad payload', false);`), "dead");
  });

  test("an expired lease on the last attempt is dead-lettered, not run again", (t) => {
    if (!ready(t)) return;
    const [id] = enqueue("lastlease-1", "test.lastlease", ", NULL, now(), 1").split("|");
    claim("r1");
    rows(`UPDATE public.jobs SET locked_until = now() - interval '1 second' WHERE id = '${id}';`);
    assert.deepEqual(
      claim("r2").filter((r) => r.startsWith(id!)),
      [],
    );
    assert.equal(statusOf(id!), "dead|1");
  });

  test("a dead job can be requeued; a live one cannot", (t) => {
    if (!ready(t)) return;
    const [id] = enqueue("requeue-1", "test.requeue", ", NULL, now(), 1").split("|");
    claim("r1");
    one(`SELECT public.fail_job('${id}', 'r1', 'x', true);`);
    assert.equal(one(`SELECT public.requeue_dead_job('${id}');`), "t");
    assert.equal(statusOf(id!), "queued|0");
    assert.equal(one(`SELECT public.requeue_dead_job('${id}');`), "f");
  });

  test("future jobs wait; stats report dead letters and due age; prune removes only old successes", (t) => {
    if (!ready(t)) return;
    const [future] = enqueue("future-1", "test.future", ", NULL, now() + interval '1 hour'").split(
      "|",
    );
    assert.deepEqual(
      claim("r1", 100).filter((r) => r.startsWith(future!)),
      [],
    );
    const stats = asService(
      `SELECT kind || '|' || status || '|' || jobs FROM public.job_queue_stats() WHERE status = 'dead' ORDER BY 1;`,
    );
    assert.ok(stats.some((s) => s.startsWith("test.retry|dead|")));
    const [old] = enqueue("prune-1", "test.prune").split("|");
    assert.ok(claim("pruner", 100).some((r) => r.startsWith(old!)));
    assert.equal(one(`SELECT public.complete_job('${old}', 'pruner', NULL);`), "t");
    rows(`UPDATE public.jobs SET completed_at = now() - interval '8 days' WHERE id = '${old}';`);
    assert.equal(one(`SELECT public.prune_jobs();`), "1", "only the 8-day-old success");
    assert.deepEqual(rows(`SELECT count(*) FROM public.jobs WHERE id = '${old}';`), ["0"]);
    assert.deepEqual(rows(`SELECT (count(*) >= 3)::text FROM public.jobs WHERE status = 'dead';`), [
      "true",
    ]);
  });

  test("customers have no access to the queue or its functions", (t) => {
    if (!ready(t)) return;
    for (const sql of [
      `SELECT * FROM public.jobs;`,
      `SELECT * FROM public.enqueue_job('x.y', '{}', 'k');`,
      `SELECT * FROM public.claim_jobs('w', 1, 60);`,
    ]) {
      const r = execSql!(`SET ROLE authenticated;\n${sql}`);
      assert.notEqual(r.status, 0, sql);
      assert.match(r.stderr, /permission denied/);
    }
  });
});
