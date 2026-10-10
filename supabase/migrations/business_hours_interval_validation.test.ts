import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-scan coverage for the business_hours/business_hour_overrides
 * interval-validation trigger (see that migration's own header comment).
 * This pins the SQL text's own invariants independent of whether
 * PostgreSQL happens to be available when this suite runs.
 *
 * The actual executable semantics — closed-row bypass, array/object/key/
 * format/ordering checks, the override isOpen requirement, and (as of
 * this file's sibling) the unrelated-update skip condition — are covered
 * by business_hours_interval_validation.pg.test.ts, which creates a real,
 * disposable PostgreSQL instance, loads this exact migration file, and
 * runs genuine INSERT/UPDATE statements against it. That file supplements
 * this one rather than replacing it: it skips itself (via t.skip, visibly
 * reported, never silently) when no usable PostgreSQL installation is
 * found, so this source-scan file is what still runs everywhere.
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

  test("on UPDATE, skips re-validation when neither the closed-flag nor intervals changed from OLD — but only on UPDATE, never on INSERT", () => {
    const sql = readSql();
    const fnBody = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.validate_business_hours_interval_shape"),
      sql.indexOf("CREATE TRIGGER trg_business_hours_validate_intervals"),
    );
    assert.match(fnBody, /IF TG_OP = 'UPDATE' THEN/);
    assert.match(
      fnBody,
      /v_closed IS NOT DISTINCT FROM v_old_closed\s+AND NEW\.intervals IS NOT DISTINCT FROM OLD\.intervals THEN\s+RETURN NEW;/,
    );
    // OLD is unassigned on INSERT — referencing it outside an
    // `IF TG_OP = 'UPDATE'` guard would error at runtime, so the OLD
    // comparison must appear strictly after that guard opens, never
    // unconditionally.
    const tgOpIdx = fnBody.indexOf("IF TG_OP = 'UPDATE' THEN");
    const oldRefIdx = fnBody.indexOf("OLD.is_closed");
    assert.ok(tgOpIdx > -1 && oldRefIdx > -1 && tgOpIdx < oldRefIdx);
  });

  test("the unrelated-update skip check runs before the closed-row bypass, and the closed-row bypass is otherwise unchanged", () => {
    const sql = readSql();
    const skipCheckIdx = sql.indexOf("IF TG_OP = 'UPDATE' THEN");
    const closedCheckIdx = sql.indexOf("IF v_closed THEN");
    assert.ok(skipCheckIdx > -1 && closedCheckIdx > -1 && skipCheckIdx < closedCheckIdx);
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
