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
import { normalizeToE164 } from "../contacts-import.ts";

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
    // `URLSearchParams.get` already URL-decodes the value per the WHATWG
    // URL spec (including a literal "+" -> space, the
    // application/x-www-form-urlencoded convention) — this is correct
    // behavior for a normally percent-encoded query parameter, but it is
    // also exactly why an un-encoded special character in the secret
    // itself (a literal "&", "=", "+", "#", or space pasted straight into
    // the Exotel Passthru URL) silently corrupts what actually arrives
    // here: a "&" splits the query string into an extra parameter, cutting
    // `verify_token` short; a "+" decodes to a space the real secret never
    // had. Both produce a length or content mismatch below with no way to
    // tell which from the boolean return value alone — see the diagnostic
    // logging this comment introduces.
    const provided = url?.searchParams.get("verify_token");
    const expected = this.config.webhookVerifyToken;
    const expectedBytes = Buffer.from(expected, "utf8");

    if (!provided) {
      // Safe: presence/length only, never either value.
      console.error("exotel_provider:webhook_verify_token_check", {
        secretConfigured: expectedBytes.length > 0,
        secretLength: expectedBytes.length,
        receivedTokenPresent: false,
        receivedLength: 0,
        matched: false,
      });
      return false;
    }

    const providedBytes = Buffer.from(provided, "utf8");
    const matched =
      providedBytes.length === expectedBytes.length &&
      timingSafeEqual(providedBytes, expectedBytes);

    // Logged every time (pass or fail), matching the format this diagnostic
    // is meant to be read from wrangler tail on the very next test call —
    // a passing check is just as useful to confirm as a failing one.
    console[matched ? "info" : "error"]("exotel_provider:webhook_verify_token_check", {
      secretConfigured: expectedBytes.length > 0,
      secretLength: expectedBytes.length,
      receivedTokenPresent: true,
      receivedLength: providedBytes.length,
      matched,
    });

    return matched;
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
    if (!callSid) {
      // No usable call identity at all — genuinely nothing to do with this
      // event (never fabricate a CallSid). Diagnostic only: field NAMES the
      // payload actually carried, never values.
      console.error("exotel_provider:webhook_payload_unrecognized", {
        fieldsPresent: Object.keys(fields),
        callSidFound: false,
      });
      return null;
    }

    const rawStatus = firstString(fields, [
      "Status",
      "DialCallStatus",
      "CallStatus",
      "status",
    ])?.toLowerCase();
    const statusRecognized = Boolean(rawStatus && rawStatus in STATUS_MAP);
    // Exotel's Voicebot Passthru sends an initial callback (observed live:
    // CallType=call-attempt, every status-ish field absent/null) with a
    // valid CallSid but no recognized status field at all. Previously this
    // returned null and dropped the event outright — since this is the
    // *first* event for a brand-new call, dropping it meant the call_logs
    // row the media-stream authorization check depends on was never
    // created, so the Voicebot's WebSocket connection was rejected a few
    // hundred ms later with "No known call for CallSid ...". Falling back
    // to "initiated" (the earliest, most permissive NormalizedCallStatus —
    // see telephony-guard.server.ts's ALLOWED_TRANSITIONS, which allows
    // initiated -> every other status) fixes that without guessing at a
    // status the payload didn't actually assert: a real ringing/answered/
    // completed event for the same CallSid still arrives and correctly
    // progresses the row via applyCallEvent's own transition check.
    const status: NormalizedCallStatus = statusRecognized ? STATUS_MAP[rawStatus!]! : "initiated";
    if (!statusRecognized) {
      console.error("exotel_provider:webhook_status_fallback", {
        callSid,
        fieldsPresent: Object.keys(fields),
        fallbackStatus: status,
      });
    }

    const direction = firstString(fields, ["Direction", "direction"]);
    // Exotel's own "From"/"To" fields were observed live NOT in E.164 (e.g.
    // "09513886363" — Indian local/STD format, a leading 0 and no country
    // code) even though this codebase's phone_numbers.e164 column is always
    // written in E.164 ("+91...") by convention — a direct string match
    // between the two never succeeds, producing a spurious
    // "telephony:webhook_unknown_number" for a correctly-provisioned,
    // active number. normalizeToE164 (contacts-import.ts — already used and
    // tested for the exact same "0" + 10-digit Indian shape via CSV import)
    // is reused here rather than duplicated. Falls back to the raw string
    // when normalization can't make sense of it (an unrecognized shape),
    // matching the previous behavior for those inputs exactly — never a
    // regression, only a fix for the specific shape Exotel actually sends.
    const rawFrom = firstString(fields, ["From", "CallFrom", "from"]);
    const rawTo = firstString(fields, ["To", "CallTo", "to"]);
    const fromE164 = rawFrom ? (normalizeToE164(rawFrom) ?? rawFrom) : undefined;
    const toE164 = rawTo ? (normalizeToE164(rawTo) ?? rawTo) : undefined;
    return {
      providerCallId: callSid,
      status,
      direction: direction?.toLowerCase().startsWith("outbound") ? "outbound" : "inbound",
      fromE164,
      toE164,
      vaaniE164: toE164,
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
