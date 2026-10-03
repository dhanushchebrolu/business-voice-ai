import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { maskCallSid } from "./media-session-authorization.server.ts";

/**
 * Regression coverage for a real production failure: a live Exotel test
 * call produced `exotel_media_route:call_log_lookup` / `found: false` /
 * `exotel_media_route:rejected` / "No known call for CallSid ..." even
 * though the call had otherwise reached the media WebSocket correctly.
 * Tracing it found two compounding issues this module (and this test file)
 * exists to fix and guard against regressing:
 *
 *   1. exotel-media-route.server.ts and call-session-durable-object.server.ts
 *      each carried their own independently-maintained COPY of the
 *      CallSid -> call_logs lookup/retry/authorization logic. A previous
 *      fix (widening which call_logs.status values are accepted) landed in
 *      only one of the two copies — the one that is NOT what production
 *      traffic runs through when the CALL_SESSION Durable Object binding
 *      is active, which the live log's `exotel_media_route:*`-prefixed
 *      (not `call_session_do:*`-prefixed) lines proved was happening.
 *   2. The retry window (5 attempts / 200ms = 1s total) was short relative
 *      to plausible real-world webhook delivery latency, so a genuinely
 *      live call's call_logs row could still not exist yet when the media
 *      route gave up looking for it.
 *
 * See media-session-authorization.server.ts's own module doc for the full
 * story. Source-scanned (rather than exercised end-to-end) where DB access
 * would be required — this sandbox cannot reach a live Supabase instance,
 * matching every other telephony test in this repo.
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
