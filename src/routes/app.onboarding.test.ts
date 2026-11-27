import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-scanned like every other route in this codebase (see
 * app.calendar.test.ts) — no DOM-rendering harness exists here. Covers the
 * onboarding "Hours" step's business-hours validation: this seed also
 * writes business_hours directly via the browser Supabase client, with no
 * server function or RPC in between.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "app.onboarding.tsx"), "utf8");
/** The wizard's writes. */
const save = readFileSync(join(here, "..", "lib", "onboarding-save.ts"), "utf8");

describe("app.onboarding.tsx — Hours step validates before the seed insert", () => {
  test("imports the shared business-hours validator", () => {
    assert.match(src, /from "@\/lib\/calendar\/business-hours-validation"/);
  });

  test("next() validates openTime/closeTime before leaving the Hours step, only when at least one day is open", () => {
    const fnStart = src.indexOf("function next() {");
    const fnEnd = src.indexOf("\n  }", fnStart);
    const fnBody = src.slice(fnStart, fnEnd);
    assert.match(fnBody, /if \(step === 2 && openDays\.length > 0\)/);
    assert.match(fnBody, /describeInvalidInterval\(\{ start: openTime, end: closeTime \}\)/);
    assert.match(fnBody, /toast\.error\(validationError\);\s*\n\s*return;/);
  });

  test("the business_hours write checks its own error and surfaces a translated message", () => {
    const idx = save.indexOf('.from("business_hours")');
    assert.ok(idx > -1);
    const block = save.slice(idx - 80, idx + 300);
    assert.match(block, /const \{ error: hoursError \} = await supabase/);
    assert.match(
      block,
      /if \(hoursError\)\s*\n?\s*throw new Error\(describeBusinessHoursWriteError\(hoursError\) \?\? hoursError\.message\);/,
    );
  });
});
