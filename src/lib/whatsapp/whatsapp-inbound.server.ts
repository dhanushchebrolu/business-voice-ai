/**
 * Inbound Meta WhatsApp webhook processing:
 *
 *   1. Authentication: every POST must carry a valid X-Hub-Signature-256
 *      (HMAC of the raw body with META_APP_SECRET) — verified by the route
 *      before anything is parsed or stored (verifyWhatsAppWebhookSignature).
 *   2. Delivery-status updates (sent/delivered/read/failed) for messages
 *      this codebase sent — scoped to the connection the payload names and
 *      never moved backwards (a late "delivered" can't undo "read").
 *   3. Inbound customer messages are persisted (whatsapp_conversations/
 *      whatsapp_messages); the ids of NEW inbound text messages are
 *      returned so the route can hand them to the AI reply worker
 *      (whatsapp-ai-reply.server.ts) without blocking Meta's acknowledgement.
 *
 * Idempotency: the whole payload is claimed in webhook_events
 * (provider='whatsapp', event id = SHA-256 of the raw body) and each message
 * is unique per (connection, wa_message_id). If processing fails part-way,
 * the claim is released and the error propagates (the route answers 5xx) so
 * Meta retries; messages already stored are skipped on the retry, and only
 * messages stored for the first time are passed on for a reply.
 *
 * Tenant identity comes only from the connection row matched by the
 * payload's phone_number_id — never from anything else in the payload.
 *
 * A customer's inbound message is never treated as proof of payment,
 * confirmation or anything payment-state-related.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { timingSafeEqual } from "node:crypto";
import { verifyMetaWebhookSignature } from "../meta/meta-webhook-signature.server.ts";
import { recordConsentEvent } from "./whatsapp-consent.server.ts";

type Client = SupabaseClient<Database>;

export function getWhatsAppWebhookVerifyToken(): string | null {
  return process.env["WHATSAPP_WEBHOOK_VERIFY_TOKEN"] ?? null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Meta's GET verification handshake: echo back hub.challenge only if hub.verify_token matches our configured secret. Returns null (caller responds 403) on any mismatch. */
export function verifyWebhookHandshake(params: {
  mode: string | null;
  verifyToken: string | null;
  challenge: string | null;
}): string | null {
  const configuredToken = getWhatsAppWebhookVerifyToken();
  if (!configuredToken) return null;
  if (params.mode !== "subscribe") return null;
  if (params.verifyToken === null || !constantTimeEquals(params.verifyToken, configuredToken)) {
    return null;
  }
  return params.challenge;
}

/** POST authentication (X-Hub-Signature-256 with META_APP_SECRET). Fails closed when the secret isn't configured. */
export function verifyWhatsAppWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  return verifyMetaWebhookSignature(rawBody, signatureHeader, process.env["META_APP_SECRET"]);
}

interface MetaStatusUpdate {
  id?: string;
  status?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string }[];
}
interface MetaInboundMessage {
  id?: string;
  from?: string;
  type?: string;
  timestamp?: string;
  text?: { body?: string };
}
interface MetaWebhookValue {
  metadata?: { phone_number_id?: string };
  statuses?: MetaStatusUpdate[];
  messages?: MetaInboundMessage[];
  contacts?: { profile?: { name?: string }; wa_id?: string }[];
}

/**
 * Which stored statuses each Meta status may replace. Statuses only move
 * forward (queued → sent → delivered → read); "failed" can only replace a
 * status that hasn't reached the customer yet. Meta can deliver them out of
 * order and more than once.
 */
const STATUS_MAY_REPLACE: Record<string, readonly string[]> = {
  sent: ["queued"],
  delivered: ["queued", "sent"],
  read: ["queued", "sent", "delivered"],
  failed: ["queued", "sent"],
};

function mapInboundMessageType(metaType: string | undefined): string {
  switch (metaType) {
    case "text":
    case "image":
    case "audio":
    case "video":
    case "document":
    case "interactive":
    case "template":
      return metaType;
    default:
      return "unsupported";
  }
}

function extractValues(rawBody: string): MetaWebhookValue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  const body = (parsed ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(body["entry"]) ? (body["entry"] as unknown[]) : [];
  const values: MetaWebhookValue[] = [];
  for (const entry of entries) {
    const changes = (entry as Record<string, unknown> | null)?.["changes"];
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as Record<string, unknown> | null)?.["value"];
      if (value && typeof value === "object") values.push(value as MetaWebhookValue);
    }
  }
  return values;
}

async function resolveConnectionByPhoneNumberId(
  supabaseAdmin: Client,
  phoneNumberId: string,
): Promise<{ id: string; organization_id: string; business_id: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_connections")
    .select("id, organization_id, business_id")
    .eq("phone_number_id", phoneNumberId)
    .neq("status", "disconnected")
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** A short, customer-safe failure reason from Meta's status error (never the raw payload). */
function statusErrorMessage(status: MetaStatusUpdate): string | null {
  const first = status.errors?.[0];
  if (!first) return null;
  const code = typeof first.code === "number" ? ` (${first.code})` : "";
  const title = typeof first.title === "string" ? first.title.slice(0, 200) : "Delivery failed";
  return `${title}${code}`;
}

/** Meta's "this user has stopped marketing messages from businesses" delivery error. */
export const META_MARKETING_OPT_OUT_ERROR = 131050;

async function applyStatusUpdate(
  supabaseAdmin: Client,
  connection: { id: string; organization_id: string; business_id: string | null },
  status: MetaStatusUpdate,
): Promise<void> {
  const connectionId = connection.id;
  if (!status.id || !status.status) return;
  const replaceable = STATUS_MAY_REPLACE[status.status];
  if (!replaceable) return; // Unrecognized Meta status — never guess, just skip.
  const update: Database["public"]["Tables"]["whatsapp_messages"]["Update"] = {
    status: status.status,
  };
  if (status.status === "failed") update.error_message = statusErrorMessage(status);
  const { error } = await supabaseAdmin
    .from("whatsapp_messages")
    .update(update)
    .eq("whatsapp_connection_id", connectionId)
    .eq("wa_message_id", status.id)
    .in("status", [...replaceable]);
  if (error) throw error;

  // The customer told WhatsApp they don't want marketing from businesses:
  // record it so no campaign targets them again.
  if (
    status.status === "failed" &&
    status.errors?.some((e) => e.code === META_MARKETING_OPT_OUT_ERROR) &&
    connection.business_id
  ) {
    const waId = status.recipient_id;
    if (waId && /^[1-9]\d{6,14}$/.test(waId)) {
      await recordConsentEvent(supabaseAdmin, {
        organizationId: connection.organization_id,
        businessId: connection.business_id,
        waId,
        scope: "marketing",
        action: "opt_out",
        source: "meta_signal",
        evidence: `meta_error:${META_MARKETING_OPT_OUT_ERROR}:${status.id}`,
      });
    }
  }
}

/** Stores one inbound message. Returns its row id when it was stored for the first time, null when it already existed (a Meta retry). */
async function persistInboundMessage(
  supabaseAdmin: Client,
  connection: { id: string; organization_id: string },
  message: MetaInboundMessage,
  contactName: string | undefined,
): Promise<string | null> {
  if (!message.from || !message.id) return null;

  const { data: conversation, error: convError } = await supabaseAdmin
    .from("whatsapp_conversations")
    .upsert(
      {
        organization_id: connection.organization_id,
        whatsapp_connection_id: connection.id,
        wa_id: message.from,
        customer_display_name: contactName ?? null,
      },
      { onConflict: "whatsapp_connection_id,wa_id", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  if (convError) throw convError;

  const seconds = Number(message.timestamp);
  const occurredAt =
    Number.isFinite(seconds) && seconds > 0
      ? new Date(seconds * 1000).toISOString()
      : new Date().toISOString();
  const text = message.type === "text" ? (message.text?.body ?? null) : null;

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("whatsapp_messages")
    .insert({
      organization_id: connection.organization_id,
      whatsapp_connection_id: connection.id,
      conversation_id: conversation.id,
      wa_message_id: message.id,
      direction: "inbound",
      message_type: mapInboundMessageType(message.type),
      content: text,
      status: "received",
      occurred_at: occurredAt,
    })
    .select("id")
    .single();
  if (insertError) {
    if (insertError.code === "23505") return null; // already stored by an earlier delivery
    throw insertError;
  }

  // The latest inbound message opens Meta's 24-hour customer-service window;
  // a late, out-of-order delivery must not move it backwards.
  const { error: windowError } = await supabaseAdmin
    .from("whatsapp_conversations")
    .update({
      last_inbound_at: occurredAt,
      last_message_at: occurredAt,
      last_message_preview: text?.slice(0, 200) ?? null,
    })
    .eq("id", conversation.id)
    .or(`last_inbound_at.is.null,last_inbound_at.lt."${occurredAt}"`);
  if (windowError) throw windowError;

  return inserted.id;
}

export interface ProcessInboundWebhookResult {
  outcome: "duplicate" | "processed" | "ignored";
  /** Inbound text messages stored for the first time by this delivery — the ones that may get an AI reply. */
  newInboundTextMessageIds: string[];
}

/** Process one already signature-verified webhook delivery. Throws (after releasing its claim) if anything fails, so the caller can ask Meta to retry. */
export async function processInboundWhatsAppWebhook(
  supabaseAdmin: Client,
  input: { rawBody: string; eventId: string },
): Promise<ProcessInboundWebhookResult> {
  const { error: dedupeError } = await supabaseAdmin.from("webhook_events").insert({
    provider: "whatsapp",
    event_id: input.eventId,
    payload: (() => {
      try {
        return JSON.parse(input.rawBody) as Json;
      } catch {
        return { raw: input.rawBody.slice(0, 2000) } as Json;
      }
    })(),
  });
  if (dedupeError) {
    if (dedupeError.code === "23505") return { outcome: "duplicate", newInboundTextMessageIds: [] };
    throw dedupeError;
  }

  const newInboundTextMessageIds: string[] = [];
  let didAnything = false;
  try {
    for (const value of extractValues(input.rawBody)) {
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const connection = await resolveConnectionByPhoneNumberId(supabaseAdmin, phoneNumberId);
      if (!connection) continue;

      for (const status of value.statuses ?? []) {
        await applyStatusUpdate(supabaseAdmin, connection, status);
        didAnything = true;
      }

      for (const message of value.messages ?? []) {
        const contactName = value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name;
        const storedId = await persistInboundMessage(
          supabaseAdmin,
          connection,
          message,
          contactName ?? value.contacts?.[0]?.profile?.name,
        );
        if (storedId && message.type === "text" && message.text?.body) {
          newInboundTextMessageIds.push(storedId);
        }
        didAnything = true;
      }
    }
  } catch (err) {
    // Release the claim so Meta's retry is processed rather than skipped as
    // a duplicate. Messages already stored are idempotent on the retry.
    await supabaseAdmin
      .from("webhook_events")
      .delete()
      .eq("provider", "whatsapp")
      .eq("event_id", input.eventId);
    throw err;
  }

  await supabaseAdmin
    .from("webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("provider", "whatsapp")
    .eq("event_id", input.eventId);

  return { outcome: didAnything ? "processed" : "ignored", newInboundTextMessageIds };
}
