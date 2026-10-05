import type { AudioFormat, AudioFrame, AudioMediaBridge } from "./audio-bridge.ts";
import { releaseVobizMediaSession } from "./vobiz-media-registry.server.ts";

/**
 * Wraps one Vobiz `<Stream>` WebSocket connection (already accepted — see
 * src/server.ts) as the provider-agnostic `AudioMediaBridge` the voice
 * runtime programs against.
 *
 * Protocol (see vobiz-provider.ts's module doc for sourcing/confidence):
 * inbound JSON messages carry `event: "start"|"media"|"dtmf"|"stop"`; a
 * `start` event's `mediaFormat` field (e.g. `["audio/x-mulaw", 8000]`)
 * names the negotiated codec, defaulting to 8kHz mu-law — the exact format
 * requested via the `contentType="audio/x-mulaw;rate=8000"` attribute on
 * the `<Stream>` Voice XML element Klyro returns from the answer route, so
 * this bridge's NATIVE_FORMAT below must stay in lockstep with whatever
 * that element actually requests. Outbound audio is sent as a `playAudio`
 * event carrying `{streamId, playAudio:{media, contentType, sampleRate}}`;
 * `clearAudio` signals barge-in; `stop` ends the stream from Vobiz's side.
 *
 * Message parsing is strict and defensive — every frame is validated
 * before use, a malformed frame is logged and dropped, never thrown out of
 * the WebSocket's message handler — same discipline as
 * exotel-media-bridge.server.ts.
 */

const NATIVE_FORMAT: AudioFormat = { encoding: "mulaw", sampleRateHz: 8000 };
const MAX_MESSAGE_BYTES = 64 * 1024;
const MIN_MEDIA_PAYLOAD_BYTES = 1;
const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

function firstDefinedString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

export interface VobizSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", cb: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
  readyState: number;
}

export class VobizMediaBridge implements AudioMediaBridge {
  readonly inboundFormat = NATIVE_FORMAT;
  readonly outboundFormat = NATIVE_FORMAT;

  private socket: VobizSocketLike;
  private streamId: string;
  private providerCallId: string;
  private inboundHandlers: ((frame: AudioFrame) => void)[] = [];
  private closeHandlers: ((reason: string) => void)[] = [];
  private closed = false;
  private readonly startedAt = Date.now();
  private loggedDroppedFrameWarning = false;
  private loggedPostCloseSendWarning = false;
  private readonly onRelease: (providerCallId: string) => void;

  constructor(
    socket: VobizSocketLike,
    initialStreamId: string,
    providerCallId: string,
    onRelease: (providerCallId: string) => void = releaseVobizMediaSession,
  ) {
    this.socket = socket;
    this.streamId = initialStreamId;
    this.providerCallId = providerCallId;
    this.onRelease = onRelease;

    socket.addEventListener("message", (ev) => this.handleRawMessage(ev.data));
    socket.addEventListener("close", (ev) =>
      this.handleClose(`ws closed (${ev.code})`, ev.code, ev.reason),
    );
    socket.addEventListener("error", () => {
      console.error("vobiz_bridge:socket_error", { providerCallId: this.providerCallId });
    });
  }

  /** Replays a raw message that arrived before this bridge existed — see vobiz-media-route.server.ts's buffering comment. */
  ingestRawMessage(data: unknown): void {
    this.handleRawMessage(data);
  }

  private handleRawMessage(data: unknown) {
    if (typeof data !== "string") {
      console.error("vobiz_bridge:unexpected_binary_frame", {
        providerCallId: this.providerCallId,
      });
      return;
    }
    if (data.length > MAX_MESSAGE_BYTES) {
      console.error("vobiz_bridge:oversized_message", {
        providerCallId: this.providerCallId,
        bytes: data.length,
      });
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      console.error("vobiz_bridge:malformed_json", { providerCallId: this.providerCallId });
      return;
    }

    const eventName = String(msg["event"] ?? "").toLowerCase();
    switch (eventName) {
      case "connected":
        console.info("vobiz_bridge:connected", { providerCallId: this.providerCallId });
        return;
      case "start": {
        const sid = firstDefinedString(msg, ["streamId", "stream_id", "StreamId"]);
        if (sid) this.streamId = sid;
        console.info("vobiz_bridge:start", {
          providerCallId: this.providerCallId,
          streamId: this.streamId,
        });
        return;
      }
      case "media":
        this.handleMediaEvent(msg);
        return;
      case "dtmf":
        // Out of scope for a conversational voice agent, same as Exotel's bridge.
        return;
      case "stop":
        console.info("vobiz_bridge:stop", { providerCallId: this.providerCallId });
        this.handleClose("provider stop event");
        return;
      default:
        console.error("vobiz_bridge:unknown_event", {
          providerCallId: this.providerCallId,
          event: eventName || "(missing)",
        });
    }
  }

  private handleMediaEvent(msg: Record<string, unknown>) {
    const payload = msg["media"];
    if (typeof payload !== "string" || payload.length === 0) {
      console.error("vobiz_bridge:media_missing_payload", { providerCallId: this.providerCallId });
      return;
    }
    if (!BASE64_SHAPE.test(payload)) {
      console.error("vobiz_bridge:media_invalid_base64", { providerCallId: this.providerCallId });
      return;
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(payload, "base64");
    } catch {
      console.error("vobiz_bridge:media_invalid_base64", { providerCallId: this.providerCallId });
      return;
    }
    if (bytes.length < MIN_MEDIA_PAYLOAD_BYTES || bytes.length > MAX_MESSAGE_BYTES) {
      console.error("vobiz_bridge:media_invalid_size", {
        providerCallId: this.providerCallId,
        bytes: bytes.length,
      });
      return;
    }

    if (this.inboundHandlers.length === 0 && !this.loggedDroppedFrameWarning) {
      this.loggedDroppedFrameWarning = true;
      console.info("vobiz_bridge:media_frame_dropped_no_listener", {
        providerCallId: this.providerCallId,
      });
    }

    const frame: AudioFrame = {
      data: new Uint8Array(bytes),
      timestampMs: Date.now() - this.startedAt,
    };
    for (const handler of this.inboundHandlers) handler(frame);
  }

  private handleClose(reason: string, code?: number, wsReason?: string) {
    if (this.closed) return;
    this.closed = true;
    console.info("vobiz_bridge:closed", {
      providerCallId: this.providerCallId,
      reason,
      wsCloseCode: code ?? null,
      wsCloseReason: wsReason || null,
    });
    this.onRelease(this.providerCallId);
    for (const handler of this.closeHandlers) handler(reason);
  }

  onInboundFrame(cb: (frame: AudioFrame) => void): void {
    this.inboundHandlers.push(cb);
  }

  sendOutboundFrame(frame: AudioFrame): void {
    if (this.closed || this.socket.readyState !== 1 /* OPEN */) {
      if (!this.loggedPostCloseSendWarning) {
        this.loggedPostCloseSendWarning = true;
        console.info("vobiz_bridge:outbound_frame_dropped_after_close", {
          providerCallId: this.providerCallId,
          socketReadyState: this.socket.readyState,
        });
      }
      return;
    }
    const payload = Buffer.from(frame.data).toString("base64");
    this.socket.send(
      JSON.stringify({
        event: "playAudio",
        streamId: this.streamId,
        playAudio: {
          media: payload,
          contentType: "audio/x-mulaw",
          sampleRate: this.outboundFormat.sampleRateHz,
        },
      }),
    );
  }

  clearOutboundBuffer(): void {
    if (this.closed || this.socket.readyState !== 1 /* OPEN */) return;
    this.socket.send(JSON.stringify({ event: "clearAudio", streamId: this.streamId }));
  }

  onClose(cb: (reason: string) => void): void {
    this.closeHandlers.push(cb);
  }

  close(): void {
    if (this.closed) return;
    try {
      this.socket.send(JSON.stringify({ event: "stop", streamId: this.streamId }));
      this.socket.close(1000, "done");
    } catch {
      /* best-effort */
    }
    this.handleClose("closed by application");
  }
}
