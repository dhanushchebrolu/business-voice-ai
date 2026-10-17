import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
 * REAL-PostgreSQL regression coverage for the voice reschedule incident
 * (Smile Dental: booked 12:00, asked to move to 1 PM, ended with both
 * bookings live). Replays EVERY migration in this directory onto a brand-
 * new disposable cluster, then exercises the exact database path the fixed
 * voice flow uses — reschedule_booking_atomic — and the read-only
 * reconciliation query in supabase/verification/.
 *
 * Verifies, against the real schema:
 *   - a reschedule moves the SAME row (id preserved), releases the old slot
 *     and leaves exactly one live booking;
 *   - a failed reschedule (slot taken, outside hours, another tenant)
 *     leaves the original booking exactly as it was;
 *   - concurrent writers into one slot: exactly one wins;
 *   - retries create no duplicates;
 *   - the reconciliation query finds the defect's duplicate pair and
 *     nothing else, and writes nothing.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILES = readdirSync(migrationsDir)
  .filter((f) => /^\d{14}_.*\.sql$/.test(f))
  .sort();
const RECONCILIATION_SQL = readFileSync(
  join(migrationsDir, "..", "verification", "find_duplicate_reschedule_bookings.sql"),
  "utf8",
);

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
const OTHER_BIZ = randomUUID();
const CALLER = "+919876543210";
const OTHER_CALLER = "+919845012345";

/** A future IST wall-clock time on `day` as a timestamptz literal. */
const ist = (day: string, hhmm: string) => `${day} ${hhmm}:00+05:30`;

function rows(sql: string): string[] {
  const result = execSql!(`\\pset format unaligned\n\\pset tuples_only on\n${sql}`);
  if (result.status !== 0) throw new Error(`SQL failed: ${result.stderr}\n${sql}`);
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Output format") && !l.startsWith("Tuples only"));
}

function execSqlAsync(sql: string): Promise<RunResult> {
  return new Promise((resolve) => {
    if (!cluster) {
      resolve({ status: 1, stdout: "", stderr: "cluster not ready" });
      return;
    }
    const args = [
      "-h",
      cluster.sockDir,
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-X",
      "-f",
      "-",
    ];
    const child = cluster.useSu
      ? spawn("su", ["postgres", "-c", [`${cluster.pgBinDir}psql`, ...args].join(" ")])
      : spawn(`${cluster.pgBinDir}psql`, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
    child.stdin.write(sql);
    child.stdin.end();
  });
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
    INSERT INTO public.businesses (id, organization_id, name, timezone) VALUES
      ('${BIZ}', '${ORG}', 'Smile Dental', 'Asia/Kolkata'),
      ('${OTHER_BIZ}', '${OTHER_ORG}', 'Other Clinic', 'Asia/Kolkata');
    INSERT INTO public.business_hours (organization_id, business_id, day_of_week, is_closed, intervals)
      SELECT o, b, d, false, '[{"start":"09:00","end":"19:00"}]'::jsonb
      FROM (VALUES ('${ORG}'::uuid, '${BIZ}'::uuid), ('${OTHER_ORG}'::uuid, '${OTHER_BIZ}'::uuid)) t(o, b),
           generate_series(0, 6) d;
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

function bookSql(opts: {
  key: string;
  phone: string;
  start: string;
  end: string;
  org?: string;
  biz?: string;
}): string {
  return `SELECT id FROM public.create_booking_atomic(
      '${opts.org ?? ORG}', '${opts.biz ?? BIZ}', NULL, NULL, NULL, NULL,
      '${opts.start}'::timestamptz, '${opts.end}'::timestamptz, 'Asia/Kolkata',
      'Dhanush', '${opts.phone}', NULL, 'voice', '${opts.key}', 'CONFIRMED', NULL, NULL, 'root canal');`;
}

function book(opts: Parameters<typeof bookSql>[0]): string {
  return rows(bookSql(opts))[0]!;
}

function rescheduleSql(bookingId: string, start: string, end: string, org = ORG): string {
  return `SELECT id, status FROM public.reschedule_booking_atomic(
      '${org}', '${bookingId}', '${start}'::timestamptz, '${end}'::timestamptz);`;
}

function state(bookingId: string): string {
  return rows(`SELECT status || '|' || to_char(start_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')
    FROM public.bookings WHERE id = '${bookingId}';`)[0]!;
}

function liveCount(day: string, phone: string): number {
  return Number(
    rows(`SELECT count(*) FROM public.bookings
      WHERE business_id = '${BIZ}' AND customer_phone = '${phone}'
        AND status NOT IN ('CANCELLED','NO_SHOW','PAYMENT_EXPIRED','PAYMENT_FAILED')
        AND (start_at AT TIME ZONE 'Asia/Kolkata')::date = '${day}';`)[0],
  );
}

describe("voice reschedule — real PostgreSQL, every migration applied", () => {
  pgTest(
    "book 12:00 then reschedule to 13:00: one live booking, same id, at 13:00; the 12:00 slot is free again",
    () => {
      const day = "2030-11-04";
      const id = book({
        key: `voice:call-a:${day}`,
        phone: CALLER,
        start: ist(day, "12:00"),
        end: ist(day, "12:30"),
      });
      const [moved] = rows(rescheduleSql(id, ist(day, "13:00"), ist(day, "13:30")));
      assert.equal(moved, `${id}|RESCHEDULED`, "the same row moved");
      assert.equal(state(id), `RESCHEDULED|${day} 13:00`);
      assert.equal(liveCount(day, CALLER), 1, "exactly one live booking for the caller");

      // The old slot was released in the same transaction.
      const other = book({
        key: `voice:call-b:${day}`,
        phone: OTHER_CALLER,
        start: ist(day, "12:00"),
        end: ist(day, "12:30"),
      });
      assert.ok(other);
    },
  );

  pgTest("a reschedule into a taken slot fails and leaves the original exactly as it was", () => {
    const day = "2030-11-05";
    const mine = book({
      key: `voice:call-c:${day}`,
      phone: CALLER,
      start: ist(day, "12:00"),
      end: ist(day, "12:30"),
    });
    book({
      key: `voice:call-d:${day}`,
      phone: OTHER_CALLER,
      start: ist(day, "13:00"),
      end: ist(day, "13:30"),
    });
    const failed = execSql!(rescheduleSql(mine, ist(day, "13:00"), ist(day, "13:30")));
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /SLOT_NO_LONGER_AVAILABLE/);
    assert.equal(state(mine), `CONFIRMED|${day} 12:00`);
  });

  pgTest("a reschedule outside working hours fails and leaves the original intact", () => {
    const day = "2030-11-06";
    const mine = book({
      key: `voice:call-e:${day}`,
      phone: CALLER,
      start: ist(day, "12:00"),
      end: ist(day, "12:30"),
    });
    const failed = execSql!(rescheduleSql(mine, ist(day, "21:00"), ist(day, "21:30")));
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /SLOT_OUTSIDE_SCHEDULE/);
    assert.equal(state(mine), `CONFIRMED|${day} 12:00`);
  });

  pgTest(
    "tenant isolation: another organization can't move the booking (BOOKING_NOT_FOUND), and it is unchanged",
    () => {
      const day = "2030-11-07";
      const mine = book({
        key: `voice:call-f:${day}`,
        phone: CALLER,
        start: ist(day, "12:00"),
        end: ist(day, "12:30"),
      });
      const failed = execSql!(rescheduleSql(mine, ist(day, "13:00"), ist(day, "13:30"), OTHER_ORG));
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /BOOKING_NOT_FOUND/);
      assert.equal(state(mine), `CONFIRMED|${day} 12:00`);
    },
  );

  pgTest(
    "concurrent: a reschedule and a new booking racing for the same slot — exactly one wins",
    async () => {
      for (let i = 0; i < 4; i++) {
        const day = `2030-11-${String(10 + i).padStart(2, "0")}`;
        const mine = book({
          key: `voice:race-${i}:${day}`,
          phone: CALLER,
          start: ist(day, "10:00"),
          end: ist(day, "10:30"),
        });
        const [moveResult, bookResult] = await Promise.all([
          execSqlAsync(rescheduleSql(mine, ist(day, "15:00"), ist(day, "15:30"))),
          execSqlAsync(
            bookSql({
              key: `voice:race-new-${i}:${day}`,
              phone: OTHER_CALLER,
              start: ist(day, "15:00"),
              end: ist(day, "15:30"),
            }),
          ),
        ]);
        const winners = [moveResult, bookResult].filter((r) => r.status === 0);
        assert.equal(
          winners.length,
          1,
          `iteration ${i}: exactly one writer may take the slot.\nmove: ${moveResult.stderr}\nbook: ${bookResult.stderr}`,
        );
        const occupying = rows(`SELECT count(*) FROM public.bookings
          WHERE business_id = '${BIZ}' AND start_at = '${ist(day, "15:00")}'::timestamptz
            AND status NOT IN ('CANCELLED','NO_SHOW','PAYMENT_EXPIRED','PAYMENT_FAILED');`);
        assert.deepEqual(occupying, ["1"]);
        if (moveResult.status !== 0) {
          assert.equal(
            state(mine),
            `CONFIRMED|${day} 10:00`,
            "the losing move left the original intact",
          );
        }
      }
    },
  );

  pgTest(
    "retries create no duplicates: repeating a reschedule or a booking request changes nothing more",
    () => {
      const day = "2030-11-20";
      const key = `voice:call-g:${day}`;
      const id = book({ key, phone: CALLER, start: ist(day, "12:00"), end: ist(day, "12:30") });
      assert.equal(
        book({ key, phone: CALLER, start: ist(day, "12:00"), end: ist(day, "12:30") }),
        id,
      );
      rows(rescheduleSql(id, ist(day, "13:00"), ist(day, "13:30")));
      const [again] = rows(rescheduleSql(id, ist(day, "13:00"), ist(day, "13:30")));
      assert.equal(again, `${id}|RESCHEDULED`);
      assert.equal(state(id), `RESCHEDULED|${day} 13:00`);
      assert.equal(liveCount(day, CALLER), 1);
    },
  );

  pgTest(
    "the reconciliation query lists the defect's duplicate pair (same call) and no single-booking caller",
    () => {
      const day = "2030-12-01";
      // The defect: one call booked 12:00, then "rescheduled" by booking 13:00.
      const dupCaller = "+919811122233";
      const first = book({
        key: `voice:dup-call:${day}T06:30:00.000Z:x`,
        phone: dupCaller,
        start: ist(day, "12:00"),
        end: ist(day, "12:30"),
      });
      const second = book({
        key: `voice:dup-call:${day}T07:30:00.000Z:y`,
        phone: dupCaller,
        start: ist(day, "13:00"),
        end: ist(day, "13:30"),
      });
      book({
        key: `voice:single:${day}`,
        phone: "+919800000001",
        start: ist(day, "15:00"),
        end: ist(day, "15:30"),
      });

      const result = rows(RECONCILIATION_SQL).filter((l) => l.includes("|2233|"));
      assert.equal(result.length, 2, result.join("\n"));
      const [r1, r2] = result.map((l) => l.split("|"));
      assert.equal(r1![3], first);
      assert.equal(r2![3], second);
      // same_call_group (index 11) and created_order (index 12).
      assert.equal(r1![11], "2");
      assert.equal(r1![12], "1");
      assert.equal(r2![12], "2");
      assert.ok(
        !rows(RECONCILIATION_SQL).some((l) => l.includes("|0001|")),
        "single booking not listed",
      );
      assert.ok(
        !rows(RECONCILIATION_SQL).some((l) => l.includes(dupCaller)),
        "full phone numbers never appear in the output",
      );
    },
  );

  pgTest("the reconciliation query is read-only", () => {
    const body = RECONCILIATION_SQL.replace(/--.*$/gm, "");
    assert.doesNotMatch(
      body,
      /\b(insert|update|delete|alter|drop|create|truncate|grant|revoke)\b/i,
    );
    const before = rows(`SELECT count(*), max(updated_at) FROM public.bookings;`);
    rows(RECONCILIATION_SQL);
    assert.deepEqual(rows(`SELECT count(*), max(updated_at) FROM public.bookings;`), before);
  });
});
