import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getVobizCallSessionStub, getCloudflareEnv } from "./cloudflare-env.server.ts";

/**
 * Regression coverage for the diagnostic added to getVobizCallSessionStub
 * (production incident: a WebSocket-upgrade request for a Vobiz call fell
 * back to the non-DO path while the same call's /internal/start-runtime RPC
 * — which calls this function — resolved the VOBIZ_CALL_SESSION binding
 * fine. Logging the same shape here as src/server.ts's own
 * "server:vobiz_ws_routing_decision" log lets the two binding-acquisition
 * paths be compared directly for the same call on the next test).
 *
 * getCloudflareEnv() reads globalThis.__env__ (Nitro's own mechanism) — set
 * directly here, mirroring how Nitro's _module-handler.mjs sets it on every
 * real request, to drive this function through real behavior without a live
 * Cloudflare Workers runtime.
 */

function captureInfoLogs() {
  const calls: { event: string; data: unknown }[] = [];
  const original = console.info;
  console.info = (event: unknown, data?: unknown) => {
    calls.push({ event: String(event), data });
  };
  return {
    calls,
    restore: () => {
      console.info = original;
    },
  };
}

function withGlobalEnv<T>(env: unknown, fn: () => T): T {
  const original = (globalThis as { __env__?: unknown }).__env__;
  (globalThis as { __env__?: unknown }).__env__ = env;
  try {
    return fn();
  } finally {
    (globalThis as { __env__?: unknown }).__env__ = original;
  }
}

describe("getCloudflareEnv — reads globalThis.__env__, the same mechanism Nitro's cloudflare-module preset uses", () => {
  test("returns null when globalThis.__env__ is unset (local dev / Node test runner)", () => {
    withGlobalEnv(undefined, () => {
      assert.equal(getCloudflareEnv(), null);
    });
  });

  test("returns the env object when globalThis.__env__ is a real object", () => {
    withGlobalEnv({ VOBIZ_CALL_SESSION: {} }, () => {
      const env = getCloudflareEnv();
      assert.ok(env);
      assert.ok("VOBIZ_CALL_SESSION" in env!);
    });
  });
});

describe("getVobizCallSessionStub — DIAGNOSTIC (production incident: WS-upgrade and RPC paths resolved the VOBIZ_CALL_SESSION binding differently for the same call)", () => {
  test("logs telephony:vobiz_call_session_stub_lookup every time this function runs, whether or not the binding is present", () => {
    const logs = captureInfoLogs();
    try {
      withGlobalEnv({}, () => {
        getVobizCallSessionStub();
      });
    } finally {
      logs.restore();
    }
    const found = logs.calls.find((c) => c.event === "telephony:vobiz_call_session_stub_lookup");
    assert.ok(found, "expected the diagnostic to log unconditionally");
  });

  test("reports hasVobizCallSessionBinding: false and returns null when the binding is absent but env itself is present", () => {
    const logs = captureInfoLogs();
    let result: unknown;
    try {
      withGlobalEnv({}, () => {
        result = getVobizCallSessionStub();
      });
    } finally {
      logs.restore();
    }
    assert.equal(result, null);
    const data = logs.calls[0]!.data as {
      hasEnv: boolean;
      hasVobizCallSessionBinding: boolean;
      hasCallSessionBinding: boolean;
    };
    assert.equal(data.hasEnv, true);
    assert.equal(data.hasVobizCallSessionBinding, false);
    assert.equal(data.hasCallSessionBinding, false);
  });

  test("reports hasEnv: false when globalThis.__env__ was never set at all (the exact shape a genuinely missing binding acquisition would log)", () => {
    const logs = captureInfoLogs();
    let result: unknown;
    try {
      withGlobalEnv(undefined, () => {
        result = getVobizCallSessionStub();
      });
    } finally {
      logs.restore();
    }
    assert.equal(result, null);
    const data = logs.calls[0]!.data as { hasEnv: boolean; envKeyCount: number | null };
    assert.equal(data.hasEnv, false);
    assert.equal(data.envKeyCount, null);
  });

  test("reports hasVobizCallSessionBinding: true and returns a resolved stub when the binding is present", () => {
    const fakeStub = { fetch: async () => new Response("ok") };
    const fakeNamespace = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => fakeStub,
    };
    const logs = captureInfoLogs();
    let result: unknown;
    try {
      withGlobalEnv({ VOBIZ_CALL_SESSION: fakeNamespace, CALL_SESSION: fakeNamespace }, () => {
        result = getVobizCallSessionStub();
      });
    } finally {
      logs.restore();
    }
    assert.equal(result, fakeStub);
    const data = logs.calls[0]!.data as {
      hasVobizCallSessionBinding: boolean;
      hasCallSessionBinding: boolean;
    };
    assert.equal(data.hasVobizCallSessionBinding, true);
    assert.equal(data.hasCallSessionBinding, true);
  });

  test("never logs binding/secret NAMES — only a count of env's own top-level keys", () => {
    const fakeNamespace = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({ fetch: async () => new Response("ok") }),
    };
    const logs = captureInfoLogs();
    try {
      withGlobalEnv(
        { VOBIZ_CALL_SESSION: fakeNamespace, SUPABASE_SERVICE_ROLE_KEY: "super-secret-value" },
        () => {
          getVobizCallSessionStub();
        },
      );
    } finally {
      logs.restore();
    }
    const data = logs.calls[0]!.data as Record<string, unknown>;
    assert.ok(!("envKeys" in data), "expected no raw key-name list, only envKeyCount");
    assert.equal(data["envKeyCount"], 2);
    const allLoggedText = JSON.stringify(logs.calls);
    assert.doesNotMatch(allLoggedText, /SUPABASE_SERVICE_ROLE_KEY/);
    assert.doesNotMatch(allLoggedText, /super-secret-value/);
  });
});
