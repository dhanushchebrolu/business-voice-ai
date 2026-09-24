import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Coverage for the Phase 4 customer-payments migration. No live Postgres
 * instance is available in this environment — a source scan, matching the
 * convention established by razorpay-merchant-connections.test.ts.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(migrationsDir, "20260926090000_customer_payments.sql");

function readSql(): string {
  return readFileSync(MIGRATION, "utf8");
}

test("payment_requests enables row level security with a tenant-scoped SELECT policy", () => {
  const sql = readSql();
  assert.match(sql, /ALTER TABLE public\.payment_requests ENABLE ROW LEVEL SECURITY;/);
  const tableBlock = sql.slice(sql.indexOf("CREATE TABLE public.payment_requests ("));
  assert.match(
    tableBlock.slice(0, tableBlock.indexOf("FOR SELECT TO authenticated") + 200),
    /public\.is_org_member\(organization_id\)/,
  );
});

test("payment_requests is never directly writable by authenticated (server-side only)", () => {
  const sql = readSql();
  assert.doesNotMatch(
    sql,
    /GRANT (INSERT|UPDATE|DELETE|ALL) ON public\.payment_requests TO authenticated/,
  );
});

test("payment_webhook_events and payment_domain_events are fully server-only (no authenticated access at all)", () => {
  const sql = readSql();
  for (const table of ["payment_webhook_events", "payment_domain_events"]) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`REVOKE ALL ON public\\.${table} FROM authenticated, anon;`));
    // Scope the "no CREATE POLICY" check to this table's own CREATE TABLE
    // block, not the whole file — an unscoped scan would false-positive on
    // an earlier table's CREATE POLICY followed, anywhere later in the
    // file, by this table's name appearing in prose comments.
    const blockStart = sql.indexOf(`CREATE TABLE public.${table} (`);
    assert.ok(blockStart > -1, `expected to find CREATE TABLE public.${table}`);
    const nextTableStart = sql.indexOf("CREATE TABLE public.", blockStart + 1);
    const block = sql.slice(blockStart, nextTableStart === -1 ? undefined : nextTableStart);
    assert.doesNotMatch(block, /CREATE POLICY/);
  }
});

test("payment_webhook_events is a separate table from the platform payment_orders/payments idempotency ledger (webhook_events) — no shared namespace", () => {
  const sql = readSql();
  assert.match(sql, /CREATE TABLE public\.payment_webhook_events/);
  assert.doesNotMatch(sql, /CREATE TABLE public\.webhook_events/);
  assert.doesNotMatch(sql, /ALTER TABLE public\.webhook_events/);
});

test("does not touch ClickAI's own platform billing tables or razorpay_connections' shape", () => {
  const sql = readSql();
  for (const forbidden of [
    "ALTER TABLE public.payment_orders",
    "ALTER TABLE public.payments",
    "ALTER TABLE public.invoices",
    "ALTER TABLE public.webhook_events",
    "ALTER TABLE public.razorpay_connections",
    "DROP TABLE public.payment_orders",
    "DROP TABLE public.payments",
  ]) {
    assert.equal(sql.includes(forbidden), false, `must not touch ${forbidden}`);
  }
});

test("payment_requests references razorpay_connections read-only (no new columns added to it)", () => {
  const sql = readSql();
  assert.match(
    sql,
    /razorpay_connection_id UUID NOT NULL REFERENCES public\.razorpay_connections\(id\)/,
  );
});

test("one active payment request per booking is enforced at the database level", () => {
  const sql = readSql();
  assert.match(
    sql,
    /CREATE UNIQUE INDEX idx_payment_requests_one_active_per_booking\s+ON public\.payment_requests \(booking_id\)\s+WHERE status IN \('CREATED', 'PENDING', 'CAPTURED'\);/,
  );
});

test("payment_requests amounts are positive integer minor units with an explicit currency", () => {
  const sql = readSql();
  assert.match(sql, /amount_minor_units INTEGER NOT NULL CHECK \(amount_minor_units > 0\)/);
  assert.match(sql, /currency TEXT NOT NULL DEFAULT 'INR'/);
});

test("payment_requests status is constrained to the documented lifecycle", () => {
  const sql = readSql();
  const constraintMatch = sql.match(
    /CREATE TABLE public\.payment_requests[\s\S]*?status TEXT NOT NULL DEFAULT 'CREATED' CHECK \(status IN \(([\s\S]*?)\)\),/,
  );
  assert.ok(constraintMatch, "expected a payment_requests status CHECK constraint");
  const allowed = constraintMatch![1]!;
  for (const value of ["CREATED", "PENDING", "CAPTURED", "FAILED", "EXPIRED", "CANCELLED"]) {
    assert.match(allowed, new RegExp(`'${value}'`), `expected status '${value}' to be allowed`);
  }
});

test("payment_requests has a retry-safe idempotency key unique per organization", () => {
  const sql = readSql();
  assert.match(sql, /idempotency_key TEXT NOT NULL,/);
  assert.match(sql, /UNIQUE \(organization_id, idempotency_key\)/);
});

test("payment_domain_events covers the documented event types including late-capture reconciliation", () => {
  const sql = readSql();
  const constraintMatch = sql.match(
    /event_type TEXT NOT NULL CHECK \(event_type IN \(([\s\S]*?)\)\),/,
  );
  assert.ok(constraintMatch, "expected a payment_domain_events event_type CHECK constraint");
  const allowed = constraintMatch![1]!;
  for (const value of [
    "PAYMENT_CAPTURED",
    "PAYMENT_FAILED",
    "PAYMENT_EXPIRED",
    "PAYMENT_CAPTURED_AFTER_EXPIRY",
  ]) {
    assert.match(allowed, new RegExp(`'${value}'`), `expected event_type '${value}' to be allowed`);
  }
});

test("payment_domain_events tracks each consumer's dispatch independently (fault isolation)", () => {
  const sql = readSql();
  for (const col of ["calendar_dispatched_at", "whatsapp_dispatched_at", "voice_dispatched_at"]) {
    assert.match(sql, new RegExp(`${col} TIMESTAMPTZ`));
  }
});

test("bookings.status CHECK is widened additively — every original value is preserved", () => {
  const sql = readSql();
  const constraintMatch = sql.match(
    /ALTER TABLE public\.bookings ADD CONSTRAINT bookings_status_check CHECK \(status IN \(([\s\S]*?)\)\);/,
  );
  assert.ok(constraintMatch, "expected a widened bookings_status_check constraint");
  const allowed = constraintMatch![1]!;
  for (const value of [
    "DRAFT",
    "PENDING_CONFIRMATION",
    "CONFIRMED",
    "RESCHEDULED",
    "CANCELLED",
    "COMPLETED",
    "NO_SHOW",
    "CALENDAR_SYNC_FAILED",
    "PENDING_PAYMENT",
    "PAYMENT_FAILED",
    "PAYMENT_EXPIRED",
  ]) {
    assert.match(
      allowed,
      new RegExp(`'${value}'`),
      `expected bookings status '${value}' to be allowed`,
    );
  }
});

test("bookings gains hold_expires_at and call_id as additive, nullable columns", () => {
  const sql = readSql();
  assert.match(sql, /ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ;/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS call_id TEXT;/);
});

test("the exact-start-time double-booking guard now releases expired/failed holds, and still blocks a live PENDING_PAYMENT hold", () => {
  const sql = readSql();
  const indexMatch = sql.match(
    /CREATE UNIQUE INDEX idx_bookings_no_exact_start_clash\s+ON public\.bookings \(calendar_connection_id, start_at\)\s+WHERE status NOT IN \(([\s\S]*?)\)/,
  );
  assert.ok(indexMatch, "expected the widened idx_bookings_no_exact_start_clash index");
  const excluded = indexMatch![1]!;
  for (const value of ["CANCELLED", "NO_SHOW", "PAYMENT_EXPIRED", "PAYMENT_FAILED"]) {
    assert.match(excluded, new RegExp(`'${value}'`), `expected '${value}' to release the slot`);
  }
  // PENDING_PAYMENT must NOT be in the exclusion list — a live hold still blocks the slot.
  assert.doesNotMatch(excluded, /'PENDING_PAYMENT'/);
});

test("create_booking_payment_hold is restricted to service_role only", () => {
  const sql = readSql();
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION public\.create_booking_payment_hold FROM PUBLIC, anon, authenticated;/,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION public\.create_booking_payment_hold TO service_role;/,
  );
});

test("create_booking_payment_hold is idempotent on (organization_id, idempotency_key) before taking any lock", () => {
  const sql = readSql();
  const fnBlock = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.create_booking_payment_hold"),
  );
  const idempotencyIdx = fnBlock.indexOf("IF p_idempotency_key IS NOT NULL THEN");
  const lockIdx = fnBlock.indexOf("pg_advisory_xact_lock");
  assert.ok(idempotencyIdx > -1 && lockIdx > -1);
  assert.ok(
    idempotencyIdx < lockIdx,
    "idempotency short-circuit must run before the advisory lock",
  );
});

test("create_booking_payment_hold takes a per-calendar-connection advisory lock before its overlap check, closing the check-then-insert race", () => {
  const sql = readSql();
  const fnBlock = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.create_booking_payment_hold"),
  );
  const lockIdx = fnBlock.indexOf("pg_advisory_xact_lock");
  const overlapIdx = fnBlock.indexOf("start_at < p_end_at");
  const insertIdx = fnBlock.indexOf("INSERT INTO public.bookings");
  assert.ok(lockIdx > -1 && overlapIdx > -1 && insertIdx > -1);
  assert.ok(lockIdx < overlapIdx && overlapIdx < insertIdx);
  assert.match(
    sql,
    /pg_advisory_xact_lock\(hashtextextended\(p_calendar_connection_id::text, 0\)\)/,
  );
});

test("create_booking_payment_hold rejects a true time-range overlap, not just an exact-start-time clash", () => {
  const sql = readSql();
  const fnBlock = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.create_booking_payment_hold"),
  );
  assert.match(fnBlock, /start_at < p_end_at\s*\n\s*AND end_at > p_start_at/);
  assert.match(fnBlock, /RAISE EXCEPTION 'SLOT_NO_LONGER_AVAILABLE';/);
});

test("create_booking_payment_hold always inserts with status PENDING_PAYMENT, never CONFIRMED directly", () => {
  const sql = readSql();
  const fnBlock = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.create_booking_payment_hold"),
  );
  const insertBlock = fnBlock.slice(fnBlock.indexOf("INSERT INTO public.bookings"));
  assert.match(insertBlock, /'PENDING_PAYMENT'/);
  assert.doesNotMatch(insertBlock.slice(0, insertBlock.indexOf(")")), /'CONFIRMED'/);
});

test("does not DROP any table and does not DELETE any data (purely additive)", () => {
  const sql = readSql();
  assert.doesNotMatch(sql, /\bDROP TABLE\b/);
  assert.doesNotMatch(sql, /\bDELETE FROM\b/);
});
