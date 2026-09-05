import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Static/textual guard rail for the seed-idempotency fix (see the "MUST
 * FIX" review of commit e5413e9, item 6): the original migration's
 * `ON CONFLICT DO NOTHING` had no matching unique constraint, so re-running
 * the seed block would silently duplicate all six starter rows.
 *
 * There is no live Postgres instance in this environment to run a real
 * integration test against (no Supabase project is connected here), so this
 * cannot prove idempotency by actually re-running the SQL twice. What it
 * *can* prove, and does: the fix's two required pieces — a UNIQUE
 * constraint on `title`, and an `ON CONFLICT (title)` clause that targets
 * it — are both present in the migration file, so a future edit that
 * silently drops either half of the fix (re-introducing the bug) fails this
 * test. Real idempotency should still be confirmed by actually applying
 * this migration twice against a real Supabase project before relying on
 * it in production.
 */
const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "20260905080100_public_knowledge_base.sql",
);

function readMigration(): string {
  return readFileSync(migrationPath, "utf8");
}

test("public_knowledge_base.title has a UNIQUE constraint", () => {
  const sql = readMigration();
  assert.match(
    sql,
    /title\s+text\s+NOT\s+NULL\s+UNIQUE/i,
    "expected `title text NOT NULL UNIQUE` on public_knowledge_base",
  );
});

test("the seed INSERT targets the title unique constraint in ON CONFLICT", () => {
  const sql = readMigration();
  assert.match(
    sql,
    /ON CONFLICT\s*\(\s*title\s*\)\s*DO NOTHING/i,
    "expected `ON CONFLICT (title) DO NOTHING`, not a no-op bare ON CONFLICT DO NOTHING",
  );
});

test("the seed INSERT is not using a bare (targetless) ON CONFLICT DO NOTHING", () => {
  const sql = readMigration();
  assert.doesNotMatch(
    sql,
    /\)\s*\nON CONFLICT DO NOTHING;/,
    "a targetless ON CONFLICT DO NOTHING never matches (id is always a fresh random uuid) and silently duplicates rows on re-run",
  );
});

test("every seeded row has a distinct title (the unique constraint would otherwise reject the seed itself)", () => {
  const sql = readMigration();
  // Each seeded row is `(\n    'Title',\n    'content...',\n ...)` — the
  // title is always the first quoted string right after the opening paren.
  const titles = [...sql.matchAll(/\(\s*\n\s*'((?:[^']|'')+)',/g)].map((m) => m[1]);
  assert.ok(titles.length >= 6, `expected at least 6 seeded titles, found ${titles.length}`);
  assert.equal(new Set(titles).size, titles.length, "seeded titles must be unique");
});
