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
import { normalizeCustomerPhone } from "../../src/lib/phone-number.ts";

/**
 * REAL-PostgreSQL regression coverage for the Smile Dental voice-booking
 * incident. Unlike booking_concurrency.pg.test.ts (which loads only the
 * booking migrations onto a hand-written fixture schema), this replays
 * EVERY migration in this directory, in filename order, onto a brand-new
 * disposable cluster — so contacts.phone's real CHECK constraint, the real
 * bookings table, the real create_booking_atomic, and the real RLS policies
 * are what's exercised. Supabase's own `auth` schema and API roles are not
 * part of these migrations, so a minimal stand-in for exactly what they
 * reference (auth.users, auth.uid(), anon/authenticated/service_role) is
 * created first.
 *
 * Verifies, against the real schema:
 *   - the root cause: a raw spoken "9876543210" violates contacts_phone_e164,
 *     while the normalized number the fixed booking service now sends is
 *     accepted;
 *   - 6:30 PM in the business's timezone persists exactly once as CONFIRMED
 *     (stored as 13:00Z for Asia/Kolkata), and a retried call with the same
 *     idempotency key returns the same row;
 *   - the dashboard's bookings read (RLS "tenant bookings read") shows it to
 *     the business's own members and to nobody else;
 *   - the interval is busy for availability and a second booking of it is
 *     rejected.
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
const OTHER_ORG = randomUUID();
const OWNER = randomUUID();
const OTHER_USER = randomUUID();
const BIZ = randomUUID();
// 6:30 PM in Asia/Kolkata on a fixed future date (validate_booking_schedule
// does not care about "now", but keeping it in the future mirrors how the
// voice flow is ever reached).
const DATE = "2030-10-14";
const START_UTC = `${DATE} 13:00:00+00`;
const END_UTC = `${DATE} 13:30:00+00`;

/** Runs SQL and returns unaligned, tuples-only output lines. */
function rows(sql: string): string[] {
  const result = execSql!(`\\pset format unaligned\n\\pset tuples_only on\n${sql}`);
  if (result.status !== 0) throw new Error(`SQL failed: ${result.stderr}\n${sql}`);
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only"));
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
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const applied = execSql(`BEGIN;\n${sql}\nCOMMIT;`);
    if (applied.status !== 0) {
      setupFailure = `migration ${file} failed to apply: ${applied.stderr}`;
      return;
    }
  }
  const seed = execSql(`
    INSERT INTO public.organizations (id, name, owner_id) VALUES
      ('${ORG}', 'Smile Dental', '${OWNER}'),
      ('${OTHER_ORG}', 'Other Clinic', '${OTHER_USER}');
    INSERT INTO public.organization_members (organization_id, user_id) VALUES
      ('${ORG}', '${OWNER}'), ('${OTHER_ORG}', '${OTHER_USER}');
    INSERT INTO public.businesses (id, organization_id, name, timezone)
      VALUES ('${BIZ}', '${ORG}', 'Smile Dental', 'Asia/Kolkata');
    INSERT INTO public.business_hours (organization_id, business_id, day_of_week, is_closed, intervals)
      SELECT '${ORG}', '${BIZ}', d, false, '[{"start":"09:00","end":"19:00"}]'::jsonb
      FROM generate_series(0, 6) d;
  `);
  if (seed.status !== 0) setupFailure = `seed failed: ${seed.stderr}`;
});

after(() => {
  unregisterSignalCleanup?.();
  if (cluster) teardownCluster(cluster);
});

function pgTest(name: string, fn: (t: TestContext) => void | Promise<void>) {
  test(name, async (t) => {
    if (skipReason) {
      t.skip(skipReason);
      return;
    }
    if (setupFailure) {
      assert.fail(
        `PostgreSQL is available, but setup failed — a real failure, not a skip: ${setupFailure}`,
      );
    }
    await fn(t);
  });
}

function bookSql(key: string, phone: string, start = START_UTC, end = END_UTC): string {
  return `SELECT id, status, start_at AT TIME ZONE 'Asia/Kolkata', customer_phone
    FROM public.create_booking_atomic(
      '${ORG}', '${BIZ}', NULL, NULL, NULL, NULL,
      '${start}'::timestamptz, '${end}'::timestamptz, 'Asia/Kolkata',
      'Dhanush', '${phone}', NULL, 'voice', '${key}', 'CONFIRMED', NULL, NULL, 'teeth cleaning');`;
}

describe("Smile Dental voice booking — real PostgreSQL, every migration applied", () => {
  pgTest(
    "root cause: a raw spoken number violates contacts_phone_e164; the normalized one is accepted",
    () => {
      const raw = execSql!(
        `INSERT INTO public.contacts (organization_id, business_id, phone) VALUES ('${ORG}', '${BIZ}', '9876543210');`,
      );
      assert.notEqual(raw.status, 0);
      assert.match(raw.stderr, /contacts_phone_e164/);

      const normalized = normalizeCustomerPhone("9876543210", "IN");
      assert.equal(normalized, "+919876543210");
      const ok = execSql!(
        `INSERT INTO public.contacts (organization_id, business_id, phone, source)
       VALUES ('${ORG}', '${BIZ}', '${normalized}', 'booking')
       ON CONFLICT (organization_id, phone) DO UPDATE SET name = EXCLUDED.name;`,
      );
      assert.equal(ok.status, 0, ok.stderr);
    },
  );

  pgTest(
    "1/8: 6:30 PM IST persists exactly once as CONFIRMED; a retry with the same key returns the same booking",
    () => {
      const key = `voice:call-1:${DATE}T13:00:00.000Z:${DATE}T13:30:00.000Z`;
      const [first] = rows(bookSql(key, "+919876543210"));
      const [id, status, localStart, phone] = first!.split("|");
      assert.equal(status, "CONFIRMED");
      assert.equal(
        localStart,
        `${DATE} 18:30:00`,
        "stored as 6:30 PM in the business's own timezone",
      );
      assert.equal(phone, "+919876543210");

      const [retry] = rows(bookSql(key, "+919876543210"));
      assert.equal(retry!.split("|")[0], id, "the retry returns the existing booking");
      assert.deepEqual(rows(`SELECT count(*) FROM public.bookings WHERE business_id = '${BIZ}';`), [
        "1",
      ]);
    },
  );

  pgTest(
    "3: the dashboard's read (RLS 'tenant bookings read') returns it to Smile Dental's members only",
    () => {
      const asUser = (userId: string) =>
        rows(`
        SET ROLE authenticated;
        SELECT set_config('request.jwt.claim.sub', '${userId}', false);
        SELECT business_id, status FROM public.bookings WHERE organization_id = '${ORG}' ORDER BY start_at;
        RESET ROLE;`).filter((l) => l !== userId);
      assert.deepEqual(asUser(OWNER), [`${BIZ}|CONFIRMED`]);
      assert.deepEqual(asUser(OTHER_USER), [], "another tenant never sees it");
    },
  );

  pgTest("2: the interval is busy for availability, and a second booking of it is rejected", () => {
    // The same filter check_calendar_availability applies (business_id, not
    // CANCELLED/NO_SHOW, starting within the local day).
    const busy = rows(`
      SELECT to_char(start_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') FROM public.bookings
      WHERE business_id = '${BIZ}' AND status NOT IN ('CANCELLED','NO_SHOW')
        AND start_at >= '${DATE} 00:00:00+05:30' AND start_at < '${DATE} 24:00:00+05:30';`);
    assert.deepEqual(busy, ["18:30"]);

    const overlap = execSql!(
      bookSql("voice:call-2:other", "+919845012345", `${DATE} 12:45:00+00`, `${DATE} 13:15:00+00`),
    );
    assert.notEqual(overlap.status, 0);
    assert.match(overlap.stderr, /SLOT_NO_LONGER_AVAILABLE/);
  });

  pgTest(
    "the schedule check uses the business's timezone: 6:30 PM IST is open, 7:30 PM IST is not",
    () => {
      const outside = execSql!(
        bookSql("voice:call-3:late", "+919845012345", `${DATE} 14:00:00+00`, `${DATE} 14:30:00+00`),
      );
      assert.notEqual(outside.status, 0);
      assert.match(outside.stderr, /SLOT_OUTSIDE_SCHEDULE/);
    },
  );
});
