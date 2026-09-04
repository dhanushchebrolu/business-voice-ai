import { test } from "node:test";
import assert from "node:assert/strict";
import { ExotelMediaBridge, type ExotelSocketLike } from "./exotel-media-bridge.server.ts";

/**
 * Deterministic local Exotel WebSocket simulator (spec §29) — NOT an
 * end-to-end Exotel test (no live account exists in this environment; see
 * PHASE_D1_EXOTEL_FINAL_REPORT.md §18). Drives the exact documented event
 * sequence: Connected -> Start -> Media -> Media -> Mark -> Clear -> Media
 * -> Stop, and asserts the bridge's protocol handling at each step.
 */
class FakeExotelSocket implements ExotelSocketLike {
  readyState = 1; // OPEN
  sent: string[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;
  private listeners: Record<string, ((ev: never) => void)[]> = {
    message: [],
    close: [],
    error: [],
  };

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.readyState = 3; // CLOSED
    this.closeCode = code;
    this.closeReason = reason;
    for (const cb of this.listeners["close"]!)
      (cb as (ev: { code: number; reason: string }) => void)({
        code: code ?? 1000,
        reason: reason ?? "",
      });
  }
  addEventListener(type: string, cb: (ev: never) => void): void {
    this.listeners[type]!.push(cb);
  }
  emitMessage(data: string) {
    for (const cb of this.listeners["message"]!) (cb as (ev: { data: unknown }) => void)({ data });
  }
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

test("Exotel protocol simulation: full Connected->Start->Media->Mark->Clear->Media->Stop sequence", () => {
  const socket = new FakeExotelSocket();
  const bridge = new ExotelMediaBridge(socket, "placeholder", "CAtestcall");

  const received: string[] = [];
  bridge.onInboundFrame((frame) => received.push(Buffer.from(frame.data).toString("utf8")));
  let closedReason: string | null = null;
  bridge.onClose((reason) => {
    closedReason = reason;
  });

  socket.emitMessage(JSON.stringify({ event: "connected" }));
  socket.emitMessage(
    JSON.stringify({ event: "start", start: { stream_sid: "STtest123", call_sid: "CAtestcall" } }),
  );
  socket.emitMessage(JSON.stringify({ event: "media", media: { payload: b64("frame-one") } }));
  socket.emitMessage(JSON.stringify({ event: "media", media: { payload: b64("frame-two") } }));
  socket.emitMessage(JSON.stringify({ event: "mark", mark: { name: "m1" } }));

  assert.deepEqual(received, ["frame-one", "frame-two"]);

  // Outbound: the bridge must echo the real stream_sid learned from Start,
  // not the placeholder passed to the constructor.
  bridge.sendOutboundFrame({ data: new TextEncoder().encode("assistant-audio"), timestampMs: 0 });
  const sentMedia = JSON.parse(socket.sent.at(-1)!) as {
    event: string;
    stream_sid: string;
    media: { payload: string };
  };
  assert.equal(sentMedia.event, "media");
  assert.equal(sentMedia.stream_sid, "STtest123");
  assert.equal(Buffer.from(sentMedia.media.payload, "base64").toString("utf8"), "assistant-audio");

  bridge.clearOutboundBuffer();
  const sentClear = JSON.parse(socket.sent.at(-1)!) as { event: string; stream_sid: string };
  assert.equal(sentClear.event, "clear");
  assert.equal(sentClear.stream_sid, "STtest123");

  socket.emitMessage(JSON.stringify({ event: "media", media: { payload: b64("frame-three") } }));
  assert.deepEqual(received, ["frame-one", "frame-two", "frame-three"]);

  socket.emitMessage(JSON.stringify({ event: "stop" }));
  assert.equal(closedReason, "provider stop event");
});

test("malformed messages are dropped, never thrown, and never delivered as frames", () => {
  const socket = new FakeExotelSocket();
  const bridge = new ExotelMediaBridge(socket, "placeholder", "CAtestcall");
  const received: unknown[] = [];
  bridge.onInboundFrame((frame) => received.push(frame));

  assert.doesNotThrow(() => socket.emitMessage("not json at all"));
  assert.doesNotThrow(() => socket.emitMessage(JSON.stringify({ event: "media" }))); // no media.payload
  assert.doesNotThrow(() =>
    socket.emitMessage(
      JSON.stringify({ event: "media", media: { payload: "not-valid-base64!!!" } }),
    ),
  );
  assert.doesNotThrow(() => socket.emitMessage(JSON.stringify({ event: "totally_unknown_event" })));
  assert.doesNotThrow(() => socket.emitMessage("x".repeat(200_000))); // oversized

  assert.equal(received.length, 0);
});

test("close() is idempotent and closes the underlying socket", () => {
  const socket = new FakeExotelSocket();
  const bridge = new ExotelMediaBridge(socket, "placeholder", "CAtestcall");
  let closeCount = 0;
  bridge.onClose(() => {
    closeCount++;
  });
  bridge.close();
  bridge.close();
  assert.equal(closeCount, 1);
  assert.equal(socket.readyState, 3);
});
