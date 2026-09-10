import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { constantTimeEquals } from "./constant-time-equals.server.ts";

/**
 * Regression coverage for M1 (non-constant-time Exotel media-token
 * comparison).
 *
 * exotel.media-token.ts is a createFileRoute-based route file, which this
 * repo's Node-native test runner cannot import directly (no route file in
 * this repo has a .test.ts sibling — the same constraint documented in
 * service-lock-message.test.ts for the H2 fix). So this suite:
 *
 *   1. Exercises constantTimeEquals directly — the exact logic the route
 *      now delegates the "verify_token" check to.
 *   2. Statically verifies (source scan) that the route file no longer
 *      does a plain `!==`/`===` comparison of the token, that it imports
 *      and calls constantTimeEquals, and that the rest of the existing
 *      Exotel media-token flow (secret-not-configured 503, CallSid
 *      extraction, call_logs lookup, mintMediaSessionToken call, response
 *      shapes) is byte-for-byte unchanged.
 */

describe("constantTimeEquals", () => {
  test("accepts a correct/matching token", () => {
    assert.equal(constantTimeEquals("shared-secret-value", "shared-secret-value"), true);
  });

  test("rejects an incorrect token of the same length", () => {
    assert.equal(constantTimeEquals("shared-secret-valuE", "shared-secret-value"), false);
  });

  test("rejects a completely different token", () => {
    assert.equal(constantTimeEquals("totally-wrong", "shared-secret-value"), false);
  });

  test("rejects a shorter token without throwing", () => {
    assert.doesNotThrow(() => constantTimeEquals("short", "shared-secret-value"));
    assert.equal(constantTimeEquals("short", "shared-secret-value"), false);
  });

  test("rejects a longer token without throwing", () => {
    assert.doesNotThrow(() =>
      constantTimeEquals("shared-secret-value-plus-extra", "shared-secret-value"),
    );
    assert.equal(
      constantTimeEquals("shared-secret-value-plus-extra", "shared-secret-value"),
      false,
    );
  });

  test("rejects an empty supplied token safely", () => {
    assert.doesNotThrow(() => constantTimeEquals("", "shared-secret-value"));
    assert.equal(constantTimeEquals("", "shared-secret-value"), false);
  });

  test("two empty strings are considered equal (length-0 buffers compare true)", () => {
    assert.equal(constantTimeEquals("", ""), true);
  });

  test("is case-sensitive and does not normalize input", () => {
    assert.equal(constantTimeEquals("Secret", "secret"), false);
  });

  test("does not leak either input value if it throws or is inspected", () => {
    // timingSafeEqual only throws on a length mismatch, which this function
    // guards against before ever calling it — so under normal operation
    // there is no exception path that could carry a token into a stack
    // trace. Confirm no exception is thrown for any of these inputs, and
    // that the function's only observable output is a boolean.
    const secret = "super-secret-token-value-should-not-leak";
    for (const candidate of ["", "x", secret, secret + "x", secret.slice(0, -1)]) {
      let result: boolean | undefined;
      assert.doesNotThrow(() => {
        result = constantTimeEquals(candidate, secret);
      });
      assert.equal(typeof result, "boolean");
    }
  });
});

const routeSrc = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "routes",
    "api",
    "public",
    "webhooks",
    "exotel.media-token.ts",
  ),
  "utf8",
);

describe("exotel.media-token.ts — route wiring after the M1 fix", () => {
  test("no longer compares the token with a plain !== or === operator", () => {
    assert.doesNotMatch(routeSrc, /provided\s*!==\s*secret/);
    assert.doesNotMatch(routeSrc, /provided\s*===\s*secret/);
    assert.doesNotMatch(routeSrc, /secret\s*!==\s*provided/);
    assert.doesNotMatch(routeSrc, /secret\s*===\s*provided/);
  });

  test("imports and uses constantTimeEquals for the verify_token check", () => {
    assert.match(
      routeSrc,
      /import\s*\{\s*constantTimeEquals\s*\}\s*from\s*"@\/lib\/constant-time-equals\.server"/,
    );
    assert.match(routeSrc, /!provided\s*\|\|\s*!constantTimeEquals\(provided,\s*secret\)/);
  });

  test("unauthorized responses never echo the provided or expected token", () => {
    // The 401 branch must be a fixed literal string, not built from either
    // `provided` or `secret`.
    const match = routeSrc.match(
      /if \(!provided \|\| !constantTimeEquals\(provided, secret\)\) \{\s*\n\s*return new Response\(([^;]+)\);\s*\n\s*\}/,
    );
    assert.ok(match, "expected to find the unauthorized-response block");
    const responseArgs = match[1];
    assert.ok(responseArgs, "expected a captured Response(...) argument list");
    assert.doesNotMatch(responseArgs, /provided/);
    assert.doesNotMatch(responseArgs, /\bsecret\b/);
    assert.match(responseArgs, /"Unauthorized"/);
  });

  test("secret-not-configured short-circuit (503) is unchanged", () => {
    assert.match(
      routeSrc,
      /const secret = process\.env\["EXOTEL_WEBHOOK_SECRET"\];\s*\n\s*if \(!secret\) return new Response\("Not configured", \{ status: 503 \}\);/,
    );
  });

  test("CallSid extraction and no-call_logs-row short-circuit are unchanged", () => {
    assert.match(
      routeSrc,
      /const callSid = url\.searchParams\.get\("CallSid"\) \?\? url\.searchParams\.get\("call_sid"\);/,
    );
    assert.match(
      routeSrc,
      /if \(!callSid\) return new Response\(JSON\.stringify\(\{ token: null \}\), \{ status: 200 \}\);/,
    );
    assert.match(
      routeSrc,
      /if \(!call\) return new Response\(JSON\.stringify\(\{ token: null \}\), \{ status: 200 \}\);/,
    );
  });

  test("call_logs lookup and mintMediaSessionToken call are unchanged", () => {
    assert.match(routeSrc, /\.from\("call_logs"\)/);
    assert.match(routeSrc, /\.eq\("provider", "exotel"\)/);
    assert.match(routeSrc, /\.eq\("provider_call_id", callSid\)/);
    assert.match(routeSrc, /mintMediaSessionToken\(\{/);
    assert.match(routeSrc, /callId: call\.id,/);
    assert.match(routeSrc, /providerCallId: callSid,/);
    assert.match(routeSrc, /organizationId: call\.organization_id,/);
  });

  test("success response shape (200, JSON, content-type header) is unchanged", () => {
    assert.match(
      routeSrc,
      /return new Response\(JSON\.stringify\(\{ token \}\), \{\s*\n\s*status: 200,\s*\n\s*headers: \{ "content-type": "application\/json" \},\s*\n\s*\}\);/,
    );
  });
});
