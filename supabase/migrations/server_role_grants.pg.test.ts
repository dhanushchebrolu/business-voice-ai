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
 * Production incident: "Failed to create OAuth state: permission denied for
 * table oauth_states" when starting a Google Calendar connection.
 *
 * The other real-PostgreSQL suites stand Supabase in with the LEGACY default
 * privileges (every new public table auto-granted to anon/authenticated/
 * service_role), which is exactly what hid this bug. This suite stands it in
 * the way this production project behaves — NO default privileges — so a
 * table only has the grants its migrations give it. It replays every
 * migration in order, reproduces the error just before the fix migration,
 * then checks the fix and the OAuth-state security properties as the real
 * database roles (service_role for the server, anon/authenticated for
 * browsers).
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const FIX = "20261013090000_grant_server_access_to_integration_tables.sql";
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();

// Supabase's roles/auth schema, WITHOUT any ALTER DEFAULT PRIVILEGES.
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

const AFFECTED = [
  "oauth_states",
  "google_calendar_connections",
  "bookings",
  "razorpay_connections",
  "payment_requests",
  "payment_webhook_events",
  "payment_domain_events",
] as const;

let cluster: Cluster | null = null;
let execSql: ((sql: string) => RunResult) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;
let unregister: (() => void) | null = null;
/** The error service_role got inserting an OAuth state BEFORE the fix migration. */
let preFixInsert: RunResult | null = null;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const OWNER = randomUUID();
const OTHER_USER = randomUUID();
const BIZ = randomUUID();

function sql(statement: string): RunResult {
  return execSql!(statement);
}

/** Unaligned, tuples-only rows. */
function rows(statement: string): string[] {
  const r = sql(`\\pset format unaligned\n\\pset tuples_only on\n${statement}`);
  if (r.status !== 0) throw new Error(`SQL failed: ${r.stderr}`);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only"));
}

const asRole = (role: string, statement: string) =>
  sql(`SET ROLE ${role};\n${statement}\nRESET ROLE;`);

/** The exact insert createOAuthState performs (oauth-state.server.ts). */
const insertState = (state: string, expiresSql = "now() + interval '10 minutes'") => `
  INSERT INTO public.oauth_states (state, provider, organization_id, business_id, user_id, redirect_to, expires_at)
  VALUES ('${state}', 'google_calendar', '${ORG}', '${BIZ}', '${OWNER}', '/app/integrations', ${expiresSql});`;

/** The exact atomic consume consumeOAuthState performs. */
const consumeState = (state: string, provider = "google_calendar") => `
  \\pset format unaligned
  \\pset tuples_only on
  UPDATE public.oauth_states SET consumed_at = now()
   WHERE state = '${state}' AND provider = '${provider}'
     AND consumed_at IS NULL AND expires_at > now()
  RETURNING organization_id || '|' || business_id || '|' || user_id || '|' || redirect_to;`;

function returned(result: RunResult): string[] {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("|"));
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
      // Reproduce the production failure with every earlier migration applied.
      const seed = sql(`
        INSERT INTO public.organizations (id, name, owner_id) VALUES
          ('${ORG}', 'Smile Dental', '${OWNER}'), ('${OTHER_ORG}', 'Other Clinic', '${OTHER_USER}');
        INSERT INTO public.organization_members (organization_id, user_id) VALUES
          ('${ORG}', '${OWNER}'), ('${OTHER_ORG}', '${OTHER_USER}');
        INSERT INTO public.businesses (id, organization_id, name, timezone)
          VALUES ('${BIZ}', '${ORG}', 'Smile Dental', 'Asia/Kolkata');`);
      if (seed.status !== 0) {
        setupFailure = `seed failed: ${seed.stderr}`;
        return;
      }
      preFixInsert = asRole("service_role", insertState("pre-fix-state"));
    }
    const applied = sql(`BEGIN;\n${readFileSync(join(migrationsDir, file), "utf8")}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  if (!preFixInsert) setupFailure = `fix migration ${FIX} not found`;
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

describe("root cause, reproduced with production-like privileges", () => {
  pgTest(
    "before the fix, the server role is denied on oauth_states — the exact production error",
    () => {
      assert.notEqual(preFixInsert!.status, 0);
      assert.match(preFixInsert!.stderr, /permission denied for table oauth_states/);
    },
  );
});

describe("OAuth state as the server (service_role), after the fix", () => {
  pgTest("creates a state and consumes it exactly once, returning the stored tenant", () => {
    const state = `state-${randomUUID()}`;
    assert.equal(asRole("service_role", insertState(state)).status, 0);
    assert.deepEqual(returned(asRole("service_role", consumeState(state))), [
      `${ORG}|${BIZ}|${OWNER}|/app/integrations`,
    ]);
    assert.deepEqual(
      returned(asRole("service_role", consumeState(state))),
      [],
      "a replayed state is rejected",
    );
  });

  pgTest("an expired state can't be consumed", () => {
    const state = `expired-${randomUUID()}`;
    assert.equal(
      asRole("service_role", insertState(state, "now() - interval '1 second'")).status,
      0,
    );
    assert.deepEqual(returned(asRole("service_role", consumeState(state))), []);
  });

  pgTest("a state issued for one provider can't be consumed by another", () => {
    const state = `provider-${randomUUID()}`;
    assert.equal(asRole("service_role", insertState(state)).status, 0);
    assert.deepEqual(returned(asRole("service_role", consumeState(state, "razorpay"))), []);
    assert.equal(returned(asRole("service_role", consumeState(state))).length, 1);
  });

  pgTest("state tokens are unique", () => {
    const state = `dup-${randomUUID()}`;
    assert.equal(asRole("service_role", insertState(state)).status, 0);
    const dup = asRole("service_role", insertState(state));
    assert.notEqual(dup.status, 0);
    assert.match(dup.stderr, /duplicate key|unique/i);
  });
});

describe("browsers can't touch OAuth state (anon and authenticated)", () => {
  for (const role of ["anon", "authenticated"]) {
    pgTest(`${role} can't read, create or consume OAuth state`, () => {
      const state = `browser-${randomUUID()}`;
      for (const statement of [
        "SELECT state FROM public.oauth_states LIMIT 1;",
        insertState(state),
        `UPDATE public.oauth_states SET consumed_at = now() WHERE state = '${state}';`,
        `DELETE FROM public.oauth_states WHERE state = '${state}';`,
      ]) {
        const r = asRole(
          role,
          `SELECT set_config('request.jwt.claim.sub', '${OWNER}', false);\n${statement}`,
        );
        assert.notEqual(r.status, 0, `${role}: ${statement}`);
        assert.match(r.stderr, /permission denied for table oauth_states/);
      }
    });
  }
});

describe("grants are exactly what the server code needs", () => {
  const priv = (role: string, table: string, privilege: string) =>
    rows(`SELECT has_table_privilege('${role}', 'public.${table}', '${privilege}');`)[0];

  pgTest("service_role can read and write every affected table (no DELETE/TRUNCATE)", () => {
    const needsInsert = new Set(AFFECTED.filter((t) => t !== "bookings"));
    for (const table of AFFECTED) {
      assert.equal(priv("service_role", table, "SELECT"), "t", `${table} SELECT`);
      assert.equal(priv("service_role", table, "UPDATE"), "t", `${table} UPDATE`);
      assert.equal(
        priv("service_role", table, "INSERT"),
        needsInsert.has(table) ? "t" : "f",
        `${table} INSERT`,
      );
      assert.equal(priv("service_role", table, "DELETE"), "f", `${table} DELETE`);
      assert.equal(priv("service_role", table, "TRUNCATE"), "f", `${table} TRUNCATE`);
    }
  });

  pgTest("anon has no access, and authenticated can never write, on any affected table", () => {
    for (const table of AFFECTED) {
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal(priv("anon", table, p), "f", `anon ${p} ${table}`);
      }
      for (const p of ["INSERT", "UPDATE", "DELETE"]) {
        assert.equal(priv("authenticated", table, p), "f", `authenticated ${p} ${table}`);
      }
    }
  });

  pgTest("connection credentials stay unreadable to signed-in users", () => {
    for (const table of ["google_calendar_connections", "razorpay_connections"]) {
      assert.equal(
        rows(
          `SELECT has_column_privilege('authenticated', 'public.${table}', 'encrypted_credentials', 'SELECT');`,
        )[0],
        "f",
        table,
      );
    }
  });

  pgTest(
    "signed-in members read only their own organization's bookings (RLS still applies)",
    () => {
      const start = "2030-10-16 10:30:00+00";
      const end = "2030-10-16 11:00:00+00";
      const book = sql(`
      INSERT INTO public.business_hours (organization_id, business_id, day_of_week, is_closed, intervals)
        SELECT '${ORG}', '${BIZ}', d, false, '[{"start":"09:00","end":"19:00"}]'::jsonb
        FROM generate_series(0, 6) d ON CONFLICT DO NOTHING;
      SELECT id FROM public.create_booking_atomic(
        '${ORG}', '${BIZ}', NULL, NULL, NULL, NULL, '${start}'::timestamptz, '${end}'::timestamptz,
        'Asia/Kolkata', 'Dhanush', '+919876543210', NULL, 'voice', 'grant-test-1', 'CONFIRMED', NULL, NULL, NULL);`);
      assert.equal(book.status, 0, book.stderr);
      const readAs = (user: string) =>
        rows(`
        SET ROLE authenticated;
        SELECT set_config('request.jwt.claim.sub', '${user}', false);
        SELECT customer_name FROM public.bookings WHERE business_id = '${BIZ}';
        RESET ROLE;`).filter((l) => l !== user);
      assert.deepEqual(readAs(OWNER), ["Dhanush"]);
      assert.deepEqual(readAs(OTHER_USER), [], "another tenant sees nothing");
    },
  );

  pgTest(
    "guard: every table in public is reachable by the server role (no table can ship without a grant again)",
    () => {
      const missing = rows(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND NOT has_table_privilege('service_role', c.oid, 'SELECT')
       ORDER BY 1;`);
      assert.deepEqual(missing, []);
    },
  );
});
