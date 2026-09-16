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

/** Captures console.info calls (this bridge's diagnostics are all console.info) without ever letting a real one reach the test runner's own output. */
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
    sequence_number: number;
    media: { payload: string; chunk: number; timestamp: string };
  };
  assert.equal(sentMedia.event, "media");
  assert.equal(sentMedia.stream_sid, "STtest123");
  assert.equal(Buffer.from(sentMedia.media.payload, "base64").toString("utf8"), "assistant-audio");
  // sequence_number/media.chunk/media.timestamp — see sendOutboundFrame's
  // own comment for why these were added defensively.
  assert.equal(sentMedia.sequence_number, 1);
  assert.equal(sentMedia.media.chunk, 1);
  assert.equal(sentMedia.media.timestamp, "0");

  bridge.sendOutboundFrame({ data: new TextEncoder().encode("more-audio"), timestampMs: 120 });
  const sentMedia2 = JSON.parse(socket.sent.at(-1)!) as {
    sequence_number: number;
    media: { chunk: number; timestamp: string };
  };
  assert.equal(sentMedia2.sequence_number, 2, "the sequence counter increments per outbound frame");
  assert.equal(sentMedia2.media.chunk, 2);
  assert.equal(sentMedia2.media.timestamp, "120");

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

test("ingestRawMessage() feeds a message through the exact same protocol handling as a real socket message — the replay path the pre-registration buffering fix depends on", () => {
  const socket = new FakeExotelSocket();
  const bridge = new ExotelMediaBridge(socket, "placeholder", "CAtestcall");
  const received: string[] = [];
  bridge.onInboundFrame((frame) => received.push(Buffer.from(frame.data).toString("utf8")));

  // Establish the real stream_sid the normal way first...
  bridge.ingestRawMessage(
    JSON.stringify({ event: "start", start: { stream_sid: "STreplay", call_sid: "CAtestcall" } }),
  );
  // ...then replay a "media" frame exactly as call-session-durable-object.server.ts
  // / exotel-media-route.server.ts do for frames that arrived before this
  // bridge existed. It must be indistinguishable from one delivered live.
  bridge.ingestRawMessage(JSON.stringify({ event: "media", media: { payload: b64("replayed") } }));
  assert.deepEqual(received, ["replayed"]);

  // Malformed input replayed this way is dropped exactly like a live one — no throw.
  assert.doesNotThrow(() => bridge.ingestRawMessage("not json"));
  assert.equal(received.length, 1);
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

test("DIAGNOSTIC (WebSocket lifecycle tracing): a 'media' frame arriving before any onInboundFrame listener is registered is logged once, never per-frame, and never throws", () => {
  const socket = new FakeExotelSocket();
  const bridge = new ExotelMediaBridge(socket, "placeholder", "CAtestcall");
  const logs = captureInfoLogs();
  try {
    // No onInboundFrame listener registered yet — simulates media arriving
    // before voice-runtime.server.ts's startRuntimeSession has attached.
    socket.emitMessage(JSON.stringify({ event: "media", media: { payload: b64("early-frame") } }));
    socket.emitMessage(
      JSON.stringify({ event: "media", media: { payload: b64("early-frame-2") } }),
    );
  } finally {
    logs.restore();
  }
  const dropped = logs.calls.filter(
    (c) => c.event === "exotel_bridge:media_frame_dropped_no_listener",
  );
  assert.equal(dropped.length, 1, "expected exactly one warning, not one per dropped frame");
  assert.deepEqual(dropped[0]!.data, { providerCallId: "CAtestcall" });
});

test("DIAGNOSTIC: once a listener is attached, frames are delivered normally and no drop warning fires", () => {
  const socket = new FakeExotelSocket();
  const bridge = new ExotelMediaBridge(socket, "placeholder", "CAtestcall");
  const received: string[] = [];
  bridge.onInboundFrame((frame) => received.push(Buffer.from(frame.data).toString("utf8")));
  const logs = captureInfoLogs();
  try {
    socket.emitMessage(JSON.stringify({ event: "media", media: { payload: b64("heard") } }));
  } finally {
    logs.restore();
  }
  assert.deepEqual(received, ["heard"]);
  assert.equal(
    logs.calls.some((c) => c.event === "exotel_bridge:media_frame_dropped_no_listener"),
    false,
  );
});

test("DIAGNOSTIC: the first outbound frame sent to Exotel is logged once; a second frame does not repeat it", () => {
  const socket = new FakeExotelSocket();
  const bridge = new ExotelMediaBridge(socket, "placeholder", "CAtestcall");
  const logs = captureInfoLogs();
  try {
    bridge.sendOutboundFrame({ data: new TextEncoder().encode("hello"), timestampMs: 0 });
    bridge.sendOutboundFrame({ data: new TextEncoder().encode("world"), timestampMs: 20 });
  } finally {
    logs.restore();
  }
  const firstFrameLogs = logs.calls.filter(
    (c) => c.event === "exotel_bridge:first_outbound_frame_sent",
  );
  assert.equal(firstFrameLogs.length, 1);
  assert.deepEqual(firstFrameLogs[0]!.data, { providerCallId: "CAtestcall" });
});

test("DIAGNOSTIC (requirement 6: was the socket closed before any audio was sent?): sendOutboundFrame after close() is a no-op and is logged once, distinct from a successful send", () => {
  const socket = new FakeExotelSocket();
  const bridge = new ExotelMediaBridge(socket, "placeholder", "CAtestcall");
  bridge.close();
  const logs = captureInfoLogs();
  try {
    bridge.sendOutboundFrame({ data: new TextEncoder().encode("too-late"), timestampMs: 0 });
    bridge.sendOutboundFrame({ data: new TextEncoder().encode("still-too-late"), timestampMs: 10 });
  } finally {
    logs.restore();
  }
  assert.equal(socket.sent.length, 0, "no media frame should reach the socket after close");
  const droppedLogs = logs.calls.filter(
    (c) => c.event === "exotel_bridge:outbound_frame_dropped_after_close",
  );
  assert.equal(droppedLogs.length, 1, "expected exactly one warning, not one per dropped frame");
  assert.equal(
    logs.calls.some((c) => c.event === "exotel_bridge:first_outbound_frame_sent"),
    false,
    "a frame that never actually reached Exotel must not be logged as 'first outbound frame sent'",
  );
});

test("DIAGNOSTIC (requirements 3/6): closing logs the close reason, the underlying WS close code/reason, and how many outbound frames were sent before it — 0 means Klyro never got to speak", () => {
  const socket = new FakeExotelSocket();
  const bridge = new ExotelMediaBridge(socket, "placeholder", "CAtestcall");
  const logs = captureInfoLogs();
  try {
    socket.emitMessage(JSON.stringify({ event: "connected" }));
    // Closed by Exotel's side (e.g. the caller hung up) before Klyro ever spoke.
    socket.close(1006, "abnormal closure");
  } finally {
    logs.restore();
  }
  const closedLogs = logs.calls.filter((c) => c.event === "exotel_bridge:closed");
  assert.equal(closedLogs.length, 1);
  assert.deepEqual(closedLogs[0]!.data, {
    providerCallId: "CAtestcall",
    reason: "ws closed (1006)",
    wsCloseCode: 1006,
    wsCloseReason: "abnormal closure",
    outboundFramesSent: 0,
  });
});

test("DIAGNOSTIC: outboundFramesSent in the close log reflects frames actually sent before close, once audio did go out", () => {
  const socket = new FakeExotelSocket();
  const bridge = new ExotelMediaBridge(socket, "placeholder", "CAtestcall");
  bridge.sendOutboundFrame({ data: new TextEncoder().encode("greeting"), timestampMs: 0 });
  bridge.sendOutboundFrame({ data: new TextEncoder().encode("more"), timestampMs: 50 });
  const logs = captureInfoLogs();
  try {
    bridge.close();
  } finally {
    logs.restore();
  }
  const closedLogs = logs.calls.filter((c) => c.event === "exotel_bridge:closed");
  assert.equal(closedLogs.length, 1);
  assert.equal((closedLogs[0]!.data as { outboundFramesSent: number }).outboundFramesSent, 2);
});

test("DIAGNOSTIC (requirement 2): a 'stop' event is logged before the bridge closes", () => {
  const socket = new FakeExotelSocket();
  const bridge = new ExotelMediaBridge(socket, "placeholder", "CAtestcall");
  const logs = captureInfoLogs();
  try {
    socket.emitMessage(JSON.stringify({ event: "stop" }));
  } finally {
    logs.restore();
  }
  const stopIdx = logs.calls.findIndex((c) => c.event === "exotel_bridge:stop");
  const closedIdx = logs.calls.findIndex((c) => c.event === "exotel_bridge:closed");
  assert.ok(stopIdx > -1 && closedIdx > -1);
  assert.ok(stopIdx < closedIdx, "the 'stop' event log must precede the resulting close log");
});
