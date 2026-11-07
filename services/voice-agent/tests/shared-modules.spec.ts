/**
 * The agent reuses pure production modules from the repository's src/lib by
 * relative path. The container copies them explicitly (Dockerfile), so a new
 * import that is not copied would only fail in production. This keeps the
 * two in step, and keeps those modules free of package imports (the image
 * has only the agent's own node_modules).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "../..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const importsOf = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);

/** Every repository src/lib module the agent's runtime code reaches, transitively. */
function sharedModules(): Set<string> {
  const seen = new Set<string>();
  const queue = files(join(root, "src")).flatMap((f) =>
    importsOf(f)
      .filter((i) => i.includes("/src/lib/"))
      .map((i) => resolve(dirname(f), i)),
  );
  while (queue.length) {
    const p = queue.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    for (const i of importsOf(p)) if (i.startsWith(".")) queue.push(resolve(dirname(p), i));
  }
  return seen;
}

test("every shared module the agent imports is copied into the image", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  const copied = new Set(
    [...dockerfile.matchAll(/src\/lib\/([\w.-]+\.ts)/g)].map((m) => `src/lib/${m[1]}`),
  );
  const needed = [...sharedModules()].map((p) => relative(repo, p));
  assert.ok(needed.length >= 6, needed.join(", "));
  for (const n of needed)
    assert.ok(copied.has(n), `${n} is imported but not copied by the Dockerfile`);
});

test("shared modules import nothing but each other (no packages, no aliases)", () => {
  for (const p of sharedModules()) {
    for (const i of importsOf(p))
      assert.ok(i.startsWith("./"), `${relative(repo, p)} imports ${i}`);
  }
});
