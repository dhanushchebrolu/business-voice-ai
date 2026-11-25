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

/** call_analyses (20261201100000) on a real PostgreSQL, replayed after every earlier migration. */
const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const THIS = "20261201100000_call_analyses.sql";

const STANDIN = `
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
let unregister: (() => void) | null = null;
const ORG = randomUUID();
const CALL = randomUUID();

function pgTest(name: string, fn: () => void) {
  test(name, (t: TestContext) => {
    if (setupFailure) assert.fail(setupFailure);
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    fn();
  });
}

const insert = (o: { call?: string; status?: string; source?: string; analysis?: string } = {}) =>
  `INSERT INTO public.call_analyses (organization_id, call_id, status, source, analysis)
   VALUES ('${ORG}', '${o.call ?? CALL}', '${o.status ?? "done"}', '${o.source ?? "ai"}', '${o.analysis ?? "{}"}'::jsonb);`;
const run = (sql: string) => execSql!(sql);
const count = () => {
  const r = run(
    `\\pset format unaligned\n\\pset tuples_only on\nSELECT count(*) FROM public.call_analyses;`,
  );
  return Number(r.stdout.split("\n").find((l) => /^\d+$/.test(l.trim())));
};

before(() => {
  const result = bootstrapCluster();
  if (!result.ok) {
    skipReason = result.reason;
    return;
  }
  cluster = result.cluster;
  execSql = makeExecSql(cluster);
  unregister = registerSignalCleanup(() => cluster);
  const standin = execSql(STANDIN);
  if (standin.status !== 0) {
    setupFailure = `stand-in failed: ${standin.stderr}`;
    return;
  }
  for (const file of MIGRATIONS) {
    const applied = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  const seed = execSql(`
    INSERT INTO public.organizations (id, name, owner_id) VALUES ('${ORG}', 'Clinic', '${randomUUID()}');
    INSERT INTO public.call_logs (id, organization_id, provider, direction, status, started_at)
      VALUES ('${CALL}', '${ORG}', 'sarvam', 'outbound', 'completed', now());`);
  if (seed.status !== 0) setupFailure = `seed failed: ${seed.stderr}`;
});

after(() => {
  unregister?.();
  if (cluster) teardownCluster(cluster);
});

describe("call_analyses", () => {
  pgTest("one analysis per call: a second insert for the same call is refused", () => {
    assert.equal(run(insert()).status, 0);
    const again = run(insert({ status: "pending_ai", source: "rules" }));
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /call_analyses_one_per_call|duplicate key/);
    assert.equal(count(), 1);
  });

  pgTest("only the known statuses and sources are accepted", () => {
    const other = randomUUID();
    run(
      `INSERT INTO public.call_logs (id, organization_id, provider, direction, status, started_at) VALUES ('${other}', '${ORG}', 'sarvam', 'outbound', 'completed', now());`,
    );
    for (const status of ["done", "pending_ai", "no_transcript", "failed"]) {
      const id = randomUUID();
      run(
        `INSERT INTO public.call_logs (id, organization_id, provider, direction, status, started_at) VALUES ('${id}', '${ORG}', 'sarvam', 'outbound', 'completed', now());`,
      );
      assert.equal(run(insert({ call: id, status })).status, 0, status);
    }
    assert.notEqual(run(insert({ call: other, status: "analysed" })).status, 0);
    assert.notEqual(run(insert({ call: other, source: "guess" })).status, 0);
  });

  pgTest("an analysis belongs to its call: deleting the call removes it", () => {
    const id = randomUUID();
    run(
      `INSERT INTO public.call_logs (id, organization_id, provider, direction, status, started_at) VALUES ('${id}', '${ORG}', 'sarvam', 'outbound', 'completed', now());`,
    );
    run(insert({ call: id }));
    const before = count();
    assert.equal(run(`DELETE FROM public.call_logs WHERE id = '${id}';`).status, 0);
    assert.equal(count(), before - 1);
  });

  pgTest("browser roles have no access; the server role can read and write", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const sql of [
        "SELECT * FROM public.call_analyses",
        `INSERT INTO public.call_analyses (organization_id, call_id, status, source, analysis) VALUES ('${ORG}', '${randomUUID()}', 'done', 'ai', '{}'::jsonb)`,
        "UPDATE public.call_analyses SET status = 'done'",
        "DELETE FROM public.call_analyses",
      ]) {
        const r = run(`SET ROLE ${role};\n${sql};`);
        assert.notEqual(r.status, 0, `${role}: ${sql}`);
        assert.match(r.stderr, /permission denied/i);
      }
    }
    assert.equal(run(`SET ROLE service_role;\nSELECT * FROM public.call_analyses;`).status, 0);
    assert.equal(
      run(
        `SET ROLE service_role;\nUPDATE public.call_analyses SET attempts = attempts WHERE false;`,
      ).status,
      0,
    );
  });

  pgTest("row level security is on, so no future grant exposes it by accident", () => {
    const r = run(
      `\\pset format unaligned\n\\pset tuples_only on\nSELECT relrowsecurity FROM pg_class WHERE oid = 'public.call_analyses'::regclass;`,
    );
    assert.match(r.stdout, /^t$/m);
  });

  pgTest("re-applying the migration is harmless", () => {
    const again = run(`BEGIN;\n${readFileSync(join(migrationsDir, THIS), "utf8")}\nCOMMIT;`);
    assert.equal(again.status, 0, again.stderr);
  });
});
