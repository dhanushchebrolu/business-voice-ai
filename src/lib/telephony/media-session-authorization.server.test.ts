import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { maskCallSid } from "./media-session-authorization.server.ts";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "media-session-authorization.server.ts"),
  "utf8",
);

/**
 * Regression coverage for the shared media-session authorization: one copy of
 * the call lookup, retry and entitlement logic, used by both Vobiz media paths.
 * Two independent copies once drifted apart and a status-check fix reached only
 * the one production did not run. Source-scanned where database access would be
 * required.
 */

describe("maskCallSid", () => {
  test("keeps only the last 6 characters, masking the rest", () => {
    assert.equal(maskCallSid("abcdefghij"), "****efghij");
  });

  test("a short CallSid masks fully rather than exposing every character", () => {
    assert.equal(maskCallSid("CA123"), "*****");
  });

  test("never throws on an empty string", () => {
    assert.equal(maskCallSid(""), "");
  });
});

describe("authorizeMediaSession is the one provider-scoped entry point", () => {
  test("no provider-specific wrapper or media-session token remains", () => {
    assert.deepEqual(src.match(/export async function \w+/g), [
      "export async function authorizeMediaSession",
    ]);
    assert.doesNotMatch(src, /optionalToken|MediaSessionToken/);
  });

  test("the shared authorizeMediaSession function is provider-parameterized, not hardcoded to one provider's call_logs rows", () => {
    assert.match(
      src,
      /export async function authorizeMediaSession\(\s*provider: string,\s*callSid: string,?\s*\)/,
    );
    assert.match(src, /\.eq\("provider", provider\)/);
    assert.doesNotMatch(src, /\.eq\("provider", "exotel"\)/);
  });

  test("log lines are provider-prefixed dynamically (vobiz_media_session:* for Vobiz) rather than a literal hardcoded prefix", () => {
    assert.match(src, /const logPrefix = `\$\{provider\}_media_session`;/);
    assert.match(src, /`\$\{logPrefix\}:call_log_lookup`/);
    assert.match(src, /`\$\{logPrefix\}:rejected_by_gate`/);
  });
});
