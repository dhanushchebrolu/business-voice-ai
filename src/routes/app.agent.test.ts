import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Whole-app loading/performance audit: `if (isLoading || !business ||
 * !agent) return <LoadingState label="Loading receptionist" />` collapsed
 * three different situations into one spinner — still loading, errored,
 * and "resolved but genuinely missing a row" — none of which are the same
 * as "still loading."
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.agent.tsx"), "utf8");

describe("app.agent.tsx — loading, error, and missing-row states are distinguished", () => {
  test("destructures isError/error/refetch from the workspace query", () => {
    assert.match(src, /isError: wsIsError,\s*\n\s*error: wsError,\s*\n\s*refetch: refetchWs,/);
  });

  test("checks loading, then error, then !business, then !agent, in that order — never collapsing them into one LoadingState", () => {
    const loadingIdx = src.indexOf("if (isLoading) return <LoadingState");
    const errorIdx = src.indexOf("if (wsIsError) {");
    const noBusinessIdx = src.indexOf("if (!business) {");
    const noAgentIdx = src.indexOf("if (!agent) {");
    assert.ok(loadingIdx > -1 && errorIdx > -1 && noBusinessIdx > -1 && noAgentIdx > -1);
    assert.ok(loadingIdx < errorIdx && errorIdx < noBusinessIdx && noBusinessIdx < noAgentIdx);
  });

  test("a workspace query error renders ErrorState with retry, not a spinner", () => {
    const idx = src.indexOf("if (wsIsError) {");
    const block = src.slice(idx, idx + 250);
    assert.match(block, /<ErrorState/);
    assert.match(block, /onRetry=\{\(\) => void refetchWs\(\)\}/);
  });

  test("a business with no agent_configs row is a real dead end (ErrorState), not a perpetual spinner", () => {
    const idx = src.indexOf("if (!agent) {");
    const block = src.slice(idx, idx + 350);
    assert.match(block, /<ErrorState/);
    assert.doesNotMatch(block, /<LoadingState/);
  });
});
