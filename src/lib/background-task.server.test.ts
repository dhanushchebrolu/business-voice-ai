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
    const failure = new TypeError("boom");
    try {
      assert.doesNotThrow(() => {
        runInBackground(Promise.reject(failure), undefined, "test:runtime_handoff_failed");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = originalError;
    }
    assert.equal(calls.length, 1, "logged exactly once");
    assert.equal(calls[0]?.length, 2, "label + one structured payload, nothing else");
    assert.equal(calls[0]?.[0], "test:runtime_handoff_failed");
    // Structured diagnostics (since 6f1cc7c): the error's own name, message
    // and stack — as a plain object, not the Error instance, so log sinks
    // that serialize with JSON.stringify keep every field.
    const payload = calls[0]?.[1];
    assert.ok(!(payload instanceof Error), "a plain object, not the Error itself");
    assert.deepEqual(payload, {
      name: "TypeError",
      message: "boom",
      stack: failure.stack,
    });
    assert.match(String((payload as { stack?: unknown }).stack), /TypeError: boom/);
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload, "survives JSON serialization");
  });

  test("a non-Error rejection is still caught and logged under the given label, stringified", async () => {
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      assert.doesNotThrow(() => {
        runInBackground(Promise.reject("plain failure"), undefined, "test:non_error");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(calls, [["test:non_error", { error: "plain failure" }]]);
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
