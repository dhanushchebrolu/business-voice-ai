import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Production incident regression coverage: Klyro production (deployed
 * directly to Cloudflare, backed by the Klyro Ai Supabase project
 * eorazvlmqwunmhwiocn) must never surface a message telling a user to
 * "Connect Supabase in Lovable Cloud" — that instruction is specific to
 * Lovable's own hosted preview/editor environment and is both wrong and
 * confusing on this deployment target.
 *
 * The exact string was found in three files, all of which construct a
 * Supabase client (or verify a bearer token via one) and throw when
 * required env vars are missing: the lazy browser client, the service-role
 * server client, and the requireSupabaseAuth middleware every server
 * function is gated by. All three are covered here so a future edit to any
 * one of them can't reintroduce the message without this suite catching it.
 */

const dir = dirname(fileURLToPath(import.meta.url));
const files = {
  client: readFileSync(join(dir, "client.ts"), "utf8"),
  clientServer: readFileSync(join(dir, "client.server.ts"), "utf8"),
  authMiddleware: readFileSync(join(dir, "auth-middleware.ts"), "utf8"),
};

/** Strips `//` comment lines — this suite checks executable strings only; an
 * explanatory comment is allowed to name what must NOT appear at runtime. */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("no file constructs a message naming Lovable Cloud", () => {
  for (const [name, src] of Object.entries(files)) {
    const code = stripLineComments(src);

    test(`${name} never mentions Lovable Cloud in executable code`, () => {
      assert.doesNotMatch(code, /Lovable Cloud/i);
    });

    test(`${name} never tells the user to "Connect Supabase" in executable code`, () => {
      assert.doesNotMatch(code, /Connect Supabase/i);
    });
  }
});

describe("the missing-env-var error is generic and safe for a user to see", () => {
  for (const [name, src] of Object.entries(files)) {
    test(`${name} throws the exact generic message, with no variable names inside it`, () => {
      assert.match(src, /throw new Error\("Application configuration is incomplete\."\)/);
    });

    test(`${name} still logs variable NAMES server-side (console.error), for diagnosis`, () => {
      const idx = src.indexOf("console.error(`[Supabase] Missing environment variable(s)");
      assert.ok(idx > -1, `expected a diagnostic console.error in ${name}`);
      assert.match(src.slice(idx, idx + 120), /missing\.join\(", "\)/);
    });

    test(`${name}'s thrown Error message is a literal, never built from the missing-vars list (so no variable name can leak through it)`, () => {
      const throwIdx = src.indexOf('throw new Error("Application configuration is incomplete.")');
      assert.ok(throwIdx > -1);
      // The literal must not be string-interpolated from `missing`.
      assert.doesNotMatch(src.slice(Math.max(0, throwIdx - 5), throwIdx + 60), /\$\{missing/);
    });
  }
});
