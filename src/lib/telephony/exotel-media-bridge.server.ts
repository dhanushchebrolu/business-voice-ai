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
  /** Outbound "media" message counter — see sendOutboundFrame's own comment for why this exists. */
  private outboundChunkCounter = 0;
  /** Diagnostic requirement 2/6: logged once, the first "media" frame that arrives before any onInboundFrame listener is registered — see handleMediaEvent. Never spams per-frame. */
  private loggedDroppedFrameWarning = false;
  /** Diagnostic requirement 6: logged once, the first outbound frame dropped because the socket was already closed — see sendOutboundFrame. */
  private loggedPostCloseSendWarning = false;

  private readonly onRelease: (providerCallId: string) => void;

  /**
   * `initialStreamSid` is a placeholder (the caller passes providerCallId)
   * used only until the real `stream_sid` arrives on the "start" event —
   * see handleRawMessage's "start" case, which overwrites `this.streamSid`.
   *
   * `onRelease` defaults to the module-level, in-process registry's
   * `releaseMediaSession` (the pre-existing behavior, used when this bridge
   * is constructed outside a Durable Object — e.g. local dev without the
   * CALL_SESSION binding). `CallSessionDurableObject` passes its own
   * instance-scoped release method instead, since its claim/release state is
   * Durable-Object-instance state, not this module's — see
   * call-session-durable-object.server.ts.
   */
  constructor(
    socket: ExotelSocketLike,
    initialStreamSid: string,
    providerCallId: string,
    onRelease: (providerCallId: string) => void = releaseMediaSession,
  ) {
    this.socket = socket;
    this.streamSid = initialStreamSid;
    this.providerCallId = providerCallId;
    this.onRelease = onRelease;

    socket.addEventListener("message", (ev) => this.handleRawMessage(ev.data));
    socket.addEventListener("close", (ev) =>
      this.handleClose(`ws closed (${ev.code})`, ev.code, ev.reason),
    );
    socket.addEventListener("error", () => {
      console.error("exotel_bridge:socket_error", { providerCallId: this.providerCallId });
    });
  }

  /**
   * Feeds one raw WebSocket message into this bridge's own protocol
   * handling, exactly as if the socket's own "message" event had fired.
   * Used by the caller (call-session-durable-object.server.ts /
   * exotel-media-route.server.ts) to replay messages that arrived on the
   * socket *before* this bridge existed — see those callers' own comments
   * on the buffered pre-registration window this closes.
   */
  ingestRawMessage(data: unknown): void {
    this.handleRawMessage(data);
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
        console.info("exotel_bridge:stop", { providerCallId: this.providerCallId });
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

    // Diagnostic requirements 2/6: no onInboundFrame listener exists until
    // voice-runtime.server.ts's startRuntimeSession has actually registered
    // one — a "media" frame arriving before that (the runtime hasn't been
    // routed to yet, or is still connecting STT/TTS) is silently dropped
    // below with no handler to receive it. That's expected during the
    // brief startup window, but worth surfacing once (never per-frame) so
    // it's distinguishable from a frame simply never arriving at all.
    if (this.inboundHandlers.length === 0 && !this.loggedDroppedFrameWarning) {
      this.loggedDroppedFrameWarning = true;
      console.info("exotel_bridge:media_frame_dropped_no_listener", {
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
    // Diagnostic requirements 3/6: guaranteed to fire for every close path
    // (provider "stop" event, the WebSocket's own "close" event, or this
    // bridge's own close()) — never the case before this change that a
    // socket teardown went completely unlogged when no voice-runtime
    // session ever attached (voice-runtime.server.ts's "bridge_closed" log
    // only fires if startRuntimeSession was actually called). Logging
    // outboundFramesSent alongside the close reason directly answers
    // requirement 6: 0 here means the socket closed before Klyro ever sent
    // any audio back to Exotel.
    console.info("exotel_bridge:closed", {
      providerCallId: this.providerCallId,
      reason,
      wsCloseCode: code ?? null,
      wsCloseReason: wsReason || null,
      outboundFramesSent: this.outboundChunkCounter,
    });
    this.onRelease(this.providerCallId);
    for (const handler of this.closeHandlers) handler(reason);
  }

  onInboundFrame(cb: (frame: AudioFrame) => void): void {
    this.inboundHandlers.push(cb);
  }

  sendOutboundFrame(frame: AudioFrame): void {
    if (this.closed || this.socket.readyState !== 1 /* OPEN */) {
      // Diagnostic requirement 6: distinguishes "the socket was already
      // closed when Klyro tried to speak" from silence with no attempt at
      // all — logged once, not per-frame, since a burst of TTS audio can
      // arrive in the same tick right after a close.
      if (!this.loggedPostCloseSendWarning) {
        this.loggedPostCloseSendWarning = true;
        console.info("exotel_bridge:outbound_frame_dropped_after_close", {
          providerCallId: this.providerCallId,
          socketReadyState: this.socket.readyState,
        });
      }
      return;
    }
    const payload = Buffer.from(frame.data).toString("base64");
    this.outboundChunkCounter += 1;
    if (this.outboundChunkCounter === 1) {
      // Diagnostic requirement 5: the first, and most important, signal
      // that Klyro ever sent audio back to Exotel at all — everything
      // upstream (STT/LLM/TTS) can be perfectly healthy and still never
      // reach this line if, e.g., the runtime was never started for this
      // call (see telephony.ts's routeToAgentRuntime trigger).
      console.info("exotel_bridge:first_outbound_frame_sent", {
        providerCallId: this.providerCallId,
      });
    }
    // sequence_number (top-level) and media.chunk/media.timestamp were
    // previously omitted — WebSearch summaries of Exotel's Voicebot Applet
    // docs (docs.sarvam.ai is unreachable from this sandbox for Sarvam; the
    // equivalent Exotel support-center/docs domains are equally
    // unreachable, so this is the same secondary-source caveat as
    // sarvam-realtime.server.ts's) describe these as part of the required
    // outbound "media" event shape, not merely diagnostic metadata. Adding
    // them is a safe, additive change either way (an extra recognized field
    // is normally harmless if it turns out not to be required) against a
    // real, plausible failure mode if it IS required: audio silently never
    // reaching the caller while every earlier pipeline stage works
    // correctly. `chunk` mirrors the running sequence counter (the
    // documented convention); `timestamp` is milliseconds since this
    // bridge's stream started, matching the same base used for
    // AudioFrame.timestampMs.
    this.socket.send(
      JSON.stringify({
        event: "media",
        stream_sid: this.streamSid,
        sequence_number: this.outboundChunkCounter,
        media: {
          chunk: this.outboundChunkCounter,
          timestamp: String(frame.timestampMs),
          payload,
        },
      }),
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
