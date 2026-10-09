import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Whole-app loading/performance audit — root cause: no Supabase REST/RPC/
 * Auth fetch anywhere in this app had a timeout or AbortController. A
 * stalled connection (DB connection-pool pressure, a held lock, a dropped
 * response) never resolved or rejected, so the calling useQuery's
 * isLoading never flipped — which is what a page "stuck loading
 * indefinitely" actually is. Source-scanned like every other file in this
 * directory (see no-lovable-cloud.test.ts) since these three files build a
 * real Supabase client — exercising them live would need a running
 * Supabase instance.
 */

const dir = dirname(fileURLToPath(import.meta.url));
const files = {
  client: readFileSync(join(dir, "client.ts"), "utf8"),
  clientServer: readFileSync(join(dir, "client.server.ts"), "utf8"),
  authMiddleware: readFileSync(join(dir, "auth-middleware.ts"), "utf8"),
};

describe("every Supabase fetch wrapper bounds the request with a timeout", () => {
  for (const [name, src] of Object.entries(files)) {
    test(`${name}: passes a signal — a caller-supplied one if present, otherwise AbortSignal.timeout(SUPABASE_FETCH_TIMEOUT_MS)`, () => {
      assert.match(src, /const SUPABASE_FETCH_TIMEOUT_MS = \d[\d_]*;/);
      assert.match(
        src,
        /signal: init\?\.signal \?\? AbortSignal\.timeout\(SUPABASE_FETCH_TIMEOUT_MS\)/,
      );
    });

    test(`${name}: routes the actual fetch through fetchWithTiming (observability), never a bare fetch() call`, () => {
      assert.match(src, /import \{ fetchWithTiming \} from ['"].*supabase-fetch-timing['"]/);
      assert.match(src, /return fetchWithTiming\(/);
      assert.doesNotMatch(src, /return fetch\(input,/);
    });
  }
});
