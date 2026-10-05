import { createHmac, timingSafeEqual } from "crypto";
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
import { awaitVobizMediaBridge } from "./vobiz-media-registry.server.ts";
import { normalizeToE164 } from "../contacts-import.ts";

/**
 * Real Vobiz adapter — call control against Vobiz's REST Voice API, plus
 * the Voice XML `<Stream>` media path (see vobiz-media-bridge.server.ts and
 * the vobiz-answer webhook route for the XML/audio transport).
 *
 * VERIFICATION NOTE: this environment's network egress is restricted to an
 * allowlisted proxy that does not reach vobiz.ai/docs.vobiz.ai/
 * api.vobiz.ai at all (a direct `curl`/WebFetch to any of those three
 * returns a hard proxy-level `connect_rejected` — this is a wider block
 * than the Exotel/Sarvam restriction, which could at least reach some
 * pages), so nothing below comes from a direct read of Vobiz's live
 * reference docs. It is assembled from (a) web-search summaries that quote
 * Vobiz's own documentation pages by URL and title, and (b) actual,
 * runnable code in Vobiz's own public GitHub reference implementations
 * (vobiz-ai/Vobiz-X-Pipecat's server.py/bot.py, vobiz-ai/Vobiz-n8n-nodes'
 * signature-verification PR) — treated as higher-confidence than a search
 * summary alone because it is real, working code, not paraphrase. Same
 * verification discipline as exotel-provider.ts and
 * sarvam-provider.server.ts: everything below is limited to what those
 * sources actually showed, defensively coded (multiple candidate field
 * names, safe fallbacks, never a fabricated value treated as certain), and
 * the specific things that could NOT be independently confirmed are called
 * out inline. Verify against a real Vobiz account before production use —
 * this is explicitly the "development/testing" provider for now (see
 * telephony.server.ts's dedicated vobiz branch and the migration report).
 *
 * Confirmed-with-reasonable-confidence (consistent across multiple
 * independent sources, including real reference-implementation code):
 *   - Base URL: https://api.vobiz.ai/api/v1
 *   - Auth: X-Auth-ID / X-Auth-Token headers (never Basic auth, never a
 *     bearer token)
 *   - Outbound call: POST /Account/{auth_id}/Call/ with
 *     {from, to, answer_url, answer_method, hangup_url}, returns 201 with
 *     {call_uuid, status}
 *   - Inbound/outbound call-flow control is Vobiz's own "Voice XML" format
 *     requested from an `answer_url` your server supplies; a `<Stream>`
 *     element with a `wss://` body URL opens bidirectional media
 *     (audio/x-mulaw;rate=8000 by default)
 *   - Hangup/status callback (`hangup_url`) posts CallUUID, CallStatus,
 *     Duration, HangupCause — CallStatus values: ringing, in-progress,
 *     completed (inbound-terminal), or completed/busy/failed/timeout/
 *     no-answer (outbound-terminal)
 *   - Recording-ready callback posts RecordUrl/RecordingDuration/
 *     RecordingID/CallUUID/RecordingEndReason
 *   - Numbers: GET /inventory/numbers, POST /numbers/purchase-from-inventory
 *     {e164}, DELETE /numbers/{e164}
 *
 * NOT independently confirmed (documented honestly, handled defensively):
 *   - The exact X-Vobiz-Signature-V3 HMAC formula below
 *     (base64(HMAC-SHA256(authToken, requestUrlWithoutQuery + "." + nonce)),
 *     nonce in an X-Vobiz-Signature-V3-Nonce header) comes from a Vobiz
 *     community-maintained n8n-node's signature-verification PR, which
 *     itself cites Vobiz's "Validating Callbacks" doc page by name — real,
 *     tested verification code, but not a first-party read. For this
 *     reason it is treated as a defense-in-depth SECONDARY check, not the
 *     sole gate: the PRIMARY, guaranteed-correct check is a `verify_token`
 *     query parameter Klyro itself appends to every answer_url/hangup_url
 *     it ever gives Vobiz (the exact same proven pattern
 *     ExotelTelephonyAdapter uses for exactly this reason — see that
 *     file's own verification note). A request is accepted only if the
 *     verify_token matches; the HMAC check, when a signature header is
 *     actually present, must ALSO pass (a present-but-invalid signature is
 *     always rejected, never ignored) — mirroring
 *     SarvamTelephonyAdapter's layered verify_token + provider-signature
 *     pattern.
 *   - The exact hangup/live-call-control REST path (`DELETE
 *     /Account/{auth_id}/Call/{call_uuid}`) is inferred from the Vobiz
 *     Python SDK's `client.live_calls.hangup_call(auth_id, call_uuid)`
 *     method name and the API's otherwise-consistent REST shape, not a
 *     directly-quoted endpoint reference — not implemented here at all
 *     (the adapter interface has no "hangup a live call" method today;
 *     only `terminateAgentRuntime`/closing the media bridge end a call
 *     from Klyro's side, which this adapter already supports via
 *     `openMediaBridge`'s returned bridge `.close()`).
 */

export interface VobizConfig {
  authId: string;
  authToken: string;
  /** Defaults to Vobiz's documented API base. Override only for a verified region/sub-account host. */
  baseUrl?: string | undefined;
  /** Vobiz's default outbound caller ID when a call doesn't otherwise specify one. */
  phoneNumber?: string | undefined;
  /** Shared secret Klyro appends as `?verify_token=` to every answer_url/hangup_url it gives Vobiz. */
  webhookVerifyToken: string;
  /** How long (ms) openMediaBridge waits for Vobiz's WS connection to arrive before giving up. */
  mediaBridgeTimeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.vobiz.ai/api/v1";

const STATUS_MAP: Record<string, NormalizedCallStatus> = {
  ringing: "ringing",
  "in-progress": "in_progress",
  "in progress": "in_progress",
  call_initiated: "initiated",
  "call-initiated": "initiated",
  initiated: "initiated",
  completed: "completed",
  busy: "busy",
  failed: "failed",
  timeout: "no_answer",
  "no-answer": "no_answer",
  "no answer": "no_answer",
  cancelled: "cancelled",
  canceled: "cancelled",
};

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

export class VobizTelephonyAdapter implements TelephonyProviderAdapter {
  id = "vobiz";
  // Confirmed self-service numbers API (GET /inventory/numbers, POST
  // /numbers/purchase-from-inventory) — unlike Exotel, Vobiz does appear to
  // support real programmatic purchase.
  supportsPurchase = true;

  private config: VobizConfig;

  constructor(config: VobizConfig) {
    this.config = config;
  }

  private baseUrl(): string {
    return this.config.baseUrl ?? DEFAULT_BASE_URL;
  }

  private authHeaders(): Record<string, string> {
    return {
      "X-Auth-ID": this.config.authId,
      "X-Auth-Token": this.config.authToken,
    };
  }

  /** Appends Klyro's own verify_token so verifyWebhookSignature can authenticate the request Klyro itself gets called back on. */
  withVerifyToken(url: string): string {
    const u = new URL(url);
    u.searchParams.set("verify_token", this.config.webhookVerifyToken);
    return u.toString();
  }

  /**
   * Read-only `GET /inventory/numbers` — browsable, available numbers for a
   * country/prefix. Never purchases anything. Shared by `provisionNumber`
   * (below) and the admin connectivity test (telephony-admin.functions.ts's
   * `testVobizConnectivity`), which needs exactly this one safe, side-
   * effect-free call to prove credentials actually authenticate against
   * Vobiz without ever buying a number or placing a call.
   */
  async listInventoryNumbers(
    country: string,
    prefix?: string,
  ): Promise<{ e164?: string; monthly_fee?: number }[]> {
    let res: Response;
    try {
      const listUrl = new URL(`${this.baseUrl()}/Account/${this.config.authId}/inventory/numbers`);
      listUrl.searchParams.set("country", country);
      if (prefix) listUrl.searchParams.set("search", prefix);
      res = await fetch(listUrl, { headers: this.authHeaders() });
    } catch {
      throw new TelephonyAdapterError("Could not reach Vobiz. Please retry.", 503);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new TelephonyAdapterError(
        `Vobiz rejected the number inventory request (${res.status}). ${detail.slice(0, 200)}`,
        res.status,
      );
    }
    const body = (await res.json().catch(() => ({}))) as {
      objects?: { e164?: string; monthly_fee?: number }[];
    };
    return body.objects ?? [];
  }

  async provisionNumber(input: ProvisionNumberInput): Promise<ProvisionedNumber> {
    const inventory = await this.listInventoryNumbers(input.country, input.prefix);
    const candidate = inventory[0];
    if (!candidate?.e164) {
      throw new TelephonyAdapterError(
        `No Vobiz numbers available for country=${input.country}${input.prefix ? ` prefix=${input.prefix}` : ""}.`,
        404,
      );
    }

    let purchaseRes: Response;
    try {
      purchaseRes = await fetch(
        `${this.baseUrl()}/Account/${this.config.authId}/numbers/purchase-from-inventory`,
        {
          method: "POST",
          headers: { ...this.authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ e164: candidate.e164 }),
        },
      );
    } catch {
      throw new TelephonyAdapterError("Could not reach Vobiz. Please retry.", 503);
    }
    if (!purchaseRes.ok) {
      const detail = await purchaseRes.text().catch(() => "");
      throw new TelephonyAdapterError(
        `Vobiz rejected the number purchase (${purchaseRes.status}). ${detail.slice(0, 200)}`,
        purchaseRes.status,
      );
    }
    return {
      providerNumberId: candidate.e164,
      e164: candidate.e164,
      displayNumber: candidate.e164,
      monthlyPrice: candidate.monthly_fee ?? null,
      capabilities: ["voice"],
    };
  }

  async releaseNumber(providerNumberId: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl()}/Account/${this.config.authId}/numbers/${encodeURIComponent(providerNumberId)}`,
        { method: "DELETE", headers: this.authHeaders() },
      );
    } catch {
      throw new TelephonyAdapterError("Could not reach Vobiz. Please retry.", 503);
    }
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => "");
      throw new TelephonyAdapterError(
        `Vobiz could not release the number (${res.status}). ${detail.slice(0, 200)}`,
        res.status,
      );
    }
  }

  async initiateOutboundCall(input: InitiateOutboundCallInput): Promise<InitiatedCall> {
    const answerUrl = this.withVerifyToken(
      `${webhookOrigin(input.callbackUrl)}/api/public/webhooks/vobiz-answer`,
    );
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}/Account/${this.config.authId}/Call/`, {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          from: input.fromE164,
          to: input.toE164,
          answer_url: answerUrl,
          answer_method: "POST",
          hangup_url: this.withVerifyToken(input.callbackUrl),
          hangup_method: "POST",
        }),
      });
    } catch {
      throw new TelephonyAdapterError("Could not reach Vobiz. Please retry.", 503);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new TelephonyAdapterError(
        `Vobiz rejected the outbound call (${res.status}). ${detail.slice(0, 200)}`,
        res.status,
      );
    }
    const body = (await res.json().catch(() => ({}))) as { call_uuid?: string; status?: string };
    if (!body.call_uuid)
      throw new TelephonyAdapterError("Vobiz accepted the request but returned no call_uuid.", 502);
    return {
      providerCallId: body.call_uuid,
      status: body.status === "ringing" ? "ringing" : "initiated",
    };
  }

  /**
   * Layered check (see the module doc's verification note): Klyro's own
   * verify_token query parameter is the guaranteed-correct primary gate;
   * Vobiz's X-Vobiz-Signature-V3 header, when present, must ALSO pass — a
   * present-but-wrong signature is always rejected, never ignored, exactly
   * like SarvamTelephonyAdapter's verify_token + provider-signature layering.
   */
  verifyWebhookSignature(
    _rawBody: string,
    headers: Record<string, string | null>,
    url?: URL,
  ): boolean {
    const providedToken = url?.searchParams.get("verify_token");
    const expectedToken = this.config.webhookVerifyToken;
    const expectedTokenBytes = Buffer.from(expectedToken, "utf8");

    if (!providedToken) {
      console.error("vobiz_provider:webhook_verify_token_check", {
        secretConfigured: expectedTokenBytes.length > 0,
        receivedTokenPresent: false,
        matched: false,
      });
      return false;
    }
    const providedTokenBytes = Buffer.from(providedToken, "utf8");
    const tokenMatched =
      providedTokenBytes.length === expectedTokenBytes.length &&
      timingSafeEqual(providedTokenBytes, expectedTokenBytes);
    if (!tokenMatched) {
      console.error("vobiz_provider:webhook_verify_token_check", {
        secretConfigured: expectedTokenBytes.length > 0,
        receivedTokenPresent: true,
        matched: false,
      });
      return false;
    }

    const signature = headers["x-vobiz-signature-v3"];
    const nonce = headers["x-vobiz-signature-v3-nonce"];
    if (!signature || !nonce || !url) {
      // No Vobiz-side signature to additionally verify — Klyro's own
      // verify_token (already matched above) is the full authentication
      // this request gets, same graceful degradation Sarvam's adapter uses
      // when its own provider-signature header isn't present.
      console.info("vobiz_provider:webhook_verify_token_check", {
        secretConfigured: true,
        receivedTokenPresent: true,
        matched: true,
        providerSignaturePresent: false,
      });
      return true;
    }

    const addressNoQuery = `${url.origin}${url.pathname}`;
    const expectedSignature = createHmac("sha256", this.config.authToken)
      .update(`${addressNoQuery}.${nonce}`)
      .digest("base64");
    const expectedSignatureBytes = Buffer.from(expectedSignature, "utf8");
    const providedSignatureBytes = Buffer.from(signature, "utf8");
    const signatureMatched =
      providedSignatureBytes.length === expectedSignatureBytes.length &&
      timingSafeEqual(providedSignatureBytes, expectedSignatureBytes);

    console[signatureMatched ? "info" : "error"]("vobiz_provider:webhook_signature_check", {
      providerSignaturePresent: true,
      matched: signatureMatched,
    });
    return signatureMatched;
  }

  normalizeWebhookEvent(rawBody: string): NormalizedCallEvent | null {
    // Vobiz's callbacks are documented as form-urlencoded POSTs in every
    // reference implementation seen (same convention as Exotel/Twilio-
    // family providers) — accept JSON too, defensively, same as Exotel.
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

    const callUuid = firstString(fields, ["CallUUID", "call_uuid", "CallUuid"]);
    if (!callUuid) {
      console.error("vobiz_provider:webhook_payload_unrecognized", {
        fieldsPresent: Object.keys(fields),
        callUuidFound: false,
      });
      return null;
    }

    const rawStatus = firstString(fields, ["CallStatus", "call_status", "status"])?.toLowerCase();
    const statusRecognized = Boolean(rawStatus && rawStatus in STATUS_MAP);
    // Same reasoning as ExotelTelephonyAdapter: the very first callback for
    // a brand-new call (the answer_url request itself) may not carry a
    // status Vobiz has documented a fixed value for — fall back to the
    // earliest, most permissive status rather than dropping the event,
    // which would otherwise leave call_logs with no row for the media
    // bridge's authorization check to find.
    const status: NormalizedCallStatus = statusRecognized ? STATUS_MAP[rawStatus!]! : "initiated";
    if (!statusRecognized) {
      console.error("vobiz_provider:webhook_status_fallback", {
        callUuid,
        fieldsPresent: Object.keys(fields),
        fallbackStatus: status,
      });
    }

    const direction = firstString(fields, ["Direction", "direction"]);
    const rawFrom = firstString(fields, ["From", "from"]);
    const rawTo = firstString(fields, ["To", "to"]);
    const fromE164 = rawFrom ? (normalizeToE164(rawFrom) ?? rawFrom) : undefined;
    const toE164 = rawTo ? (normalizeToE164(rawTo) ?? rawTo) : undefined;
    const hangupCause = firstString(fields, ["HangupCause", "hangup_cause"]);

    return {
      providerCallId: callUuid,
      status,
      direction: direction?.toLowerCase().startsWith("outbound") ? "outbound" : "inbound",
      fromE164,
      toE164,
      destinationE164: toE164,
      durationSeconds: (() => {
        const v = firstString(fields, ["Duration", "CallDuration", "duration"]);
        const n = v ? Number(v) : NaN;
        return Number.isFinite(n) ? n : undefined;
      })(),
      recordingUrl: firstString(fields, ["RecordUrl", "RecordingURL", "recording_url"]) ?? null,
      failureReason:
        rawStatus === "failed" || rawStatus === "busy" || rawStatus === "timeout"
          ? (hangupCause ?? `Call ${rawStatus}`)
          : null,
      occurredAt: new Date().toISOString(),
      raw: fields,
    };
  }

  /**
   * Vobiz is the WebSocket *client* — the `<Stream>` Voice XML element
   * (returned by the vobiz-answer route) hands Vobiz a `wss://` URL it
   * connects out to, exactly like Exotel's Voicebot Applet. This method
   * never dials out; it only waits (bounded) for the WS route to have
   * already authorized and registered a connection for this exact
   * providerCallId. Returning null after the timeout is the same honest
   * "no live audio path for this call" signal every other adapter uses.
   */
  async openMediaBridge(providerCallId: string): Promise<AudioMediaBridge | null> {
    return awaitVobizMediaBridge(providerCallId, this.config.mediaBridgeTimeoutMs ?? 15_000);
  }
}

/** Derives `https://host` from a full callback URL, for building the sibling vobiz-answer URL next to it. */
function webhookOrigin(callbackUrl: string): string {
  return new URL(callbackUrl).origin;
}
