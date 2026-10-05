import { test } from "node:test";
import assert from "node:assert/strict";
import { VobizMediaBridge, type VobizSocketLike } from "./vobiz-media-bridge.server.ts";

/**
 * Deterministic local Vobiz WebSocket simulator — mirrors
 * exotel-media-bridge.server.test.ts's FakeExotelSocket, adapted to
 * Vobiz's own documented event shapes (see vobiz-provider.ts's module doc):
 * start -> media -> media -> stop, and the outbound playAudio/clearAudio
 * events.
 */
class FakeVobizSocket implements VobizSocketLike {
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

test("Vobiz protocol simulation: full connected->start->media->media->stop sequence", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "placeholder", "cu-testcall");

  const received: string[] = [];
  bridge.onInboundFrame((frame) => received.push(Buffer.from(frame.data).toString("utf8")));
  let closedReason: string | null = null;
  bridge.onClose((reason) => {
    closedReason = reason;
  });

  socket.emitMessage(JSON.stringify({ event: "connected" }));
  socket.emitMessage(JSON.stringify({ event: "start", streamId: "st-123", callId: "cu-testcall" }));
  socket.emitMessage(JSON.stringify({ event: "media", media: b64("frame-one") }));
  socket.emitMessage(JSON.stringify({ event: "media", media: b64("frame-two") }));

  assert.deepEqual(received, ["frame-one", "frame-two"]);

  // Outbound: the bridge must echo the real streamId learned from "start",
  // not the placeholder passed to the constructor.
  bridge.sendOutboundFrame({ data: new TextEncoder().encode("assistant-audio"), timestampMs: 0 });
  const sentPlayAudio = JSON.parse(socket.sent.at(-1)!) as {
    event: string;
    streamId: string;
    playAudio: { media: string; contentType: string; sampleRate: number };
  };
  assert.equal(sentPlayAudio.event, "playAudio");
  assert.equal(sentPlayAudio.streamId, "st-123");
  assert.equal(sentPlayAudio.playAudio.contentType, "audio/x-mulaw");
  assert.equal(sentPlayAudio.playAudio.sampleRate, 8000);
  assert.equal(
    Buffer.from(sentPlayAudio.playAudio.media, "base64").toString("utf8"),
    "assistant-audio",
  );

  bridge.clearOutboundBuffer();
  const sentClear = JSON.parse(socket.sent.at(-1)!) as { event: string; streamId: string };
  assert.equal(sentClear.event, "clearAudio");
  assert.equal(sentClear.streamId, "st-123");

  socket.emitMessage(JSON.stringify({ event: "stop" }));
  assert.equal(closedReason, "provider stop event");
});

test("a malformed media frame (invalid base64) is dropped, not thrown, and never reaches onInboundFrame", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "st-1", "cu-1");
  const received: string[] = [];
  bridge.onInboundFrame((frame) => received.push(Buffer.from(frame.data).toString("utf8")));

  assert.doesNotThrow(() =>
    socket.emitMessage(JSON.stringify({ event: "media", media: "not-base64!!!" })),
  );
  assert.deepEqual(received, []);
});

test("a missing media payload is dropped, not thrown", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "st-1", "cu-1");
  const received: string[] = [];
  bridge.onInboundFrame((frame) => received.push(Buffer.from(frame.data).toString("utf8")));

  assert.doesNotThrow(() => socket.emitMessage(JSON.stringify({ event: "media" })));
  assert.deepEqual(received, []);
});

test("malformed JSON on the socket is dropped, not thrown", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "st-1", "cu-1");
  bridge.onInboundFrame(() => {});
  assert.doesNotThrow(() => socket.emitMessage("{not json"));
});

test("sendOutboundFrame after close is a safe no-op, not a send on a closed socket", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "st-1", "cu-1", () => {});
  bridge.close();
  const sentBefore = socket.sent.length;
  bridge.sendOutboundFrame({ data: new Uint8Array([1, 2, 3]), timestampMs: 0 });
  assert.equal(socket.sent.length, sentBefore);
});

test("close() is idempotent — calling it twice does not throw or double-release", () => {
  const socket = new FakeVobizSocket();
  let releaseCount = 0;
  const bridge = new VobizMediaBridge(socket, "st-1", "cu-1", () => {
    releaseCount++;
  });
  bridge.close();
  bridge.close();
  assert.equal(releaseCount, 1);
});

test("native audio format is mu-law at 8kHz, matching the <Stream> contentType this codebase requests", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "st-1", "cu-1", () => {});
  assert.deepEqual(bridge.inboundFormat, { encoding: "mulaw", sampleRateHz: 8000 });
  assert.deepEqual(bridge.outboundFormat, { encoding: "mulaw", sampleRateHz: 8000 });
});
