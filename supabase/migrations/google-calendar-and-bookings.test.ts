import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Coverage for the Google Calendar + bookings migration (Phase 2). No live
 * Postgres instance is available in this environment (see
 * phone-number-pool.test.ts's doc comment for why every migration test here
 * is a source scan, not an execution test) — these assertions verify the
 * SQL text contains the specific isolation/security invariants this
 * migration is required to establish.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(migrationsDir, "20260924090000_google_calendar_and_bookings.sql");

function readSql(): string {
  return readFileSync(MIGRATION, "utf8");
}

test("all three tables enable row level security", () => {
  const sql = readSql();
  for (const table of ["oauth_states", "google_calendar_connections", "bookings"]) {
    assert.match(
      sql,
      new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY;`),
      `expected RLS enabled on ${table}`,
    );
  }
});

test("oauth_states has no authenticated-readable or authenticated-writable policy at all", () => {
  const sql = readSql();
  assert.match(sql, /REVOKE ALL ON public\.oauth_states FROM authenticated, anon;/);
  assert.doesNotMatch(sql, /CREATE POLICY[\s\S]{0,200}ON public\.oauth_states/);
});

test("google_calendar_connections and bookings scope customer SELECT through is_org_member(organization_id)", () => {
  const sql = readSql();
  for (const table of ["google_calendar_connections", "bookings"]) {
    const tableBlock = sql.slice(sql.indexOf(`CREATE TABLE public.${table} (`));
    assert.match(
      tableBlock.slice(0, tableBlock.indexOf("FOR SELECT TO authenticated") + 200),
      /public\.is_org_member\(organization_id\)/,
      `expected ${table}'s SELECT policy to gate on is_org_member(organization_id)`,
    );
  }
});

test("bookings is never directly writable by authenticated (server-side only)", () => {
  const sql = readSql();
  assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE|ALL) ON public\.bookings TO authenticated/);
});

test("encrypted_credentials is excluded from the authenticated SELECT grant on google_calendar_connections", () => {
  const sql = readSql();
  assert.match(sql, /REVOKE SELECT ON public\.google_calendar_connections FROM authenticated;/);
  const grantMatch = sql.match(
    /GRANT SELECT \(([\s\S]*?)\) ON public\.google_calendar_connections TO authenticated;/,
  );
  assert.ok(
    grantMatch,
    "expected an explicit column-list SELECT grant on google_calendar_connections",
  );
  const columns = grantMatch![1]!;
  assert.doesNotMatch(columns, /encrypted_credentials/);
  assert.match(columns, /\bstatus\b/);
  assert.match(columns, /\bcalendar_id\b/);
});

test("bookings.status is constrained and deliberately does not yet include PENDING_PAYMENT", () => {
  const sql = readSql();
  const constraintMatch = sql.match(/CHECK \(status IN \(([\s\S]*?)\)\),/);
  assert.ok(constraintMatch, "expected a bookings status CHECK constraint");
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
  ]) {
    assert.match(allowed, new RegExp(`'${value}'`), `expected status '${value}' to be allowed`);
  }
  assert.doesNotMatch(allowed, /'PENDING_PAYMENT'/);
});

test("bookings prevents duplicate creation via a per-organization idempotency key", () => {
  const sql = readSql();
  assert.match(sql, /UNIQUE \(organization_id, idempotency_key\)/);
});

test("bookings guards against an exact-start-time clash on the same calendar connection", () => {
  const sql = readSql();
  assert.match(
    sql,
    /CREATE UNIQUE INDEX idx_bookings_no_exact_start_clash\s*\n\s*ON public\.bookings \(calendar_connection_id, start_at\)\s*\n\s*WHERE status NOT IN \('CANCELLED', 'NO_SHOW'\) AND calendar_connection_id IS NOT NULL;/,
  );
});

test("bookings.end_at is constrained to be after start_at", () => {
  const sql = readSql();
  assert.match(sql, /end_at TIMESTAMPTZ NOT NULL CHECK \(end_at > start_at\),/);
});

test("google_calendar_connections is unique per (organization, business, provider)", () => {
  const sql = readSql();
  assert.match(sql, /UNIQUE \(organization_id, business_id, provider\)/);
});

test("bookings links to the existing contacts/agent_configs/services models rather than duplicating them", () => {
  const sql = readSql();
  assert.match(sql, /contact_id UUID REFERENCES public\.contacts\(id\) ON DELETE SET NULL,/);
  assert.match(
    sql,
    /agent_config_id UUID REFERENCES public\.agent_configs\(id\) ON DELETE SET NULL,/,
  );
  assert.match(sql, /service_id UUID REFERENCES public\.services\(id\) ON DELETE SET NULL,/);
});

test("all three tables cascade-delete with their owning organization", () => {
  const sql = readSql();
  for (const table of ["oauth_states", "google_calendar_connections", "bookings"]) {
    const tableBlock = sql.slice(
      sql.indexOf(`CREATE TABLE public.${table} (`),
      sql.indexOf(`CREATE TABLE public.${table} (`) + 800,
    );
    assert.match(
      tableBlock,
      /organization_id UUID NOT NULL REFERENCES public\.organizations\(id\) ON DELETE CASCADE,/,
      `expected ${table}.organization_id to cascade-delete with organizations`,
    );
  }
});

test("does not touch platform billing tables (payment_orders/payments/webhook_events/payment_connections/payment_transactions)", () => {
  const sql = readSql();
  for (const forbidden of [
    "ALTER TABLE public.payment_orders",
    "ALTER TABLE public.payments",
    "ALTER TABLE public.webhook_events",
    "CREATE TABLE public.payment_connections",
    "CREATE TABLE public.payment_transactions",
    "CREATE TABLE public.payment_requests",
    "CREATE TABLE public.payment_events",
  ]) {
    assert.equal(sql.includes(forbidden), false, `must not touch/create ${forbidden}`);
  }
});
