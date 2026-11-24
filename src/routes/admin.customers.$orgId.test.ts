import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Whole-app loading/performance audit: the readiness, klyroReadiness, and
 * profit queries on this heavily-trafficked admin page never checked
 * `error`, and their render sites branched purely on `data ? <content/> :
 * <LoadingState/>` — a thrown/failed fetch left "Running health checks" /
 * "Loading runtime readiness" / "Loading finance" spinning forever with no
 * escape. The finance section also mis-rendered a legitimate "no financial
 * activity yet" row as the same perpetual spinner.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "admin.customers.$orgId.tsx"),
  "utf8",
);

describe("admin.customers.$orgId.tsx — readiness/klyroReadiness/profit errors are surfaced, never left spinning", () => {
  test("readiness query destructures isError/error/refetch and its render site checks it before falling to LoadingState", () => {
    assert.match(
      src,
      /isError: readinessIsError,\s*\n\s*error: readinessError,\s*\n\s*refetch: refetchReadiness,/,
    );
    const idx = src.indexOf("{readinessIsError ? (");
    assert.ok(idx > -1);
    const block = src.slice(idx, idx + 250);
    assert.match(block, /<ErrorState/);
    assert.match(block, /onRetry=\{\(\) => void refetchReadiness\(\)\}/);
  });

  test("klyroReadiness query destructures isError/error/refetch and its render site checks it before falling to LoadingState", () => {
    assert.match(
      src,
      /isError: klyroIsError,\s*\n\s*error: klyroError,\s*\n\s*refetch: refetchKlyro,/,
    );
    const idx = src.indexOf("{klyroIsError ? (");
    assert.ok(idx > -1);
    const block = src.slice(idx, idx + 250);
    assert.match(block, /<ErrorState/);
    assert.match(block, /onRetry=\{\(\) => void refetchKlyro\(\)\}/);
  });

  test("the finance section distinguishes loading, error, a real row, and no financial activity — four states, not two", () => {
    const idx = src.indexOf('<SectionCard title="Finance"');
    const block = src.slice(idx, idx + 1200);
    assert.match(block, /profitIsLoading \? \(/);
    assert.match(block, /profitIsError \? \(/);
    assert.match(block, /financeRow \? \(/);
    assert.match(block, /No financial activity yet\./);
    assert.match(block, /<ErrorState/);
  });
});
