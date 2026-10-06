/**
 * Sarvam realtime voice WebSocket clients — server-only.
 *
 * Speech-to-text: `saaras:v3-realtime` streaming API.
 * Text-to-speech: `bulbul:v3` streaming API.
 *
 * STT ENDPOINT — CONFIRMED BY PRODUCTION: a live call against
 * `/speech-to-text/ws` with `model=saaras:v3-realtime` was rejected by
 * Sarvam's own server with close code 4000, reason "Invalid model
 * 'saaras:v3-realtime'. Supported models: 'saarika...'" — proving
 * `/speech-to-text/ws` is the batch/legacy endpoint (saarika:* models
 * only), not the realtime one. Fixed: STT now connects to
 * `/speech-to-text-realtime/ws`.
 *
 * STT QUERY PARAM NAMES — CONFIRMED BY PRODUCTION (round 2): the realtime
 * endpoint then rejected the connection with "Missing required query
 * parameter 'language_code'." — this file was sending `language-code`
 * (hyphenated). Fixed to `language_code` (underscore); `sample-rate` was
 * the identical bug and is now `sample_rate` too. `model` and `encoding`
 * were already spelled correctly. `vad-signals` remains unconfirmed either
 * way (no production evidence yet) and was left untouched.
 *
 * TTS CONFIG FIELD NAME — CONFIRMED BY PRODUCTION: the WS handshake and
 * `tts_connected` succeed, but the server rejects the first `config`
 * message with "Input parameters has to be a valid dictionary." This file
 * was sending `target_language_code`; the documented config contract is
 * `{"type":"config","data":{"language_code":"...","speaker":"..."}}`.
 * Fixed to `language_code`.
 *
 * TTS CONFIG SCHEMA — `model` CONFIRMED BY PRODUCTION, `speech_sample_rate`
 * per user-supplied Sarvam documentation (not yet independently verified by
 * a live call the way the fixes above were — this sandbox still cannot
 * reach docs.sarvam.ai directly; see the VERIFICATION NOTE below). `model`
 * is a connection-level query param
 * (`?model=bulbul:v3` on TTS_WS_URL), exactly mirroring STT's
 * `?model=saaras:v3-realtime` — not a `data` field, which is why the
 * documented minimal contract above never lists it. `output_audio_bitrate`
 * has been removed outright: "bitrate" names a compressed-codec property
 * (kbps), not a sample rate, so it was never a valid field for a PCM/
 * companded codec like mulaw.
 *
 * CORRECTION (do not repeat this mistake): an earlier revision of this
 * comment claimed `output_audio_codec: "mulaw"` alone fully declared the
 * output format because mulaw is a fixed-rate telephony codec. That is
 * wrong — codec and sample rate are independent, separately-negotiated
 * settings in Sarvam's realtime API, and bulbul:v3's documented default
 * sample rate is 24000 Hz regardless of codec (8000 Hz is supported, but
 * only if asked for). `speech_sample_rate` is now sent explicitly in
 * `config.data` alongside `output_audio_codec`. Getting this wrong would
 * not have surfaced as a connection error — Sarvam would have happily
 * generated 24kHz audio that the Vobiz bridge forwards byte-for-byte
 * (declaring mulaw/8kHz the whole time) without resampling, producing
 * corrupted/garbled audio on a live call with no error anywhere in the
 * logs. `outputSampleRateHz` (`ConnectTtsOptions`, see its own doc
 * comment) is the single source for this value — never hardcode 8000
 * elsewhere in this file. voice-runtime.server.ts's
 * `first_outbound_audio_frame` diagnostic is verification only: it logs
 * the declared format next to whatever metadata Sarvam's own audio event
 * happens to carry, so a mismatch is visible after the fact — it is not
 * itself what makes the format correct; `speech_sample_rate` in the config
 * message is.
 *
 * TTS MESSAGE TYPE — the 422 "Input parameters has to be a valid
 * dictionary" persisted, UNCHANGED, across both of the above fixes
 * (`language_code`, then `speech_sample_rate`) — strong evidence the config
 * message was never the actual problem. `sendText()` sent
 * `{"type":"convert","data":{"text":...}}`; the current protocol's
 * text-input message type is `"text"`, not `"convert"` — `convert` was
 * never a recognized type at all. Fixed to `type: "text"`. Also sending
 * `speech_sample_rate` as a STRING (`"8000"`), not a number — per a
 * current working Sarvam implementation (user-supplied; like the fields
 * above, not independently verifiable from this sandbox). `flush`
 * (`{"type":"flush"}`, no `data`) was already correct and is unchanged.
 * `tts:config_sent`/`tts:text_sent`/`tts:flush_sent` diagnostics (see
 * connectSarvamTts) now trace every outbound frame's safe shape, since
 * synchronous fire-and-forget sends make log *order* alone insufficient to
 * attribute a later `tts_error` to a specific message. If the 422 recurs
 * after this fix, `tts_error`'s `raw` field (see `extractErrorDetail`
 * below) combined with these per-send traces will show exactly which
 * frame Sarvam rejected and why.
 *
 * TTS CONFIRMED WORKING END TO END (production): all of the TTS fixes
 * above (query param, config fields, message type) together produced a
 * full, working call — `tts:config_sent`/`tts:text_sent`/`tts:flush_sent`,
 * `first_outbound_audio_frame`, and the greeting actually played to the
 * caller. `/text-to-speech/ws` (no dedicated realtime path) is therefore
 * confirmed correct for TTS — the "TTS WS path" hypothesis previously
 * listed under NOT CONFIRMED is resolved and removed below.
 *
 * STT AUDIO TRANSPORT — CONFIRMED BY PRODUCTION (round 3, after TTS was
 * fixed and confirmed working): STT connects and accepts its query params
 * with no error, but produces zero transcripts for a caller who is
 * audibly speaking. Root cause: `sendAudioFrame` sent the raw `Uint8Array`
 * as a BINARY WebSocket frame, with no JSON envelope and no base64
 * encoding at all — not even the legacy shape, just unwrapped bytes. This
 * was flagged, unconfirmed, as this file's very first NOT CONFIRMED item
 * before any live test; current Sarvam documentation now confirms it
 * directly: the realtime endpoint expects a JSON **text** frame,
 * `{"event":"audio_input","audio":"<base64>"}`. Fixed. The bytes
 * themselves are unchanged — still Vobiz's raw mulaw/8kHz, decoded once in
 * vobiz-media-bridge.server.ts and handed through unmodified; only the
 * wire transport here changes, confirmed by `stt:audio_sent`/
 * `stt:event_received` diagnostics (see connectSarvamStt) that trace every
 * outbound audio frame and inbound wire message without ever logging the
 * base64 audio or the transcript text itself.
 *
 * STT TRANSCRIPT FIELD NAME — CONFIRMED BY PRODUCTION (round 4, after audio
 * transport was fixed and confirmed working: session.begin, vad.speech_start,
 * multiple transcript.partial, vad.speech_end, and transcript.final all
 * arrive with no error — but the caller still heard only the greeting, then
 * silence). Root cause: this file looked for the transcript text under a
 * field named `transcript`; the current realtime protocol's field is `text`
 * (confirmed by https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming
 * — `message.text`, read directly off the parsed message, same object as
 * `message.event`). Since the transcript branch in `normalizeSttMessage` has
 * no dedicated `kind === "transcript.partial"/"transcript.final"` case of
 * its own — it fires only via the generic "does a transcript field exist"
 * check — every transcript.partial/transcript.final message was
 * misclassified as `{type:"unknown"}`, so `handleUserUtterance`
 * (voice-runtime.server.ts's only path to the LLM and a spoken reply) was
 * never invoked, for any call, regardless of what the caller said. Fixed:
 * `data["text"] ?? data["transcript"]`, preferring the confirmed-correct
 * field and keeping `transcript` only as a fallback for the legacy,
 * non-realtime shape this file no longer connects to.
 *
 * STT RECEIVE-PATH WATCHDOG (round 5, diagnostic only, no behavior change):
 * runtime_session_id f77b2529-58a5-4060-8479-017ab3e94169 showed
 * `stt_connected` and many `stt:audio_sent` with ZERO inbound messages of
 * any kind for the whole call — not session.begin, not an error, nothing.
 * Since `socket.send()` never confirms the peer is reading, a dead receive
 * path on an otherwise-open socket was previously indistinguishable from
 * "the caller just hasn't said anything yet." `connectSarvamStt` now logs
 * `stt:no_inbound_message_received` if no message arrives within
 * `STT_RECEIVE_WATCHDOG_MS` of connecting, and `session.begin`/
 * `session.end` are now recognized kinds (`stt:session_begin_received`/
 * `stt:session_end_received`) instead of falling through to `unknown`.
 * Neither changes what `onSttEvent` does with any event, retries anything,
 * or reconnects — this is purely so the next occurrence of this failure
 * mode is directly visible instead of inferred from an absence of logs.
 *
 * STT RECEIVE-PATH IDLE WATCHDOG + AUDIO FLOW HEARTBEAT (round 6, diagnostic
 * only, no behavior change): a live call after round 5 showed exactly one
 * stt:event_received (transcript.partial), then nothing — no vad.speech_end,
 * no transcript.final. Round 5's watchdog cannot see this: it is permanently
 * disarmed by the first inbound message, so it only ever proves "nothing
 * arrived at all," not "the stream started, then went quiet." Replaced with
 * a periodic idle check (stt:receive_path_idle) that only considers firing
 * once at least one Sarvam event has arrived, and a periodic low-volume
 * audio-flow aggregate (stt:audio_flow_heartbeat, replacing nothing —
 * stt:audio_sent still logs every frame). Together these let a future
 * occurrence be read as "audio kept flowing but Sarvam's events stopped" vs.
 * "audio itself stopped reaching Sarvam," which is the one thing round 5's
 * logs could not distinguish. Still purely diagnostic: nothing here retries,
 * reconnects, or changes how onSttEvent/normalizeSttMessage/Gemini behave.
 *
 * RAW INBOUND FRAME LOGGING (round 7, temporary diagnostic, no behavior
 * change): a call showed stt_connected and repeated stt:audio_sent but zero
 * stt:event_received, zero transcript, zero stt:audio_flow_heartbeat, and
 * zero stt_disconnected/stt_error — and the deployed code producing those
 * logs could not be confirmed to be this file's current version (see the
 * git history investigation this round). `connectSarvamStt`'s "message"
 * listener now logs `stt:raw_message_received` for every inbound WS frame,
 * text or binary, BEFORE the existing JSON.parse — including a binary
 * frame, which the pre-existing `if (typeof ev.data !== "string") return;`
 * check has always silently dropped with no log at all, and a
 * non-JSON text frame, which previously returned before any of this file's
 * other diagnostics could log it. `stt:first_inbound_message` fires once,
 * the first time any frame arrives. `stt:ws_closed`/`stt:ws_error` log the
 * raw WS close code/reason and error event directly in this file,
 * independent of whether `opts.onEvent`'s downstream dispatch runs. Purely
 * additive: does not touch the STT connection URL, query parameters,
 * authentication, audio transport/format, or normalizeSttMessage/parsing
 * behavior in any way.
 *
 * VERIFICATION NOTE (re-checked, still unresolved for everything below this
 * line — see docs/voice-pipeline-testing.md): this sandbox's network egress
 * cannot reach docs.sarvam.ai or any other documentation host directly
 * (confirmed again on a second pass: WebFetch to docs.sarvam.ai,
 * docs.pipecat.ai, docs.slng.ai, and a personal blog all returned
 * EGRESS_BLOCKED). WebSearch itself works (routed differently) and a
 * third-party community Rust SDK (github.com/skundu42/sarvam-rs) was
 * reachable via raw.githubusercontent.com — neither is Sarvam's own primary
 * documentation, so nothing below is "confirmed"; it is the most specific,
 * sourced information obtainable without a live SARVAM_API_KEY call.
 *
 * CONFIRMED (converging from multiple independent sources):
 *   - TTS: `wss://api.sarvam.ai/text-to-speech/ws`, config message first,
 *     then `text`/`flush`/`close` client message types, `bulbul:v3`. (This
 *     file sent `convert` instead of `text` until the TTS MESSAGE TYPE fix
 *     below — a stale, incorrect value in this very doc comment, not just
 *     the code; the two had drifted apart.)
 *   - Auth: an `api-subscription-key` mechanism (this file uses it as a WS
 *     subprotocol — the one auth-attachment method available to a browser-
 *     compatible `WebSocket` constructor, which Node's global also is).
 *
 * NOT CONFIRMED — specific, actionable leads (highest-value diagnostic: if
 * STT still connects but never emits a transcript after the audio-transport
 * fix above, check these in order):
 *   1. STT `vad-signals` query param casing: unlike `language_code`/
 *      `sample_rate` (confirmed underscored by production), this one has no
 *      direct evidence either way and was deliberately left as-is.
 *   2. TTS `pace` config field: still unconfirmed either way — not part of
 *      the minimal documented contract, but nothing in production evidence
 *      suggests it's wrong either (unlike `model`/`output_audio_bitrate`,
 *      now fixed — see the TTS notes above), and it's needed for the
 *      configurable speaking rate feature, so left unchanged.
 *   3. STT `session.begin`/`session.end` ordering requirements: now
 *      recognized and diagnosably logged (see STT RECEIVE-PATH WATCHDOG
 *      above), but still unconfirmed whether Sarvam requires session.begin
 *      before it will accept audio_input frames — if it does, sending
 *      audio immediately on WS "open" (this file's current behavior,
 *      unchanged) could be the actual cause of a dead receive path on a
 *      slow connection. Not fixed here, since that would mean withholding
 *      audio until session.begin arrives — a behavior change, not a
 *      diagnostic.
 * Every incoming message is parsed defensively (`normalizeSttMessage` /
 * `normalizeTtsMessage`) against multiple plausible shapes rather than
 * assuming one is correct, and an unrecognized shape is surfaced as a
 * structured `unknown` event (logged, never thrown) instead of crashing the
 * call — this bounds the blast radius of any of the above being wrong, but
 * does not fix a wrong connection URL or a wrong audio-transport shape,
 * which need an actual code change once confirmed.
 *
 * See also sarvam.server.ts's own doc comment: its chat model was updated
 * to "sarvam-105b-conversations" (from "sarvam-m") and its batch STT model
 * to "saaras:v3" (from "saaras:v2.5") on user-supplied reference, not an
 * independently-reachable doc — same unresolved-until-a-real-call caveat as
 * everything in this file. The realtime models below ("saaras:v3-realtime",
 * "bulbul:v3") were not part of that change and remain as they were.
 */

const STT_WS_URL = "wss://api.sarvam.ai/speech-to-text-realtime/ws";
const TTS_WS_URL = "wss://api.sarvam.ai/text-to-speech/ws";

export const SARVAM_REALTIME_MODELS = {
  stt: "saaras:v3-realtime",
  tts: "bulbul:v3",
} as const;

function apiKey(): string {
  const key = process.env["SARVAM_API_KEY"];
  if (!key)
    throw new SarvamRealtimeError(
      "not_configured",
      "The AI voice provider is not configured for this workspace.",
    );
  return key;
}

function authSubprotocol(): string {
  return `api-subscription-key.${apiKey()}`;
}

export class SarvamRealtimeError extends Error {
  code: "not_configured" | "auth_failed" | "connect_failed" | "timeout" | "protocol_error";
  constructor(code: SarvamRealtimeError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Extracts a human-readable error detail from a Sarvam error frame, trying
 * several plausible field names rather than assuming `message` — added
 * after production proved `normalizeTtsMessage`'s old `message`-only check
 * was silently discarding Sarvam's actual rejection text for TTS (the
 * observed "Speech synthesis error" was this file's own generic fallback,
 * not anything Sarvam sent). Never reads from the outgoing auth
 * subprotocol/API key — this only inspects an inbound server payload.
 */
function extractErrorDetail(msg: Record<string, unknown>): string | undefined {
  const data = (msg["data"] as Record<string, unknown> | undefined) ?? msg;
  for (const source of [data, msg]) {
    for (const key of [
      "message",
      "error",
      "detail",
      "reason",
      "error_message",
      "error_description",
    ]) {
      const value = source[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return undefined;
}

const CONNECT_TIMEOUT_MS = 8_000;

/**
 * STT RECEIVE-PATH IDLE WATCHDOG (round 6, diagnostic only, no behavior
 * change): round 5's one-shot watchdog only detects "zero messages ever
 * arrived" — it is permanently disarmed by the first inbound message, so it
 * cannot see a receive path that starts fine and then goes silent partway
 * through (production evidence: a call that logged exactly one
 * transcript.partial, then nothing else — no vad.speech_end, no
 * transcript.final). This checks periodically how long it's been since the
 * last Sarvam event, but only once at least one event has arrived — it must
 * never fire merely because the caller hasn't spoken yet. The threshold is
 * well above the gap between ordinary partials during continuous speech,
 * but well below voice-runtime's own SILENCE_HANGUP_MS (10s), so a dead
 * receive path is visible before the caller-silence timeout reacts to the
 * same underlying symptom.
 */
const STT_RECEIVE_IDLE_CHECK_INTERVAL_MS = 2_000;
const STT_RECEIVE_IDLE_THRESHOLD_MS = 7_000;

/**
 * Low-volume aggregate of outbound audio flow — NOT per-frame (stt:audio_sent
 * already logs every frame). Lets a drop in audio reaching Sarvam be told
 * apart, from the logs alone, from Sarvam's event stream going quiet while
 * audio keeps flowing.
 */
const STT_AUDIO_FLOW_HEARTBEAT_INTERVAL_MS = 1_500;

async function openSocket(url: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<WebSocket> {
  const socket = new WebSocket(url, [authSubprotocol()]);
  socket.binaryType = "arraybuffer";
  return await new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new SarvamRealtimeError("timeout", "Timed out connecting to the AI voice provider."));
    }, timeoutMs);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(
          new SarvamRealtimeError("connect_failed", "Could not connect to the AI voice provider."),
        );
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      (ev) => {
        clearTimeout(timer);
        if (ev.code === 1008 || ev.code === 4001 || ev.code === 4003) {
          reject(
            new SarvamRealtimeError(
              "auth_failed",
              "The AI voice provider rejected the platform credentials.",
            ),
          );
        }
      },
      { once: true },
    );
  });
}

/* ------------------------------------------------------------------ */
/* STT — saaras:v3-realtime                                            */
/* ------------------------------------------------------------------ */

export type SttEvent =
  | { type: "partial_transcript"; text: string; language?: string | undefined }
  | { type: "final_transcript"; text: string; language?: string | undefined }
  | { type: "speech_start" }
  | { type: "speech_end" }
  | { type: "session_begin" }
  | { type: "session_end" }
  | { type: "language_detected"; language: string }
  | { type: "error"; message: string; raw?: unknown }
  | { type: "closed"; code: number; reason: string }
  | { type: "unknown"; raw: unknown };

export interface SttSession {
  sendAudioFrame(data: Uint8Array): void;
  close(): void;
}

export interface ConnectSttOptions {
  /** BCP-47-ish Sarvam language code (e.g. "te-IN"), or "unknown" for auto-detect. */
  language: string;
  sampleRateHz: number;
  encoding: "linear16" | "mulaw";
  onEvent: (event: SttEvent) => void;
}

export function normalizeSttMessage(raw: unknown): SttEvent {
  if (typeof raw !== "object" || raw === null) return { type: "unknown", raw };
  const msg = raw as Record<string, unknown>;
  const kind = String(msg["type"] ?? msg["event"] ?? "");

  // Session lifecycle events — diagnostic-only recognition (production
  // incident: runtime_session_id f77b2529-58a5-4060-8479-017ab3e94169 shows
  // stt_connected and repeated stt:audio_sent with ZERO inbound messages of
  // any kind — no session.begin, no error, nothing. Recognizing these two
  // kinds here, instead of letting them fall through to `unknown`, makes
  // "did Sarvam ever consider this session started" directly observable on
  // the next call via connectSarvamStt's dedicated session_begin/
  // session_end diagnostics, without changing how onSttEvent reacts to
  // them — neither is wired to any new behavior.
  if (kind === "session.begin") return { type: "session_begin" };
  if (kind === "session.end") return { type: "session_end" };

  if (kind === "vad.speech_start" || kind === "speech_start") return { type: "speech_start" };
  if (kind === "vad.speech_end" || kind === "speech_end") return { type: "speech_end" };

  if (kind === "error") {
    const message = extractErrorDetail(msg) ?? "Speech recognition error";
    return { type: "error", message, raw: msg };
  }

  // `text` is the current realtime protocol's field name for transcript.partial/
  // transcript.final (confirmed by official docs: message.text, read directly off
  // the top-level parsed message — https://docs.sarvam.ai/api/api-guides-tutorials/
  // speech-to-text/realtime-streaming). `transcript` is kept as a fallback for
  // Sarvam's legacy, non-realtime streaming API shape, which this file's own
  // STT_WS_URL no longer talks to but which a future shape change could plausibly
  // revert toward — see STT TRANSCRIPT FIELD NAME in this file's module doc for why
  // `text` was wrong to omit.
  const data = (msg["data"] as Record<string, unknown> | undefined) ?? msg;
  const transcript = data["text"] ?? data["transcript"];
  if (typeof transcript === "string") {
    const isFinal =
      Boolean(data["is_final"] ?? msg["is_final"]) ||
      kind === "final_transcript" ||
      kind === "transcript.final";
    const language =
      typeof data["language_code"] === "string" ? (data["language_code"] as string) : undefined;
    return isFinal
      ? { type: "final_transcript", text: transcript, language }
      : { type: "partial_transcript", text: transcript, language };
  }

  if (kind === "language_detected" && typeof msg["language_code"] === "string") {
    return { type: "language_detected", language: msg["language_code"] as string };
  }

  return { type: "unknown", raw };
}

export async function connectSarvamStt(opts: ConnectSttOptions): Promise<SttSession> {
  const url = new URL(STT_WS_URL);
  url.searchParams.set("model", SARVAM_REALTIME_MODELS.stt);
  url.searchParams.set("language_code", opts.language);
  url.searchParams.set("sample_rate", String(opts.sampleRateHz));
  url.searchParams.set("encoding", opts.encoding);
  // Server-driven VAD (the documented default) — no manual speech_start/end framing needed.
  url.searchParams.set("vad-signals", "true");

  const socket = await openSocket(url.toString());

  const connectedAt = Date.now();

  // Per-connection diagnostic state (see STT RECEIVE-PATH IDLE WATCHDOG
  // above this function) — intentionally local to this call, never global,
  // so concurrent calls never share or clobber each other's counters.
  let sttEventsReceived = 0;
  let lastSttEventAt: number | null = null;
  let lastEventType: string | null = null;
  let idleReported = false; // one stt:receive_path_idle log per idle episode; a new event clears this

  let audioFramesSent = 0;
  let lastAudioSentAt: number | null = null;
  let framesSentAtLastHeartbeat = 0;

  // TEMPORARY DIAGNOSTIC state (round 7, raw-frame visibility — see the
  // "message"/"close"/"error" listeners below): tracks only whether the
  // very first inbound frame of any kind has been logged yet, so
  // stt:first_inbound_message fires at most once per connection.
  let firstInboundMessageLogged = false;

  // unref() where available (Node) so these recurring timers never by
  // themselves keep a process alive — Cloudflare Workers' setInterval
  // return value has no unref() at all, hence the feature check rather
  // than a direct call.
  function unref(timer: unknown) {
    if (typeof (timer as { unref?: unknown })?.unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  }

  const idleCheckTimer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return; // connection not expected active
    if (sttEventsReceived === 0) return; // never fire merely because the caller hasn't spoken yet
    if (idleReported) return;
    const idleMs = Date.now() - (lastSttEventAt as number);
    if (idleMs < STT_RECEIVE_IDLE_THRESHOLD_MS) return;
    idleReported = true;
    console.info("stt:receive_path_idle", {
      elapsedSinceLastSttEventMs: idleMs,
      elapsedSinceLastAudioSentMs: lastAudioSentAt !== null ? Date.now() - lastAudioSentAt : null,
      audioFramesSent,
      sttEventsReceived,
      socketReadyState: socket.readyState,
      connectionAgeMs: Date.now() - connectedAt,
      lastEventType,
      lastAudioSentAt,
      lastSttEventAt,
    });
  }, STT_RECEIVE_IDLE_CHECK_INTERVAL_MS);
  unref(idleCheckTimer);

  const audioFlowHeartbeatTimer = setInterval(() => {
    const framesSentSinceLastHeartbeat = audioFramesSent - framesSentAtLastHeartbeat;
    framesSentAtLastHeartbeat = audioFramesSent;
    console.info("stt:audio_flow_heartbeat", {
      framesSentSinceLastHeartbeat,
      totalFramesSent: audioFramesSent,
      elapsedSinceLastAudioSentMs: lastAudioSentAt !== null ? Date.now() - lastAudioSentAt : null,
      socketReadyState: socket.readyState,
    });
  }, STT_AUDIO_FLOW_HEARTBEAT_INTERVAL_MS);
  unref(audioFlowHeartbeatTimer);

  function clearDiagnosticTimers() {
    clearInterval(idleCheckTimer);
    clearInterval(audioFlowHeartbeatTimer);
  }

  socket.addEventListener("message", (ev) => {
    // TEMPORARY DIAGNOSTIC (round 7, read-only investigation into calls that
    // show stt_connected and repeated stt:audio_sent but zero
    // stt:event_received, zero transcript, zero stt:audio_flow_heartbeat, and
    // zero error/close — logs every raw inbound WS frame, text or binary,
    // BEFORE any parsing, so a binary frame is visible at all (the existing
    // check right below has always silently dropped one with no log
    // whatsoever) and so a message that fails JSON.parse is visible too
    // (that path returns before this file's other diagnostics ever log).
    // Safe fields only: kind/length/a 200-char-or-200-byte-capped preview of
    // Sarvam's own inbound payload — never our outgoing API key (sent only
    // as a WS auth subprotocol, never read from here) and never anything
    // this file sends out itself. Purely additive: does not change parsing,
    // the JSON.parse try/catch below, or anything normalizeSttMessage/
    // onEvent does with the result.
    //
    // REDACTION: a text frame carrying a `text`/`transcript` field is the
    // caller's actual spoken words — every other diagnostic in this file
    // has always deliberately kept that out of logs (see stt:event_received
    // below: textPresent/textLength only, never the text itself). This
    // preview's diagnostic value is in showing malformed/unexpected
    // payloads (a proxy error page, truncated JSON, control bytes) — not in
    // re-exposing caller speech — so a frame that looks like a transcript
    // event gets a fixed redaction marker instead of its literal content.
    const isText = typeof ev.data === "string";
    const rawLength = isText
      ? (ev.data as string).length
      : ev.data instanceof ArrayBuffer
        ? ev.data.byteLength
        : null;
    let rawPreview: string | null = null;
    if (isText) {
      const text = ev.data as string;
      let looksLikeTranscript = false;
      try {
        const probe = JSON.parse(text) as unknown;
        const probeObj =
          typeof probe === "object" && probe !== null ? (probe as Record<string, unknown>) : {};
        const probeData = (probeObj["data"] as Record<string, unknown> | undefined) ?? probeObj;
        looksLikeTranscript =
          typeof probeData["text"] === "string" || typeof probeData["transcript"] === "string";
      } catch {
        looksLikeTranscript = false; // unparseable — exactly the case this preview exists to surface
      }
      rawPreview = looksLikeTranscript
        ? "<redacted: transcript field present>"
        : text.slice(0, 200);
    } else if (ev.data instanceof ArrayBuffer) {
      rawPreview = Buffer.from(new Uint8Array(ev.data).slice(0, 200)).toString("base64");
    }
    console.info("stt:raw_message_received", {
      kind: isText ? "text" : "binary",
      length: rawLength,
      preview: rawPreview,
      socketReadyState: socket.readyState,
    });
    if (!firstInboundMessageLogged) {
      firstInboundMessageLogged = true;
      console.info("stt:first_inbound_message", {
        atMs: Date.now(),
        elapsedSinceConnectMs: Date.now() - connectedAt,
        kind: isText ? "text" : "binary",
      });
    }

    if (typeof ev.data !== "string") return; // binary frames from this endpoint are not expected inbound
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      opts.onEvent({ type: "unknown", raw: ev.data });
      return;
    }
    // TEMPORARY DIAGNOSTIC (production incident: STT connects and accepts
    // audio with no error, and Sarvam returns session.begin/vad.speech_start/
    // transcript.partial/vad.speech_end/transcript.final — but every
    // transcript event's text was being silently dropped, because this file
    // checked a field named `transcript` while the current realtime
    // protocol's field is `text`. textPresent/transcriptFieldPresent are
    // reported SEPARATELY (unlike the old hasTranscript field, which only
    // checked the wrong one) specifically so a shape regression on either
    // field name is visible, not just whichever one happens to be checked
    // this round. Safe fields only: never the transcript text itself, just
    // whether one is present and how long it is.
    const msg =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const eventType = String(msg["type"] ?? msg["event"] ?? "unknown");
    const data = (msg["data"] as Record<string, unknown> | undefined) ?? msg;
    const extractedText = data["text"] ?? data["transcript"];
    console.info("stt:event_received", {
      eventType,
      topLevelKeys: Object.keys(msg),
      textPresent: typeof data["text"] === "string",
      textLength: typeof data["text"] === "string" ? (data["text"] as string).length : null,
      dataKeys: Object.keys(data),
      transcriptFieldPresent: typeof data["transcript"] === "string",
      extractedTextPresent: typeof extractedText === "string",
      isError: eventType === "error",
      errorCode: typeof data["code"] === "number" ? data["code"] : null,
      errorMessage: eventType === "error" ? (extractErrorDetail(msg) ?? null) : null,
    });
    sttEventsReceived += 1;
    lastSttEventAt = Date.now();
    lastEventType = eventType;
    idleReported = false;
    const normalized = normalizeSttMessage(parsed);
    // Dedicated, clearly-named diagnostics for the two session lifecycle
    // kinds — see normalizeSttMessage's own comment for why these are
    // recognized instead of falling through to `unknown`. Logged here
    // (not inside normalizeSttMessage, which stays a pure function) so
    // these are easy to grep for on their own, separately from the
    // always-fires stt:event_received above.
    if (normalized.type === "session_begin") {
      console.info("stt:session_begin_received", { elapsedMs: Date.now() - connectedAt });
    }
    if (normalized.type === "session_end") {
      console.info("stt:session_end_received", { elapsedMs: Date.now() - connectedAt });
    }
    opts.onEvent(normalized);
  });
  socket.addEventListener("close", (ev) => {
    // TEMPORARY DIAGNOSTIC (round 7) — raw WS close, logged directly here
    // regardless of how onEvent's "closed" dispatch is handled downstream
    // (voice-runtime.server.ts's own stt_disconnected log depends on that
    // dispatch actually running; this does not).
    console.info("stt:ws_closed", {
      code: ev.code,
      reason: ev.reason,
      atMs: Date.now(),
      connectionAgeMs: Date.now() - connectedAt,
    });
    clearDiagnosticTimers();
    opts.onEvent({ type: "closed", code: ev.code, reason: ev.reason });
  });
  socket.addEventListener("error", (ev) => {
    // TEMPORARY DIAGNOSTIC (round 7) — raw WS error, logged directly here.
    // The standard WebSocket "error" event carries no message/code of its
    // own (why the existing onEvent dispatch below uses a fixed string) —
    // this logs whatever is safely observable: the event's own type and
    // connection state at the moment it fired.
    console.info("stt:ws_error", {
      eventType: (ev as { type?: string } | undefined)?.type ?? "error",
      socketReadyState: socket.readyState,
      atMs: Date.now(),
      connectionAgeMs: Date.now() - connectedAt,
    });
    clearDiagnosticTimers();
    opts.onEvent({ type: "error", message: "Speech recognition connection error" });
  });

  let audioFrameSequence = 0;

  return {
    sendAudioFrame(data: Uint8Array) {
      if (socket.readyState !== WebSocket.OPEN) return;
      audioFramesSent += 1;
      lastAudioSentAt = Date.now();
      audioFrameSequence += 1;
      // FIX (production incident: STT connects and accepts query params
      // fine, but never produces a single transcript for audio that is
      // clearly arriving — this file previously sent the raw Uint8Array as
      // a BINARY WebSocket frame with no JSON envelope at all. The current
      // realtime protocol expects a JSON **text** frame:
      // {"event":"audio_input","audio":"<base64>"} — this was flagged,
      // unconfirmed, in this file's very first module doc before any live
      // test, and is now directly confirmed. The bytes themselves are
      // unchanged (still Vobiz's raw mulaw/8kHz, decoded once in
      // vobiz-media-bridge.server.ts) — only the transport wrapping here
      // changes; no resampling or re-encoding of the audio itself.
      const audioBase64 = Buffer.from(data).toString("base64");
      const payload = { event: "audio_input", audio: audioBase64 };
      // TEMPORARY DIAGNOSTIC — never logs the base64 audio itself, only its
      // length and the frame's known encoding/sample-rate metadata.
      const bytesPerSample = opts.encoding === "linear16" ? 2 : 1;
      console.info("stt:audio_sent", {
        base64Length: audioBase64.length,
        byteLength: data.length,
        durationMs: Math.round((data.length / bytesPerSample / opts.sampleRateHz) * 1000),
        sequence: audioFrameSequence,
        sampleRateHz: opts.sampleRateHz,
        encoding: opts.encoding,
        event: payload.event,
      });
      socket.send(JSON.stringify(payload));
    },
    close() {
      clearDiagnosticTimers();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.close(1000, "done");
    },
  };
}

/* ------------------------------------------------------------------ */
/* TTS — bulbul:v3 streaming                                           */
/* ------------------------------------------------------------------ */

export type TtsEvent =
  | { type: "audio"; data: Uint8Array; meta?: Record<string, unknown> }
  | { type: "flushed" }
  | { type: "error"; message: string; raw?: unknown }
  | { type: "closed"; code: number; reason: string }
  | { type: "unknown"; raw: unknown };

export interface TtsSession {
  /** Streams one chunk of text to be synthesized (call repeatedly as sentences complete). */
  sendText(text: string): void;
  /** Forces synthesis of whatever text has been sent so far, without waiting for more. */
  flush(): void;
  close(): void;
}

export interface ConnectTtsOptions {
  voiceId: string;
  language: string;
  pace: number;
  /** Output codec the telephony leg expects — resolved from the audio bridge's outbound format. */
  outputCodec: "mulaw" | "linear16" | "wav";
  /**
   * Sample rate the telephony leg expects — resolved from the audio
   * bridge's outbound format. Sent to Sarvam as `speech_sample_rate`
   * (separate from `outputCodec`/`output_audio_codec`: codec and sample
   * rate are independent settings, and bulbul:v3 otherwise defaults to
   * 24000 Hz regardless of codec — see connectSarvamTts). Also kept for
   * the caller's own format-verification diagnostics
   * (declaredTtsOutputSampleRateHz in voice-runtime.server.ts), which
   * verify the declared value was honored — they don't by themselves
   * cause it to be.
   */
  outputSampleRateHz: number;
  onEvent: (event: TtsEvent) => void;
}

export function normalizeTtsMessage(raw: unknown): TtsEvent {
  if (typeof raw !== "object" || raw === null) return { type: "unknown", raw };
  const msg = raw as Record<string, unknown>;
  const kind = String(msg["type"] ?? msg["event"] ?? "");

  if (kind === "audio") {
    const data = (msg["data"] as Record<string, unknown> | undefined) ?? msg;
    const audio = data["audio"];
    if (typeof audio === "string") {
      try {
        const decoded = Uint8Array.from(Buffer.from(audio, "base64"));
        // Pass through whatever else Sarvam included alongside the audio
        // payload (e.g. a sample rate or codec field, if it sends one) so
        // callers can verify the actual output format matches what was
        // declared in the config message, instead of trusting it blindly —
        // see onTtsEvent's first_outbound_audio_frame diagnostic.
        const meta: Record<string, unknown> = { ...data };
        delete meta["audio"];
        return { type: "audio", data: decoded, meta };
      } catch {
        return { type: "error", message: "Malformed audio chunk from the AI voice provider" };
      }
    }
  }
  if (kind === "flushed" || kind === "flush_ack") return { type: "flushed" };
  if (kind === "error") {
    const message = extractErrorDetail(msg) ?? "Speech synthesis error";
    return { type: "error", message, raw: msg };
  }
  return { type: "unknown", raw };
}

export async function connectSarvamTts(opts: ConnectTtsOptions): Promise<TtsSession> {
  const url = new URL(TTS_WS_URL);
  url.searchParams.set("model", SARVAM_REALTIME_MODELS.tts);

  const socket = await openSocket(url.toString());

  socket.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      opts.onEvent(normalizeTtsMessage(JSON.parse(ev.data)));
    } catch {
      opts.onEvent({ type: "unknown", raw: ev.data });
    }
  });
  socket.addEventListener("close", (ev) => {
    opts.onEvent({ type: "closed", code: ev.code, reason: ev.reason });
  });
  socket.addEventListener("error", () => {
    opts.onEvent({ type: "error", message: "Speech synthesis connection error" });
  });

  // Config must be the first message on the socket (documented requirement).
  // model is a connection-level query param (set above), matching STT's
  // proven-correct shape, not a config field. output_audio_codec and
  // speech_sample_rate are separate, independent settings — codec alone
  // does NOT imply a sample rate: Sarvam's documented default for
  // bulbul:v3 is 24000 Hz regardless of codec, with 8000 Hz supported for
  // streaming. Both must be declared explicitly, or Sarvam will generate
  // 24kHz audio that a mulaw/8kHz telephony bridge forwards byte-for-byte
  // without resampling — not a connection error, just corrupted/garbled
  // audio on the call. See this file's module doc for why bitrate
  // specifically was still wrong (a compressed-codec bitrate, not a sample
  // rate — never reintroduce output_audio_bitrate). speech_sample_rate is
  // sent as a STRING, not a number — per a current working Sarvam
  // implementation (user-supplied; not independently verifiable from this
  // sandbox, see module doc's VERIFICATION NOTE).
  const configPayload = {
    type: "config",
    data: {
      language_code: opts.language,
      speaker: opts.voiceId,
      pace: Math.min(2, Math.max(0.5, opts.pace)),
      output_audio_codec: opts.outputCodec,
      speech_sample_rate: String(opts.outputSampleRateHz),
    },
  };
  // TEMPORARY DIAGNOSTIC (production incident: Sarvam rejects the TTS
  // session with a 422 "Input parameters has to be a valid dictionary"
  // even after two rounds of config-only fixes — this traces every send on
  // the wire so the next call shows the exact sequence rather than
  // inferring it from log order, which synchronous fire-and-forget sends
  // make unreliable. Safe fields only: never the API key/auth subprotocol,
  // never audio, never the full transcript (text gets only a length and a
  // ≤20-char preview — see tts:text_sent below).
  console.info("tts:config_sent", {
    topLevelKeys: Object.keys(configPayload),
    dataKeys: Object.keys(configPayload.data),
    dataValueTypes: Object.fromEntries(
      Object.entries(configPayload.data).map(([k, v]) => [k, typeof v]),
    ),
    modelInUrl: url.searchParams.get("model"),
    codec: configPayload.data.output_audio_codec,
    sampleRateValue: configPayload.data.speech_sample_rate,
    sampleRateType: typeof configPayload.data.speech_sample_rate,
    languageCode: configPayload.data.language_code,
    speaker: configPayload.data.speaker,
    pace: configPayload.data.pace,
  });
  socket.send(JSON.stringify(configPayload));

  return {
    sendText(text: string) {
      if (!text) return;
      if (socket.readyState === WebSocket.OPEN) {
        // "text", not "convert" — per the current Sarvam realtime TTS
        // protocol (user-supplied); "convert" was never a recognized
        // message type, and is the leading suspect for the persistent 422
        // that survived two unrelated config-field fixes.
        const textPayload = { type: "text", data: { text } };
        console.info("tts:text_sent", {
          topLevelKeys: Object.keys(textPayload),
          dataKeys: Object.keys(textPayload.data),
          dataType: typeof textPayload.data,
          textType: typeof textPayload.data.text,
          textLength: text.length,
          textPreview: text.slice(0, 20),
        });
        socket.send(JSON.stringify(textPayload));
      }
    },
    flush() {
      if (socket.readyState === WebSocket.OPEN) {
        const flushPayload = { type: "flush" };
        console.info("tts:flush_sent", { shape: flushPayload });
        socket.send(JSON.stringify(flushPayload));
      }
    },
    close() {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "close" }));
        socket.close(1000, "done");
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    },
  };
}
