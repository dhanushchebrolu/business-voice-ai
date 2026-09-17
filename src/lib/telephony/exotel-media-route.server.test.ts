import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleExotelMediaUpgrade } from "./exotel-media-route.server.ts";
import type { ExotelSocketLike } from "./exotel-media-bridge.server.ts";

test("returns null (pass-through to the normal app router) for any non-media-stream path", async () => {
  const req = new Request("https://vaani.app/api/public/webhooks/telephony?provider=exotel", {
    headers: { upgrade: "websocket" },
  });
  const res = await handleExotelMediaUpgrade(req);
  assert.equal(res, null);
});

test("rejects a non-upgrade request to the media-stream path", async () => {
  const req = new Request("https://vaani.app/api/public/media-stream/exotel");
  const res = await handleExotelMediaUpgrade(req);
  assert.ok(res);
  assert.equal(res!.status, 400);
});

test("fails closed (501, not a crash) when the Cloudflare WebSocketPair global is unavailable — the real state of this Node test environment, not a mock", async () => {
  assert.equal(typeof (globalThis as Record<string, unknown>)["WebSocketPair"], "undefined");
  const req = new Request("https://vaani.app/api/public/media-stream/exotel", {
    headers: { upgrade: "websocket" },
  });
  const res = await handleExotelMediaUpgrade(req);
  assert.ok(res);
  assert.equal(res!.status, 501);
});

/** Minimal fake matching Cloudflare's WebSocketPair contract — same shape call-session-durable-object.server.test.ts already uses. */
class FakeSocket implements ExotelSocketLike {
  readyState = 1;
  closedWith: { code: number; reason: string } | null = null;
  private listeners: Record<"message" | "close" | "error", Array<(ev: never) => void>> = {
    message: [],
    close: [],
    error: [],
  };
  accept(): void {}
  send(): void {}
  close(code?: number, reason?: string): void {
    if (this.closedWith) return;
    this.closedWith = { code: code ?? 1000, reason: reason ?? "" };
    this.readyState = 3;
  }
  addEventListener(type: "message" | "close" | "error", cb: (ev: never) => void): void {
    this.listeners[type].push(cb);
  }
  emit(type: "message" | "close" | "error", ev: never): void {
    for (const cb of this.listeners[type]) cb(ev);
  }
}
class FakeWebSocketPair {
  static instances: FakeWebSocketPair[] = [];
  0: FakeSocket;
  1: FakeSocket;
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
    FakeWebSocketPair.instances.push(this);
  }
}

test("BUGFIX regression: a 'media' frame arriving in the same tick as 'start' does not crash the process and the socket is still cleanly closed once validation fails", async () => {
  // Same race as call-session-durable-object.server.test.ts's equivalent
  // regression test, exercised here against the local-dev fallback path
  // (handleExotelMediaUpgrade itself, used when no CALL_SESSION Durable
  // Object binding is configured). See that test for the full rationale.
  const originalPair = (globalThis as Record<string, unknown>)["WebSocketPair"];
  FakeWebSocketPair.instances = [];
  (globalThis as Record<string, unknown>)["WebSocketPair"] = FakeWebSocketPair;
  try {
    // handleExotelMediaUpgrade has no try/catch of its own around
    // `new Response(null, {status: 101, webSocket})` — in real Cloudflare
    // Workers that construct is supported and never throws; Node's own
    // Response implementation rejects status 101 outright, which is why
    // this call is expected to reject here (same documented Node-only
    // artifact call-session-durable-object.server.test.ts already relies
    // on). What matters is that `server.addEventListener("message", ...)`
    // already ran before that point, so the fake socket is still usable.
    await assert.rejects(() =>
      handleExotelMediaUpgrade(
        new Request("https://vaani.app/api/public/media-stream/exotel", {
          headers: { upgrade: "websocket" },
        }),
      ),
    );
    const serverSocket = FakeWebSocketPair.instances[0]![0];

    serverSocket.emit("message", {
      data: JSON.stringify({ event: "start", start: { call_sid: "CA-race-2" } }),
    } as never);
    serverSocket.emit("message", {
      data: JSON.stringify({ event: "media", media: { payload: "AAAA" } }),
    } as never);

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(
      serverSocket.closedWith !== null,
      "expected the socket to have been closed once validation failed, not left hanging open",
    );
  } finally {
    if (originalPair === undefined) delete (globalThis as Record<string, unknown>)["WebSocketPair"];
    else (globalThis as Record<string, unknown>)["WebSocketPair"] = originalPair;
  }
});

test("TASK 7 (reject invalid provider/call identifiers): a 'start' event with no CallSid at all is rejected — socket closed 1008, never left hanging waiting for a database lookup that has nothing to look up", async () => {
  const originalPair = (globalThis as Record<string, unknown>)["WebSocketPair"];
  FakeWebSocketPair.instances = [];
  (globalThis as Record<string, unknown>)["WebSocketPair"] = FakeWebSocketPair;
  try {
    await assert.rejects(() =>
      handleExotelMediaUpgrade(
        new Request("https://vaani.app/api/public/media-stream/exotel", {
          headers: { upgrade: "websocket" },
        }),
      ),
    );
    const serverSocket = FakeWebSocketPair.instances[0]![0];

    // "start" with a stream_sid but deliberately no call_sid/CallSid/callSid
    // anywhere — the exact shape a misconfigured or spoofed client could
    // send, and the one this route's own CallSid-required check exists for.
    serverSocket.emit("message", {
      data: JSON.stringify({ event: "start", start: { stream_sid: "STnoSid" } }),
    } as never);

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(serverSocket.closedWith, "expected the socket to be closed, not left open");
    assert.equal(serverSocket.closedWith!.code, 1008);
    assert.equal(serverSocket.closedWith!.reason, "unauthorized");
  } finally {
    if (originalPair === undefined) delete (globalThis as Record<string, unknown>)["WebSocketPair"];
    else (globalThis as Record<string, unknown>)["WebSocketPair"] = originalPair;
  }
});

test("REGRESSION (production incident: 'initiated' calls rejected by media-session auth): the call_logs status eligibility check delegates to the shared isEligibleForMediaSession helper, not a local re-implementation", () => {
  // This sandbox has no live Supabase connection (see this session's other
  // source-scan tests), so the actual DB-backed branch that rejected a
  // real Exotel call stuck at status "initiated" cannot be exercised
  // end-to-end here. What this proves instead: the eligibility check is
  // the single shared function (media-session-eligibility.test.ts covers
  // its behavior directly, including "initiated" now being eligible), not
  // a hand-rolled `status !== "answered" && status !== "in_progress"`
  // comparison that could silently drift from call-session-durable-object.
  // server.ts's copy again.
  const source = readFileSync(new URL("./exotel-media-route.server.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /import\s*\{\s*isEligibleForMediaSession\s*\}\s*from\s*["']\.\/media-session-eligibility\.ts["']/,
    "expected exotel-media-route.server.ts to import the shared eligibility helper",
  );
  assert.match(
    source,
    /if\s*\(\s*!isEligibleForMediaSession\(call\.status\)\s*\)/,
    "expected the status-eligibility check to call the shared helper, not a local comparison",
  );
  assert.doesNotMatch(
    source,
    /call\.status\s*!==\s*["']answered["']/,
    "expected no local 'answered'/'in_progress'-only comparison left behind in this file",
  );
});
