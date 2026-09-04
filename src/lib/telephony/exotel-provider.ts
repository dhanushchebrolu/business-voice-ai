import { timingSafeEqual } from "crypto";
import {
  TelephonyAdapterError,
  type InitiateOutboundCallInput,
  type InitiatedCall,
  type NormalizedCallEvent,
  type NormalizedCallStatus,
  type ProvisionNumberInput,
  type ProvisionedNumber,
  type TelephonyProviderAdapter,
} from "./adapter.ts";
import type { AudioMediaBridge } from "./audio-bridge.ts";
import { awaitMediaBridge } from "./exotel-media-registry.server.ts";

/**
 * Real Exotel adapter — call control against Exotel's documented REST API,
 * plus the Voicebot Applet media path (see exotel-media-bridge.server.ts
 * and src/server.ts for the actual audio transport).
 *
 * VERIFICATION NOTE (see PHASE_D1_EXOTEL_FINAL_REPORT.md §3 for sources):
 * this environment's network egress is restricted to an allowlisted proxy
 * that does not reach developer.exotel.com or support.exotel.com, so the
 * exact REST/webhook field names below come from WebSearch summaries of
 * Exotel's docs, not a direct read of the live reference — the same
 * verification constraint noted for Sarvam in the Phase E report. What is
 * used here is limited to what those summaries actually stated. Two
 * specific things could NOT be independently confirmed and must be
 * verified against a real account before production use:
 *   1. The exact call-status webhook field names (mapped defensively below
 *      against several plausible variants, degrading to `null` — never a
 *      guessed value treated as certain — for anything unrecognized).
 *   2. Whether Exotel signs webhooks with a header at all. Their own
 *      documented security guidance (WebSearch, see the report) describes
 *      HTTPS + a dashboard-configured "webhook verify token" + strict
 *      payload validation — NOT HMAC over the body the way Razorpay/the
 *      generic adapter assume. This adapter checks that verify token as a
 *      URL query parameter (the one place Exotel's own docs confirm you
 *      can attach account-specific configuration), which is why
 *      `TelephonyProviderAdapter.verifyWebhookSignature` gained an
 *      optional `url` parameter (adapter.ts) — the smallest change that
 *      could accommodate a provider with a genuinely different security
 *      model, not a redesign.
 */

export interface ExotelConfig {
  accountSid: string;
  apiKey: string;
  apiToken: string;
  /** e.g. "api.exotel.com" or a region-specific subdomain — verify against your account. */
  subdomain: string;
  /** Shared secret compared against the `verify_token` query parameter on inbound webhooks. */
  webhookVerifyToken: string;
  /** How long (ms) openMediaBridge waits for Exotel's WS connection to arrive before giving up. */
  mediaBridgeTimeoutMs?: number;
}

const STATUS_MAP: Record<string, NormalizedCallStatus> = {
  queued: "initiated",
  ringing: "ringing",
  "in-progress": "in_progress",
  "in progress": "in_progress",
  completed: "completed",
  failed: "failed",
  busy: "busy",
  "no-answer": "no_answer",
  "no answer": "no_answer",
  canceled: "cancelled",
  cancelled: "cancelled",
};

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

export class ExotelTelephonyAdapter implements TelephonyProviderAdapter {
  id = "exotel";
  // No confirmed public self-service number-purchase API — Exotel numbers
  // are acquired through the account's dashboard/sales process. Provisioning
  // a number here means *attaching* one already obtained that way (the same
  // manual-attach path telephony-admin.functions.ts already supports for
  // every provider with purchase:false).
  supportsPurchase = false;

  private config: ExotelConfig;

  constructor(config: ExotelConfig) {
    this.config = config;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.config.apiKey}:${this.config.apiToken}`).toString("base64")}`;
  }

  private baseUrl(): string {
    return `https://${this.config.subdomain}/v1/Accounts/${this.config.accountSid}`;
  }

  async provisionNumber(_input: ProvisionNumberInput): Promise<ProvisionedNumber> {
    throw new TelephonyAdapterError(
      "Exotel does not expose a public self-service number-purchase API. Acquire the number through your Exotel account team/dashboard, then attach it here with its Exophone as the E.164 number (no purchase).",
      400,
    );
  }

  async releaseNumber(_providerNumberId: string): Promise<void> {
    throw new TelephonyAdapterError(
      "Exotel numbers are released through your Exotel account, not this API. Detaching it from the customer in Vaani (already supported) does not delete it from Exotel.",
      400,
    );
  }

  /**
   * Exotel's Connect (outbound call) API. Field names verified against
   * Exotel's long-stable core Voice API shape at implementation time from
   * general familiarity with it, not re-confirmed against live docs in
   * this session (egress-blocked) — flagged per the verification note
   * above; re-check before relying on this in production.
   */
  async initiateOutboundCall(input: InitiateOutboundCallInput): Promise<InitiatedCall> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}/Calls/connect.json`, {
        method: "POST",
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          From: input.fromE164,
          To: input.toE164,
          CallerId: input.fromE164,
          StatusCallback: input.callbackUrl,
          StatusCallbackEvents: "terminal,answered",
        }),
      });
    } catch {
      throw new TelephonyAdapterError("Could not reach Exotel. Please retry.", 503);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new TelephonyAdapterError(
        `Exotel rejected the outbound call (${res.status}). ${detail.slice(0, 200)}`,
        res.status,
      );
    }
    const body = (await res.json().catch(() => ({}))) as {
      Call?: { Sid?: string; Status?: string };
    };
    const callSid = body.Call?.Sid;
    if (!callSid)
      throw new TelephonyAdapterError("Exotel accepted the request but returned no CallSid.", 502);
    return {
      providerCallId: callSid,
      status: body.Call?.Status === "ringing" ? "ringing" : "initiated",
    };
  }

  verifyWebhookSignature(
    _rawBody: string,
    _headers: Record<string, string | null>,
    url?: URL,
  ): boolean {
    const provided = url?.searchParams.get("verify_token");
    if (!provided) return false;
    const expected = this.config.webhookVerifyToken;
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  normalizeWebhookEvent(rawBody: string): NormalizedCallEvent | null {
    // Exotel's status callback is application/x-www-form-urlencoded in most
    // documented examples, not JSON — accept both defensively.
    let fields: Record<string, unknown>;
    if (rawBody.trim().startsWith("{")) {
      try {
        fields = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return null;
      }
    } else {
      fields = Object.fromEntries(new URLSearchParams(rawBody));
    }

    const callSid = firstString(fields, ["CallSid", "call_sid", "Sid"]);
    const rawStatus = firstString(fields, [
      "Status",
      "DialCallStatus",
      "CallStatus",
      "status",
    ])?.toLowerCase();
    if (!callSid || !rawStatus || !(rawStatus in STATUS_MAP)) return null;

    const direction = firstString(fields, ["Direction", "direction"]);
    return {
      providerCallId: callSid,
      status: STATUS_MAP[rawStatus]!,
      direction: direction?.toLowerCase().startsWith("outbound") ? "outbound" : "inbound",
      fromE164: firstString(fields, ["From", "CallFrom", "from"]),
      toE164: firstString(fields, ["To", "CallTo", "to"]),
      vaaniE164: firstString(fields, ["To", "CallTo"]),
      durationSeconds: (() => {
        const v = firstString(fields, ["CallDuration", "Duration", "duration"]);
        const n = v ? Number(v) : NaN;
        return Number.isFinite(n) ? n : undefined;
      })(),
      recordingUrl: firstString(fields, ["RecordingUrl", "recording_url"]) ?? null,
      failureReason: rawStatus === "failed" ? "Call failed" : null,
      occurredAt: new Date().toISOString(),
      raw: fields,
    };
  }

  /**
   * Exotel is the WebSocket *client* — it connects to Vaani, not the other
   * way around (spec §6). This method never dials out; it only waits
   * (bounded) for src/server.ts's inbound WS route to have already fully
   * authorized a connection for this exact providerCallId and registered
   * it. Returning null after the timeout is the honest, non-fatal "no
   * live audio path" signal telephony-runtime.ts already knows how to
   * handle (same contract as every other adapter).
   *
   * Duplicate-connection rejection (spec §18) is NOT this method's job —
   * it lives entirely in the WS route, which owns the actual connection
   * and is the only place that can refuse a second one before a bridge
   * ever exists. This method is purely a waiter.
   */
  async openMediaBridge(providerCallId: string): Promise<AudioMediaBridge | null> {
    return awaitMediaBridge(providerCallId, this.config.mediaBridgeTimeoutMs ?? 15_000);
  }
}
