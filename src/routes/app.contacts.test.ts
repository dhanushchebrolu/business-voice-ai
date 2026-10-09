import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Whole-app loading/performance audit: a failed contactsQuery previously
 * left isLoading=false, contacts=undefined, and fell straight into the
 * "No contacts yet" empty state — an error silently misreported as "there
 * is nothing here." Separately, the CSV import handler had no loading
 * feedback at all during what can be an arbitrarily long, serial,
 * per-row import — indistinguishable from a hang. Source-scanned like
 * every other route in this codebase.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.contacts.tsx"), "utf8");

describe("app.contacts.tsx — a failed fetch is a real, retryable error, never a silent empty state", () => {
  test("destructures isError/error/refetch from the contacts query", () => {
    assert.match(src, /isLoading,\s*isError,\s*error,\s*refetch\s*\} = useQuery\(contactsQuery/);
  });

  test("renders ErrorState before falling through to the empty/table branch", () => {
    const loadingIdx = src.indexOf("{isLoading ? (");
    const errorIdx = src.indexOf("isError ? (", loadingIdx);
    const filteredIdx = src.indexOf("filtered.length ? (");
    assert.ok(loadingIdx > -1 && errorIdx > -1 && filteredIdx > -1);
    assert.ok(loadingIdx < errorIdx && errorIdx < filteredIdx);
    const block = src.slice(errorIdx, filteredIdx);
    assert.match(block, /<ErrorState/);
    assert.match(block, /onRetry=\{\(\) => void refetch\(\)\}/);
  });
});

describe("app.contacts.tsx — CSV import gives real loading feedback and never strands it on an error", () => {
  test("tracks an importing state and disables/labels the upload button while importing", () => {
    assert.match(src, /const \[importing, setImporting\] = useState\(false\)/);
    assert.match(src, /disabled=\{importing\}/);
  });

  test("the import handler wraps the whole operation in try/catch/finally — setImporting(false) is reached on every outcome", () => {
    const idx = src.indexOf("onChange={async (e) => {");
    const endIdx = src.indexOf("\n      />", idx);
    const block = src.slice(idx, endIdx > -1 ? endIdx : idx + 3000);
    assert.match(block, /setImporting\(true\);/);
    assert.match(block, /\} catch \(err\) \{/);
    assert.match(block, /finally \{[\s\S]{0,40}setImporting\(false\);/);
  });
});
