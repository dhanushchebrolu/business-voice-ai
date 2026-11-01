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
 * Root cause of the WhatsApp onboarding billing-gate failure, on a
 * disposable cluster replaying every migration with production-like
 * privileges (no default privileges, as server_role_grants.pg.test.ts):
 *
 *   - feature_locked() is executable by `authenticated` only, so the
 *     service role (supabaseAdmin) is denied — which checkFeatureAccess
 *     reports as "Could not evaluate WhatsApp entitlement";
 *   - called as a signed-in user it answers exactly what the function
 *     answers for the organization (it is SECURITY DEFINER and ignores the
 *     caller), for locked and unlocked organizations alike.
 * whatsapp-feature-gate.server.ts therefore evaluates it with the caller's
 * own client; no new grant is needed.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
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

const ACTIVE = randomUUID();
const SUSPENDED = randomUUID();
const OWNER = randomUUID();

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregister: (() => void) | null = null;

const sql = (statement: string): RunResult => execSql!(statement);
const lockedAs = (role: string, org: string) =>
  sql(`\\pset format unaligned
\\pset tuples_only on
BEGIN;
SET LOCAL ROLE ${role};
SELECT set_config('request.jwt.claim.sub', '${OWNER}', true) \\g /dev/null
SELECT public.feature_locked('${org}', 'whatsapp');
COMMIT;`);
const answer = (r: RunResult) => r.stdout.trim().split("\n").pop()!.trim();

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
      ('${ACTIVE}', 'Smile Dental', '${OWNER}', 'active'),
      ('${SUSPENDED}', 'Suspended Clinic', '${OWNER}', 'suspended');
    INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
      ('${ACTIVE}', '${OWNER}', 'owner'), ('${SUSPENDED}', '${OWNER}', 'owner');`);
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

describe("feature_locked() and the WhatsApp onboarding gate", () => {
  pgTest("root cause: the service role cannot execute feature_locked()", () => {
    const r = lockedAs("service_role", ACTIVE);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /permission denied for function feature_locked/);
  });

  pgTest("a signed-in user gets the function's own answer, locked and unlocked", () => {
    for (const org of [ACTIVE, SUSPENDED]) {
      const asUser = lockedAs("authenticated", org);
      assert.equal(asUser.status, 0, asUser.stderr);
      const asOwnerRole = sql(
        `\\pset format unaligned\n\\pset tuples_only on\nSELECT public.feature_locked('${org}', 'whatsapp');`,
      );
      assert.equal(answer(asUser), answer(asOwnerRole), org);
    }
    assert.equal(
      answer(lockedAs("authenticated", SUSPENDED)),
      "t",
      "a suspended organization is locked",
    );
  });

  pgTest(
    "voice: the same holds for the 'phone' feature (requestPhoneNumber, checkTelephonyAccess)",
    () => {
      const asService = sql(
        `BEGIN; SET LOCAL ROLE service_role; SELECT public.feature_locked('${ACTIVE}', 'phone'); COMMIT;`,
      );
      assert.notEqual(asService.status, 0);
      assert.match(asService.stderr, /permission denied for function feature_locked/);
      const asUser = sql(`\\pset format unaligned
\\pset tuples_only on
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '${OWNER}', true) \\g /dev/null
SELECT public.feature_locked('${ACTIVE}', 'phone');
COMMIT;`);
      assert.equal(asUser.status, 0, asUser.stderr);
      assert.equal(
        answer(asUser),
        answer(
          sql(
            `\\pset format unaligned\n\\pset tuples_only on\nSELECT public.feature_locked('${ACTIVE}', 'phone');`,
          ),
        ),
      );
    },
  );

  pgTest("anonymous callers still can't evaluate it", () => {
    const r = sql(
      `BEGIN; SET LOCAL ROLE anon; SELECT public.feature_locked('${ACTIVE}', 'whatsapp'); COMMIT;`,
    );
    assert.match(r.stderr, /permission denied for function feature_locked/);
  });
});
