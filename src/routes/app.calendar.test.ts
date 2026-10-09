import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Whole-app loading/performance audit: this page had two confirmed,
 * 100%-reproducible stuck-loading bugs (not just a race) —
 *   1. `if (!businessId) return <LoadingState .../>` conflated "workspace
 *      query still loading" with "workspace query errored" with "workspace
 *      resolved but genuinely has no business" — an error left the page
 *      reading "Loading workspace…" forever, with no escape.
 *   2. `isLoading || !view` did the same thing one level down for the day
 *      view query — once isLoading flips false on an error, `!view` is
 *      still true, so the UI stayed on the loading branch forever instead
 *      of surfacing the error.
 * Source-scanned like every other route in this codebase (see
 * app.knowledge.test.ts) — no DOM-rendering harness exists here.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.calendar.tsx"), "utf8");

describe("app.calendar.tsx — workspace loading/error/empty are distinguished, never collapsed into a perpetual spinner", () => {
  test("destructures isError/error/refetch from the workspace query, not just data", () => {
    assert.match(
      src,
      /isLoading: wsLoading,\s*\n\s*isError: wsIsError,\s*\n\s*error: wsError,\s*\n\s*refetch: refetchWs,/,
    );
  });

  test("an errored workspace query renders ErrorState with a retry action, before the !businessId check", () => {
    const loadingIdx = src.indexOf("if (wsLoading) return <LoadingState");
    const errorIdx = src.indexOf("if (wsIsError) {");
    const noBusinessIdx = src.indexOf("if (!businessId) {");
    assert.ok(loadingIdx > -1 && errorIdx > -1 && noBusinessIdx > -1);
    assert.ok(loadingIdx < errorIdx && errorIdx < noBusinessIdx);
    const block = src.slice(errorIdx, noBusinessIdx);
    assert.match(block, /<ErrorState/);
    assert.match(block, /onRetry=\{\(\) => void refetchWs\(\)\}/);
  });

  test("a genuinely missing business renders an EmptyState, not a LoadingState lie", () => {
    const idx = src.indexOf("if (!businessId) {");
    const block = src.slice(idx, idx + 400);
    assert.match(block, /<EmptyState/);
    assert.doesNotMatch(block, /<LoadingState/);
  });
});

describe("app.calendar.tsx — the day-view query's error state is distinguished from its loading state", () => {
  test("destructures isError/error/refetch from the day-view query", () => {
    assert.match(
      src,
      /isError: viewIsError,\s*\n\s*error: viewError,\s*\n\s*refetch: refetchView,/,
    );
  });

  test("viewIsError is checked before the old '!view' fallback, so an error never reads as 'still loading'", () => {
    const sectionIdx = src.indexOf("{isLoading ? (");
    assert.ok(sectionIdx > -1);
    const block = src.slice(sectionIdx, sectionIdx + 600);
    const isLoadingIdx = block.indexOf("isLoading ? (");
    const isErrorIdx = block.indexOf("viewIsError ? (");
    const fallbackIdx = block.indexOf("!view ? (");
    assert.ok(isLoadingIdx > -1 && isErrorIdx > -1 && fallbackIdx > -1);
    assert.ok(isLoadingIdx < isErrorIdx && isErrorIdx < fallbackIdx);
    assert.match(block.slice(isErrorIdx, fallbackIdx), /<ErrorState/);
  });
});
