/**
 * Inbound Meta WhatsApp webhook processing — the minimum this codebase
 * needs and no more (spec: "do not build a complete WhatsApp AI chatbot
 * implementation unless genuinely required by the payment flow"):
 *
 *   1. Delivery-status updates (sent/delivered/read/failed) for messages
 *      THIS codebase sent — updates whatsapp_messages.status. This is
 *      purely observational; it never touches payment/booking state.
 *   2. Inbound customer messages are PERSISTED (whatsapp_conversations/
 *      whatsapp_messages) but NEVER given an AI-generated reply. Persisting
 *      them is not scope creep — whatsapp-payments.server.ts's 24-hour
 *      free-form-messaging-window check depends on knowing when a
 *      customer last messaged this number, so without this, every payment
 *      notification would incorrectly require a template.
 *
 * A customer's inbound WhatsApp message is NEVER treated as proof of
 * payment, confirmation, or anything payment-state-related — this module
 * has no code path that reads message content to affect payment_requests
 * or bookings in any way.
 *
 * Payload shape caveat: same network-egress constraint as
 * meta-client.server.ts (no live fetch of developers.facebook.com in this
 * session) — the top-level webhook envelope shape
 * (`entry[].changes[].value.{messages[],statuses[],metadata}`) is Meta's
 * long-stable, extensively documented Cloud API webhook format,
 * corroborated the same way meta-client.server.ts's other endpoints were.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

export function getWhatsAppWebhookVerifyToken(): string | null {
  return process.env["WHATSAPP_WEBHOOK_VERIFY_TOKEN"] ?? null;
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
  if (params.verifyToken !== configuredToken) return null;
  return params.challenge;
}

interface MetaStatusUpdate {
  id?: string;
  status?: string;
  recipient_id?: string;
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

const META_STATUS_TO_OUR_STATUS: Record<string, string> = {
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
};

/** Maps Meta's inbound message `type` to our own message_type CHECK values, defaulting to 'unsupported' rather than inventing a value the schema doesn't allow. */
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
    const changes = (entry as Record<string, unknown>)?.["changes"];
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as Record<string, unknown>)?.["value"];
      if (value && typeof value === "object") values.push(value as MetaWebhookValue);
    }
  }
  return values;
}

async function resolveConnectionIdByPhoneNumberId(
  supabaseAdmin: Client,
  phoneNumberId: string,
): Promise<{ id: string; organization_id: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_connections")
    .select("id, organization_id")
    .eq("phone_number_id", phoneNumberId)
    .neq("status", "disconnected")
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function applyStatusUpdate(supabaseAdmin: Client, status: MetaStatusUpdate): Promise<void> {
  if (!status.id || !status.status) return;
  const ourStatus = META_STATUS_TO_OUR_STATUS[status.status];
  if (!ourStatus) return; // Unrecognized Meta status — never guess, just skip.
  // Idempotent by construction: setting the same status twice is a no-op,
  // and Meta statuses only ever move forward (sent -> delivered -> read),
  // so no ordering guard is needed for this observational-only field.
  await supabaseAdmin
    .from("whatsapp_messages")
    .update({ status: ourStatus })
    .eq("wa_message_id", status.id);
}

async function persistInboundMessage(
  supabaseAdmin: Client,
  connection: { id: string; organization_id: string },
  message: MetaInboundMessage,
  contactName: string | undefined,
): Promise<void> {
  if (!message.from) return;

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

  const occurredAt = message.timestamp
    ? new Date(Number(message.timestamp) * 1000).toISOString()
    : new Date().toISOString();

  // Idempotent via whatsapp_messages' own partial unique index on
  // (whatsapp_connection_id, wa_message_id) — a redelivered webhook for
  // the same inbound message is a silent no-op, never a duplicate row.
  const { error: insertError } = await supabaseAdmin.from("whatsapp_messages").insert({
    organization_id: connection.organization_id,
    whatsapp_connection_id: connection.id,
    conversation_id: conversation.id,
    wa_message_id: message.id ?? null,
    direction: "inbound",
    message_type: mapInboundMessageType(message.type),
    content: message.type === "text" ? (message.text?.body ?? null) : null,
    status: "received",
    occurred_at: occurredAt,
  });
  if (insertError && insertError.code !== "23505") throw insertError;

  await supabaseAdmin
    .from("whatsapp_conversations")
    .update({
      last_message_at: occurredAt,
      last_message_preview:
        message.type === "text" ? (message.text?.body?.slice(0, 200) ?? null) : null,
    })
    .eq("id", conversation.id);
}

export interface ProcessInboundWebhookResult {
  outcome: "duplicate" | "processed" | "ignored";
}

/**
 * Processes one already-received WhatsApp webhook POST body. Idempotency
 * for the whole batch uses the existing, provider-generic webhook_events
 * table (provider='whatsapp') — the Phase 1 migration's own header
 * comment already documented this exact convention before this module
 * was written, so it's reused here rather than a new table being
 * introduced. Per-item idempotency (individual messages/statuses) is
 * additionally handled by whatsapp_messages' own constraints, exactly as
 * that migration's own comment describes ("defense-in-depth alongside
 * the outer webhook_events(provider, event_id) dedupe").
 */
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
    if (dedupeError.code === "23505") return { outcome: "duplicate" };
    throw dedupeError;
  }

  const values = extractValues(input.rawBody);
  let didAnything = false;

  for (const value of values) {
    const phoneNumberId = value.metadata?.phone_number_id;
    if (!phoneNumberId) continue;
    const connection = await resolveConnectionIdByPhoneNumberId(supabaseAdmin, phoneNumberId);
    if (!connection) continue;

    for (const status of value.statuses ?? []) {
      await applyStatusUpdate(supabaseAdmin, status);
      didAnything = true;
    }

    const contactName = value.contacts?.[0]?.profile?.name;
    for (const message of value.messages ?? []) {
      await persistInboundMessage(supabaseAdmin, connection, message, contactName);
      didAnything = true;
    }
  }

  await supabaseAdmin
    .from("webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("provider", "whatsapp")
    .eq("event_id", input.eventId);

  return { outcome: didAnything ? "processed" : "ignored" };
}
