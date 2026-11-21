import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The operator checks "Needs review" before and after a supervised call; an
// empty filtered list must not read as "no calls have ever happened".
const src = readFileSync(new URL("./admin.calls.tsx", import.meta.url), "utf8");

test("the empty state names the active filter instead of 'No calls yet'", () => {
  const empty = src.slice(
    src.indexOf("<EmptyState"),
    src.indexOf("/>", src.indexOf("<EmptyState")),
  );
  assert.match(empty, /needsReview\s*\?[\s\S]*"No calls need review"/);
  assert.match(empty, /orgId\.trim\(\)[\s\S]*"No calls for this organization"/);
  assert.match(empty, /"No calls yet"/);
});
