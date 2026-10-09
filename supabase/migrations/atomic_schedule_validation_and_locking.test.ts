import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Coverage for the staff-closes-a-slot-vs-AI-books-it race fix (see this
 * migration's own header comment). A source scan — same documented
 * limitation as atomic_booking_creation.test.ts regarding genuine
 * concurrent-session behavior — but this change was ALSO verified against
 * a real disposable PostgreSQL 16 instance this session (functional
 * sanity checks for every scenario below, plus real concurrent psql
 * processes for the actual races); see the session's own final report for
 * those results. This file verifies the SQL text establishes the
 * invariants the fix requires, independent of whether a live Postgres
 * instance happens to be available when this suite runs in CI.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(migrationsDir, "20261009120000_atomic_schedule_validation_and_locking.sql");

function readSql(): string {
  return readFileSync(MIGRATION, "utf8");
}

function slice(sql: string, startMarker: string, endMarker?: string): string {
  const start = sql.indexOf(startMarker);
  assert.ok(start > -1, `expected to find "${startMarker}"`);
  const end = endMarker ? sql.indexOf(endMarker, start) : sql.length;
  assert.ok(!endMarker || end > -1, `expected to find "${endMarker}" after "${startMarker}"`);
  return sql.slice(start, end === -1 ? undefined : end);
}

describe("create_booking_atomic — the per-business lock and schedule validation are inside the transaction", () => {
  test("acquires the per-business advisory lock (salt 1) before anything else, and before the pre-existing per-calendar-connection lock (salt 0)", () => {
    const sql = readSql();
    const fnBody = slice(
      sql,
      "CREATE OR REPLACE FUNCTION public.create_booking_atomic(",
      "CREATE OR REPLACE FUNCTION public.apply_business_schedule_override(",
    );
    const businessLockIdx = fnBody.indexOf(
      "pg_advisory_xact_lock(hashtextextended(p_business_id::text, 1))",
    );
    const connectionLockIdx = fnBody.indexOf(
      "pg_advisory_xact_lock(hashtextextended(p_calendar_connection_id::text, 0))",
    );
    assert.ok(businessLockIdx > -1, "expected a per-business advisory lock at salt 1");
    assert.ok(
      connectionLockIdx > -1,
      "expected the pre-existing per-calendar-connection lock, unchanged",
    );
    assert.ok(
      businessLockIdx < connectionLockIdx,
      "the business lock must be acquired BEFORE the calendar-connection lock — fixed, one-directional ordering so the two lock spaces can never deadlock",
    );
  });

  test("calls validate_booking_schedule after the business lock and before the connection lock/overlap check/insert", () => {
    const sql = readSql();
    const fnBody = slice(
      sql,
      "CREATE OR REPLACE FUNCTION public.create_booking_atomic(",
      "CREATE OR REPLACE FUNCTION public.apply_business_schedule_override(",
    );
    const businessLockIdx = fnBody.indexOf(
      "pg_advisory_xact_lock(hashtextextended(p_business_id::text, 1))",
    );
    const validateIdx = fnBody.indexOf("public.validate_booking_schedule(");
    const connectionLockIdx = fnBody.indexOf(
      "pg_advisory_xact_lock(hashtextextended(p_calendar_connection_id::text, 0))",
    );
    const insertIdx = fnBody.indexOf("INSERT INTO public.bookings");
    assert.ok(
      businessLockIdx < validateIdx,
      "schedule validation must run after acquiring the business lock",
    );
    assert.ok(
      validateIdx < connectionLockIdx,
      "schedule validation must run before the connection lock",
    );
    assert.ok(validateIdx < insertIdx, "schedule validation must run before the insert");
  });

  test("the idempotency check still runs first, before any lock — an already-resolved retry needs neither", () => {
    const sql = readSql();
    const fnBody = slice(
      sql,
      "CREATE OR REPLACE FUNCTION public.create_booking_atomic(",
      "CREATE OR REPLACE FUNCTION public.apply_business_schedule_override(",
    );
    const idempotencyIdx = fnBody.indexOf("IF p_idempotency_key IS NOT NULL THEN");
    const businessLockIdx = fnBody.indexOf(
      "pg_advisory_xact_lock(hashtextextended(p_business_id::text, 1))",
    );
    assert.ok(idempotencyIdx > -1 && idempotencyIdx < businessLockIdx);
  });

  test("the pre-existing overlap check and insert are preserved verbatim below the new lock/validation", () => {
    const sql = readSql();
    assert.match(
      sql,
      /status NOT IN \('CANCELLED', 'NO_SHOW', 'PAYMENT_EXPIRED', 'PAYMENT_FAILED'\)/,
    );
    assert.match(sql, /start_at < p_end_at\s+AND\s+end_at > p_start_at/);
    assert.match(sql, /RAISE EXCEPTION 'SLOT_NO_LONGER_AVAILABLE'/);
  });
});

describe("business_effective_open_ranges — precedence matches calendar-service.server.ts", () => {
  test("a full-day closure override returns immediately with no open ranges, before even reading business_hours", () => {
    const sql = readSql();
    const fnBody = slice(
      sql,
      "CREATE OR REPLACE FUNCTION public.business_effective_open_ranges(",
      "REVOKE ALL ON FUNCTION public.business_effective_open_ranges",
    );
    const fullDayIdx = fnBody.indexOf("v_override.is_full_day_closure THEN");
    const hoursSelectIdx = fnBody.indexOf("SELECT * INTO v_hours FROM public.business_hours");
    assert.ok(fullDayIdx > -1 && fullDayIdx < hoursSelectIdx);
  });

  test("override 'close' intervals are applied as a subtraction AFTER the merge of weekly hours + override 'opens' — closes always win", () => {
    const sql = readSql();
    const fnBody = slice(
      sql,
      "CREATE OR REPLACE FUNCTION public.business_effective_open_ranges(",
      "REVOKE ALL ON FUNCTION public.business_effective_open_ranges",
    );
    const mergeIdx = fnBody.indexOf("-- Single merge pass");
    const subtractIdx = fnBody.indexOf("-- Apply each close as a subtraction");
    assert.ok(mergeIdx > -1 && subtractIdx > -1 && mergeIdx < subtractIdx);
  });

  test("uses AT TIME ZONE for wall-clock <-> instant conversion, never naive UTC arithmetic on the local HH:mm strings", () => {
    const sql = readSql();
    const occurrences = (sql.match(/AT TIME ZONE p_timezone/g) ?? []).length;
    assert.ok(occurrences >= 3, "expected multiple wall-clock conversions through AT TIME ZONE");
  });
});

describe("staff-side schedule mutations take the SAME business lock as create_booking_atomic", () => {
  for (const fn of [
    "apply_business_schedule_override",
    "remove_business_schedule_override",
    "set_business_weekly_hours",
  ]) {
    test(`${fn} acquires pg_advisory_xact_lock(hashtextextended(p_business_id::text, 1)) before touching the schedule`, () => {
      const sql = readSql();
      const fnBody = slice(sql, `CREATE OR REPLACE FUNCTION public.${fn}(`);
      const bodyEnd = fnBody.indexOf("$$;");
      const body = fnBody.slice(0, bodyEnd);
      assert.match(body, /pg_advisory_xact_lock\(hashtextextended\(p_business_id::text, 1\)\)/);
    });
  }

  test("apply_business_schedule_override rejects a full-day closure that would cover an existing active booking", () => {
    const sql = readSql();
    const fnBody = slice(
      sql,
      "CREATE OR REPLACE FUNCTION public.apply_business_schedule_override(",
      "REVOKE ALL ON FUNCTION public.apply_business_schedule_override",
    );
    assert.match(
      fnBody,
      /IF p_is_full_day_closure THEN[\s\S]*?RAISE EXCEPTION 'CANNOT_CLOSE_SLOT_WITH_ACTIVE_BOOKING'/,
    );
  });

  test("apply_business_schedule_override rejects a specific close interval that overlaps an existing active booking", () => {
    const sql = readSql();
    const fnBody = slice(
      sql,
      "CREATE OR REPLACE FUNCTION public.apply_business_schedule_override(",
      "REVOKE ALL ON FUNCTION public.apply_business_schedule_override",
    );
    const elseIdx = fnBody.indexOf("ELSE");
    const afterElse = fnBody.slice(elseIdx);
    assert.match(afterElse, /isOpen/);
    assert.match(afterElse, /RAISE EXCEPTION 'CANNOT_CLOSE_SLOT_WITH_ACTIVE_BOOKING'/);
  });

  test("the active-booking conflict check excludes CANCELLED/NO_SHOW/PAYMENT_EXPIRED/PAYMENT_FAILED, matching create_booking_atomic's own exclusion list", () => {
    const sql = readSql();
    const fnBody = slice(
      sql,
      "CREATE OR REPLACE FUNCTION public.apply_business_schedule_override(",
      "REVOKE ALL ON FUNCTION public.apply_business_schedule_override",
    );
    for (const status of ["CANCELLED", "NO_SHOW", "PAYMENT_EXPIRED", "PAYMENT_FAILED"]) {
      assert.match(fnBody, new RegExp(status));
    }
  });

  test("remove_business_schedule_override takes the lock but performs no active-booking conflict check — removal can only ever widen the schedule, never invalidate a booking", () => {
    const sql = readSql();
    const fnBody = slice(
      sql,
      "CREATE OR REPLACE FUNCTION public.remove_business_schedule_override(",
      "REVOKE ALL ON FUNCTION public.remove_business_schedule_override",
    );
    assert.doesNotMatch(fnBody, /CANNOT_CLOSE_SLOT_WITH_ACTIVE_BOOKING/);
    assert.match(fnBody, /DELETE FROM public.business_hour_overrides/);
  });
});

describe("grants — every new function follows the existing service_role-only convention", () => {
  for (const fn of [
    "business_effective_open_ranges",
    "validate_booking_schedule",
    "apply_business_schedule_override",
    "remove_business_schedule_override",
    "set_business_weekly_hours",
  ]) {
    test(`${fn} revokes PUBLIC/anon/authenticated and grants only service_role`, () => {
      const sql = readSql();
      assert.match(
        sql,
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM PUBLIC, anon, authenticated`),
      );
      assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn} TO service_role`));
    });
  }
});
