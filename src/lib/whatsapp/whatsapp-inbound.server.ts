/**
 * Inbound WhatsApp webhook processing (deliveries from Vobiz, ClickAI's BSP):
 *
 *   1. Authentication: every POST must carry a valid X-Webhook-Signature
 *      (hex HMAC-SHA256 of the raw body with VOBIZ_WHATSAPP_WEBHOOK_SECRET) —
 *      verified by the route before anything is parsed or stored
 *      (vobiz-webhook.server.ts).
 *   2. Delivery-status updates (sent/delivered/read/failed, `message.status`)
 *      for messages this codebase sent — scoped to the connection the
 *      payload names and never moved backwards (a late "delivered" can't
 *      undo "read").
 *   3. Inbound customer messages (`message.inbound`) are persisted
 *      (whatsapp_conversations/whatsapp_messages); the ids of NEW inbound
 *      text messages are returned so the route can hand them to the AI reply
 *      worker (whatsapp-ai-reply.server.ts) without blocking the
 *      acknowledgement.
 *
 * Idempotency: the delivery's `event_id` is claimed in webhook_events
 * (provider='vobiz_whatsapp') and each message is unique per (connection,
 * wa_message_id). If processing fails part-way, the claim is released and
 * the error propagates (the route answers 5xx) so Vobiz retries; messages
 * already stored are skipped on the retry, and only messages stored for the
 * first time are passed on for a reply.
 *
 * Tenant identity comes only from the connection row matched by the
 * payload's phone_number_id — never from anything else in the payload.
 *
 * A customer's inbound message is never treated as proof of payment,
 * confirmation or anything payment-state-related.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { consentEventTime, recordConsentEvent } from "./whatsapp-consent.server.ts";
import { parseVobizWebhookEnvelope } from "./vobiz-webhook.server.ts";

type Client = SupabaseClient<Database>;

/** The provider name under which Vobiz deliveries are claimed in webhook_events. */
export const VOBIZ_WEBHOOK_PROVIDER = "vobiz_whatsapp";

interface MetaStatusUpdate {
  id?: string;
  status?: string;
  recipient_id?: string;
  timestamp?: string;
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
        occurredAt: consentEventTime(status.timestamp, new Date()),
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

/**
 * Process one already signature-verified Vobiz delivery
 * (vobiz-webhook.server.ts). The envelope's `event_id` is claimed in
 * webhook_events, so a redelivery is a duplicate; each message is also
 * unique per (connection, wa_message_id), so the same message in another
 * event is stored once. Only `message.inbound` and `message.status` carry
 * WhatsApp data; other events (`call.*`) are acknowledged and ignored.
 * Throws (after releasing the claim) if anything fails, so the caller can
 * answer 5xx and Vobiz retries.
 */
export async function processVobizWhatsAppWebhook(
  supabaseAdmin: Client,
  input: { rawBody: string },
): Promise<ProcessInboundWebhookResult & { eventType: string | null }> {
  const envelope = parseVobizWebhookEnvelope(input.rawBody);
  if (!envelope) return { outcome: "ignored", newInboundTextMessageIds: [], eventType: null };
  if (envelope.eventType !== "message.inbound" && envelope.eventType !== "message.status") {
    return { outcome: "ignored", newInboundTextMessageIds: [], eventType: envelope.eventType };
  }
  const result = await processWhatsAppWebhookValues(supabaseAdmin, {
    provider: VOBIZ_WEBHOOK_PROVIDER,
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    payload: envelope.payload as Json,
    values: [envelope.payload as MetaWebhookValue],
  });
  return { ...result, eventType: envelope.eventType };
}

/** Claims the event, then applies each WhatsApp Cloud API change value (statuses, then messages). */
async function processWhatsAppWebhookValues(
  supabaseAdmin: Client,
  input: {
    provider: string;
    eventId: string;
    eventType: string;
    payload: Json;
    values: MetaWebhookValue[];
  },
): Promise<ProcessInboundWebhookResult> {
  const { error: dedupeError } = await supabaseAdmin.from("webhook_events").insert({
    provider: input.provider,
    event_id: input.eventId,
    event_type: input.eventType,
    payload: input.payload,
  });
  if (dedupeError) {
    if (dedupeError.code === "23505") return { outcome: "duplicate", newInboundTextMessageIds: [] };
    throw dedupeError;
  }

  const newInboundTextMessageIds: string[] = [];
  let didAnything = false;
  try {
    for (const value of input.values) {
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
    // Release the claim so Vobiz's retry is processed rather than skipped as
    // a duplicate. Messages already stored are idempotent on the retry.
    await supabaseAdmin
      .from("webhook_events")
      .delete()
      .eq("provider", input.provider)
      .eq("event_id", input.eventId);
    throw err;
  }

  await supabaseAdmin
    .from("webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("provider", input.provider)
    .eq("event_id", input.eventId);

  return { outcome: didAnything ? "processed" : "ignored", newInboundTextMessageIds };
}
