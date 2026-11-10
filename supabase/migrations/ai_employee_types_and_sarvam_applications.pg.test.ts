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
 * REAL-PostgreSQL coverage for
 * 20261111090000_ai_employee_types_and_sarvam_applications.sql: employee
 * types, shared vs dedicated Sarvam application templates, and that the
 * old one-app-per-agent rule still holds for direct mappings.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = "20261111090000_ai_employee_types_and_sarvam_applications.sql";
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

const OWNER = randomUUID();
const ORGS = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const AGENTS = ORGS.map(() => randomUUID());
const SHARED = randomUUID();
const DEDICATED = randomUUID();

function rows(sql: string): string[] {
  const result = execSql!(`\\pset format unaligned\n\\pset tuples_only on\n${sql}`);
  if (result.status !== 0) throw new Error(`SQL failed: ${result.stderr}\n${sql}`);
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only"));
}

function fails(sql: string, pattern: RegExp) {
  const r = execSql!(sql);
  assert.notEqual(r.status, 0, `expected failure: ${sql}`);
  assert.match(r.stderr, pattern);
}

function ready(t: TestContext): boolean {
  if (setupFailure) assert.fail(setupFailure);
  if (skipReason) {
    t.skip(skipReason);
    return false;
  }
  return true;
}

const mapTemplate = (agent: string, app: string | null) =>
  `UPDATE public.agent_configs SET sarvam_application_id = ${app ? `'${app}'` : "NULL"} WHERE id = '${agent}';`;

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
  const again = execSql(readFileSync(join(migrationsDir, MIGRATION), "utf8"));
  if (again.status !== 0) {
    setupFailure = `re-applying the migration failed: ${again.stderr}`;
    return;
  }
  const seed = ORGS.map((org, i) => {
    const biz = randomUUID();
    return `INSERT INTO public.organizations (id, name, owner_id) VALUES ('${org}', 'Org ${i}', '${OWNER}');
      INSERT INTO public.businesses (id, organization_id, name) VALUES ('${biz}', '${org}', 'Biz ${i}');
      INSERT INTO public.agent_configs (id, organization_id, business_id) VALUES ('${AGENTS[i]}', '${org}', '${biz}');`;
  }).join("\n");
  const seeded = execSql(`${seed}
    INSERT INTO public.sarvam_applications (id, name, employee_type, sarvam_app_id, sarvam_app_version, is_shared)
      VALUES ('${SHARED}', 'Booking', 'receptionist', 'app-booking', 3, true),
             ('${DEDICATED}', 'Custom', 'sales_executive', 'app-custom', 1, false);`);
  if (seeded.status !== 0) setupFailure = `seed failed: ${seeded.stderr}`;
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

describe("employee_type", () => {
  test("existing and new agents default to receptionist; unknown types are rejected", (t) => {
    if (!ready(t)) return;
    assert.deepEqual(
      rows(`SELECT employee_type FROM public.agent_configs WHERE id = '${AGENTS[0]}';`),
      ["receptionist"],
    );
    rows(
      `UPDATE public.agent_configs SET employee_type = 'customer_care_executive' WHERE id = '${AGENTS[0]}';`,
    );
    fails(
      `UPDATE public.agent_configs SET employee_type = 'doctor' WHERE id = '${AGENTS[0]}';`,
      /agent_configs_employee_type_check/,
    );
  });

  test("customers cannot set employee_type or the template from the browser", (t) => {
    if (!ready(t)) return;
    for (const column of [
      "employee_type = 'sales_executive'",
      `sarvam_application_id = '${SHARED}'`,
    ]) {
      fails(
        `SET ROLE authenticated;\nUPDATE public.agent_configs SET ${column} WHERE id = '${AGENTS[0]}';`,
        /permission denied/,
      );
    }
  });
});

describe("Sarvam application templates", () => {
  test("a shared template maps to several organizations and copies its app id and version", (t) => {
    if (!ready(t)) return;
    rows(mapTemplate(AGENTS[0]!, SHARED) + mapTemplate(AGENTS[1]!, SHARED));
    assert.deepEqual(
      rows(`SELECT sarvam_app_id || ' v' || sarvam_app_version FROM public.agent_configs
            WHERE sarvam_application_id = '${SHARED}' ORDER BY id;`),
      ["app-booking v3", "app-booking v3"],
    );
  });

  test("a non-shared template stays on one agent", (t) => {
    if (!ready(t)) return;
    rows(mapTemplate(AGENTS[2]!, DEDICATED));
    fails(mapTemplate(AGENTS[3]!, DEDICATED), /SARVAM_APP_ALREADY_MAPPED/);
  });

  test("a direct mapping cannot reuse a template's app, nor another agent's direct app", (t) => {
    if (!ready(t)) return;
    fails(
      `UPDATE public.agent_configs SET sarvam_app_id = 'app-booking', sarvam_app_version = 3 WHERE id = '${AGENTS[3]}';`,
      /SARVAM_APP_ALREADY_MAPPED/,
    );
    rows(mapTemplate(AGENTS[2]!, null));
    rows(
      `UPDATE public.agent_configs SET sarvam_app_id = 'app-direct', sarvam_app_version = 1 WHERE id = '${AGENTS[2]}';`,
    );
    fails(
      `UPDATE public.agent_configs SET sarvam_app_id = 'app-direct', sarvam_app_version = 1 WHERE id = '${AGENTS[3]}';`,
      /idx_agent_configs_sarvam_app_id/,
    );
  });

  test("a template in use cannot change version, be unshared or be deleted", (t) => {
    if (!ready(t)) return;
    fails(
      `UPDATE public.sarvam_applications SET sarvam_app_version = 4 WHERE id = '${SHARED}';`,
      /SARVAM_APPLICATION_IN_USE/,
    );
    fails(
      `UPDATE public.sarvam_applications SET is_shared = false WHERE id = '${SHARED}';`,
      /SARVAM_APPLICATION_IN_USE/,
    );
    fails(`DELETE FROM public.sarvam_applications WHERE id = '${SHARED}';`, /foreign key/);
  });

  test("the registry is server-only", (t) => {
    if (!ready(t)) return;
    fails(
      `SET ROLE authenticated;\nSELECT * FROM public.sarvam_applications;`,
      /permission denied/,
    );
    assert.deepEqual(
      rows(`SET ROLE service_role;\nSELECT count(*) FROM public.sarvam_applications;`),
      ["2"],
    );
  });
});
