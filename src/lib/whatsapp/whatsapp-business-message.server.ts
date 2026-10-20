/**
 * Business-initiated WhatsApp messages: booking and payment notifications
 * and campaign messages. One path, so every one of them gets the same
 * rules:
 *
 *   1. Only through the business's own connected number (exact
 *      organization + business match — never another business's number).
 *   2. To a valid number (E.164, normalized with the business's country).
 *   3. At most one live message per idempotency key per number: an early
 *      read, and the unique index idx_whatsapp_messages_idempotency_live
 *      for the race (a concurrent sender gets 23505 → skipped_duplicate).
 *   4. Consent (whatsapp-consent.server.ts): never to a suppressed or
 *      opted-out number; marketing only with an explicit opt-in.
 *   5. Inside Meta's 24-hour customer-service window: free-form text.
 *      Outside it: only an APPROVED template — from the number's synced
 *      template registry (purpose mapping), else the
 *      WHATSAPP_TEMPLATE_<PURPOSE>_NAME / _LANGUAGE environment fallback.
 *      A missing template fails explicitly; nothing is ever sent as
 *      free-form text where Meta requires a template, and no template name
 *      is ever invented.
 *   6. Delivery through deliverWhatsAppMessage (timeouts, bounded retries
 *      only when Meta answered 429/5xx, token never logged).
 *
 * Never throws for a delivery problem — the result says what happened and
 * whether trying again later is safe (`retryable`). Database errors do
 * throw, so they aren't mistaken for a decision.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { deliverWhatsAppMessage, type DeliveryDeps } from "./whatsapp-outbound.server.ts";
import { checkSendPermission, toWaId, type ConsentScope } from "./whatsapp-consent.server.ts";

type Client = SupabaseClient<Database>;

const WINDOW_MS = 24 * 60 * 60 * 1000;

export type MessagePurpose =
  | "booking_confirmed"
  | "booking_rescheduled"
  | "booking_cancelled"
  | "booking_reminder"
  | "payment_link"
  | "payment_confirmation"
  | "payment_failed"
  | "payment_expired"
  | "marketing";

export interface BusinessMessageInput {
  organizationId: string;
  businessId: string;
  /** The customer's number as stored (E.164 or national format). */
  customerPhone: string;
  purpose: MessagePurpose;
  scope: ConsentScope;
  idempotencyKey: string;
  /** Free-form text used inside the 24-hour window. */
  bodyText: string;
  /** Body parameters for the template, in order. Defaults to [bodyText]. */
  templateBodyParams?: string[] | undefined;
  /** A specific approved template (campaigns). Otherwise resolved from `purpose`. */
  template?: { name: string; language: string; bodyParamCount: number } | undefined;
  /** Always send the template, even inside the window (campaigns). */
  forceTemplate?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type BusinessMessageResult =
  | { outcome: "sent"; messageRowId: string; waMessageId: string }
  | { outcome: "skipped_duplicate"; existingStatus: string | null }
  | {
      outcome: "skipped";
      reason: "no_connection" | "invalid_phone" | "suppressed" | "opted_out" | "no_consent";
    }
  | { outcome: "failed"; error: string; retryable: boolean; messageRowId?: string | undefined };

interface ResolvedTemplate {
  name: string;
  language: string;
  bodyParamCount: number | null;
}

/** The approved template for a purpose on this number, or the environment fallback. */
export async function resolveTemplateForPurpose(
  supabaseAdmin: Client,
  connectionId: string,
  purpose: MessagePurpose,
): Promise<ResolvedTemplate | null> {
  if (purpose !== "marketing") {
    const { data, error } = await supabaseAdmin
      .from("whatsapp_templates")
      .select("name, language, status, body_param_count")
      .eq("whatsapp_connection_id", connectionId)
      .eq("purpose", purpose)
      .maybeSingle();
    if (error) throw error;
    if (data && data.status === "APPROVED") {
      return { name: data.name, language: data.language, bodyParamCount: data.body_param_count };
    }
    if (data) return null; // mapped, but not (or no longer) approved: don't fall back silently
  }
  const name = process.env[`WHATSAPP_TEMPLATE_${purpose.toUpperCase()}_NAME`];
  if (!name) return null;
  return {
    name,
    language: process.env[`WHATSAPP_TEMPLATE_${purpose.toUpperCase()}_LANGUAGE`] || "en_US",
    bodyParamCount: null,
  };
}

async function latestInboundAt(
  supabaseAdmin: Client,
  conversation: { id: string; last_inbound_at: string | null },
): Promise<number | null> {
  if (conversation.last_inbound_at) return new Date(conversation.last_inbound_at).getTime();
  // Conversations from before last_inbound_at existed: read the messages.
  const { data, error } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("occurred_at")
    .eq("conversation_id", conversation.id)
    .eq("direction", "inbound")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? new Date(data.occurred_at).getTime() : null;
}

export async function sendBusinessWhatsAppMessage(
  supabaseAdmin: Client,
  input: BusinessMessageInput,
  deps: DeliveryDeps = {},
): Promise<BusinessMessageResult> {
  const now = (deps.now ?? (() => new Date()))();

  const { data: connection, error: connError } = await supabaseAdmin
    .from("whatsapp_connections")
    .select("id, organization_id, business_id, phone_number_id, access_token_ciphertext, status")
    .eq("organization_id", input.organizationId)
    .eq("business_id", input.businessId)
    .eq("status", "connected")
    .maybeSingle();
  if (connError) throw connError;
  if (!connection) return { outcome: "skipped", reason: "no_connection" };

  const { data: business, error: businessError } = await supabaseAdmin
    .from("businesses")
    .select("country")
    .eq("id", input.businessId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (businessError) throw businessError;
  const waId = toWaId(input.customerPhone, business?.country ?? null);
  if (!waId) return { outcome: "skipped", reason: "invalid_phone" };

  const { data: existing, error: dupError } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("id, status")
    .eq("whatsapp_connection_id", connection.id)
    .eq("metadata->>idempotency_key", input.idempotencyKey)
    .in("status", ["queued", "sent", "delivered", "read"])
    .limit(1)
    .maybeSingle();
  if (dupError) throw dupError;
  if (existing) return { outcome: "skipped_duplicate", existingStatus: existing.status };

  const permission = await checkSendPermission(supabaseAdmin, input.businessId, waId, input.scope);
  if (!permission.allowed) return { outcome: "skipped", reason: permission.reason };

  const { data: conversation, error: convError } = await supabaseAdmin
    .from("whatsapp_conversations")
    .upsert(
      {
        organization_id: input.organizationId,
        whatsapp_connection_id: connection.id,
        wa_id: waId,
      },
      { onConflict: "whatsapp_connection_id,wa_id", ignoreDuplicates: false },
    )
    .select("id, last_inbound_at")
    .single();
  if (convError) throw convError;

  const inboundAt = await latestInboundAt(supabaseAdmin, conversation);
  const inWindow = inboundAt !== null && now.getTime() - inboundAt < WINDOW_MS;
  const useTemplate = Boolean(input.forceTemplate) || !inWindow;

  const metadata = {
    ...(input.metadata ?? {}),
    purpose: input.purpose,
    idempotency_key: input.idempotencyKey,
  };
  const baseRow = {
    organization_id: input.organizationId,
    whatsapp_connection_id: connection.id,
    conversation_id: conversation.id,
    direction: "outbound",
    content: input.bodyText,
    metadata: metadata as Json,
  };

  let template: ResolvedTemplate | null = null;
  if (useTemplate) {
    template =
      input.template ??
      (await resolveTemplateForPurpose(supabaseAdmin, connection.id, input.purpose));
    const params = input.templateBodyParams ?? [input.bodyText];
    const problem = !template
      ? `A Message Template is required outside the 24h window, but none is approved/configured for "${input.purpose}" (sync templates and map one, or set WHATSAPP_TEMPLATE_${input.purpose.toUpperCase()}_NAME).`
      : template.bodyParamCount !== null && template.bodyParamCount !== params.length
        ? `Template "${template.name}" expects ${template.bodyParamCount} body parameter(s); this message has ${params.length}.`
        : null;
    if (problem) {
      // Recorded on a failed row so staff see it in the conversation.
      await supabaseAdmin
        .from("whatsapp_messages")
        .insert({ ...baseRow, message_type: "template", status: "failed", error_message: problem });
      return { outcome: "failed", error: problem, retryable: false };
    }
  }

  const { data: row, error: insertError } = await supabaseAdmin
    .from("whatsapp_messages")
    .insert({ ...baseRow, message_type: useTemplate ? "template" : "text", status: "queued" })
    .select("id")
    .single();
  if (insertError) {
    if (insertError.code === "23505") return { outcome: "skipped_duplicate", existingStatus: null };
    throw insertError;
  }

  const result = await deliverWhatsAppMessage(
    supabaseAdmin,
    {
      messageRowId: row.id,
      connection,
      to: waId,
      payload: useTemplate
        ? {
            kind: "template",
            name: template!.name,
            languageCode: template!.language,
            bodyParams: input.templateBodyParams ?? [input.bodyText],
          }
        : { kind: "text", body: input.bodyText },
    },
    deps,
  );
  if (result.outcome === "failed") {
    return {
      outcome: "failed",
      error: result.error,
      retryable: result.retryable,
      messageRowId: row.id,
    };
  }
  await supabaseAdmin
    .from("whatsapp_conversations")
    .update({
      last_message_at: now.toISOString(),
      last_message_preview: input.bodyText.slice(0, 200),
    })
    .eq("id", conversation.id);
  return { outcome: "sent", messageRowId: row.id, waMessageId: result.waMessageId };
}
