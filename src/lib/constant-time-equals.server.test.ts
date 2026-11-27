import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { constantTimeEquals } from "./constant-time-equals.server.ts";

/**
 * constantTimeEquals compares shared secrets without a timing side channel
 * (audit finding M1: a plain `!==` on a webhook token).
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
