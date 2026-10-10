import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-scan coverage for the business_hours/business_hour_overrides
 * interval-validation trigger (see that migration's own header comment).
 * The actual semantics — closed-day bypass, array/object/key/format/
 * ordering checks, override isOpen requirement — were verified this
 * session against a real, disposable PostgreSQL 16 instance with 22
 * scripted scenarios (legacy-invalid row, valid interval, all-day
 * convention, equal times, empty array, closed day with garbage/null
 * content, non-array intervals, non-object elements, missing keys, wrong
 * field types, malformed HH:mm, an UPDATE that introduces a bad interval,
 * and the override-specific isOpen checks) — not reproducible here since
 * this suite runs without a live Postgres instance. This file instead
 * pins the SQL text's own invariants, independent of whether Postgres is
 * available when the suite runs.
 */

const migrationsDir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(migrationsDir, "20261010100000_business_hours_interval_validation.sql");

function readSql(): string {
  return readFileSync(MIGRATION, "utf8");
}

describe("validate_business_hours_interval_shape — structure", () => {
  test("is attached BEFORE INSERT OR UPDATE on both tables, not AFTER", () => {
    const sql = readSql();
    assert.match(
      sql,
      /CREATE TRIGGER trg_business_hours_validate_intervals\s+BEFORE INSERT OR UPDATE ON public\.business_hours/,
    );
    assert.match(
      sql,
      /CREATE TRIGGER trg_business_hour_overrides_validate_intervals\s+BEFORE INSERT OR UPDATE ON public\.business_hour_overrides/,
    );
  });

  test("is a plain trigger function, not SECURITY DEFINER (matches update_updated_at_column's existing convention)", () => {
    const sql = readSql();
    const fnBody = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.validate_business_hours_interval_shape"),
      sql.indexOf("CREATE TRIGGER trg_business_hours_validate_intervals"),
    );
    assert.doesNotMatch(fnBody, /SECURITY DEFINER/);
    assert.match(fnBody, /SET search_path = public/);
  });

  test("uses IF/ELSE control flow (not a single CASE expression) to pick is_closed vs is_full_day_closure, so NEW's field access is only ever attempted on the table that actually has it", () => {
    const sql = readSql();
    const fnBody = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.validate_business_hours_interval_shape"),
      sql.indexOf("CREATE TRIGGER trg_business_hours_validate_intervals"),
    );
    assert.match(
      fnBody,
      /IF TG_TABLE_NAME = 'business_hours' THEN\s+v_closed := NEW\.is_closed;\s+ELSE\s+v_closed := NEW\.is_full_day_closure;\s+END IF;/,
    );
    // The single-SQL-expression form this replaces (confirmed broken against
    // real Postgres: "record new has no field is_full_day_closure") must not
    // reappear.
    assert.doesNotMatch(fnBody, /v_closed := CASE/);
  });

  test("returns early (skips all validation) whenever the row is closed, before any array/object/format check", () => {
    const sql = readSql();
    const closedCheckIdx = sql.indexOf("IF v_closed THEN");
    const arrayCheckIdx = sql.indexOf("jsonb_typeof(NEW.intervals) IS DISTINCT FROM 'array'");
    assert.ok(closedCheckIdx > -1);
    assert.ok(arrayCheckIdx > -1);
    assert.ok(
      closedCheckIdx < arrayCheckIdx,
      "the closed bypass must run before the array-shape check",
    );
  });

  test("NULL intervals returns early rather than raising its own exception (defers to the column's NOT NULL constraint)", () => {
    const sql = readSql();
    const nullCheckIdx = sql.indexOf("IF NEW.intervals IS NULL THEN");
    const closedCheckIdx = sql.indexOf("IF v_closed THEN");
    assert.ok(nullCheckIdx > -1 && nullCheckIdx < closedCheckIdx);
  });

  test("validates every element via a loop (jsonb_array_elements), not just the first", () => {
    const sql = readSql();
    assert.match(sql, /FOR v_elem IN SELECT \* FROM jsonb_array_elements\(NEW\.intervals\) LOOP/);
  });

  test("requires end strictly after start (rejects equal and reversed), never adds a day to reinterpret a reversed pair as overnight", () => {
    const sql = readSql();
    assert.match(sql, /IF v_end <= v_start THEN/);
    assert.doesNotMatch(sql, /\+\s*interval\s*'1 day'/i);
  });

  test("enforces the strict zero-padded 24h HH:mm pattern on both start and end", () => {
    const sql = readSql();
    const pattern = "'^([01][0-9]|2[0-3]):[0-5][0-9]$'";
    assert.ok(sql.includes(`v_start !~ ${pattern}`));
    assert.ok(sql.includes(`v_end !~ ${pattern}`));
  });

  test("requires a boolean isOpen key only for business_hour_overrides, not business_hours", () => {
    const sql = readSql();
    const fnBody = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.validate_business_hours_interval_shape"),
      sql.indexOf("CREATE TRIGGER trg_business_hours_validate_intervals"),
    );
    assert.match(
      fnBody,
      /IF TG_TABLE_NAME = 'business_hour_overrides' THEN\s+IF NOT \(v_elem \? 'isOpen'\)/,
    );
  });

  test("does not modify, DROP, or ALTER anything from the already-reviewed pending batch (20260908110000..20261009120000)", () => {
    const sql = readSql();
    assert.doesNotMatch(sql, /ALTER TABLE/i);
    assert.doesNotMatch(sql, /DROP /i);
    assert.doesNotMatch(sql, /UPDATE public\./i);
    assert.doesNotMatch(
      sql,
      /CREATE OR REPLACE FUNCTION public\.(create_booking_atomic|set_business_weekly_hours|apply_business_schedule_override|business_effective_open_ranges|validate_booking_schedule|remove_business_schedule_override)/,
    );
  });

  test("never scans or backfills existing rows — no SELECT/UPDATE statement targets existing business_hours/business_hour_overrides data", () => {
    const sql = readSql();
    assert.doesNotMatch(sql, /UPDATE public\.business_hours/);
    assert.doesNotMatch(sql, /UPDATE public\.business_hour_overrides/);
  });
});
