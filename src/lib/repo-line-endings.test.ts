import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Many tests read source and SQL files and match their text (a migration's
 * grants, a route's guard order). On a checkout with CRLF line endings —
 * Git for Windows' default (core.autocrlf=true) before .gitattributes
 * pinned eol=lf — those tests fail by the dozen although nothing is wrong
 * with the code. This one check names the real cause instead.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const SCANNED = ["src", "supabase", ".github"];
const TEXT = /\.(?:ts|tsx|js|mjs|sql|json|ya?ml|toml|md|css)$/;

function textFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".output") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) textFiles(path, out);
    else if (TEXT.test(name)) out.push(path);
  }
  return out;
}

test("source, SQL and config files are checked out with LF line endings", () => {
  const files = SCANNED.flatMap((d) => {
    try {
      return textFiles(join(ROOT, d));
    } catch {
      return [];
    }
  });
  assert.ok(files.length > 100, `expected to scan the repository's files, found ${files.length}`);
  const crlf = files.filter((f) => readFileSync(f, "utf8").includes("\r\n"));
  assert.deepEqual(
    crlf.map((f) => relative(ROOT, f)).slice(0, 10),
    [],
    `${crlf.length} file(s) have CRLF line endings, so tests that read source text will fail. ` +
      "This repository's .gitattributes pins eol=lf; check it out again " +
      "(for example a fresh clone or `git worktree add`) with core.autocrlf=false.",
  );
});
