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
 * not free-form text. The template comes from the number's synced
 * template registry (purpose mapping) or the WHATSAPP_TEMPLATE_<PURPOSE>_
 * NAME / _LANGUAGE environment fallback — if a template is required and
 * none is approved/configured, this fails explicitly (a failed message
 * row with the reason) rather than attempting a free-form send Meta would
 * reject anyway, and rather than fabricating a template name.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { sendBusinessWhatsAppMessage } from "./whatsapp-business-message.server.ts";

type Client = SupabaseClient<Database>;

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
  "sent" | "skipped_no_connection" | "skipped_duplicate" | "skipped_not_permitted" | "failed";

export interface SendPaymentMessageResult {
  outcome: SendPaymentMessageOutcome;
  error?: string;
  /** For a failure: whether trying again later is safe (Meta did not accept the message). */
  retryable?: boolean;
  /** For skipped_duplicate: the existing message's status ('queued' = still in flight or outcome unknown). */
  existingStatus?: string | null;
  /** For a failure: the sender's code (e.g. template_missing, template_not_approved). */
  code?: string;
  /** For skipped_not_permitted: why (invalid_phone, suppressed, opted_out, notifications_disabled, no_consent_basis). */
  reason?: string;
}

/** The customer-facing text of a payment-link message (shared by request_payment and the notification worker). */
export function paymentLinkMessageText(paymentLinkUrl: string | null): string {
  return paymentLinkUrl
    ? `Please complete your payment here: ${paymentLinkUrl}`
    : "We are preparing your payment link and will send it shortly.";
}

/**
 * Sends one payment-related WhatsApp message through the shared
 * business-message path (whatsapp-business-message.server.ts: connection
 * scoping, consent and suppression, the 24h window and templates,
 * at-most-once per (purpose, payment_request_id), bounded delivery
 * retries). Never throws on a delivery failure — the caller (a
 * payment_domain_events consumer, or the notification worker) must be able
 * to complete its own bookkeeping regardless of whether the message
 * actually reached WhatsApp.
 */
export async function sendWhatsAppPaymentMessage(
  supabaseAdmin: Client,
  input: SendPaymentMessageInput,
  fetchImpl: typeof fetch = fetch,
): Promise<SendPaymentMessageResult> {
  const result = await sendBusinessWhatsAppMessage(
    supabaseAdmin,
    {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerPhone: input.customerPhone,
      purpose: input.purpose,
      scope: "transactional",
      idempotencyKey: `${input.purpose}:${input.paymentRequestId}`,
      bodyText: input.bodyText,
      metadata: { booking_id: input.bookingId, payment_request_id: input.paymentRequestId },
    },
    { fetchImpl },
  );
  switch (result.outcome) {
    case "sent":
      return { outcome: "sent" };
    case "skipped_duplicate":
      return { outcome: "skipped_duplicate", existingStatus: result.existingStatus };
    case "skipped":
      return result.reason === "no_connection"
        ? { outcome: "skipped_no_connection" }
        : { outcome: "skipped_not_permitted", reason: result.reason };
    case "failed":
      return {
        outcome: "failed",
        code: result.code,
        error: result.error,
        retryable: result.retryable,
      };
  }
}
