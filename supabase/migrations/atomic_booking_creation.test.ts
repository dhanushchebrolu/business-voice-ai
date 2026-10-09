import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Coverage for the atomic-booking-creation migration (Round F: closes the
 * DB-level double-booking race for the direct/voice booking path — see
 * booking-service.server.ts's createBooking doc comment for the full
 * story). No live Postgres instance is available in this environment
 * (see phone-number-pool.test.ts's doc comment for why every migration
 * test here is a source scan, not an execution test) — these assertions
 * verify the SQL text actually establishes the locking/overlap/grant
 * invariants this migration is required to establish. Genuine concurrent-
 * request behavior (two real simultaneous callers racing against a real
 * Postgres advisory lock) is NOT provable in this sandbox; see this
 * repository's own test report for that acknowledged limitation.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(migrationsDir, "20261009090000_atomic_booking_creation.sql");

function readSql(): string {
  return readFileSync(MIGRATION, "utf8");
}

test("create_booking_atomic takes a pg_advisory_xact_lock keyed on the calendar connection before checking for conflicts", () => {
  const sql = readSql();
  const fnBody = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.create_booking_atomic("),
    sql.indexOf("CREATE OR REPLACE FUNCTION public.create_booking_payment_hold("),
  );
  const lockIdx = fnBody.indexOf("pg_advisory_xact_lock(hashtextextended(p_calendar_connection_id");
  assert.ok(lockIdx > -1, "expected an advisory lock keyed on the calendar connection");

  const conflictIdx = fnBody.indexOf("start_at < p_end_at");
  assert.ok(conflictIdx > -1, "expected a full time-range overlap check, not an exact-start check");
  assert.ok(lockIdx < conflictIdx, "the lock must be acquired BEFORE the conflict check runs");

  const insertIdx = fnBody.indexOf("INSERT INTO public.bookings");
  assert.ok(conflictIdx < insertIdx, "the conflict check must run BEFORE the insert");
});

test("create_booking_atomic's overlap check uses proper interval overlap (start < other_end AND end > other_start), not an exact-start comparison", () => {
  const sql = readSql();
  assert.match(sql, /start_at < p_end_at\s+AND\s+end_at > p_start_at/);
});

test("create_booking_atomic excludes CANCELLED/NO_SHOW/PAYMENT_EXPIRED/PAYMENT_FAILED from the conflict set, matching the existing exact-start index's own exclusion list", () => {
  const sql = readSql();
  const fnBody = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.create_booking_atomic("));
  const conflictBlock = fnBody.slice(
    fnBody.indexOf("WHERE calendar_connection_id"),
    fnBody.indexOf("start_at < p_end_at") + 50,
  );
  for (const status of ["CANCELLED", "NO_SHOW", "PAYMENT_EXPIRED", "PAYMENT_FAILED"]) {
    assert.match(conflictBlock, new RegExp(status));
  }
});

test("create_booking_atomic checks idempotency BEFORE taking the lock, returning the existing row rather than raising or inserting again", () => {
  const sql = readSql();
  const fnBody = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.create_booking_atomic("),
    sql.indexOf("CREATE OR REPLACE FUNCTION public.create_booking_payment_hold("),
  );
  const idempotencyIdx = fnBody.indexOf("p_idempotency_key IS NOT NULL");
  const lockIdx = fnBody.indexOf("pg_advisory_xact_lock");
  assert.ok(idempotencyIdx > -1 && lockIdx > -1);
  assert.ok(
    idempotencyIdx < lockIdx,
    "idempotency short-circuit must come before the lock is taken",
  );
});

test("create_booking_payment_hold is redefined as a thin wrapper delegating to create_booking_atomic, rather than duplicating the lock/overlap logic a second time", () => {
  const sql = readSql();
  const walletFnBody = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.create_booking_payment_hold("),
  );
  assert.match(walletFnBody, /SELECT public\.create_booking_atomic\(/);
  assert.doesNotMatch(
    walletFnBody,
    /pg_advisory_xact_lock/,
    "the wrapper must not re-implement the lock itself",
  );
  assert.match(walletFnBody, /'PENDING_PAYMENT'/);
});

test("both functions are SECURITY DEFINER with a fixed search_path and EXECUTE restricted to service_role only", () => {
  const sql = readSql();
  for (const fn of ["create_booking_atomic", "create_booking_payment_hold"]) {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    const nextFnOrEof =
      sql.indexOf("CREATE OR REPLACE FUNCTION", start + 1) === -1
        ? sql.length
        : sql.indexOf("CREATE OR REPLACE FUNCTION", start + 1);
    const block = sql.slice(start, nextFnOrEof);
    assert.match(block, /SECURITY DEFINER/);
    assert.match(block, /SET search_path = public/);
    assert.match(
      block,
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn} FROM PUBLIC, anon, authenticated;`),
    );
    assert.match(block, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn} TO service_role;`));
  }
});

test("no new Postgres extension is added — the overlap guarantee comes from the advisory lock, not btree_gist/EXCLUDE", () => {
  const sql = readSql();
  assert.doesNotMatch(sql, /CREATE EXTENSION/i);
  assert.doesNotMatch(sql, /EXCLUDE USING/i);
});
