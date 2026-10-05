import type { AudioFormat, AudioFrame, AudioMediaBridge } from "./audio-bridge.ts";
import { releaseVobizMediaSession } from "./vobiz-media-registry.server.ts";
import { maskCallSid } from "./media-session-authorization.server.ts";

/**
 * Wraps one Vobiz `<Stream>` WebSocket connection (already accepted — see
 * src/server.ts) as the provider-agnostic `AudioMediaBridge` the voice
 * runtime programs against.
 *
 * Protocol — confirmed directly against Vobiz's own documentation
 * (vobiz.ai/docs/integrations/websockets, vobiz.ai/docs/xml/stream/audio-formats,
 * docs.vobiz.ai/concepts/streaming-websockets), cross-checked against
 * Plivo's identical documented protocol (VobizFrameSerializer is a
 * documented subclass of Pipecat's PlivoFrameSerializer — Vobiz's
 * media-stream wire format is Plivo's):
 * inbound JSON messages carry `event: "start"|"media"|"dtmf"|"stop"`. The
 * `start` event's call/stream identifiers are nested one level down, inside
 * a `start` sub-object (`start.callId`/`start.streamId`/`start.mediaFormat`
 * — a production incident where this was wrongly assumed flat is what
 * first surfaced the nested-shape pattern this protocol uses throughout).
 * `start.mediaFormat` names the negotiated codec, defaulting to 8kHz
 * mu-law — the exact format requested via the
 * `contentType="audio/x-mulaw;rate=8000"` attribute on the `<Stream>`
 * Voice XML element Klyro returns from the answer route, so this bridge's
 * NATIVE_FORMAT below must stay in lockstep with whatever that element
 * actually requests. The `media` event is likewise nested: the base64
 * audio is at `media.payload` (alongside `media.track`/`media.chunk`/
 * `media.timestamp`), not a flat top-level `media` string — a second
 * production incident (`vobiz_bridge:media_missing_payload` on every
 * ~20ms frame) is what surfaced this one. Outbound audio is sent as a
 * `playAudio` event carrying `{streamId, media:{contentType, sampleRate,
 * payload}}` (same nested `media` shape as inbound, confirmed from the
 * same sources — not the `{playAudio:{media, contentType, sampleRate}}`
 * shape this file sent before that incident, which no real Vobiz-side
 * parser would have recognized); `clearAudio` is `{event, streamId}` flat
 * (confirmed, no payload) and signals barge-in; `stop` ends the stream
 * from Vobiz's side.
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
  private loggedMediaShapeDiagnostic = false;
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
        // Same nested-vs-flat fix as vobiz-media-route.server.ts /
        // vobiz-call-session-durable-object.server.ts: Vobiz's "start"
        // event nests streamId inside a "start" sub-object (confirmed
        // Plivo-protocol shape — see those files' comments for the
        // sourcing chain). Nested lookup first; flat top-level kept as a
        // defensive fallback only.
        const startData =
          typeof msg["start"] === "object" && msg["start"] !== null
            ? (msg["start"] as Record<string, unknown>)
            : null;
        const sid =
          (startData && firstDefinedString(startData, ["streamId", "stream_id", "StreamId"])) ??
          firstDefinedString(msg, ["streamId", "stream_id", "StreamId"]);
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
    // Production incident: this previously read msg["media"] directly as
    // the base64 string. Vobiz's confirmed real shape nests it one level
    // down — media.payload — so every real frame failed the
    // `typeof payload !== "string"` check below and was dropped, logging
    // vobiz_bridge:media_missing_payload on every ~20ms frame for the
    // whole call. See this file's module doc for the sourcing.
    const mediaRaw = msg["media"];
    const media =
      typeof mediaRaw === "object" && mediaRaw !== null
        ? (mediaRaw as Record<string, unknown>)
        : null;
    const payload = media ? media["payload"] : undefined;

    if (!this.loggedMediaShapeDiagnostic) {
      this.loggedMediaShapeDiagnostic = true;
      // TEMPORARY DIAGNOSTIC (same incident) — logged once per bridge
      // instance, not per frame (frames arrive every ~20ms; a per-frame
      // log here would flood production logs the same way the bug itself
      // did). Field NAMES, TYPES, and LENGTHS only — never raw audio, the
      // base64 payload contents, auth tokens, or signatures.
      console.info("vobiz_bridge:media_event_shape", {
        providerCallId: maskCallSid(this.providerCallId),
        topLevelKeys: Object.keys(msg),
        nestedMediaKeys: media ? Object.keys(media) : null,
        mediaValueType: typeof mediaRaw,
        payloadValueType: typeof payload,
        payloadPresent: typeof payload === "string" && payload.length > 0,
        payloadLength: typeof payload === "string" ? payload.length : null,
        sequenceNumber:
          typeof msg["sequenceNumber"] === "string" || typeof msg["sequenceNumber"] === "number"
            ? msg["sequenceNumber"]
            : null,
        streamId: typeof msg["streamId"] === "string" ? msg["streamId"] : null,
      });
    }

    if (typeof payload !== "string" || payload.length === 0) {
      console.error("vobiz_bridge:media_missing_payload", {
        providerCallId: maskCallSid(this.providerCallId),
        topLevelKeys: Object.keys(msg),
        nestedMediaKeys: media ? Object.keys(media) : null,
      });
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
    // Confirmed real Vobiz/Plivo-protocol playAudio shape: the audio lives
    // under media.payload, alongside media.contentType/media.sampleRate —
    // not under a `playAudio` sub-object with a `media` string field (the
    // speculative shape this sent before this fix, which no real
    // Vobiz-side parser would have recognized — see this file's module
    // doc for the sourcing).
    this.socket.send(
      JSON.stringify({
        event: "playAudio",
        streamId: this.streamId,
        media: {
          contentType: "audio/x-mulaw",
          sampleRate: this.outboundFormat.sampleRateHz,
          payload,
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
