/**
 * Call-level telemetry: one JSON line per event, correlated by call id and
 * SIP call id, with no conversation content. Phone numbers are masked,
 * transcripts are never logged (only lengths and the detected language).
 *
 * Metrics emitted (all in ms unless noted), consumable by any log-based
 * dashboard (Loki/Grafana, Datadog, CloudWatch):
 *   call.connected        audio connection time (room join -> session start)
 *   turn.eou              end-of-utterance delay (LiveKit EOU metrics)
 *   turn.stt              STT latency
 *   turn.llm_ttft         LLM time to first token
 *   turn.tts_ttfb         TTS time to first audio
 *   turn.first_audio      caller stopped speaking -> agent audio started
 *   turn.interrupted      a reply was cut off by the caller (count)
 *   tool                  tool name, ok, ms
 *   booking.result        outcome (confirmed / held_pending_sync / pending / failed)
 *   provider.error        which provider, recoverable?
 *   call.ended            reason, seconds
 */

export interface CallIds {
  callId: string | null;
  sipCallId: string | null;
  room: string;
}

export function maskPhone(n: string | null | undefined): string | null {
  if (!n) return null;
  const d = n.replace(/\D/g, "");
  return d.length <= 4 ? "****" : `${"*".repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`;
}

const REDACT_KEYS =
  /transcript|text|content|name|phone|number|caller|summary|secret|token|key|authorization/i;

/** Drops or masks anything that could carry caller data or secrets. */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (typeof v === "string")
      out[k] = REDACT_KEYS.test(k) ? `[redacted:${v.length}]` : v.slice(0, 200);
    else out[k] = "[object]";
  }
  return out;
}

export type Sink = (line: string) => void;

export class CallTelemetry {
  private readonly ids: CallIds;
  private readonly sink: Sink;
  private readonly startedAt = Date.now();
  readonly counters = { turns: 0, interruptions: 0, toolFailures: 0, providerErrors: 0 };

  constructor(ids: CallIds, sink: Sink = (l) => process.stdout.write(l + "\n")) {
    this.ids = ids;
    this.sink = sink;
  }

  setCallId(callId: string): void {
    this.ids.callId = callId;
  }

  emit(event: string, fields: Record<string, unknown> = {}): void {
    if (event === "turn.interrupted") this.counters.interruptions++;
    if (event === "tool" && fields["ok"] === false) this.counters.toolFailures++;
    if (event === "provider.error") this.counters.providerErrors++;
    this.sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        event,
        call_id: this.ids.callId,
        sip_call_id: this.ids.sipCallId,
        room: this.ids.room,
        t_ms: Date.now() - this.startedAt,
        ...redact(fields),
      }),
    );
  }
}
