import type { AudioFormat, AudioFrame, AudioMediaBridge } from "./audio-bridge.ts";
import { releaseMediaSession } from "./exotel-media-registry.server.ts";

/**
 * Wraps one Exotel Voicebot Applet WebSocket connection (already accepted —
 * see src/server.ts) as the provider-agnostic `AudioMediaBridge` Phase E's
 * runtime programs against.
 *
 * Native format for this path (Voicebot Applet, not the Legs API — see the
 * Phase D.1 report §4 for why that path was chosen): 16-bit signed linear
 * PCM, little-endian, 8kHz, mono, base64-encoded — exactly what the Sarvam
 * realtime STT/TTS clients already accept as `"linear16"`, so this bridge
 * does zero audio transcoding (spec §11: "do not unnecessarily transcode").
 *
 * Message parsing is strict and defensive: every frame is validated before
 * use, and a malformed frame is logged and dropped, never allowed to throw
 * out of the WebSocket's message handler (spec §10: "do not crash the
 * entire runtime because of one malformed frame"). Event names are matched
 * case-insensitively because Exotel's own docs/examples were not fully
 * consistent between "Start"/"start" style casing across their Voicebot
 * Applet and newer AgentStream product surfaces — see the report's
 * verification notes.
 */

const NATIVE_FORMAT: AudioFormat = { encoding: "linear16", sampleRateHz: 8000 };
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

export interface ExotelSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", cb: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
  readyState: number;
}

export class ExotelMediaBridge implements AudioMediaBridge {
  readonly inboundFormat = NATIVE_FORMAT;
  readonly outboundFormat = NATIVE_FORMAT;

  private socket: ExotelSocketLike;
  private streamSid: string;
  private providerCallId: string;
  private inboundHandlers: ((frame: AudioFrame) => void)[] = [];
  private closeHandlers: ((reason: string) => void)[] = [];
  private closed = false;
  private readonly startedAt = Date.now();

  /**
   * `initialStreamSid` is a placeholder (the caller passes providerCallId)
   * used only until the real `stream_sid` arrives on the "start" event —
   * see handleRawMessage's "start" case, which overwrites `this.streamSid`.
   */
  constructor(socket: ExotelSocketLike, initialStreamSid: string, providerCallId: string) {
    this.socket = socket;
    this.streamSid = initialStreamSid;
    this.providerCallId = providerCallId;

    socket.addEventListener("message", (ev) => this.handleRawMessage(ev.data));
    socket.addEventListener("close", (ev) => this.handleClose(`ws closed (${ev.code})`));
    socket.addEventListener("error", () => {
      console.error("exotel_bridge:socket_error", { providerCallId: this.providerCallId });
    });
  }

  private handleRawMessage(data: unknown) {
    if (typeof data !== "string") {
      console.error("exotel_bridge:unexpected_binary_frame", {
        providerCallId: this.providerCallId,
      });
      return;
    }
    if (data.length > MAX_MESSAGE_BYTES) {
      console.error("exotel_bridge:oversized_message", {
        providerCallId: this.providerCallId,
        bytes: data.length,
      });
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      console.error("exotel_bridge:malformed_json", { providerCallId: this.providerCallId });
      return;
    }

    const eventName = String(msg["event"] ?? "").toLowerCase();
    switch (eventName) {
      case "connected":
        console.info("exotel_bridge:connected", { providerCallId: this.providerCallId });
        return;
      case "start": {
        // Exotel assigns its own stream_sid, learned only from this event —
        // every outbound message must echo it back exactly, so it replaces
        // the constructor's placeholder (providerCallId) as soon as it's known.
        const start = (msg["start"] as Record<string, unknown> | undefined) ?? msg;
        const sid = firstDefinedString(start, ["stream_sid", "streamSid", "StreamSid"]);
        if (sid) this.streamSid = sid;
        console.info("exotel_bridge:start", {
          providerCallId: this.providerCallId,
          streamSid: this.streamSid,
        });
        return;
      }
      case "media":
        this.handleMediaEvent(msg);
        return;
      case "dtmf":
        // Out of scope for a conversational voice agent (spec review, Phase
        // E) — acknowledged but not forwarded to the runtime.
        return;
      case "mark":
        console.info("exotel_bridge:mark", { providerCallId: this.providerCallId });
        return;
      case "clear":
        // Exotel-initiated clear (if this account/product surface sends
        // one) is informational only — we never buffer inbound audio
        // ourselves, so there is nothing on our side to clear in response.
        return;
      case "stop":
        this.handleClose("provider stop event");
        return;
      default:
        console.error("exotel_bridge:unknown_event", {
          providerCallId: this.providerCallId,
          event: eventName || "(missing)",
        });
    }
  }

  private handleMediaEvent(msg: Record<string, unknown>) {
    const media = (msg["media"] as Record<string, unknown> | undefined) ?? msg;
    const payload = media["payload"];
    if (typeof payload !== "string" || payload.length === 0) {
      console.error("exotel_bridge:media_missing_payload", { providerCallId: this.providerCallId });
      return;
    }
    // Node's Buffer.from(str, "base64") is lenient — it silently drops
    // invalid characters instead of throwing, so garbage input never lands
    // in the try/catch below. A real shape check is required first.
    if (!BASE64_SHAPE.test(payload)) {
      console.error("exotel_bridge:media_invalid_base64", { providerCallId: this.providerCallId });
      return;
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(payload, "base64");
    } catch {
      console.error("exotel_bridge:media_invalid_base64", { providerCallId: this.providerCallId });
      return;
    }
    if (bytes.length < MIN_MEDIA_PAYLOAD_BYTES || bytes.length > MAX_MESSAGE_BYTES) {
      console.error("exotel_bridge:media_invalid_size", {
        providerCallId: this.providerCallId,
        bytes: bytes.length,
      });
      return;
    }

    const frame: AudioFrame = {
      data: new Uint8Array(bytes),
      timestampMs: Date.now() - this.startedAt,
    };
    for (const handler of this.inboundHandlers) handler(frame);
  }

  private handleClose(reason: string) {
    if (this.closed) return;
    this.closed = true;
    releaseMediaSession(this.providerCallId);
    for (const handler of this.closeHandlers) handler(reason);
  }

  onInboundFrame(cb: (frame: AudioFrame) => void): void {
    this.inboundHandlers.push(cb);
  }

  sendOutboundFrame(frame: AudioFrame): void {
    if (this.closed || this.socket.readyState !== 1 /* OPEN */) return;
    const payload = Buffer.from(frame.data).toString("base64");
    this.socket.send(
      JSON.stringify({ event: "media", stream_sid: this.streamSid, media: { payload } }),
    );
  }

  clearOutboundBuffer(): void {
    if (this.closed || this.socket.readyState !== 1 /* OPEN */) return;
    this.socket.send(JSON.stringify({ event: "clear", stream_sid: this.streamSid }));
  }

  onClose(cb: (reason: string) => void): void {
    this.closeHandlers.push(cb);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    try {
      this.socket.close(1000, "done");
    } catch {
      /* best-effort */
    }
    this.handleClose("closed by application");
  }
}
