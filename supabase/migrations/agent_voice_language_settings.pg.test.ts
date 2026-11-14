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

/**
 * REAL-PostgreSQL coverage for 20261114090000_agent_voice_language_settings.sql:
 * the language policy, one row per agent, the same-org guard, the applied
 * state needing a version, and customers reading only their own row.
 */

const OWNER = randomUUID();
const OTHER_USER = randomUUID();
const SMILE = randomUUID();
const ABC = randomUUID();
const SMILE_AGENT = randomUUID();
const ABC_AGENT = randomUUID();
const VOICE = "01a0cf16-897b-76f8-8de9-34f27e861df6";

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
  for (const file of [...MIGRATION_FILES, "20261114090000_agent_voice_language_settings.sql"]) {
    // The new migration is applied twice: it must be re-runnable.
    const applied = execSql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  const seed = execSql(`
    INSERT INTO auth.users (id) VALUES ('${OWNER}'), ('${OTHER_USER}');
    INSERT INTO public.organizations (id, name, owner_id) VALUES
      ('${SMILE}', 'Smile Dental', '${OWNER}'), ('${ABC}', 'ABC Dental', '${OTHER_USER}');
    INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
      ('${SMILE}', '${OWNER}', 'owner'), ('${ABC}', '${OTHER_USER}', 'owner')
      ON CONFLICT DO NOTHING;
    INSERT INTO public.businesses (id, organization_id, name) VALUES
      ('${SMILE}', '${SMILE}', 'Smile Dental'), ('${ABC}', '${ABC}', 'ABC Dental');
    INSERT INTO public.agent_configs (id, organization_id, business_id) VALUES
      ('${SMILE_AGENT}', '${SMILE}', '${SMILE}'), ('${ABC_AGENT}', '${ABC}', '${ABC}');
  `);
  if (seed.status !== 0) setupFailure = `seed failed: ${seed.stderr}`;
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

const insert = (org: string, agent: string, def: string, langs: string[]) =>
  `INSERT INTO public.agent_voice_language_settings
     (organization_id, agent_config_id, default_language, allowed_languages, sarvam_voice_internal_id, sarvam_voice_name)
   VALUES ('${org}', '${agent}', '${def}', ARRAY[${langs.map((l) => `'${l}'`).join(",")}]::text[], '${VOICE}', 'Kavitha');`;

describe("agent_voice_language_settings", () => {
  test("enforces default + English + Hindi, known languages and at most five", (t) => {
    if (!ready(t)) return;
    fails(
      insert(SMILE, SMILE_AGENT, "Telugu", ["Telugu", "English"]),
      /agent_voice_language_policy/,
    );
    fails(
      insert(SMILE, SMILE_AGENT, "Tamil", ["Telugu", "English", "Hindi"]),
      /agent_voice_language_policy/,
    );
    fails(
      insert(SMILE, SMILE_AGENT, "Telugu", ["Telugu", "English", "Hindi", "Urdu"]),
      /known_languages/,
    );
    fails(
      insert(SMILE, SMILE_AGENT, "Telugu", [
        "Telugu",
        "English",
        "Hindi",
        "Tamil",
        "Kannada",
        "Odia",
      ]),
      /agent_voice_language_policy/,
    );
    rows(insert(SMILE, SMILE_AGENT, "Telugu", ["Telugu", "English", "Hindi", "Tamil", "Assamese"]));
    fails(insert(SMILE, SMILE_AGENT, "Telugu", ["Telugu", "English", "Hindi"]), /duplicate key/);
  });

  test("a row may only point at an agent of its own organization", (t) => {
    if (!ready(t)) return;
    fails(
      insert(SMILE, ABC_AGENT, "Hindi", ["Hindi", "English"]),
      /VOICE_LANGUAGE_AGENT_ORG_MISMATCH/,
    );
    rows(insert(ABC, ABC_AGENT, "Hindi", ["Hindi", "English"]));
  });

  test("applied needs the Sarvam version and time", (t) => {
    if (!ready(t)) return;
    fails(
      `UPDATE public.agent_voice_language_settings SET status = 'applied' WHERE agent_config_id = '${SMILE_AGENT}';`,
      /applied_complete/,
    );
    rows(
      `UPDATE public.agent_voice_language_settings SET status = 'applied', applied_sarvam_app_version = 6, applied_at = now()
        WHERE agent_config_id = '${SMILE_AGENT}';`,
    );
  });

  test("customers read only their own row and cannot write", (t) => {
    if (!ready(t)) return;
    const asUser = (user: string, sql: string) =>
      execSql!(
        `\\pset format unaligned\n\\pset tuples_only on\nSET ROLE authenticated;\nSET request.jwt.claim.sub = '${user}';\n${sql}`,
      );
    const r = asUser(OWNER, `SELECT organization_id FROM public.agent_voice_language_settings;`);
    assert.equal(r.status, 0, r.stderr);
    const seen = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f-]{36}$/.test(l));
    assert.deepEqual(seen, [SMILE]);
    const w = asUser(
      OWNER,
      `UPDATE public.agent_voice_language_settings SET default_language = 'English' WHERE organization_id = '${SMILE}';`,
    );
    assert.notEqual(w.status, 0);
    assert.match(w.stderr, /permission denied/);
    const anon = execSql!(`SET ROLE anon;\nSELECT * FROM public.agent_voice_language_settings;`);
    assert.notEqual(anon.status, 0);
  });
});
