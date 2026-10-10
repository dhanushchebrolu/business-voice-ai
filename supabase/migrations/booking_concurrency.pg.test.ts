import { test, describe, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
 * Executable, REAL-PostgreSQL concurrency coverage for create_booking_
 * atomic (20261009090000_atomic_booking_creation.sql, redefined by
 * 20261009120000_atomic_schedule_validation_and_locking.sql to also hold
 * the per-business schedule lock) — the one DB-level serialization point
 * every booking-creation path (voice, manual, payment-hold) goes through.
 * This loads both migration files' REAL SQL verbatim against a brand-new
 * disposable cluster (via pg-test-cluster.ts, same mechanism as
 * business_hours_interval_validation.pg.test.ts) and fires genuinely
 * concurrent psql child processes at it — not sequential calls, and not
 * a mock.
 *
 * Also covers (added when the idempotency race below was fixed):
 * reschedule_booking_atomic and cancel_booking_atomic
 * (20261010130000_atomic_reschedule_and_cancel.sql), which replaced
 * rescheduleBooking()'s and cancelBooking()'s prior JS-level check-then-
 * update with the same lock-protected, single-transaction pattern — see
 * that migration's own header comment for the exact races this closes
 * (reschedule-vs-reschedule, reschedule-vs-closure, reschedule-vs-cancel).
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const ATOMIC_BOOKING_SQL = readFileSync(
  join(migrationsDir, "20261009090000_atomic_booking_creation.sql"),
  "utf8",
);
const SCHEDULE_LOCKING_SQL = readFileSync(
  join(migrationsDir, "20261009120000_atomic_schedule_validation_and_locking.sql"),
  "utf8",
);
const IDEMPOTENCY_RACE_FIX_SQL = readFileSync(
  join(migrationsDir, "20261010120000_fix_idempotent_booking_retry_race.sql"),
  "utf8",
);
const RESCHEDULE_AND_CANCEL_SQL = readFileSync(
  join(migrationsDir, "20261010130000_atomic_reschedule_and_cancel.sql"),
  "utf8",
);

let cluster: Cluster | null = null;
let execSql: (sql: string) => RunResult = () => {
  throw new Error("execSql used before before() finished setting up the cluster");
};
let unregisterSignalCleanup: (() => void) | null = null;
let skipReason: string | null = null;
let setupFailure: string | null = null;

/** Spawns a real, independent psql process and resolves once it exits — used to fire genuinely concurrent statements, not sequential ones. */
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
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
    child.stdin.write(sql);
    child.stdin.end();
  });
}

function assertSucceeds(sql: string, message: string) {
  const { status, stderr } = execSql(sql);
  assert.equal(status, 0, `${message}\nSQL:\n${sql}\nstderr:\n${stderr}`);
}

function assertRejected(sql: string, expectedSubstring: string, message: string) {
  const { status, stderr } = execSql(sql);
  assert.notEqual(status, 0, `${message} (expected a rejection, but it succeeded)\nSQL:\n${sql}`);
  assert.ok(
    stderr.includes(expectedSubstring),
    `${message}\nExpected stderr to include "${expectedSubstring}"\nActual stderr:\n${stderr}`,
  );
}

function scalar(sql: string): string {
  const { status, stdout, stderr } = execSql(`\\pset tuples_only on\n${sql}`);
  assert.equal(status, 0, `query failed:\n${sql}\nstderr:\n${stderr}`);
  return stdout.trim();
}

// Trimmed to exactly the columns create_booking_atomic, validate_booking_
// schedule, business_effective_open_ranges, and apply_business_schedule_
// override/set_business_weekly_hours read or write — no FKs (this is an
// isolated fixture, not a full-schema clone), but identical column names/
// types/constraints to the real tables so the REAL migration SQL runs
// completely unmodified against it.
// The real migration files REVOKE/GRANT against Supabase's standard
// anon/authenticated/service_role roles, which a vanilla disposable
// Postgres cluster doesn't have — created here as plain, privilege-less
// roles purely so those statements (left completely unmodified) have
// something to reference, not to replicate Supabase's actual grants.
const MINIMAL_SCHEMA = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role;
  END IF;
END;
$$;

CREATE TABLE businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata'
);

CREATE TABLE business_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_closed BOOLEAN NOT NULL DEFAULT false,
  intervals JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (business_id, day_of_week)
);

CREATE TABLE business_hour_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  override_date DATE NOT NULL,
  is_full_day_closure BOOLEAN NOT NULL DEFAULT false,
  intervals JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT,
  UNIQUE (business_id, override_date)
);

CREATE TABLE google_calendar_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google'
);

CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  contact_id UUID,
  agent_config_id UUID,
  calendar_connection_id UUID,
  service_id UUID,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'PENDING_CONFIRMATION', 'CONFIRMED', 'RESCHEDULED',
    'CANCELLED', 'COMPLETED', 'NO_SHOW', 'CALENDAR_SYNC_FAILED',
    'PENDING_PAYMENT', 'PAYMENT_FAILED', 'PAYMENT_EXPIRED'
  )),
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL CHECK (end_at > start_at),
  timezone TEXT NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  google_event_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  idempotency_key TEXT,
  hold_expires_at TIMESTAMPTZ,
  call_id TEXT,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE UNIQUE INDEX idx_bookings_no_exact_start_clash
  ON bookings (calendar_connection_id, start_at)
  WHERE status NOT IN ('CANCELLED', 'NO_SHOW') AND calendar_connection_id IS NOT NULL;
`;

before(() => {
  const result = bootstrapCluster();
  if (!result.ok) {
    skipReason = result.reason;
    return;
  }
  cluster = result.cluster;
  execSql = makeExecSql(cluster);
  unregisterSignalCleanup = registerSignalCleanup(() => cluster);

  const schemaResult = execSql(MINIMAL_SCHEMA);
  if (schemaResult.status !== 0) {
    setupFailure = `failed to create the minimal booking fixture schema: ${schemaResult.stderr}`;
    return;
  }
  const atomicResult = execSql(ATOMIC_BOOKING_SQL);
  if (atomicResult.status !== 0) {
    setupFailure = `failed to load 20261009090000_atomic_booking_creation.sql as committed: ${atomicResult.stderr}`;
    return;
  }
  const lockingResult = execSql(SCHEDULE_LOCKING_SQL);
  if (lockingResult.status !== 0) {
    setupFailure = `failed to load 20261009120000_atomic_schedule_validation_and_locking.sql as committed: ${lockingResult.stderr}`;
    return;
  }
  const idemFixResult = execSql(IDEMPOTENCY_RACE_FIX_SQL);
  if (idemFixResult.status !== 0) {
    setupFailure = `failed to load 20261010120000_fix_idempotent_booking_retry_race.sql as committed: ${idemFixResult.stderr}`;
    return;
  }
  const rescheduleCancelResult = execSql(RESCHEDULE_AND_CANCEL_SQL);
  if (rescheduleCancelResult.status !== 0) {
    setupFailure = `failed to load 20261010130000_atomic_reschedule_and_cancel.sql as committed: ${rescheduleCancelResult.stderr}`;
    return;
  }
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
        `PostgreSQL is available, but setup SQL failed to load — this is a real failure, not a skip: ${setupFailure}`,
      );
    }
    await fn(t);
  });
}

/**
 * Seeds one business, fully open every day of the week, plus a connected
 * calendar — returns its id, connection id, AND organization id.
 * organizationId is a literal UUID generated once here (via Node's
 * randomUUID), not a per-call `gen_random_uuid()` inside the SQL — two
 * related calls (a booking + a schedule override on the same business,
 * or two retries of the same booking) must share the EXACT same
 * organization_id for the functions' own org-scoped lookups
 * (create_booking_atomic's idempotency check, apply_business_schedule_
 * override's businesses lookup) to see each other at all. Evaluating
 * gen_random_uuid() inline per call would silently give each call its
 * own distinct value and make every cross-call check a guaranteed
 * no-match, independent of timing.
 */
function seedOpenBusiness(): { businessId: string; connectionId: string; organizationId: string } {
  const organizationId = randomUUID();
  const businessId = scalar(
    `INSERT INTO businesses (organization_id) VALUES ('${organizationId}') RETURNING id;`,
  );
  for (let dow = 0; dow <= 6; dow++) {
    assertSucceeds(
      `INSERT INTO business_hours (business_id, day_of_week, is_closed, intervals)
       VALUES ('${businessId}', ${dow}, false, '[{"start":"00:00","end":"23:59"}]'::jsonb);`,
      "seed weekly hours",
    );
  }
  const connectionId = scalar(
    `INSERT INTO google_calendar_connections (business_id) VALUES ('${businessId}') RETURNING id;`,
  );
  return { businessId, connectionId, organizationId };
}

function createBookingSql(args: {
  organizationId: string;
  businessId: string;
  connectionId: string;
  startIso: string;
  endIso: string;
  idempotencyKey?: string;
}): string {
  const key = args.idempotencyKey ? `'${args.idempotencyKey}'` : "NULL";
  return `SELECT public.create_booking_atomic(
    '${args.organizationId}', '${args.businessId}', '${args.connectionId}', NULL, NULL, NULL,
    '${args.startIso}'::timestamptz, '${args.endIso}'::timestamptz, 'Asia/Kolkata',
    'Test Customer', '+910000000000', 'test@example.com', 'voice',
    ${key}, 'CONFIRMED', NULL, NULL, NULL
  );`;
}

describe("create_booking_atomic — real PostgreSQL concurrency: overlapping double-booking prevention", () => {
  pgTest(
    "two genuinely concurrent requests for OVERLAPPING slots on the same calendar connection: exactly one succeeds",
    async () => {
      const { businessId, connectionId, organizationId } = seedOpenBusiness();
      const sqlA = createBookingSql({
        organizationId,
        businessId,
        connectionId,
        startIso: "2026-11-02T10:00:00+05:30",
        endIso: "2026-11-02T10:30:00+05:30",
      });
      const sqlB = createBookingSql({
        organizationId,
        businessId,
        connectionId,
        startIso: "2026-11-02T10:15:00+05:30",
        endIso: "2026-11-02T10:45:00+05:30",
      });

      const [resultA, resultB] = await Promise.all([execSqlAsync(sqlA), execSqlAsync(sqlB)]);
      const succeeded = [resultA, resultB].filter((r) => r.status === 0);
      const failed = [resultA, resultB].filter((r) => r.status !== 0);

      assert.equal(
        succeeded.length,
        1,
        `expected exactly one of the two concurrent overlapping requests to succeed, got ${succeeded.length}.\nA: status=${resultA.status} stderr=${resultA.stderr}\nB: status=${resultB.status} stderr=${resultB.stderr}`,
      );
      assert.equal(failed.length, 1, "expected exactly one of the two to fail");
      assert.ok(
        failed[0]!.stderr.includes("SLOT_NO_LONGER_AVAILABLE"),
        `the losing request must fail with SLOT_NO_LONGER_AVAILABLE, got: ${failed[0]!.stderr}`,
      );

      const count = scalar(
        `SELECT count(*) FROM bookings WHERE calendar_connection_id = '${connectionId}' AND status NOT IN ('CANCELLED','NO_SHOW');`,
      );
      assert.equal(count, "1", "exactly one row must actually be persisted, never two");
    },
  );

  pgTest(
    "two genuinely concurrent requests for the SAME exact slot (idempotency key) resolve to the SAME booking id (fixed by 20261010120000)",
    async () => {
      const { businessId, connectionId, organizationId } = seedOpenBusiness();
      const key = `retry-${Math.random().toString(36).slice(2)}`;
      // Selects just the returned row's `id` field (via Postgres composite
      // field access) so the two concurrent callers' results can be
      // compared directly, rather than the full row.
      const idSql = `\\pset tuples_only on
SELECT (public.create_booking_atomic(
  '${organizationId}', '${businessId}', '${connectionId}', NULL, NULL, NULL,
  '2026-11-03T09:00:00+05:30'::timestamptz, '2026-11-03T09:30:00+05:30'::timestamptz, 'Asia/Kolkata',
  'Test Customer', '+910000000000', 'test@example.com', 'voice',
  '${key}', 'CONFIRMED', NULL, NULL, NULL
)).id;`;

      const [resultA, resultB] = await Promise.all([execSqlAsync(idSql), execSqlAsync(idSql)]);
      assert.equal(resultA.status, 0, `request A must succeed: ${resultA.stderr}`);
      assert.equal(resultB.status, 0, `request B must succeed: ${resultB.stderr}`);

      const idA = resultA.stdout.trim();
      const idB = resultB.stdout.trim();
      assert.ok(idA.length > 0, "request A must return a real booking id");
      assert.equal(
        idA,
        idB,
        `both concurrent retries with the same idempotency key must resolve to the SAME booking id — got A=${idA} B=${idB}`,
      );

      const count = scalar(`SELECT count(*) FROM bookings WHERE idempotency_key = '${key}';`);
      assert.equal(
        count,
        "1",
        "a retried request with the same idempotency key must never create a second row",
      );
    },
  );

  pgTest(
    "repeating the request AFTER it has already completed still returns the original booking (post-completion idempotent retry)",
    async () => {
      const { businessId, connectionId, organizationId } = seedOpenBusiness();
      const key = `post-complete-${Math.random().toString(36).slice(2)}`;
      const sql = createBookingSql({
        organizationId,
        businessId,
        connectionId,
        startIso: "2026-11-05T09:00:00+05:30",
        endIso: "2026-11-05T09:30:00+05:30",
        idempotencyKey: key,
      });

      assertSucceeds(sql, "first application must succeed");
      const firstId = scalar(`SELECT id::text FROM bookings WHERE idempotency_key = '${key}';`);

      // Sequential, after the first has fully committed — the established
      // API contract (booking-service.server.ts's own pre-check comment)
      // is that a retry after completion returns the existing booking,
      // never a fresh row or an error.
      assertSucceeds(sql, "a retry after completion must also succeed");
      const secondId = scalar(`SELECT id::text FROM bookings WHERE idempotency_key = '${key}';`);
      assert.equal(
        secondId,
        firstId,
        "a post-completion retry must resolve to the original booking id",
      );

      const count = scalar(`SELECT count(*) FROM bookings WHERE idempotency_key = '${key}';`);
      assert.equal(count, "1", "a post-completion retry must never create a second row");
    },
  );

  pgTest(
    "DIFFERENT idempotency keys competing for the same slot still enforce the overlap check (idempotency never bypasses conflict validation)",
    async () => {
      const { businessId, connectionId, organizationId } = seedOpenBusiness();
      const sqlA = createBookingSql({
        organizationId,
        businessId,
        connectionId,
        startIso: "2026-11-06T09:00:00+05:30",
        endIso: "2026-11-06T09:30:00+05:30",
        idempotencyKey: `key-a-${Math.random().toString(36).slice(2)}`,
      });
      const sqlB = createBookingSql({
        organizationId,
        businessId,
        connectionId,
        startIso: "2026-11-06T09:00:00+05:30",
        endIso: "2026-11-06T09:30:00+05:30",
        idempotencyKey: `key-b-${Math.random().toString(36).slice(2)}`,
      });

      const [resultA, resultB] = await Promise.all([execSqlAsync(sqlA), execSqlAsync(sqlB)]);
      const succeeded = [resultA, resultB].filter((r) => r.status === 0);
      const failed = [resultA, resultB].filter((r) => r.status !== 0);
      assert.equal(
        succeeded.length,
        1,
        `exactly one of two different-key requests for the identical slot must succeed, got ${succeeded.length}`,
      );
      assert.ok(
        failed[0]!.stderr.includes("SLOT_NO_LONGER_AVAILABLE"),
        `the losing request must still fail with SLOT_NO_LONGER_AVAILABLE, got: ${failed[0]!.stderr}`,
      );
    },
  );

  pgTest(
    "idempotency keys are scoped per-organization — the SAME key in a DIFFERENT organization is a distinct booking, never collapsed together",
    async () => {
      const {
        businessId: businessA,
        connectionId: connectionA,
        organizationId: orgA,
      } = seedOpenBusiness();
      const {
        businessId: businessB,
        connectionId: connectionB,
        organizationId: orgB,
      } = seedOpenBusiness();
      const sharedKey = `shared-${Math.random().toString(36).slice(2)}`;

      assertSucceeds(
        createBookingSql({
          organizationId: orgA,
          businessId: businessA,
          connectionId: connectionA,
          startIso: "2026-11-07T09:00:00+05:30",
          endIso: "2026-11-07T09:30:00+05:30",
          idempotencyKey: sharedKey,
        }),
        "org A's booking with this key must succeed",
      );
      assertSucceeds(
        createBookingSql({
          organizationId: orgB,
          businessId: businessB,
          connectionId: connectionB,
          startIso: "2026-11-07T09:00:00+05:30",
          endIso: "2026-11-07T09:30:00+05:30",
          idempotencyKey: sharedKey,
        }),
        "org B's booking with the SAME key must independently succeed, not be treated as org A's retry",
      );

      const count = scalar(`SELECT count(*) FROM bookings WHERE idempotency_key = '${sharedKey}';`);
      assert.equal(
        count,
        "2",
        "the same idempotency key in two different organizations must produce two distinct rows",
      );
    },
  );

  pgTest("non-overlapping concurrent requests on the same connection both succeed", async () => {
    const { businessId, connectionId, organizationId } = seedOpenBusiness();
    const sqlA = createBookingSql({
      organizationId,
      businessId,
      connectionId,
      startIso: "2026-11-04T09:00:00+05:30",
      endIso: "2026-11-04T09:30:00+05:30",
    });
    const sqlB = createBookingSql({
      organizationId,
      businessId,
      connectionId,
      startIso: "2026-11-04T10:00:00+05:30",
      endIso: "2026-11-04T10:30:00+05:30",
    });

    const [resultA, resultB] = await Promise.all([execSqlAsync(sqlA), execSqlAsync(sqlB)]);
    assert.equal(resultA.status, 0, `non-overlapping request A must succeed: ${resultA.stderr}`);
    assert.equal(resultB.status, 0, `non-overlapping request B must succeed: ${resultB.stderr}`);
  });
});

describe("create_booking_atomic vs apply_business_schedule_override — real PostgreSQL concurrency: staff-closes-slot vs AI-books-slot race", () => {
  pgTest(
    "a booking request and a full-day-closure override fired concurrently for the same date never BOTH succeed",
    async () => {
      // Repeated across several fresh business/date pairs in one test to
      // observe both possible lock-acquisition orderings across runs
      // (which one wins is legitimately nondeterministic — the invariant
      // under test is mutual exclusion, not a specific winner), rather
      // than asserting on a single roll of the dice.
      let sawBookingWin = false;
      let sawClosureWin = false;

      for (let i = 0; i < 6; i++) {
        const { businessId, connectionId, organizationId } = seedOpenBusiness();
        const dateIso = `2026-12-${String(10 + i).padStart(2, "0")}`;
        const bookingSql = createBookingSql({
          organizationId,
          businessId,
          connectionId,
          startIso: `${dateIso}T11:00:00+05:30`,
          endIso: `${dateIso}T11:30:00+05:30`,
        });
        // Must share the SAME organization_id as the seeded business —
        // apply_business_schedule_override looks the business up by
        // (id, organization_id) and raises BUSINESS_NOT_FOUND otherwise,
        // which would make this test fail for a reason unrelated to the
        // race it's actually trying to observe.
        const closeSql = `SELECT public.apply_business_schedule_override(
          '${organizationId}', '${businessId}', '${dateIso}'::date, true, '[]'::jsonb, 'test closure'
        );`;

        const [bookingResult, closeResult] = await Promise.all([
          execSqlAsync(bookingSql),
          execSqlAsync(closeSql),
        ]);

        const bookingOk = bookingResult.status === 0;
        const closeOk = closeResult.status === 0;

        assert.ok(
          !(bookingOk && closeOk),
          `iteration ${i}: both the booking AND the full-day closure succeeded — this must never happen, a confirmed active booking must never coexist with a full-day closure covering it.\nbooking: status=${bookingResult.status} stderr=${bookingResult.stderr}\nclosure: status=${closeResult.status} stderr=${closeResult.stderr}`,
        );
        assert.ok(
          bookingOk || closeOk,
          `iteration ${i}: BOTH the booking and the closure failed — exactly one of them should have won the race.\nbooking: status=${bookingResult.status} stderr=${bookingResult.stderr}\nclosure: status=${closeResult.status} stderr=${closeResult.stderr}`,
        );

        if (bookingOk) {
          sawBookingWin = true;
          assert.ok(
            closeResult.stderr.includes("CANNOT_CLOSE_SLOT_WITH_ACTIVE_BOOKING"),
            `when the booking wins, the closure must be rejected specifically for the active-booking reason, got: ${closeResult.stderr}`,
          );
        } else {
          sawClosureWin = true;
          assert.ok(
            bookingResult.stderr.includes("SLOT_OUTSIDE_SCHEDULE"),
            `when the closure wins, the booking must be rejected specifically as outside the now-closed schedule, got: ${bookingResult.stderr}`,
          );
        }
      }

      // Not a correctness assertion (either ordering is correct) — just
      // evidence this run actually exercised real concurrency rather than
      // the two operations happening to always serialize the same way by
      // accident of timing.
      if (!sawBookingWin || !sawClosureWin) {
        console.error(
          `note: across 6 iterations, only the "${sawBookingWin ? "booking" : "closure"}" side ever won — the mutual-exclusion invariant held in every case, but genuine interleaving in both directions was not directly observed in this run.`,
        );
      }
    },
  );
});

describe("validate_booking_schedule / business_effective_open_ranges — real PostgreSQL: boundary correctness", () => {
  pgTest("a request exactly matching the open range's start and end succeeds", () => {
    const { businessId, connectionId, organizationId } = seedOpenBusiness();
    assertSucceeds(
      createBookingSql({
        organizationId,
        businessId,
        connectionId,
        startIso: "2026-11-10T00:00:00+05:30",
        endIso: "2026-11-10T23:59:00+05:30",
      }),
      "a request spanning exactly the configured all-day interval must be accepted",
    );
  });

  pgTest(
    "a request one minute past the open range's end is rejected as outside the schedule",
    () => {
      const organizationId = randomUUID();
      const businessId = scalar(
        `INSERT INTO businesses (organization_id) VALUES ('${organizationId}') RETURNING id;`,
      );
      assertSucceeds(
        `INSERT INTO business_hours (business_id, day_of_week, is_closed, intervals)
       VALUES ('${businessId}', EXTRACT(DOW FROM '2026-11-11'::date)::smallint, false, '[{"start":"09:00","end":"17:00"}]'::jsonb);`,
        "seed limited hours",
      );
      const connectionId = scalar(
        `INSERT INTO google_calendar_connections (business_id) VALUES ('${businessId}') RETURNING id;`,
      );
      assertRejected(
        createBookingSql({
          organizationId,
          businessId,
          connectionId,
          startIso: "2026-11-11T16:45:00+05:30",
          endIso: "2026-11-11T17:01:00+05:30",
        }),
        "SLOT_OUTSIDE_SCHEDULE",
        "a request ending even one minute past the configured close time must be rejected",
      );
    },
  );

  pgTest(
    "a request on a day with no business_hours row at all is rejected as outside the schedule",
    () => {
      const organizationId = randomUUID();
      const businessId = scalar(
        `INSERT INTO businesses (organization_id) VALUES ('${organizationId}') RETURNING id;`,
      );
      const connectionId = scalar(
        `INSERT INTO google_calendar_connections (business_id) VALUES ('${businessId}') RETURNING id;`,
      );
      assertRejected(
        createBookingSql({
          organizationId,
          businessId,
          connectionId,
          startIso: "2026-11-12T10:00:00+05:30",
          endIso: "2026-11-12T10:30:00+05:30",
        }),
        "SLOT_OUTSIDE_SCHEDULE",
        "a business with no configured hours for that weekday must reject every booking request for it",
      );
    },
  );

  pgTest(
    "a request on a date covered by a full-day-closure override is rejected even though the weekly hours are open",
    () => {
      const { businessId, connectionId, organizationId } = seedOpenBusiness();
      assertSucceeds(
        `INSERT INTO business_hour_overrides (organization_id, business_id, override_date, is_full_day_closure, intervals)
       VALUES ('${organizationId}', '${businessId}', '2026-11-13', true, '[]'::jsonb);`,
        "seed a full-day closure override",
      );
      assertRejected(
        createBookingSql({
          organizationId,
          businessId,
          connectionId,
          startIso: "2026-11-13T10:00:00+05:30",
          endIso: "2026-11-13T10:30:00+05:30",
        }),
        "SLOT_OUTSIDE_SCHEDULE",
        "a full-day closure override must take precedence over otherwise-open weekly hours",
      );
    },
  );
});

/** Creates a booking via the real RPC (sequentially, not part of the race under test) and returns its id. */
function seedBooking(args: {
  organizationId: string;
  businessId: string;
  connectionId: string;
  startIso: string;
  endIso: string;
}): string {
  return scalar(
    `\\pset tuples_only on
SELECT (public.create_booking_atomic(
  '${args.organizationId}', '${args.businessId}', '${args.connectionId}', NULL, NULL, NULL,
  '${args.startIso}'::timestamptz, '${args.endIso}'::timestamptz, 'Asia/Kolkata',
  'Test Customer', '+910000000000', 'test@example.com', 'voice',
  NULL, 'CONFIRMED', NULL, NULL, NULL
)).id;`,
  );
}

function rescheduleSql(args: {
  organizationId: string;
  bookingId: string;
  newStartIso: string;
  newEndIso: string;
}): string {
  return `SELECT public.reschedule_booking_atomic(
    '${args.organizationId}', '${args.bookingId}',
    '${args.newStartIso}'::timestamptz, '${args.newEndIso}'::timestamptz
  );`;
}

function cancelSql(args: { organizationId: string; bookingId: string; reason?: string }): string {
  const reason = args.reason ? `'${args.reason}'` : "NULL";
  return `SELECT public.cancel_booking_atomic('${args.organizationId}', '${args.bookingId}', ${reason});`;
}

describe("reschedule_booking_atomic — real PostgreSQL concurrency: double-booking and closure races", () => {
  pgTest(
    "two concurrent reschedules of DIFFERENT bookings into the SAME destination slot: exactly one succeeds",
    async () => {
      const { businessId, connectionId, organizationId } = seedOpenBusiness();
      const bookingA = seedBooking({
        organizationId,
        businessId,
        connectionId,
        startIso: "2026-11-20T09:00:00+05:30",
        endIso: "2026-11-20T09:30:00+05:30",
      });
      const bookingB = seedBooking({
        organizationId,
        businessId,
        connectionId,
        startIso: "2026-11-20T14:00:00+05:30",
        endIso: "2026-11-20T14:30:00+05:30",
      });

      const destination = {
        organizationId,
        newStartIso: "2026-11-20T16:00:00+05:30",
        newEndIso: "2026-11-20T16:30:00+05:30",
      };
      const [resultA, resultB] = await Promise.all([
        execSqlAsync(rescheduleSql({ ...destination, bookingId: bookingA })),
        execSqlAsync(rescheduleSql({ ...destination, bookingId: bookingB })),
      ]);

      const succeeded = [resultA, resultB].filter((r) => r.status === 0);
      const failed = [resultA, resultB].filter((r) => r.status !== 0);
      assert.equal(
        succeeded.length,
        1,
        `expected exactly one concurrent reschedule into the same destination to succeed, got ${succeeded.length}.\nA: status=${resultA.status} stderr=${resultA.stderr}\nB: status=${resultB.status} stderr=${resultB.stderr}`,
      );
      assert.ok(
        failed[0]!.stderr.includes("SLOT_NO_LONGER_AVAILABLE"),
        `the losing reschedule must fail with SLOT_NO_LONGER_AVAILABLE, got: ${failed[0]!.stderr}`,
      );

      const count = scalar(
        `SELECT count(*) FROM bookings WHERE calendar_connection_id = '${connectionId}' AND start_at = '2026-11-20T16:00:00+05:30'::timestamptz AND status NOT IN ('CANCELLED','NO_SHOW');`,
      );
      assert.equal(count, "1", "exactly one booking must actually occupy the destination slot");
    },
  );

  pgTest(
    "a reschedule and a full-day-closure override fired concurrently for the destination date never BOTH succeed",
    async () => {
      let sawRescheduleWin = false;
      let sawClosureWin = false;

      for (let i = 0; i < 6; i++) {
        const { businessId, connectionId, organizationId } = seedOpenBusiness();
        const booking = seedBooking({
          organizationId,
          businessId,
          connectionId,
          startIso: "2026-11-21T09:00:00+05:30",
          endIso: "2026-11-21T09:30:00+05:30",
        });
        const dateIso = `2026-12-${String(15 + i).padStart(2, "0")}`;
        const rescheduleCall = rescheduleSql({
          organizationId,
          bookingId: booking,
          newStartIso: `${dateIso}T11:00:00+05:30`,
          newEndIso: `${dateIso}T11:30:00+05:30`,
        });
        const closeSql = `SELECT public.apply_business_schedule_override(
          '${organizationId}', '${businessId}', '${dateIso}'::date, true, '[]'::jsonb, 'test closure'
        );`;

        const [rescheduleResult, closeResult] = await Promise.all([
          execSqlAsync(rescheduleCall),
          execSqlAsync(closeSql),
        ]);
        const rescheduleOk = rescheduleResult.status === 0;
        const closeOk = closeResult.status === 0;

        assert.ok(
          !(rescheduleOk && closeOk),
          `iteration ${i}: both the reschedule AND the full-day closure succeeded — a rescheduled booking must never end up inside a closed period.\nreschedule: status=${rescheduleResult.status} stderr=${rescheduleResult.stderr}\nclosure: status=${closeResult.status} stderr=${closeResult.stderr}`,
        );
        assert.ok(
          rescheduleOk || closeOk,
          `iteration ${i}: both failed — exactly one of them should have won the race.\nreschedule: status=${rescheduleResult.status} stderr=${rescheduleResult.stderr}\nclosure: status=${closeResult.status} stderr=${closeResult.stderr}`,
        );

        if (rescheduleOk) {
          sawRescheduleWin = true;
          // The closure call targets a date with no booking YET from this
          // business's other bookings, so it only fails here specifically
          // because the booking being rescheduled landed there first.
          assert.ok(
            closeResult.stderr.includes("CANNOT_CLOSE_SLOT_WITH_ACTIVE_BOOKING"),
            `when the reschedule wins, the closure must be rejected for the active-booking reason, got: ${closeResult.stderr}`,
          );
        } else {
          sawClosureWin = true;
          assert.ok(
            rescheduleResult.stderr.includes("SLOT_OUTSIDE_SCHEDULE"),
            `when the closure wins, the reschedule must be rejected as outside the now-closed schedule, got: ${rescheduleResult.stderr}`,
          );
        }
      }

      if (!sawRescheduleWin || !sawClosureWin) {
        console.error(
          `note: across 6 iterations, only the "${sawRescheduleWin ? "reschedule" : "closure"}" side ever won — the mutual-exclusion invariant held every time, but genuine interleaving in both directions was not directly observed in this run.`,
        );
      }
    },
  );

  pgTest(
    "a reschedule racing a cancellation of the SAME booking always ends CANCELLED, regardless of which wins",
    async () => {
      for (let i = 0; i < 4; i++) {
        const { businessId, connectionId, organizationId } = seedOpenBusiness();
        const booking = seedBooking({
          organizationId,
          businessId,
          connectionId,
          startIso: `2026-11-2${i}T09:00:00+05:30`,
          endIso: `2026-11-2${i}T09:30:00+05:30`,
        });

        const [rescheduleResult, cancelResult] = await Promise.all([
          execSqlAsync(
            rescheduleSql({
              organizationId,
              bookingId: booking,
              newStartIso: `2026-11-2${i}T15:00:00+05:30`,
              newEndIso: `2026-11-2${i}T15:30:00+05:30`,
            }),
          ),
          execSqlAsync(cancelSql({ organizationId, bookingId: booking, reason: "race test" })),
        ]);

        // cancel_booking_atomic never fails for an existing, owned booking
        // (cancelling an already-cancelled one is a no-op success) — only
        // reschedule can fail here, if cancel's row lock wins first.
        assert.equal(
          cancelResult.status,
          0,
          `iteration ${i}: cancel must always succeed: ${cancelResult.stderr}`,
        );

        const finalStatus = scalar(`SELECT status FROM bookings WHERE id = '${booking}';`);
        assert.equal(
          finalStatus,
          "CANCELLED",
          `iteration ${i}: the final state must be CANCELLED regardless of which operation's row lock won — got ${finalStatus}. reschedule status=${rescheduleResult.status} stderr=${rescheduleResult.stderr}`,
        );
      }
    },
  );

  pgTest(
    "a failed reschedule (destination outside business hours) leaves the original booking's slot and status completely unchanged",
    () => {
      const organizationId = randomUUID();
      const businessId = scalar(
        `INSERT INTO businesses (organization_id) VALUES ('${organizationId}') RETURNING id;`,
      );
      assertSucceeds(
        `INSERT INTO business_hours (business_id, day_of_week, is_closed, intervals)
         VALUES ('${businessId}', EXTRACT(DOW FROM '2026-11-30'::date)::smallint, false, '[{"start":"09:00","end":"17:00"}]'::jsonb);`,
        "seed limited hours",
      );
      const connectionId = scalar(
        `INSERT INTO google_calendar_connections (business_id) VALUES ('${businessId}') RETURNING id;`,
      );
      const booking = seedBooking({
        organizationId,
        businessId,
        connectionId,
        startIso: "2026-11-30T10:00:00+05:30",
        endIso: "2026-11-30T10:30:00+05:30",
      });

      assertRejected(
        rescheduleSql({
          organizationId,
          bookingId: booking,
          newStartIso: "2026-11-30T20:00:00+05:30", // outside the 09:00-17:00 window
          newEndIso: "2026-11-30T20:30:00+05:30",
        }),
        "SLOT_OUTSIDE_SCHEDULE",
        "rescheduling to a time outside business hours must be rejected",
      );

      // Compare the actual instants/status rather than a serialized
      // timestamp string — Postgres renders TIMESTAMPTZ in the session's
      // own timezone (UTC here), not the zone the literal was written in,
      // even though it's the identical instant either way.
      const row = scalar(
        `\\pset tuples_only on
SELECT (start_at = '2026-11-30T10:00:00+05:30'::timestamptz)::text || '|'
     || (end_at = '2026-11-30T10:30:00+05:30'::timestamptz)::text || '|' || status
   FROM bookings WHERE id = '${booking}';`,
      );
      assert.equal(
        row,
        "true|true|CONFIRMED",
        `a failed reschedule must leave the original slot and status completely unchanged, got: ${row}`,
      );
    },
  );

  pgTest(
    "rescheduling or cancelling a booking belonging to a DIFFERENT organization is rejected (authorization boundary)",
    () => {
      const { businessId, connectionId, organizationId } = seedOpenBusiness();
      const booking = seedBooking({
        organizationId,
        businessId,
        connectionId,
        startIso: "2026-12-01T09:00:00+05:30",
        endIso: "2026-12-01T09:30:00+05:30",
      });
      const otherOrgId = randomUUID();

      assertRejected(
        rescheduleSql({
          organizationId: otherOrgId,
          bookingId: booking,
          newStartIso: "2026-12-01T10:00:00+05:30",
          newEndIso: "2026-12-01T10:30:00+05:30",
        }),
        "BOOKING_NOT_FOUND",
        "rescheduling across an organization boundary must be rejected as not found, never leak existence",
      );
      assertRejected(
        cancelSql({ organizationId: otherOrgId, bookingId: booking }),
        "BOOKING_NOT_FOUND",
        "cancelling across an organization boundary must be rejected as not found",
      );

      const status = scalar(`SELECT status FROM bookings WHERE id = '${booking}';`);
      assert.equal(
        status,
        "CONFIRMED",
        "the booking must be completely unaffected by the rejected cross-org attempts",
      );
    },
  );

  pgTest("cancelling an already-cancelled booking is idempotent, not an error", () => {
    const { businessId, connectionId, organizationId } = seedOpenBusiness();
    const booking = seedBooking({
      organizationId,
      businessId,
      connectionId,
      startIso: "2026-12-02T09:00:00+05:30",
      endIso: "2026-12-02T09:30:00+05:30",
    });

    assertSucceeds(cancelSql({ organizationId, bookingId: booking }), "first cancel must succeed");
    assertSucceeds(
      cancelSql({ organizationId, bookingId: booking }),
      "cancelling an already-cancelled booking must succeed idempotently, not error",
    );
    const status = scalar(`SELECT status FROM bookings WHERE id = '${booking}';`);
    assert.equal(status, "CANCELLED");
  });

  pgTest("a cancelled booking can never be resurrected by a subsequent reschedule attempt", () => {
    const { businessId, connectionId, organizationId } = seedOpenBusiness();
    const booking = seedBooking({
      organizationId,
      businessId,
      connectionId,
      startIso: "2026-12-03T09:00:00+05:30",
      endIso: "2026-12-03T09:30:00+05:30",
    });
    assertSucceeds(cancelSql({ organizationId, bookingId: booking }), "cancel first");
    assertRejected(
      rescheduleSql({
        organizationId,
        bookingId: booking,
        newStartIso: "2026-12-03T14:00:00+05:30",
        newEndIso: "2026-12-03T14:30:00+05:30",
      }),
      "BOOKING_NOT_RESCHEDULABLE",
      "a cancelled booking must never be reschedulable back into an active state",
    );
    const status = scalar(`SELECT status FROM bookings WHERE id = '${booking}';`);
    assert.equal(status, "CANCELLED", "the booking must remain CANCELLED, never resurrected");
  });
});
