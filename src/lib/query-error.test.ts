import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { describeQueryError } from "./query-error.ts";

/**
 * Whole-app loading/performance audit: this is the one place every fixed
 * page's ErrorState message runs through, so it gets real unit tests
 * (unlike most route files in this codebase, which are source-scanned —
 * this is plain, side-effect-free logic that's cheap and worth executing
 * for real).
 */

describe("describeQueryError", () => {
  test("an AbortError (the new shared SUPABASE_FETCH_TIMEOUT_MS firing) reads as a slow-network message, never a generic failure, and never implies a write didn't happen", () => {
    const err = new DOMException("The operation was aborted.", "AbortError");
    const message = describeQueryError(err);
    assert.match(message, /taking longer than expected/i);
    assert.doesNotMatch(message, /failed|error|wrong/i);
  });

  test("a TimeoutError (AbortSignal.timeout's own error name on some runtimes) is treated the same as AbortError", () => {
    const err = new DOMException("Timed out.", "TimeoutError");
    assert.match(describeQueryError(err), /taking longer than expected/i);
  });

  test("a deliberately-thrown, already-user-safe Error message passes through unchanged (matches this codebase's own convention of throwing human-readable Errors)", () => {
    assert.equal(
      describeQueryError(new Error("That business does not belong to your workspace.")),
      "That business does not belong to your workspace.",
    );
  });

  test("a non-Error value (e.g. a raw PostgrestError-shaped object with no .message) falls back to the generic message, never crashes", () => {
    assert.equal(describeQueryError({ code: "42501" }), "Something went wrong. Please try again.");
  });

  test("a custom fallback message is used when provided", () => {
    assert.equal(
      describeQueryError({ code: "42501" }, "Could not load your bookings."),
      "Could not load your bookings.",
    );
  });

  test("an Error with an empty message still falls back rather than rendering a blank ErrorState", () => {
    const err = new Error("");
    assert.equal(describeQueryError(err, "fallback"), "fallback");
  });
});
