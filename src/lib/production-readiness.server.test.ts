import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-scanned like every other createServerFn-wrapped handler in this
 * codebase (see telephony-admin.functions.test.ts's doc comment,
 * calendar-dashboard.functions.test.ts) — this file imports `@/...`
 * path-aliased modules (auth-middleware, platform-admin.server,
 * telephony.server, razorpay.server) that plain `node --test` can't
 * resolve without a bundler, and its handler dynamically imports its own
 * Supabase client internally, so it can't be invoked directly here either.
 *
 * Covers the "safe diagnostics" fields added to diagnose a recurring
 * production incident ("Could not load this — step 'fetch_bookings'
 * failed ... PGRST205"): which Supabase project this deployment's
 * service-role client actually resolves to (never the full URL/any key),
 * and whether PostgREST can currently see public.bookings (reporting the
 * raw error code/message as data, not collapsing it into a boolean —
 * PGRST205 alone can't distinguish "migration never applied" from
 * "schema cache stale").
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "production-readiness.server.ts"),
  "utf8",
);

describe("parseSupabaseProjectRef — never exposes SUPABASE_URL itself", () => {
  test("is exported, reads only SUPABASE_URL, and returns only the hostname's first label", () => {
    assert.match(src, /export function parseSupabaseProjectRef/);
    const start = src.indexOf("export function parseSupabaseProjectRef");
    const end = src.indexOf("\n}", start);
    const body = src.slice(start, end);
    assert.match(body, /process\.env\["SUPABASE_URL"\]/);
    assert.match(body, /new URL\(url\)\.hostname\.split\("\."\)\[0\]/);
    // Must never return/log the full URL or any other env var.
    assert.doesNotMatch(body, /SERVICE_ROLE/);
  });
});

describe("the bookings-reachability probe reports raw diagnostic data, never suppresses or throws", () => {
  test("queries public.bookings with a lightweight head-count select, inside the same Promise.all as the other fleet-state counts", () => {
    const promiseAllIdx = src.indexOf("Promise.all([");
    const promiseAllEnd = src.indexOf("]);", promiseAllIdx);
    const block = src.slice(promiseAllIdx, promiseAllEnd);
    assert.match(block, /\.from\("bookings"\)/);
    assert.match(block, /\.select\("id",\s*\{\s*count:\s*"exact",\s*head:\s*true\s*\}\)/);
  });

  test("the bookings probe result is never thrown — its error is read into supabaseSchema instead", () => {
    const probeIdx = src.indexOf('.from("bookings")');
    const destructureIdx = src.lastIndexOf("bookingsProbe", probeIdx);
    assert.ok(
      destructureIdx > -1,
      "expected the bookings probe result to be destructured as bookingsProbe",
    );
    // Must not be awaited through a path that throws on error (unlike
    // fetch_bookings' own, correctly-throwing, calendar-dashboard.functions.ts
    // path — this is a diagnostic probe, not that data path).
    assert.doesNotMatch(src, /bookingsProbe\.error\)\s*throw/);
  });

  test("supabaseSchema reports bookingsTableReachable plus the raw error code/message, not just a boolean", () => {
    const start = src.indexOf("const supabaseSchema: SupabaseSchemaDiagnostic");
    const end = src.indexOf("};", start);
    const body = src.slice(start, end);
    assert.match(body, /bookingsTableReachable:\s*!bookingsProbe\.error/);
    assert.match(body, /bookingsTableErrorCode:\s*bookingsProbe\.error\?\.code\s*\?\?\s*null/);
    assert.match(
      body,
      /bookingsTableErrorMessage:\s*bookingsProbe\.error\?\.message\s*\?\?\s*null/,
    );
  });

  test("supabaseSchema (including the project ref) is returned from the handler", () => {
    const returnIdx = src.lastIndexOf("return {");
    const returnEnd = src.indexOf("};", returnIdx);
    const returnBody = src.slice(returnIdx, returnEnd);
    assert.match(returnBody, /supabaseSchema,/);
  });
});
