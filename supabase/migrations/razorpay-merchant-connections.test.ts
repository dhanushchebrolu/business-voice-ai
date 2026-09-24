import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Coverage for the Razorpay merchant connection migration (Phase 3). No
 * live Postgres instance is available in this environment — a source
 * scan, matching the convention established by
 * google-calendar-and-bookings.test.ts.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(migrationsDir, "20260925090000_razorpay_merchant_connections.sql");

function readSql(): string {
  return readFileSync(MIGRATION, "utf8");
}

test("razorpay_connections enables row level security", () => {
  const sql = readSql();
  assert.match(sql, /ALTER TABLE public\.razorpay_connections ENABLE ROW LEVEL SECURITY;/);
});

test("no new oauth_states table is created — the existing provider-generic one is reused", () => {
  const sql = readSql();
  assert.doesNotMatch(sql, /CREATE TABLE public\.oauth_states/);
});

test("razorpay_connections scopes customer SELECT through is_org_member(organization_id)", () => {
  const sql = readSql();
  const tableBlock = sql.slice(sql.indexOf("CREATE TABLE public.razorpay_connections ("));
  assert.match(
    tableBlock.slice(0, tableBlock.indexOf("FOR SELECT TO authenticated") + 200),
    /public\.is_org_member\(organization_id\)/,
  );
});

test("razorpay_connections is never directly writable by authenticated (server-side only)", () => {
  const sql = readSql();
  assert.doesNotMatch(
    sql,
    /GRANT (INSERT|UPDATE|DELETE|ALL) ON public\.razorpay_connections TO authenticated/,
  );
});

test("encrypted_credentials is excluded from the authenticated SELECT grant", () => {
  const sql = readSql();
  assert.match(sql, /REVOKE SELECT ON public\.razorpay_connections FROM authenticated;/);
  const grantMatch = sql.match(
    /GRANT SELECT \(([\s\S]*?)\) ON public\.razorpay_connections TO authenticated;/,
  );
  assert.ok(grantMatch, "expected an explicit column-list SELECT grant on razorpay_connections");
  const columns = grantMatch![1]!;
  assert.doesNotMatch(columns, /encrypted_credentials/);
  assert.match(columns, /\bconnection_status\b/);
  assert.match(columns, /\bmerchant_status\b/);
});

test("connection_status and merchant_status are kept as separate, distinct concepts", () => {
  const sql = readSql();
  assert.match(sql, /connection_status TEXT NOT NULL DEFAULT 'DISCONNECTED'/);
  assert.match(sql, /merchant_status TEXT,/);
  // merchant_status must not be constrained to the same enum as connection_status
  const merchantStatusLine = sql.split("\n").find((l) => l.trim().startsWith("merchant_status"));
  assert.ok(merchantStatusLine);
  assert.doesNotMatch(merchantStatusLine!, /CHECK/);
});

test("connection_status is constrained to the documented lifecycle", () => {
  const sql = readSql();
  const constraintMatch = sql.match(/CHECK \(connection_status IN \(([\s\S]*?)\)\),/);
  assert.ok(constraintMatch, "expected a connection_status CHECK constraint");
  const allowed = constraintMatch![1]!;
  for (const value of ["DISCONNECTED", "CONNECTING", "CONNECTED", "REAUTH_REQUIRED", "ERROR"]) {
    assert.match(
      allowed,
      new RegExp(`'${value}'`),
      `expected connection_status '${value}' to be allowed`,
    );
  }
});

test("one active connection per (organization, business, provider) — supports future non-Razorpay providers", () => {
  const sql = readSql();
  assert.match(sql, /UNIQUE \(organization_id, business_id, provider\)/);
});

test("cascade-deletes with its owning organization and business", () => {
  const sql = readSql();
  const tableBlock = sql.slice(
    sql.indexOf("CREATE TABLE public.razorpay_connections ("),
    sql.indexOf("CREATE TABLE public.razorpay_connections (") + 800,
  );
  assert.match(
    tableBlock,
    /organization_id UUID NOT NULL REFERENCES public\.organizations\(id\) ON DELETE CASCADE,/,
  );
  assert.match(
    tableBlock,
    /business_id UUID NOT NULL REFERENCES public\.businesses\(id\) ON DELETE CASCADE,/,
  );
});

test("does not touch platform billing tables or create Phase 4 payment-transaction tables", () => {
  const sql = readSql();
  for (const forbidden of [
    "ALTER TABLE public.payment_orders",
    "ALTER TABLE public.payments",
    "ALTER TABLE public.webhook_events",
    "CREATE TABLE public.payment_requests",
    "CREATE TABLE public.payment_transactions",
    "CREATE TABLE public.payment_events",
  ]) {
    assert.equal(sql.includes(forbidden), false, `must not touch/create ${forbidden}`);
  }
});

test("does not DROP or DELETE anything (purely additive)", () => {
  const sql = readSql();
  assert.doesNotMatch(sql, /\bDROP\b/);
  assert.doesNotMatch(sql, /\bDELETE FROM\b/);
});
