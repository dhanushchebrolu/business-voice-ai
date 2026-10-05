import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getCloudflareEnv } from "./lib/telephony/cloudflare-env.server.ts";

/**
 * Regression coverage for src/server.ts — the raw Cloudflare Workers fetch
 * handler that intercepts WebSocket upgrades before TanStack Start's own
 * request handling. This file imports `@tanstack/react-start/server-entry`
 * dynamically and expects a real Cloudflare Workers `env`/`ctx`, so this
 * repo's Node-native test runner cannot exercise its behavior directly
 * (same established convention as other Workers-only files in this repo —
 * see e.g. vobiz-media-route.server.test.ts). Source-scan verifies the
 * diagnostic's own wiring: that it fires unconditionally at the routing
 * decision, before either branch, and never logs anything beyond
 * booleans/counts/identifiers.
 *
 * Production incident this diagnostic targets: a WebSocket-upgrade request
 * for a Vobiz call produced vobiz_media_route:accepted (only emitted by the
 * non-DO fallback, vobiz-media-route.server.ts) while the SAME call's
 * /internal/start-runtime RPC produced vobiz_call_session_do:* logs (the
 * Durable Object path) — proving the two requests took different routing
 * decisions for the VOBIZ_CALL_SESSION binding. This diagnostic logs the
 * exact state of that binding at the moment of the WS-upgrade routing
 * decision, so the next test proves why.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "server.ts"), "utf8");

describe("src/server.ts — Vobiz WS routing diagnostic (production incident: WS-upgrade and RPC paths resolved VOBIZ_CALL_SESSION differently for the same call)", () => {
  test("logs server:vobiz_ws_routing_decision unconditionally, before either the durable_object or fallback branch runs", () => {
    const logIdx = src.indexOf('console.info("server:vobiz_ws_routing_decision"');
    const ifVobizNamespaceIdx = src.indexOf("if (vobizNamespace) {");
    const handleVobizMediaUpgradeIdx = src.indexOf(
      "const vobizMediaUpgrade = await handleVobizMediaUpgrade(request);",
    );
    assert.ok(logIdx > -1, "expected the diagnostic log to exist");
    assert.ok(ifVobizNamespaceIdx > -1 && handleVobizMediaUpgradeIdx > -1);
    assert.ok(
      logIdx < ifVobizNamespaceIdx,
      "the diagnostic must log before the routing decision, not after it — otherwise the branch taken could still be inferred rather than directly observed",
    );
    assert.ok(logIdx < handleVobizMediaUpgradeIdx);
  });

  test("the diagnostic is scoped to the Vobiz WS-upgrade branch only, not Exotel's equivalent interception above it", () => {
    const exotelIdx = src.indexOf("const mediaUpgrade = await handleExotelMediaUpgrade(request);");
    const logIdx = src.indexOf('console.info("server:vobiz_ws_routing_decision"');
    assert.ok(exotelIdx > -1 && logIdx > -1);
    assert.ok(
      exotelIdx < logIdx,
      "expected Exotel's own WS interception to precede the Vobiz-scoped diagnostic, confirming it was not duplicated onto Exotel's path",
    );
  });

  test("records hasVobizCallSessionBinding, hasCallSessionBinding (for cross-provider comparison), the selected routingPath, and the coordinator name", () => {
    const logIdx = src.indexOf('console.info("server:vobiz_ws_routing_decision"');
    const block = src.slice(logIdx, src.indexOf("});", logIdx));
    assert.match(block, /hasVobizCallSessionBinding: Boolean\(vobizNamespace\)/);
    assert.match(block, /hasCallSessionBinding: Boolean\(cfEnv\?\.CALL_SESSION\)/);
    assert.match(block, /routingPath: vobizNamespace \? "durable_object" : "fallback"/);
    assert.match(block, /coordinatorName: VOBIZ_CALL_SESSION_COORDINATOR_NAME/);
  });

  test("logs only a key COUNT for env, never the key names (which could include unrelated binding/secret names)", () => {
    const logIdx = src.indexOf('console.info("server:vobiz_ws_routing_decision"');
    const block = src.slice(logIdx, src.indexOf("});", logIdx));
    assert.match(block, /envKeyCount: cfEnv \? Object\.keys\(cfEnv\)\.length : null/);
    assert.doesNotMatch(block, /envKeys:/);
    assert.doesNotMatch(block, /Object\.values\(cfEnv/);
  });

  test("never logs a secret, auth token, webhook signature, or raw request/env contents", () => {
    const logIdx = src.indexOf('console.info("server:vobiz_ws_routing_decision"');
    assert.ok(logIdx > -1);
    const block = src.slice(logIdx, src.indexOf("});", logIdx));
    assert.doesNotMatch(block, /authToken/i);
    assert.doesNotMatch(block, /signature/i);
    assert.doesNotMatch(block, /verify_token/i);
    assert.doesNotMatch(block, /\bSERVICE_ROLE_KEY\b/);
    assert.doesNotMatch(block, /\bcfEnv,?\s*\n/, "must never log the raw env object itself");
  });

  test("does not change the actual routing behavior — the same if/else structure and stub.fetch(request)/handleVobizMediaUpgrade(request) calls remain", () => {
    assert.match(src, /if \(vobizNamespace\) \{/);
    assert.match(src, /return await stub\.fetch\(request\);/);
    assert.match(src, /const vobizMediaUpgrade = await handleVobizMediaUpgrade\(request\);/);
  });
});

function withGlobalEnv<T>(env: unknown, fn: () => T): T {
  const original = (globalThis as { __env__?: unknown }).__env__;
  (globalThis as { __env__?: unknown }).__env__ = env;
  try {
    return fn();
  } finally {
    (globalThis as { __env__?: unknown }).__env__ = original;
  }
}

describe("src/server.ts — FIX (production incident: VOBIZ_CALL_SESSION resolved for the RPC but not the WebSocket upgrade for the same call, same deployed version — root cause: this file's cfEnv came only from its own fetch(request, env, ctx) parameter, never getCloudflareEnv()/globalThis.__env__, which the RPC path already used and which the evidence proved reliable)", () => {
  test("the Vobiz cfEnv resolution now prefers getCloudflareEnv() over the direct fetch() parameter, with the parameter kept only as a fallback", () => {
    assert.match(
      src,
      /const cfEnv = getCloudflareEnv\(\) \?\? \(env as CloudflareEnv \| null \| undefined\);/,
      "expected getCloudflareEnv() to be tried first, exactly matching the proven-reliable RPC-path mechanism",
    );
  });

  test("getCloudflareEnv is actually imported from the shared module, not reimplemented locally", () => {
    assert.match(
      src,
      /import\s*\{[\s\S]*?getCloudflareEnv[\s\S]*?\}\s*from\s*"\.\/lib\/telephony\/cloudflare-env\.server"/,
    );
  });

  test("Exotel's own WS-upgrade block is untouched — still resolves cfEnv only from the direct parameter, never getCloudflareEnv()", () => {
    const exotelBlockStart = src.indexOf("url.pathname === MEDIA_STREAM_PATH &&");
    const vobizBlockStart = src.indexOf("url.pathname === VOBIZ_MEDIA_STREAM_PATH &&");
    assert.ok(exotelBlockStart > -1 && vobizBlockStart > -1 && exotelBlockStart < vobizBlockStart);
    const exotelBlock = src.slice(exotelBlockStart, vobizBlockStart);
    assert.match(exotelBlock, /const cfEnv = env as CloudflareEnv \| null \| undefined;/);
    assert.doesNotMatch(exotelBlock, /getCloudflareEnv/);
  });

  test("BEHAVIORAL (using the real getCloudflareEnv — the exact function the fix calls, not a reimplementation): globalThis.__env__ wins over the direct parameter when both are present", () => {
    withGlobalEnv({ VOBIZ_CALL_SESSION: "from-global" }, () => {
      const directParamEnv = { VOBIZ_CALL_SESSION: "from-param" };
      const cfEnv =
        getCloudflareEnv() ?? (directParamEnv as typeof directParamEnv | null | undefined);
      assert.equal((cfEnv as { VOBIZ_CALL_SESSION: string }).VOBIZ_CALL_SESSION, "from-global");
    });
  });

  test("BEHAVIORAL: falls back to the direct parameter when globalThis.__env__ is unset (local vite dev — getCloudflareEnv() genuinely returns null there)", () => {
    withGlobalEnv(undefined, () => {
      const directParamEnv = { VOBIZ_CALL_SESSION: "from-param" };
      const cfEnv =
        getCloudflareEnv() ?? (directParamEnv as typeof directParamEnv | null | undefined);
      assert.equal((cfEnv as { VOBIZ_CALL_SESSION: string }).VOBIZ_CALL_SESSION, "from-param");
    });
  });

  test("REGRESSION: the no-binding/failure case — neither source has the binding — degrades to the existing fallback path, not a crash", () => {
    withGlobalEnv(undefined, () => {
      const directParamEnv: unknown = undefined;
      const cfEnv =
        getCloudflareEnv() ??
        (directParamEnv as { VOBIZ_CALL_SESSION?: unknown } | null | undefined);
      const vobizNamespace = cfEnv?.VOBIZ_CALL_SESSION;
      assert.equal(vobizNamespace, undefined);
      // This is exactly the condition src/server.ts's own `if (vobizNamespace)`
      // branches on — confirming the local-dev/no-binding degraded path
      // (handleVobizMediaUpgrade, the in-process fallback) is still reached
      // correctly, not accidentally broken by preferring getCloudflareEnv().
      assert.equal(Boolean(vobizNamespace), false);
    });
  });
});
