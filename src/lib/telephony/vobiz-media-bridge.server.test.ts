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
  // Flat top-level streamId — the defensive fallback shape, exercised here
  // alongside the real nested shape in the dedicated test below.
  socket.emitMessage(JSON.stringify({ event: "start", streamId: "st-123", callId: "cu-testcall" }));
  // The real, confirmed Vobiz/Plivo-protocol media event shape: the base64
  // payload is nested under media.payload, alongside media.track/chunk/
  // timestamp — not a flat top-level media string.
  socket.emitMessage(
    JSON.stringify({
      event: "media",
      sequenceNumber: "1",
      streamId: "st-123",
      media: { track: "inbound", chunk: "1", timestamp: "0", payload: b64("frame-one") },
    }),
  );
  socket.emitMessage(
    JSON.stringify({
      event: "media",
      sequenceNumber: "2",
      streamId: "st-123",
      media: { track: "inbound", chunk: "2", timestamp: "20", payload: b64("frame-two") },
    }),
  );

  assert.deepEqual(received, ["frame-one", "frame-two"]);

  // Outbound: the bridge must echo the real streamId learned from "start",
  // not the placeholder passed to the constructor.
  bridge.sendOutboundFrame({ data: new TextEncoder().encode("assistant-audio"), timestampMs: 0 });
  const sentPlayAudio = JSON.parse(socket.sent.at(-1)!) as {
    event: string;
    streamId: string;
    media: { payload: string; contentType: string; sampleRate: number };
  };
  assert.equal(sentPlayAudio.event, "playAudio");
  assert.equal(sentPlayAudio.streamId, "st-123");
  assert.equal(sentPlayAudio.media.contentType, "audio/x-mulaw");
  assert.equal(sentPlayAudio.media.sampleRate, 8000);
  assert.equal(
    Buffer.from(sentPlayAudio.media.payload, "base64").toString("utf8"),
    "assistant-audio",
  );

  bridge.clearOutboundBuffer();
  const sentClear = JSON.parse(socket.sent.at(-1)!) as { event: string; streamId: string };
  assert.equal(sentClear.event, "clearAudio");
  assert.equal(sentClear.streamId, "st-123");

  socket.emitMessage(JSON.stringify({ event: "stop" }));
  assert.equal(closedReason, "provider stop event");
});

test("REGRESSION (production incident: Vobiz's real start event nests streamId under start.streamId, not flat): a start event with the real nested shape updates the bridge's streamId", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "placeholder", "cu-testcall");

  socket.emitMessage(
    JSON.stringify({
      event: "start",
      sequenceNumber: "1",
      start: { streamId: "st-nested-456", callId: "cu-testcall", tracks: ["inbound"] },
    }),
  );

  bridge.sendOutboundFrame({ data: new TextEncoder().encode("assistant-audio"), timestampMs: 0 });
  const sentPlayAudio = JSON.parse(socket.sent.at(-1)!) as { streamId: string };
  assert.equal(
    sentPlayAudio.streamId,
    "st-nested-456",
    "expected the nested start.streamId to be read, not just the top-level fallback",
  );
});

test("a malformed media frame (invalid base64 inside media.payload) is dropped, not thrown, and never reaches onInboundFrame", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "st-1", "cu-1");
  const received: string[] = [];
  bridge.onInboundFrame((frame) => received.push(Buffer.from(frame.data).toString("utf8")));

  assert.doesNotThrow(() =>
    socket.emitMessage(JSON.stringify({ event: "media", media: { payload: "not-base64!!!" } })),
  );
  assert.deepEqual(received, []);
});

test("a missing media payload (no 'media' key at all) is dropped, not thrown", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "st-1", "cu-1");
  const received: string[] = [];
  bridge.onInboundFrame((frame) => received.push(Buffer.from(frame.data).toString("utf8")));

  assert.doesNotThrow(() => socket.emitMessage(JSON.stringify({ event: "media" })));
  assert.deepEqual(received, []);
});

test("REGRESSION (production incident dc249661-d3d2-48f3-9391-243017527b26: vobiz_bridge:media_missing_payload fired on every ~20ms frame because 'media' is an object, not a flat base64 string): the OLD flat shape is no longer treated as a valid payload — it never reaches onInboundFrame and still logs media_missing_payload, proving the bug is understood, not just coincidentally fixed", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "st-1", "cu-1");
  const received: string[] = [];
  bridge.onInboundFrame((frame) => received.push(Buffer.from(frame.data).toString("utf8")));

  const originalError = console.error;
  const errors: unknown[] = [];
  console.error = (event: unknown, data?: unknown) => {
    errors.push({ event, data });
  };
  try {
    // The OLD (wrong) shape this bridge used to accept: a flat top-level
    // base64 string instead of a nested media.payload object.
    socket.emitMessage(JSON.stringify({ event: "media", media: b64("should-not-arrive") }));
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(received, [], "a flat top-level media string must never reach onInboundFrame");
  const missingPayloadLog = errors.find(
    (e) => (e as { event: unknown }).event === "vobiz_bridge:media_missing_payload",
  );
  assert.ok(missingPayloadLog, "expected media_missing_payload for the old, now-invalid shape");
});

test("REGRESSION (same incident): the real nested media.payload shape is correctly extracted and reaches onInboundFrame with the exact decoded bytes", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "st-1", "cu-1");
  const received: string[] = [];
  bridge.onInboundFrame((frame) => received.push(Buffer.from(frame.data).toString("utf8")));

  socket.emitMessage(
    JSON.stringify({
      event: "media",
      sequenceNumber: "7",
      streamId: "st-1",
      media: { track: "inbound", chunk: "7", timestamp: "140", payload: b64("caller-audio") },
    }),
  );

  assert.deepEqual(received, ["caller-audio"]);
});

test("REGRESSION (same incident): outbound playAudio sends the real nested {streamId, media:{contentType, sampleRate, payload}} shape, not the old {playAudio:{media, contentType, sampleRate}} shape", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "st-1", "cu-1", () => {});

  bridge.sendOutboundFrame({ data: new TextEncoder().encode("agent-reply"), timestampMs: 0 });

  const sent = JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>;
  assert.equal(sent["event"], "playAudio");
  assert.equal(sent["streamId"], "st-1");
  assert.ok(!("playAudio" in sent), "the old 'playAudio' wrapper key must be gone");
  const media = sent["media"] as { contentType: string; sampleRate: number; payload: string };
  assert.ok(media, "expected a top-level 'media' object, not a 'playAudio' sub-object");
  assert.equal(media.contentType, "audio/x-mulaw");
  assert.equal(media.sampleRate, 8000);
  assert.equal(Buffer.from(media.payload, "base64").toString("utf8"), "agent-reply");
});

test("PROBLEM 4 (broken/choppy audio investigation): a known short mu-law payload survives sendOutboundFrame byte-for-byte — base64-encoded exactly once, no truncation, no re-encoding, no resampling of the byte length", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "st-1", "cu-1", () => {});

  // One 20ms frame of 8kHz mu-law audio (160 bytes/sample, 1 byte/sample) —
  // a realistic frame size/shape, not an arbitrary string. Values chosen to
  // cover the full byte range (0x00-0x9F ascending), so a corrupting
  // transformation (e.g. accidentally treating these as PCM and
  // mu-law-encoding them a second time, or truncating/padding) would change
  // at least one byte.
  const frame = new Uint8Array(160);
  for (let i = 0; i < frame.length; i++) frame[i] = i % 256;

  bridge.sendOutboundFrame({ data: frame, timestampMs: 0 });

  const sent = JSON.parse(socket.sent.at(-1)!) as {
    media: { payload: string; contentType: string; sampleRate: number };
  };
  const decoded = Buffer.from(sent.media.payload, "base64");
  assert.equal(
    decoded.length,
    frame.length,
    "byte length must be preserved exactly — no resampling",
  );
  assert.deepEqual(
    new Uint8Array(decoded),
    frame,
    "bytes must round-trip exactly — exactly one base64 pass, no double-encoding or corruption",
  );
  assert.equal(
    sent.media.contentType,
    "audio/x-mulaw",
    "codec is declared, never silently changed",
  );
  assert.equal(sent.media.sampleRate, 8000);
});

test("DIAGNOSTIC: media_event_shape logs field NAMES/TYPES/LENGTHS only, once per bridge instance (not per frame), and never the raw audio payload", () => {
  const socket = new FakeVobizSocket();
  const bridge = new VobizMediaBridge(socket, "st-1", "cu-1");
  bridge.onInboundFrame(() => {});

  const originalInfo = console.info;
  const infoLogs: { event: unknown; data: unknown }[] = [];
  console.info = (event: unknown, data?: unknown) => {
    infoLogs.push({ event, data });
  };
  try {
    socket.emitMessage(
      JSON.stringify({
        event: "media",
        sequenceNumber: "1",
        streamId: "st-1",
        media: { track: "inbound", chunk: "1", timestamp: "0", payload: b64("secret-audio-frame") },
      }),
    );
    socket.emitMessage(
      JSON.stringify({
        event: "media",
        sequenceNumber: "2",
        streamId: "st-1",
        media: { track: "inbound", chunk: "2", timestamp: "20", payload: b64("second-frame") },
      }),
    );
  } finally {
    console.info = originalInfo;
  }

  const shapeLogs = infoLogs.filter((l) => l.event === "vobiz_bridge:media_event_shape");
  assert.equal(shapeLogs.length, 1, "expected exactly one shape diagnostic, not one per frame");

  const data = shapeLogs[0]!.data as {
    topLevelKeys: string[];
    nestedMediaKeys: string[];
    payloadPresent: boolean;
    payloadLength: number;
  };
  assert.deepEqual(data.topLevelKeys.sort(), ["event", "media", "sequenceNumber", "streamId"]);
  assert.deepEqual(data.nestedMediaKeys.sort(), ["chunk", "payload", "timestamp", "track"]);
  assert.equal(data.payloadPresent, true);
  assert.equal(data.payloadLength, b64("secret-audio-frame").length);

  const allLoggedText = JSON.stringify(infoLogs);
  assert.doesNotMatch(allLoggedText, /secret-audio-frame/);
  assert.doesNotMatch(allLoggedText, new RegExp(b64("secret-audio-frame")));
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
