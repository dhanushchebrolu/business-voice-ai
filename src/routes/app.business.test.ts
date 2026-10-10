import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-scanned like every other route in this codebase (see
 * app.calendar.test.ts, app.knowledge.test.ts) — no DOM-rendering harness
 * exists here. Covers the legacy "Opening hours" editor's business-hours
 * validation guard — this component writes business_hours directly via
 * the browser Supabase client (no server function, no RPC), so the
 * client-side check here is the only defense-in-depth layer before the
 * database trigger (20261010100000_business_hours_interval_validation.sql)
 * itself rejects a malformed/reversed write.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.business.tsx"), "utf8");

describe("app.business.tsx — Opening hours editor validates before writing directly to business_hours", () => {
  test("imports the shared business-hours validator", () => {
    assert.match(src, /from "@\/lib\/calendar\/business-hours-validation"/);
  });

  test("the day-open Switch validates the interval before updating, only when opening (not when closing)", () => {
    const switchStart = src.indexOf("<Switch");
    const switchEnd = src.indexOf("{row?.is_closed ? (", switchStart);
    const block = src.slice(switchStart, switchEnd);
    assert.match(
      block,
      /if \(open\) \{\s*\n\s*const validationError = describeInvalidInterval\(nextInterval\);/,
    );
    assert.match(block, /toast\.error\(validationError\);\s*\n\s*return;/);
  });

  test("the start/end time inputs validate the proposed new interval before updating, and never swap or normalize it", () => {
    const inputsStart = src.indexOf('(["start", "end"] as const).map');
    const inputsEnd = src.indexOf("))}", inputsStart);
    const block = src.slice(inputsStart, inputsEnd);
    assert.match(block, /const nextInterval = \{ \.\.\.base, \[key\]: e\.target\.value \};/);
    assert.match(block, /describeInvalidInterval\(nextInterval\)/);
    assert.doesNotMatch(block, /swap/i);
  });

  test("a rejected write (e.g. from the database trigger) is surfaced via toast, not silently ignored", () => {
    assert.match(src, /describeBusinessHoursWriteError\(error\)/);
  });
});
