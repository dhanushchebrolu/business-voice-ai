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
 * Who may change which bot answers a WhatsApp number, enforced by the
 * database itself (a browser can call PostgREST directly, bypassing the
 * dashboard's server functions).
 *
 * Replays every migration in order on a disposable cluster with the same
 * production-like privileges as server_role_grants.pg.test.ts (no default
 * privileges, so only explicit grants count), reproduces the gap just
 * before 20261026090000 (a viewer repoints the bot), then checks the fix as
 * real `authenticated` users with their own JWT subject.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const FIX = "20261026090000_whatsapp_connection_manager_policy.sql";
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();

const STANDIN_NO_DEFAULT_PRIVILEGES = `
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

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const BIZ = randomUUID();
const OTHER_BIZ = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const CONN = randomUUID();
const OTHER_CONN = randomUUID();
const USERS = {
  owner: randomUUID(),
  admin: randomUUID(),
  manager: randomUUID(),
  staff: randomUUID(),
  viewer: randomUUID(),
  otherOwner: randomUUID(),
};

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregister: (() => void) | null = null;
/** Rows a viewer changed with a direct UPDATE just BEFORE the fix migration. */
let preFixViewerUpdate: string[] | null = null;

const sql = (statement: string): RunResult => execSql!(statement);

/** Runs `statement` as an authenticated browser user (their JWT subject) and returns the RETURNING ids. */
function asUser(
  userId: string,
  statement: string,
): { status: number; ids: string[]; stderr: string } {
  const r = sql(`\\pset format unaligned
\\pset tuples_only on
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '${userId}', true) \\g /dev/null
${statement}
COMMIT;`);
  return {
    status: r.status,
    stderr: r.stderr,
    ids: r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[0-9a-f-]{36}$/.test(l)),
  };
}

const setBot = (connectionId: string, agentId: string | null) =>
  `UPDATE public.whatsapp_connections SET agent_config_id = ${agentId ? `'${agentId}'` : "NULL"}
   WHERE id = '${connectionId}' RETURNING id;`;

function botOf(connectionId: string): string {
  const r = sql(`\\pset format unaligned
\\pset tuples_only on
SELECT coalesce(agent_config_id::text, 'none') FROM public.whatsapp_connections WHERE id = '${connectionId}';`);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n").pop()!.trim();
}

before(() => {
  const result = bootstrapCluster();
  if (!result.ok) {
    skipReason = result.reason;
    return;
  }
  cluster = result.cluster;
  execSql = makeExecSql(cluster);
  unregister = registerSignalCleanup(() => cluster);

  const standin = sql(STANDIN_NO_DEFAULT_PRIVILEGES);
  if (standin.status !== 0) {
    setupFailure = `stand-in failed: ${standin.stderr}`;
    return;
  }
  for (const file of MIGRATIONS) {
    if (file === FIX) {
      const members = Object.entries({
        owner: [ORG, "owner"],
        admin: [ORG, "admin"],
        manager: [ORG, "manager"],
        staff: [ORG, "staff"],
        viewer: [ORG, "viewer"],
        otherOwner: [OTHER_ORG, "owner"],
      } as const)
        .map(([k, [org, role]]) => `('${org}', '${USERS[k as keyof typeof USERS]}', '${role}')`)
        .join(", ");
      const seed = sql(`
        INSERT INTO public.organizations (id, name, owner_id) VALUES
          ('${ORG}', 'Smile Dental', '${USERS.owner}'), ('${OTHER_ORG}', 'Other Clinic', '${USERS.otherOwner}');
        INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ${members};
        INSERT INTO public.businesses (id, organization_id, name, timezone) VALUES
          ('${BIZ}', '${ORG}', 'Smile Dental', 'Asia/Kolkata'),
          ('${OTHER_BIZ}', '${OTHER_ORG}', 'Other Clinic', 'Asia/Kolkata');
        INSERT INTO public.agent_configs (id, organization_id, business_id) VALUES
          ('${AGENT}', '${ORG}', '${BIZ}'), ('${OTHER_AGENT}', '${OTHER_ORG}', '${OTHER_BIZ}');
        INSERT INTO public.whatsapp_connections (id, organization_id, business_id, waba_id, phone_number_id, status) VALUES
          ('${CONN}', '${ORG}', '${BIZ}', 'waba-a', 'pn-a', 'connected'),
          ('${OTHER_CONN}', '${OTHER_ORG}', '${OTHER_BIZ}', 'waba-b', 'pn-b', 'connected');`);
      if (seed.status !== 0) {
        setupFailure = `seed failed: ${seed.stderr}`;
        return;
      }
      const pre = asUser(USERS.viewer, setBot(CONN, AGENT));
      if (pre.status !== 0) {
        setupFailure = `pre-fix viewer update errored: ${pre.stderr}`;
        return;
      }
      preFixViewerUpdate = pre.ids;
      sql(`UPDATE public.whatsapp_connections SET agent_config_id = NULL WHERE id = '${CONN}';`);
    }
    const applied = sql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  if (!preFixViewerUpdate) setupFailure = `fix migration ${FIX} not found`;
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

describe("before 20261026090000", () => {
  pgTest("a read-only viewer could repoint the bot with a direct REST update", () => {
    assert.deepEqual(preFixViewerUpdate, [CONN]);
  });
});

describe("after 20261026090000", () => {
  pgTest("owners and admins can assign and clear their own connection's bot", () => {
    assert.deepEqual(asUser(USERS.owner, setBot(CONN, AGENT)).ids, [CONN]);
    assert.equal(botOf(CONN), AGENT);
    assert.deepEqual(asUser(USERS.admin, setBot(CONN, null)).ids, [CONN]);
    assert.equal(botOf(CONN), "none");
  });

  pgTest("manager, staff and viewer updates match no row and change nothing", () => {
    for (const user of [USERS.manager, USERS.staff, USERS.viewer]) {
      const r = asUser(user, setBot(CONN, AGENT));
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.ids, []);
    }
    assert.equal(botOf(CONN), "none");
  });

  pgTest("another tenant's owner can't touch this connection", () => {
    const r = asUser(USERS.otherOwner, setBot(CONN, OTHER_AGENT));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.ids, []);
    assert.equal(botOf(CONN), "none");
  });

  pgTest("an owner still can't attach another organization's bot (20261019090000 trigger)", () => {
    const r = asUser(USERS.owner, setBot(CONN, OTHER_AGENT));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /WHATSAPP_AGENT_NOT_IN_ORGANIZATION/);
    assert.equal(botOf(CONN), "none");
  });

  pgTest("browsers still can't write any other column, even as owner", () => {
    const r = asUser(
      USERS.owner,
      `UPDATE public.whatsapp_connections SET status = 'disconnected' WHERE id = '${CONN}' RETURNING id;`,
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /permission denied/);
  });

  pgTest("re-applying the migration is a no-op", () => {
    const again = sql(`BEGIN;\n${readFileSync(join(migrationsDir, FIX), "utf8")}\nCOMMIT;`);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(asUser(USERS.viewer, setBot(CONN, AGENT)).ids, []);
  });
});
