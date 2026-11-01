import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
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
 * supabase/remediation/readonly_production_checks.sql must run cleanly
 * against the schema production has today — migrations up to and including
 * 20261022090000 (20261026–20261028 are not applied there; 20261025's
 * contents are unknown and not in this repository) — and must not be able
 * to change anything.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const CHECKS = join(migrationsDir, "..", "remediation", "readonly_production_checks.sql");
const PRODUCTION_LIKE = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .filter((f) => f.slice(0, 14) <= "20261022090000")
  .sort();

const STANDIN = `
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
-- The Supabase CLI's history table, as production has it.
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
`;

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregister: (() => void) | null = null;
const sql = (statement: string): RunResult => execSql!(statement);
const checks = readFileSync(CHECKS, "utf8");

before(() => {
  const result = bootstrapCluster();
  if (!result.ok) {
    skipReason = result.reason;
    return;
  }
  cluster = result.cluster;
  execSql = makeExecSql(cluster);
  unregister = registerSignalCleanup(() => cluster);
  const standin = sql(STANDIN);
  if (standin.status !== 0) {
    setupFailure = `stand-in failed: ${standin.stderr}`;
    return;
  }
  for (const file of PRODUCTION_LIKE) {
    const applied = sql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
});

after(() => {
  unregister?.();
  if (cluster) teardownCluster(cluster);
});

function pgTest(name: string, fn: (t: TestContext) => void | Promise<void>) {
  test(name, async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    if (setupFailure) {
      assert.fail(`PostgreSQL is available, but setup failed — a real failure: ${setupFailure}`);
    }
    await fn(t);
  });
}

describe("read-only production checks", () => {
  test("the file contains no write or DDL statement and ends in ROLLBACK", () => {
    const code = checks.replace(/--.*$/gm, "");
    assert.match(code, /^\s*BEGIN READ ONLY;/m);
    assert.match(code, /ROLLBACK;\s*$/);
    assert.doesNotMatch(
      code,
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COMMIT|COPY|VACUUM|REINDEX|CALL|DO)\b/i,
    );
  });

  pgTest("every query runs against the production-like schema (migrations ≤ 20261022)", () => {
    const r = sql(checks);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ERROR/);
  });

  pgTest(
    "B11 finds two organizations' live orders for one number — the data that makes 20261028 fail to apply",
    () => {
      // B11's own text, exactly as an operator would run it.
      const b11 =
        /-- B11\.[\s\S]*?(SELECT CASE WHEN[\s\S]*?AS duplicate_live_orders_per_number;)/.exec(
          checks,
        )?.[1];
      assert.ok(b11, "B11 is in the checks file");
      const migration = (prefix: string) => {
        const file = readdirSync(migrationsDir).find(
          (f) => f.startsWith(prefix) && f.endsWith(".sql"),
        );
        assert.ok(file, `migration ${prefix} exists`);
        return readFileSync(join(migrationsDir, file), "utf8");
      };
      const [orgA, orgB, owner] = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
      ];
      // Everything below runs in one transaction that is rolled back, so the
      // shared production-like schema is left exactly as it was.
      const setup = `
      ${migration("20261026090000")}
      ${migration("20261027090000")}
      INSERT INTO public.organizations (id, name, owner_id) VALUES
        ('${orgA}', 'Clinic A', '${owner}'), ('${orgB}', 'Clinic B', '${owner}');
      INSERT INTO public.whatsapp_number_orders (organization_id, phone_number, status) VALUES
        ('${orgA}', '+919876500001', 'completed'), ('${orgB}', '+919876500001', 'pending');`;
      const detected = sql(`BEGIN;\n${setup}\n${b11}\nROLLBACK;`);
      assert.equal(detected.status, 0, detected.stderr);
      assert.match(detected.stdout, /\+919876500001/, "B11 names the number");
      assert.match(detected.stdout, /<live_orders>2<\/live_orders>/);
      assert.match(detected.stdout, /<organizations>2<\/organizations>/);

      // And this is exactly the state in which 20261028 cannot be applied.
      const apply = sql(`BEGIN;\n${setup}\n${migration("20261028090000")}\nROLLBACK;`);
      assert.notEqual(apply.status, 0, "20261028 must fail on duplicate live orders");
      assert.match(
        apply.stderr,
        /idx_whatsapp_number_orders_one_live_number|could not create unique index/,
      );

      // Clean data: B11 reports nothing.
      const clean = sql(
        `BEGIN;\n${migration("20261026090000")}\n${migration("20261027090000")}\n${b11}\nROLLBACK;`,
      );
      assert.equal(clean.status, 0, clean.stderr);
      assert.doesNotMatch(clean.stdout, /<row>/);
    },
  );

  pgTest("the transaction refuses writes", () => {
    const r = sql(
      `BEGIN READ ONLY; UPDATE public.organizations SET name = name WHERE false; ROLLBACK;`,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /read-only transaction/);
  });
});
