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
 * REAL-PostgreSQL coverage for 20261122090000_campaign_retry_limits.sql (GATE
 * C4 finding H1): a campaign may retry only unanswered attempts (no_answer,
 * busy, failed), at least 15 minutes and at most 7 days apart; the migration
 * is re-runnable and its rollback removes exactly the two constraints.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261122090000_campaign_retry_limits.sql";
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const ROLLBACK = readFileSync(
  join(migrationsDir, "../../docs/production-rollback-20261122090000-campaign-retry-limits.sql"),
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
const ORG = randomUUID();

function ready(t: TestContext): boolean {
  if (setupFailure) assert.fail(setupFailure);
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}

/** Inserts a draft campaign, optionally with one retry setting; the INSERT's result. */
function insertCampaign(column?: string, value?: string): RunResult {
  const extra = column ? `, ${column}` : "";
  const extraValue = column ? `, ${value}` : "";
  return execSql!(
    `INSERT INTO public.campaigns (id, organization_id, name${extra})
     VALUES ('${randomUUID()}', '${ORG}', 'C'${extraValue});`,
  );
}
const refused = (r: RunResult, constraint: string) =>
  r.status !== 0 && r.stderr.includes(constraint);

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
  const seed = execSql(`INSERT INTO auth.users (id) VALUES ('${OWNER}');
    INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG}', 'Shop', '${OWNER}');`);
  if (seed.status !== 0) {
    setupFailure = `seed failed: ${seed.stderr}`;
    return;
  }
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

describe("campaign retry limits", () => {
  test("the defaults and every safe setting are accepted", (t) => {
    if (!ready(t)) return;
    const defaults = insertCampaign();
    assert.equal(defaults.status, 0, defaults.stderr);
    for (const [column, value] of [
      ["retry_statuses", "ARRAY['no_answer']::text[]"],
      ["retry_statuses", "ARRAY[]::text[]"],
      ["retry_after_minutes", "15"],
      ["retry_after_minutes", "10080"],
    ] as const) {
      const r = insertCampaign(column, value);
      assert.equal(r.status, 0, `${column}=${value}: ${r.stderr}`);
    }
  });

  test("a completed, cancelled or unknown status can never be retried", (t) => {
    if (!ready(t)) return;
    for (const status of ["completed", "cancelled", "opted_out", "anything"])
      assert.ok(
        refused(
          insertCampaign("retry_statuses", `ARRAY['no_answer', '${status}']::text[]`),
          "campaigns_retry_statuses_allowed",
        ),
        status,
      );
  });

  test("a retry waits at least 15 minutes and at most 7 days", (t) => {
    if (!ready(t)) return;
    for (const minutes of [-60, 0, 14, 10081])
      assert.ok(
        refused(
          insertCampaign("retry_after_minutes", String(minutes)),
          "campaigns_retry_after_minutes_range",
        ),
        String(minutes),
      );
  });

  test("an existing campaign cannot be changed to unsafe settings either", (t) => {
    if (!ready(t)) return;
    const id = randomUUID();
    assert.equal(
      execSql!(
        `INSERT INTO public.campaigns (id, organization_id, name) VALUES ('${id}', '${ORG}', 'C');`,
      ).status,
      0,
    );
    assert.ok(
      refused(
        execSql!(
          `UPDATE public.campaigns SET retry_statuses = ARRAY['completed']::text[] WHERE id = '${id}';`,
        ),
        "campaigns_retry_statuses_allowed",
      ),
    );
    assert.ok(
      refused(
        execSql!(`UPDATE public.campaigns SET retry_after_minutes = 1 WHERE id = '${id}';`),
        "campaigns_retry_after_minutes_range",
      ),
    );
  });
});

describe("rollback", () => {
  test("removes exactly the two constraints; re-applying restores them", (t) => {
    if (!ready(t)) return;
    const constraints = () =>
      execSql!(`SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.campaigns'::regclass
                  AND conname IN ('campaigns_retry_statuses_allowed', 'campaigns_retry_after_minutes_range');`)
        .stdout.split("\n")
        .map((l) => l.trim())
        .filter((l) => /^\d+$/.test(l));
    assert.deepEqual(constraints(), ["2"]);
    const r = execSql!(ROLLBACK);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(constraints(), ["0"]);
    const again = execSql!(
      `BEGIN;\n${readFileSync(join(migrationsDir, MIGRATION), "utf8")}\nCOMMIT;`,
    );
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(constraints(), ["2"]);
  });
});
