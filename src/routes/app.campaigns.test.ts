import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Whole-app loading/performance audit: a failed campaignsQuery previously
 * left isLoading=false, campaigns=undefined, and fell straight into the
 * "No campaigns yet" empty state — silently misreporting a real failure as
 * "there is nothing here."
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "app.campaigns.tsx"),
  "utf8",
);

describe("app.campaigns.tsx — a failed fetch is a real, retryable error, never a silent empty state", () => {
  test("destructures isError/error/refetch from the campaigns query", () => {
    assert.match(
      src,
      /isLoading,\s*isError,\s*error,\s*refetch\s*\} = useQuery\(campaignsQuery/,
    );
  });

  test("renders ErrorState before falling through to the empty/table branch", () => {
    const loadingIdx = src.indexOf("{isLoading ? (");
    const errorIdx = src.indexOf("isError ? (", loadingIdx);
    const campaignsIdx = src.indexOf("campaigns?.length ? (");
    assert.ok(loadingIdx > -1 && errorIdx > -1 && campaignsIdx > -1);
    assert.ok(loadingIdx < errorIdx && errorIdx < campaignsIdx);
    assert.match(src.slice(errorIdx, campaignsIdx), /<ErrorState/);
  });
});
