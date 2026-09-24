/**
 * WhatsApp payment-messaging orchestration (Phase 4) — the minimum
 * production-ready infrastructure the payment flow needs: payment-link
 * delivery, capture/failure/expiration notifications. Deliberately NOT a
 * general WhatsApp AI chatbot — this module only ever sends a small,
 * fixed set of payment-related messages; it never generates a reply from
 * an LLM and never reads an inbound conversational message.
 *
 * CRITICAL: WhatsApp delivery is never payment truth. Every function here
 * is called AFTER a payment state transition has already been durably
 * recorded (payment_requests.status, a payment_domain_events row) — a
 * send failure here only ever affects whatsapp_messages.status, never
 * payment_requests/bookings. Callers (the payment_domain_events
 * consumers) must never let a WhatsApp failure roll back or block payment
 * state, which is why every function below returns a result object
 * instead of throwing on a delivery failure — the one exception is a
 * genuine programming/database error (not a delivery failure), which
 * does throw so it isn't silently swallowed.
 *
 * 24-hour window: WhatsApp's Cloud API only allows free-form text
 * messages within 24 hours of the customer's last INBOUND message to this
 * number; outside that window, Meta requires a pre-approved Message
 * Template. A voice-originated booking has typically never had an inbound
 * WhatsApp message at all, so the template path is the common case here,
 * not free-form text. Template names/languages are read from env vars
 * (WHATSAPP_TEMPLATE_<PURPOSE>_NAME / _LANGUAGE) — if a template is
 * required and none is configured, this fails explicitly (a clear
 * last_error on the message row) rather than attempting a free-form send
 * Meta would reject anyway, and rather than fabricating a template name.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { MetaWhatsAppClient, MetaApiError } from "./meta-client.server.ts";
import { resolveMetaWhatsAppConfig } from "./meta-config.server.ts";
import { decryptCredential, CredentialCryptoError } from "./whatsapp-token-crypto.server.ts";

type Client = SupabaseClient<Database>;

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export type PaymentMessagePurpose =
  "payment_link" | "payment_confirmation" | "payment_failed" | "payment_expired";

export interface SendPaymentMessageInput {
  organizationId: string;
  businessId: string;
  bookingId: string;
  paymentRequestId: string;
  customerPhone: string;
  purpose: PaymentMessagePurpose;
  /** Free-form message body — used verbatim when the conversation is within the 24h window; also supplied as the template's single body parameter when a template send is required (see the module doc comment). */
  bodyText: string;
}

export type SendPaymentMessageOutcome =
  "sent" | "skipped_no_connection" | "skipped_duplicate" | "failed";

export interface SendPaymentMessageResult {
  outcome: SendPaymentMessageOutcome;
  error?: string;
}

function resolveTemplateName(purpose: PaymentMessagePurpose): string | undefined {
  return process.env[`WHATSAPP_TEMPLATE_${purpose.toUpperCase()}_NAME`] || undefined;
}
function resolveTemplateLanguage(purpose: PaymentMessagePurpose): string {
  return process.env[`WHATSAPP_TEMPLATE_${purpose.toUpperCase()}_LANGUAGE`] || "en_US";
}

/** Resolves the business's connected, usable WhatsApp number. Requires an exact business_id match — never falls back to a different business's connection (tenant isolation). */
async function resolveConnection(
  supabaseAdmin: Client,
  organizationId: string,
  businessId: string,
): Promise<{
  id: string;
  phone_number_id: string;
  access_token_ciphertext: string | null;
} | null> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_connections")
    .select("id, phone_number_id, access_token_ciphertext")
    .eq("organization_id", organizationId)
    .eq("business_id", businessId)
    .eq("status", "connected")
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function resolveOrCreateConversation(
  supabaseAdmin: Client,
  organizationId: string,
  connectionId: string,
  waId: string,
): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_conversations")
    .upsert(
      { organization_id: organizationId, whatsapp_connection_id: connectionId, wa_id: waId },
      { onConflict: "whatsapp_connection_id,wa_id", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/** Within Meta's 24-hour customer-service window only if the customer has sent an inbound message to this number within the last 24 hours. No prior inbound message (the common case for a voice-originated booking) means a template is required. */
async function isWithinFreeformWindow(
  supabaseAdmin: Client,
  conversationId: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("occurred_at")
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  return Date.now() - new Date(data.occurred_at).getTime() < TWENTY_FOUR_HOURS_MS;
}

async function findDuplicateMessage(
  supabaseAdmin: Client,
  connectionId: string,
  idempotencyKey: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("id")
    .eq("whatsapp_connection_id", connectionId)
    .eq("metadata->>idempotency_key", idempotencyKey)
    .in("status", ["queued", "sent", "delivered", "read"])
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/**
 * Sends one payment-related WhatsApp message, if a connected number exists
 * for this business and no equivalent message has already been sent for
 * this exact (purpose, payment_request_id) pair. Never throws on a
 * delivery failure — the caller (a payment_domain_events consumer) must
 * be able to complete its own dispatch bookkeeping regardless of whether
 * the message actually reached WhatsApp.
 */
export async function sendWhatsAppPaymentMessage(
  supabaseAdmin: Client,
  input: SendPaymentMessageInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SendPaymentMessageResult> {
  const connection = await resolveConnection(supabaseAdmin, input.organizationId, input.businessId);
  if (!connection) return { outcome: "skipped_no_connection" };

  const idempotencyKey = `${input.purpose}:${input.paymentRequestId}`;
  if (await findDuplicateMessage(supabaseAdmin, connection.id, idempotencyKey)) {
    return { outcome: "skipped_duplicate" };
  }

  const conversationId = await resolveOrCreateConversation(
    supabaseAdmin,
    input.organizationId,
    connection.id,
    input.customerPhone,
  );

  const useTemplate = !(await isWithinFreeformWindow(supabaseAdmin, conversationId));
  const templateName = useTemplate ? resolveTemplateName(input.purpose) : undefined;
  if (useTemplate && !templateName) {
    await supabaseAdmin.from("whatsapp_messages").insert({
      organization_id: input.organizationId,
      whatsapp_connection_id: connection.id,
      conversation_id: conversationId,
      direction: "outbound",
      message_type: "template",
      content: input.bodyText,
      status: "failed",
      error_message: `A Message Template is required outside the 24h window, but WHATSAPP_TEMPLATE_${input.purpose.toUpperCase()}_NAME is not configured.`,
      metadata: {
        purpose: input.purpose,
        idempotency_key: idempotencyKey,
        booking_id: input.bookingId,
        payment_request_id: input.paymentRequestId,
      },
    });
    return { outcome: "failed", error: "template_not_configured" };
  }

  const { data: queuedRow, error: insertError } = await supabaseAdmin
    .from("whatsapp_messages")
    .insert({
      organization_id: input.organizationId,
      whatsapp_connection_id: connection.id,
      conversation_id: conversationId,
      direction: "outbound",
      message_type: useTemplate ? "template" : "text",
      content: input.bodyText,
      status: "queued",
      metadata: {
        purpose: input.purpose,
        idempotency_key: idempotencyKey,
        booking_id: input.bookingId,
        payment_request_id: input.paymentRequestId,
      },
    })
    .select("id")
    .single();
  if (insertError) throw insertError;

  const config = resolveMetaWhatsAppConfig();
  if (!config) {
    await supabaseAdmin
      .from("whatsapp_messages")
      .update({ status: "failed", error_message: "WhatsApp is not configured on this deployment." })
      .eq("id", queuedRow.id);
    return { outcome: "failed", error: "not_configured" };
  }

  let accessToken: string;
  try {
    if (!connection.access_token_ciphertext)
      throw new CredentialCryptoError("No credential stored.");
    accessToken = decryptCredential(connection.access_token_ciphertext);
  } catch {
    await supabaseAdmin
      .from("whatsapp_messages")
      .update({
        status: "failed",
        error_message: "Could not decrypt the stored WhatsApp credential.",
      })
      .eq("id", queuedRow.id);
    return { outcome: "failed", error: "credential_error" };
  }

  const client = new MetaWhatsAppClient({
    appId: config.appId,
    appSecret: config.appSecret,
    graphApiVersion: config.graphApiVersion,
    fetchImpl,
  });

  try {
    const result = useTemplate
      ? await client.sendTemplateMessage(
          connection.phone_number_id,
          input.customerPhone,
          templateName!,
          resolveTemplateLanguage(input.purpose),
          [input.bodyText],
          accessToken,
        )
      : await client.sendTextMessage(
          connection.phone_number_id,
          input.customerPhone,
          input.bodyText,
          accessToken,
        );
    await supabaseAdmin
      .from("whatsapp_messages")
      .update({ status: "sent", wa_message_id: result.messageId })
      .eq("id", queuedRow.id);
    return { outcome: "sent" };
  } catch (err) {
    const message = err instanceof MetaApiError ? err.message : "Unknown WhatsApp send error.";
    await supabaseAdmin
      .from("whatsapp_messages")
      .update({ status: "failed", error_message: message })
      .eq("id", queuedRow.id);
    return { outcome: "failed", error: message };
  }
}
