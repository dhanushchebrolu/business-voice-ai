import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getRequestWaitUntil, runInBackground } from "./background-task.server.ts";

describe("getRequestWaitUntil", () => {
  test("returns the function Nitro's cloudflare preset attaches to the platform Request", () => {
    const waitUntil = (_p: Promise<unknown>) => {};
    const request = new Request("https://example.com");
    (request as unknown as { waitUntil: typeof waitUntil }).waitUntil = waitUntil;
    assert.equal(getRequestWaitUntil(request), waitUntil);
  });

  test("returns undefined outside Cloudflare (local dev, tests) — no property was ever attached", () => {
    const request = new Request("https://example.com");
    assert.equal(getRequestWaitUntil(request), undefined);
  });
});

describe("runInBackground", () => {
  test("registers the promise with waitUntil when available, so Cloudflare won't tear down the isolate before it settles", () => {
    let seen: Promise<unknown> | undefined;
    const waitUntil = (p: Promise<unknown>) => {
      seen = p;
    };
    runInBackground(Promise.resolve("ok"), waitUntil, "test:event");
    assert.ok(seen, "expected waitUntil to be called with the guarded promise");
  });

  test("never calls waitUntil when it's undefined, and still lets the promise run to completion", async () => {
    let ran = false;
    runInBackground(
      Promise.resolve().then(() => {
        ran = true;
      }),
      undefined,
      "test:event",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ran, true);
  });

  test("a rejection is caught and logged under the given label — never thrown synchronously, never an unhandled rejection", async () => {
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      assert.doesNotThrow(() => {
        runInBackground(
          Promise.reject(new Error("boom")),
          undefined,
          "test:runtime_handoff_failed",
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = originalError;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "test:runtime_handoff_failed");
    assert.equal(calls[0]?.[1] as Error | string, "boom");
  });

  test("does not require waitUntil to be called for the promise to still be caught on rejection", async () => {
    let seenByWaitUntil: Promise<unknown> | undefined;
    const waitUntil = (p: Promise<unknown>) => {
      seenByWaitUntil = p;
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      runInBackground(Promise.reject(new Error("boom")), waitUntil, "test:event");
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The promise handed to waitUntil must itself be the *guarded* (already
      // .catch()'d) promise, never the raw rejecting one — otherwise
      // Cloudflare's own waitUntil machinery would see an unhandled
      // rejection despite this module's whole purpose being to prevent one.
      await assert.doesNotReject(() => seenByWaitUntil!);
    } finally {
      console.error = originalError;
    }
  });
});
