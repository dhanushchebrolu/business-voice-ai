/**
 * PaymentCaptured/Failed/Expired -> WhatsApp notification consumer. Reads
 * whatever the booking/payment_request rows say NOW (not the domain
 * event's own payload) so the message always reflects current, durable
 * state. Composes a fixed, purpose-specific message per event type and
 * delegates the actual send to whatsapp-payments.server.ts, which already
 * owns every WhatsApp-specific concern (connection lookup, 24h window,
 * idempotency, delivery-failure handling). This file adds no new
 * WhatsApp API logic — it only decides WHAT to say and WHEN.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  sendWhatsAppPaymentMessage,
  type PaymentMessagePurpose,
} from "../whatsapp/whatsapp-payments.server.ts";
import type { PaymentDomainEventRow } from "./payment-events.server.ts";

type Client = SupabaseClient<Database>;

function formatAmount(amountMinorUnits: number, currency: string): string {
  const major = (amountMinorUnits / 100).toFixed(2);
  return `${currency} ${major}`;
}

export interface PaymentNotification {
  purpose: PaymentMessagePurpose;
  bodyText: string;
  customerPhone: string;
}

/**
 * What to tell the customer for a payment event, from the booking and
 * payment_request rows as they are NOW. Null when there's nothing to send
 * (no phone on file, no payment request, an unknown event type). Shared by
 * the in-process consumer below and the notification worker's recovery
 * path, so both always say the same thing.
 */
export async function composePaymentNotification(
  supabaseAdmin: Client,
  event: Pick<PaymentDomainEventRow, "event_type" | "booking_id" | "payment_request_id">,
): Promise<PaymentNotification | null> {
  const { data: booking, error: bookingError } = await supabaseAdmin
    .from("bookings")
    .select("id, customer_phone, start_at, timezone")
    .eq("id", event.booking_id)
    .maybeSingle();
  if (bookingError) throw bookingError;
  if (!booking?.customer_phone) return null; // No phone on file — nothing to send to; not an error.

  const { data: paymentRequest, error: prError } = await supabaseAdmin
    .from("payment_requests")
    .select("amount_minor_units, currency, payment_link_url")
    .eq("id", event.payment_request_id)
    .maybeSingle();
  if (prError) throw prError;
  if (!paymentRequest) return null;

  const amountText = formatAmount(paymentRequest.amount_minor_units, paymentRequest.currency);
  const when = new Date(booking.start_at).toLocaleString("en-IN", { timeZone: booking.timezone });

  switch (event.event_type) {
    case "PAYMENT_CAPTURED":
      return {
        purpose: "payment_confirmation",
        customerPhone: booking.customer_phone,
        bodyText: `Payment received! Your booking for ${when} is confirmed. Amount paid: ${amountText}. Thank you!`,
      };
    case "PAYMENT_CAPTURED_AFTER_EXPIRY":
      // Money moved, but the hold is gone — never silently claim the
      // booking is confirmed here (spec: never confirm an expired/
      // cancelled booking from a late webhook).
      return {
        purpose: "payment_confirmation",
        customerPhone: booking.customer_phone,
        bodyText: `We received your payment of ${amountText}, but your booking hold had already expired. We'll contact you shortly to confirm a new time or arrange a refund — sorry for the inconvenience.`,
      };
    case "PAYMENT_FAILED":
      return {
        purpose: "payment_failed",
        customerPhone: booking.customer_phone,
        bodyText: paymentRequest.payment_link_url
          ? `Your payment attempt didn't go through. You can try again here: ${paymentRequest.payment_link_url}`
          : `Your payment attempt didn't go through. Please contact us to try again.`,
      };
    case "PAYMENT_EXPIRED":
      return {
        purpose: "payment_expired",
        customerPhone: booking.customer_phone,
        bodyText: `Your payment link for the ${when} booking has expired and the hold was released. Please contact us if you'd still like to book.`,
      };
    default:
      return null;
  }
}

/**
 * The in-process consumer (fast path). A failed send throws, so the domain
 * event row records whatsapp_error instead of a misleading
 * whatsapp_dispatched_at; the notification outbox (enqueued by a trigger
 * on payment_domain_events) retries it, and the per-(purpose, payment
 * request) idempotency key keeps that to one message.
 */
export async function handlePaymentEventForWhatsApp(
  supabaseAdmin: Client,
  event: PaymentDomainEventRow,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const notification = await composePaymentNotification(supabaseAdmin, event);
  if (!notification) return;
  const result = await sendWhatsAppPaymentMessage(
    supabaseAdmin,
    {
      organizationId: event.organization_id,
      businessId: event.business_id,
      bookingId: event.booking_id,
      paymentRequestId: event.payment_request_id,
      customerPhone: notification.customerPhone,
      purpose: notification.purpose,
      bodyText: notification.bodyText,
    },
    fetchImpl,
  );
  if (result.outcome === "failed") {
    throw new Error(`WhatsApp notification not delivered: ${result.error ?? "unknown error"}`);
  }
}
