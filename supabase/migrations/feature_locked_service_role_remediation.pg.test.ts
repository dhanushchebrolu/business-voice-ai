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
 * supabase/remediation/grant_feature_locked_execute_to_service_role.sql on
 * a disposable cluster: every migration replayed with production-like
 * privileges (no default privileges — production returned
 * has_function_privilege('service_role', feature_locked) = false), then:
 *   - before: the service role is denied (the inbound-call gate's failure);
 *   - after: it gets exactly the function's own answers — locked stays
 *     locked, unlocked stays unlocked (billing enforcement unchanged);
 *   - nothing else changes: anon / PUBLIC stay revoked, authenticated keeps
 *     EXECUTE, no other grant is added;
 *   - re-running is a no-op, and the preflight refuses (changing nothing)
 *     if the function is no longer SECURITY DEFINER.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const REMEDIATION = join(
  migrationsDir,
  "..",
  "remediation",
  "grant_feature_locked_execute_to_service_role.sql",
);
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
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
`;

const OWNER = randomUUID();
const ACTIVE = randomUUID();
const SUSPENDED = randomUUID();
const LOCKED = randomUUID();
const NOT_ACTIVE = randomUUID();
const ORGS = [ACTIVE, SUSPENDED, LOCKED, NOT_ACTIVE];
const FEATURES = ["phone", "whatsapp", "voice", "dashboard"];

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregister: (() => void) | null = null;

const sql = (statement: string): RunResult => execSql!(statement);
const value = (statement: string) => {
  const r = sql(`\\pset format unaligned\n\\pset tuples_only on\n${statement}`);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n").pop()!.trim();
};
const asRole = (role: string, statement: string) =>
  sql(`\\pset format unaligned
\\pset tuples_only on
BEGIN;
SET LOCAL ROLE ${role};
SELECT set_config('request.jwt.claim.sub', '${OWNER}', true) \\g /dev/null
${statement}
COMMIT;`);
const lockedAs = (role: string, org: string, feature: string) =>
  asRole(role, `SELECT public.feature_locked('${org}', '${feature}');`);
const answer = (r: RunResult) => r.stdout.trim().split("\n").pop()!.trim();
const acl = () =>
  value(
    `SELECT proacl::text FROM pg_proc WHERE oid = 'public.feature_locked(uuid,text)'::regprocedure;`,
  );
const tableGrants = () =>
  value(`SELECT coalesce(string_agg(grantee || ':' || table_name || ':' || privilege_type, ',' ORDER BY 1), '')
           FROM information_schema.role_table_grants
          WHERE table_name IN ('organizations', 'organization_feature_locks',
                               'organization_entitlements', 'platform_settings');`);
const remediate = () => sql(readFileSync(REMEDIATION, "utf8"));

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
  for (const file of MIGRATIONS) {
    const applied = sql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  const seed = sql(`
    INSERT INTO public.organizations (id, name, owner_id, lifecycle_status) VALUES
      ('${ACTIVE}', 'Active', '${OWNER}', 'active'),
      ('${SUSPENDED}', 'Suspended', '${OWNER}', 'suspended'),
      ('${LOCKED}', 'Admin-locked', '${OWNER}', 'active'),
      ('${NOT_ACTIVE}', 'Not provisioned', '${OWNER}', 'not_provisioned');
    INSERT INTO public.organization_feature_locks (organization_id, feature, locked)
      VALUES ('${LOCKED}', 'phone', true);`);
  if (seed.status !== 0) setupFailure = `seed failed: ${seed.stderr}`;
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

describe("feature_locked EXECUTE for service_role (remediation script)", () => {
  let aclBefore = "";
  let tablesBefore = "";
  let ownerAnswers: Record<string, string> = {};

  pgTest(
    "the function is what the script expects (schema, signature, SECURITY DEFINER, search_path)",
    () => {
      assert.equal(
        value(`SELECT p.prosecdef || '/' || pg_get_function_result(p.oid) || '/' || array_to_string(p.proconfig, ',')
               FROM pg_proc p WHERE p.oid = 'public.feature_locked(uuid,text)'::regprocedure;`),
        "true/boolean/search_path=public",
      );
    },
  );

  pgTest(
    "before: the service role is denied (what production reports), as checkTelephonyAccess sees it",
    () => {
      aclBefore = acl();
      tablesBefore = tableGrants();
      assert.equal(
        value(
          `SELECT has_function_privilege('service_role', 'public.feature_locked(uuid,text)', 'EXECUTE');`,
        ),
        "f",
      );
      const r = lockedAs("service_role", ACTIVE, "phone");
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /permission denied for function feature_locked/);
      ownerAnswers = {};
      for (const org of ORGS)
        for (const feature of FEATURES)
          ownerAnswers[`${org}/${feature}`] = value(
            `SELECT public.feature_locked('${org}', '${feature}');`,
          );
    },
  );

  pgTest("the remediation applies", () => {
    const r = remediate();
    assert.equal(r.status, 0, r.stderr);
  });

  pgTest(
    "after: the service role gets exactly the function's own answers (enforcement unchanged)",
    () => {
      for (const org of ORGS) {
        for (const feature of FEATURES) {
          const r = lockedAs("service_role", org, feature);
          assert.equal(r.status, 0, r.stderr);
          assert.equal(answer(r), ownerAnswers[`${org}/${feature}`], `${org}/${feature}`);
        }
      }
      // Locked stays locked, unlocked stays unlocked.
      assert.equal(answer(lockedAs("service_role", SUSPENDED, "phone")), "t");
      assert.equal(answer(lockedAs("service_role", LOCKED, "phone")), "t");
      assert.equal(answer(lockedAs("service_role", NOT_ACTIVE, "phone")), "t");
    },
  );

  pgTest(
    "nothing else changes: authenticated keeps it, anon and PUBLIC stay revoked, only service_role is added",
    () => {
      const privilege = (role: string) =>
        value(
          `SELECT has_function_privilege('${role}', 'public.feature_locked(uuid,text)', 'EXECUTE');`,
        );
      assert.equal(privilege("service_role"), "t");
      assert.equal(privilege("authenticated"), "t");
      assert.equal(privilege("anon"), "f");
      const r = asRole("anon", `SELECT public.feature_locked('${ACTIVE}', 'phone');`);
      assert.match(r.stderr, /permission denied for function feature_locked/);
      const after = acl();
      assert.match(after, /service_role=X\//);
      assert.doesNotMatch(after, /(^|[{,])=X\//, "no PUBLIC grant");
      assert.equal(
        after.replace(/,?service_role=X\/[^,}]+/, ""),
        aclBefore,
        "the only ACL change is service_role's EXECUTE",
      );
      // No table privilege changed (the function reads them as its owner).
      assert.equal(tableGrants(), tablesBefore);
    },
  );

  pgTest("re-running is a no-op", () => {
    const before = acl();
    const r = remediate();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(acl(), before);
  });

  pgTest(
    "the preflight refuses, changing nothing, if the function is no longer SECURITY DEFINER",
    () => {
      const r = sql(`BEGIN;
REVOKE EXECUTE ON FUNCTION public.feature_locked(uuid, text) FROM service_role;
ALTER FUNCTION public.feature_locked(uuid, text) SECURITY INVOKER;
COMMIT;`);
      assert.equal(r.status, 0, r.stderr);
      const refused = remediate();
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /not SECURITY DEFINER/);
      assert.equal(
        value(
          `SELECT has_function_privilege('service_role', 'public.feature_locked(uuid,text)', 'EXECUTE');`,
        ),
        "f",
      );
      // Restore for any later test in this file.
      assert.equal(
        sql(`ALTER FUNCTION public.feature_locked(uuid, text) SECURITY DEFINER;`).status,
        0,
      );
    },
  );
});
