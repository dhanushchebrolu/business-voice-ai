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
} from "./adapter";

/**
 * Generic REST + HMAC-signed-webhook adapter, parameterized per provider by
 * environment variables. This is the "one clean provider adapter boundary"
 * called for in the Phase D brief — it is deliberately generic rather than
 * hard-coded to a specific vendor's SDK, because no real provider credentials
 * or API documentation are available in this environment (see the Phase D
 * report's "Real provider testing status" section). Wiring a specific
 * provider's actual REST shape means overriding `provisionNumber`,
 * `releaseNumber` and `initiateOutboundCall` below with that provider's real
 * endpoints — the interface and the rest of the codebase do not change.
 *
 * The assumed webhook contract (documented here since it is this adapter's
 * contract, not a real vendor's): a JSON body with
 * { call_id, status, direction, from, to, duration_seconds, recording_url,
 *   error, timestamp }, signed with HMAC-SHA256 over the raw body in an
 * `x-webhook-signature` header, hex-encoded.
 */

interface GenericProviderConfig {
  id: string;
  supportsPurchase: boolean;
  baseUrl: string;
  apiKey: string;
  webhookSecret: string;
}

const STATUS_MAP: Record<string, NormalizedCallStatus> = {
  initiated: "initiated",
  queued: "initiated",
  ringing: "ringing",
  answered: "answered",
  "in-progress": "in_progress",
  in_progress: "in_progress",
  completed: "completed",
  failed: "failed",
  busy: "busy",
  "no-answer": "no_answer",
  no_answer: "no_answer",
  cancelled: "cancelled",
  canceled: "cancelled",
};

export class GenericTelephonyAdapter implements TelephonyProviderAdapter {
  id: string;
  supportsPurchase: boolean;
  private config: GenericProviderConfig;

  constructor(config: GenericProviderConfig) {
    this.id = config.id;
    this.supportsPurchase = config.supportsPurchase;
    this.config = config;
  }

  async provisionNumber(input: ProvisionNumberInput): Promise<ProvisionedNumber> {
    if (!this.supportsPurchase) {
      throw new TelephonyAdapterError(
        `${this.id} does not support self-service number purchase through this platform. Provision it in the provider's own console, then attach it with its provider number ID.`,
        400,
      );
    }
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/numbers/purchase`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ country: input.country, prefix: input.prefix ?? null }),
      });
    } catch {
      throw new TelephonyAdapterError(`Could not reach ${this.id}. Please retry.`, 503);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new TelephonyAdapterError(
        `${this.id} rejected the purchase request (${res.status}). ${detail.slice(0, 200)}`,
        res.status,
      );
    }
    const body = (await res.json()) as {
      id: string;
      e164: string;
      display?: string;
      monthly_price?: number;
      capabilities?: string[];
    };
    return {
      providerNumberId: body.id,
      e164: body.e164,
      displayNumber: body.display ?? body.e164,
      monthlyPrice: body.monthly_price ?? null,
      capabilities: body.capabilities ?? [],
    };
  }

  async releaseNumber(providerNumberId: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/numbers/${encodeURIComponent(providerNumberId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      });
    } catch {
      throw new TelephonyAdapterError(`Could not reach ${this.id}. Please retry.`, 503);
    }
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => "");
      throw new TelephonyAdapterError(
        `${this.id} could not release the number (${res.status}). ${detail.slice(0, 200)}`,
        res.status,
      );
    }
  }

  async initiateOutboundCall(input: InitiateOutboundCallInput): Promise<InitiatedCall> {
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/calls`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          from: input.fromE164,
          to: input.toE164,
          callback_url: input.callbackUrl,
          metadata: input.metadata ?? {},
        }),
      });
    } catch {
      throw new TelephonyAdapterError(`Could not reach ${this.id}. Please retry.`, 503);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new TelephonyAdapterError(
        `${this.id} rejected the outbound call (${res.status}). ${detail.slice(0, 200)}`,
        res.status,
      );
    }
    const body = (await res.json()) as { call_id: string; status?: string };
    return {
      providerCallId: body.call_id,
      status: body.status === "ringing" ? "ringing" : "initiated",
    };
  }

  verifyWebhookSignature(rawBody: string, headers: Record<string, string | null>): boolean {
    const signature = headers["x-webhook-signature"];
    if (!signature) return false;
    const expected = createHmac("sha256", this.config.webhookSecret).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  normalizeWebhookEvent(rawBody: string): NormalizedCallEvent | null {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }
    const callId = typeof body["call_id"] === "string" ? (body["call_id"] as string) : null;
    const rawStatus =
      typeof body["status"] === "string" ? (body["status"] as string).toLowerCase() : null;
    if (!callId || !rawStatus || !(rawStatus in STATUS_MAP)) return null;

    return {
      eventId: typeof body["event_id"] === "string" ? (body["event_id"] as string) : undefined,
      providerCallId: callId,
      status: STATUS_MAP[rawStatus]!,
      direction:
        body["direction"] === "outbound"
          ? "outbound"
          : body["direction"] === "inbound"
            ? "inbound"
            : undefined,
      vaaniE164:
        typeof body["vaani_number"] === "string" ? (body["vaani_number"] as string) : undefined,
      fromE164: typeof body["from"] === "string" ? (body["from"] as string) : undefined,
      toE164: typeof body["to"] === "string" ? (body["to"] as string) : undefined,
      durationSeconds:
        typeof body["duration_seconds"] === "number"
          ? (body["duration_seconds"] as number)
          : undefined,
      recordingUrl:
        typeof body["recording_url"] === "string" ? (body["recording_url"] as string) : null,
      failureReason: typeof body["error"] === "string" ? (body["error"] as string) : null,
      occurredAt:
        typeof body["timestamp"] === "string"
          ? (body["timestamp"] as string)
          : new Date().toISOString(),
      raw: body,
    };
  }

  /**
   * No provider's real media-streaming protocol (Twilio Media Streams,
   * Exotel voicebot streaming, etc.) is implemented here — none is
   * configured with real credentials in this environment, and each has a
   * distinct, proprietary framing that would need to be verified against
   * that provider's live account to implement correctly. Returning `null`
   * is the honest state: this provider has no live audio path yet. See the
   * Phase E report's "Known limitations" for the concrete next step.
   */
  async openMediaBridge() {
    return null;
  }
}
