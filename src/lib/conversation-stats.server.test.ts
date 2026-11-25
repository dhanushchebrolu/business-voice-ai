import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cachedStatsLoader, loadConversationStats } from "./conversation-stats.server.ts";
import type { ConversationStats } from "./conversation-counter.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");

const fakeDb = (result: { data: unknown; error: { message: string } | null }) => {
  const calls: string[] = [];
  const db = {
    rpc: (fn: string) => {
      calls.push(fn);
      return Promise.resolve(result);
    },
  };
  return { db: db as never, calls };
};

describe("loadConversationStats", () => {
  test("reads the one aggregate function and returns exactly three numbers (bigint strings included)", async () => {
    const { db, calls } = fakeDb({
      data: [
        {
          completed_seconds: "9007199254",
          active_calls: 2,
          active_elapsed_seconds: "75",
          as_of: "2026-11-25T00:00:00Z",
          organization_id: "must-not-leak",
        },
      ],
      error: null,
    });
    const stats = await loadConversationStats(db);
    assert.deepEqual(calls, ["public_conversation_stats"]);
    assert.deepEqual(stats, {
      completedSeconds: 9007199254,
      activeCalls: 2,
      activeElapsedSeconds: 75,
    });
  });
  test("a database error or an empty answer is an error, never a zero", async () => {
    await assert.rejects(
      loadConversationStats(fakeDb({ data: null, error: { message: "boom" } }).db),
      /boom/,
    );
    await assert.rejects(loadConversationStats(fakeDb({ data: [], error: null }).db), /no row/);
  });
});

describe("cachedStatsLoader: visitors don't reach the database", () => {
  const stats = (n: number): ConversationStats => ({
    completedSeconds: n,
    activeCalls: 0,
    activeElapsedSeconds: 0,
  });
  test("many visitors inside the window cost one read; after it, one more", async () => {
    let clock = 0;
    let reads = 0;
    const get = cachedStatsLoader(
      async () => stats(++reads),
      15_000,
      () => clock,
    );
    await Promise.all(Array.from({ length: 50 }, () => get()));
    assert.equal(reads, 1);
    clock = 14_999;
    assert.equal((await get()).completedSeconds, 1);
    clock = 15_000;
    assert.equal((await get()).completedSeconds, 2);
    assert.equal(reads, 2);
  });
  test("a failed refresh keeps serving the last good total; with none, it fails", async () => {
    let clock = 0;
    let fail = false;
    const get = cachedStatsLoader(
      async () => {
        if (fail) throw new Error("db down");
        return stats(7);
      },
      1000,
      () => clock,
    );
    await assert.doesNotReject(get());
    fail = true;
    clock = 5000;
    assert.equal((await get()).completedSeconds, 7);
    const never = cachedStatsLoader(async () => {
      throw new Error("db down");
    }, 1000);
    await assert.rejects(never(), /db down/);
  });
});

describe("what the public can reach", () => {
  const route = read("../routes/api/public/stats/conversation-time.ts");
  test("the public route reads only through the aggregate loader and answers GET only", () => {
    assert.match(route, /loadConversationStats\(supabaseAdmin\)/);
    assert.doesNotMatch(route, /\.from\(|call_logs|organization/);
    assert.match(route, /GET:/);
    assert.doesNotMatch(route, /POST:|PUT:|DELETE:/);
  });
  test("a failure answers a generic 503, with no internal message", () => {
    assert.match(route, /status: 503/);
    assert.doesNotMatch(route, /JSON\.stringify\(\{ error: \(?err/);
  });
  test("the migration grants the function to the server role only", () => {
    const sql = read("../../supabase/migrations/20261130090000_public_conversation_stats.sql");
    assert.match(sql, /SECURITY DEFINER/);
    assert.match(sql, /SET search_path = ''/);
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.public_conversation_stats\(\) FROM PUBLIC, anon, authenticated;/,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.public_conversation_stats\(\) TO service_role;/,
    );
    assert.doesNotMatch(sql, /GRANT[^;]*\bTO\b[^;]*\banon\b/);
  });
  test("the landing section shows the live counter, not a hard-coded number", () => {
    const section = read("../components/landing/home/sections-a.tsx");
    assert.match(section, /LiveConversationSeconds/);
  });
});
