/**
 * Vobiz → ClickAI WhatsApp webhooks (the subscription created once with
 * `POST /api/v1/messaging/webhooks` and a ClickAI-generated secret).
 *
 * Per Vobiz's own WhatsApp skill (vobiz-ai/vobiz-mcp-server,
 * skills/vobiz-whatsapp/SKILL.md) and webhook reference:
 *   - `X-Webhook-Signature` is the HEX HMAC-SHA256 of the exact raw request
 *     body keyed by the subscription secret, with NO `sha256=` prefix;
 *     compare in constant time and answer 401 on a mismatch. (Meta's
 *     `X-Hub-Signature-256` is the Meta→Vobiz leg; ClickAI never receives it.)
 *   - `X-Webhook-Event` repeats the body's `event_type`.
 *   - Body envelope: `event_id` (unique per event, the dedupe key; Vobiz
 *     retries deliveries), `event_type`, `account_id`, `occurred_at`,
 *     `payload` — the event's slice of the WhatsApp Cloud API change value
 *     (`metadata`, `contacts[]`, `messages[]`, or `statuses[]` whose `id` is
 *     the wamid).
 *   - Only three event types exist: `message.inbound`, `message.status`,
 *     `call.<event>`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function getVobizWhatsAppWebhookSecret(): string | null {
  return process.env["VOBIZ_WHATSAPP_WEBHOOK_SECRET"] || null;
}

/** Fails closed: no secret, no header, or anything but 64 hex characters is "not verified". */
export function verifyVobizWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string | null | undefined,
): boolean {
  if (!secret || !signatureHeader) return false;
  const provided = signatureHeader.trim();
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(provided, "hex"));
}

/** The header value Vobiz would send for `rawBody` — for tests and local tooling only. */
export function signVobizWebhookBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export interface VobizWebhookEnvelope {
  eventId: string;
  eventType: string;
  occurredAt: string | null;
  /** The WhatsApp Cloud API change value (metadata/contacts/messages/statuses). */
  payload: Record<string, unknown>;
}

/** Null for anything that isn't a well-formed Vobiz envelope (never guessed at). */
export function parseVobizWebhookEnvelope(rawBody: string): VobizWebhookEnvelope | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const eventId = typeof b["event_id"] === "string" && b["event_id"] ? b["event_id"] : null;
  const eventType = typeof b["event_type"] === "string" && b["event_type"] ? b["event_type"] : null;
  const payload = b["payload"];
  if (!eventId || !eventType) return null;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  return {
    eventId,
    eventType,
    occurredAt: typeof b["occurred_at"] === "string" ? b["occurred_at"] : null,
    payload: payload as Record<string, unknown>,
  };
}
