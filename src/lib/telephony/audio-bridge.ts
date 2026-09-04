/**
 * Live call audio transport contract — the missing piece between Phase D's
 * telephony adapter (which handles call *control*: provisioning, dialing,
 * status webhooks) and Phase E's voice runtime (which needs the call's
 * actual *audio*).
 *
 * Phase D's `TelephonyProviderAdapter` never defined an audio channel —
 * `verifyWebhookSignature`/`normalizeWebhookEvent` only ever carry short
 * status events (ringing/answered/completed), not a live bidirectional
 * media stream. Real providers (Twilio Media Streams, Exotel's voicebot
 * streaming, etc.) open a *separate*, long-lived WebSocket for the call's
 * raw audio once it is answered, using their own framing/protocol. This
 * file defines the normalized contract Phase E's runtime programs against,
 * so wiring a specific provider's real media-stream protocol later means
 * implementing `TelephonyProviderAdapter.openMediaBridge` for that one
 * provider — nothing in voice-runtime.server.ts changes.
 *
 * No provider in this repository implements a real media transport yet —
 * see the Phase E report's "Known limitations". `openMediaBridge` returning
 * `null` (the only behavior implemented today) means exactly that: this
 * call has no live audio path, so the runtime cannot start.
 */

export type AudioEncoding = "mulaw" | "alaw" | "linear16" | "opus";

export interface AudioFormat {
  encoding: AudioEncoding;
  sampleRateHz: number;
}

export interface AudioFrame {
  /** Raw audio bytes for this frame, in `format`'s encoding. */
  data: Uint8Array;
  /** Milliseconds since the bridge opened, for jitter/ordering diagnostics. */
  timestampMs: number;
}

/**
 * A live, bidirectional audio channel for one in-progress call. Inbound
 * frames are the caller's voice (-> STT); outbound frames are the agent's
 * synthesized speech (<- TTS). Implementations own the underlying
 * provider-specific WebSocket/RTP transport.
 */
export interface AudioMediaBridge {
  readonly inboundFormat: AudioFormat;
  readonly outboundFormat: AudioFormat;

  /** Registers the callback invoked for every inbound (caller) audio frame. */
  onInboundFrame(cb: (frame: AudioFrame) => void): void;
  /** Sends one frame of synthesized (agent) audio to the caller. */
  sendOutboundFrame(frame: AudioFrame): void;
  /** Signals the caller-side buffer should be dropped immediately (barge-in). */
  clearOutboundBuffer(): void;
  /** Registers the callback invoked when the provider closes the media channel. */
  onClose(cb: (reason: string) => void): void;
  /** Closes the bridge from our side (call ended, runtime error, etc). Idempotent. */
  close(): void;
}
