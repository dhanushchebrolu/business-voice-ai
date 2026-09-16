import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handleExotelMediaUpgrade } from "./exotel-media-route.server.ts";
import type { ExotelSocketLike } from "./exotel-media-bridge.server.ts";

/**
 * Live-call regression: this route previously required call_logs.status to
 * already be exactly "answered" or "in_progress" before accepting Exotel's
 * media WebSocket. The retry loop just above only waits for the call_logs
 * ROW to exist, not for its status to reach one of those two values, and
 * the row is very often created first (by the status-less "call-attempt"
 * fallback event) at status "initiated" — well before Exotel's own
 * "in-progress"/"answered" status webhook lands. That left a genuinely
 * live, authorized call rejected here purely on timing. Source-scanned
 * (rather than exercised end-to-end) because reaching this code path
 * requires a live Supabase connection this sandbox cannot provide.
 */
const exotelMediaRouteSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "exotel-media-route.server.ts"),
  "utf8",
);

test("the media-session status check rejects only a call already in a TERMINAL status, not merely 'not yet answered'", () => {
  assert.match(
    exotelMediaRouteSrc,
    /import \{ checkTelephonyAccess, TERMINAL_CALL_STATUSES \} from "\.\.\/telephony-guard\.server\.ts";/,
  );
  assert.doesNotMatch(
    exotelMediaRouteSrc,
    /call\.status !== "answered" && call\.status !== "in_progress"/,
  );
  const idx = exotelMediaRouteSrc.indexOf("if (!call) return reject(");
  assert.ok(idx > -1);
  const block = exotelMediaRouteSrc.slice(idx, idx + 1500);
  assert.match(block, /TERMINAL_CALL_STATUSES\.includes\(/);
});

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
