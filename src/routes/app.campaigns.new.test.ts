import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Whole-app loading/performance audit: `setSaving(false)` previously sat
 * after the awaited insert with no try/finally — safe only as long as
 * every failure path returned via a checked `error`, not a throw. The
 * shared request timeout (SUPABASE_FETCH_TIMEOUT_MS in client.ts) makes a
 * genuine thrown/rejected call from this insert more likely under real
 * backend latency, so `saving` needed a lifecycle that can't be stranded
 * `true` if the call throws instead of resolving with `{ error }`.
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "app.campaigns.new.tsx"),
  "utf8",
);

describe("app.campaigns.new.tsx — the saving flag is cleaned up on every outcome, not just the checked-error path", () => {
  test("wraps the insert in try/catch/finally, with setSaving(false) in finally", () => {
    const idx = src.indexOf("async function createCampaign()");
    const end = src.indexOf("\n  return (", idx);
    const block = src.slice(idx, end);
    assert.match(block, /setSaving\(true\);/);
    assert.match(block, /try \{/);
    assert.match(block, /\} catch \(err\) \{/);
    assert.match(block, /\} finally \{\s*\n\s*setSaving\(false\);/);
  });

  test("a caught exception shows a safe, non-generic message via describeQueryError, never a raw/blank error", () => {
    assert.match(src, /import \{ describeQueryError \} from "@\/lib\/query-error"/);
    const idx = src.indexOf("} catch (err) {");
    const block = src.slice(idx, idx + 150);
    assert.match(block, /describeQueryError\(err,/);
  });
});
