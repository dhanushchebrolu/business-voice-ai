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
import { sendWhatsAppPaymentMessage } from "../whatsapp/whatsapp-payments.server.ts";
import type { PaymentDomainEventRow } from "./payment-events.server.ts";

type Client = SupabaseClient<Database>;

function formatAmount(amountMinorUnits: number, currency: string): string {
  const major = (amountMinorUnits / 100).toFixed(2);
  return `${currency} ${major}`;
}

export async function handlePaymentEventForWhatsApp(
  supabaseAdmin: Client,
  event: PaymentDomainEventRow,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const { data: booking, error: bookingError } = await supabaseAdmin
    .from("bookings")
    .select("id, customer_phone, start_at, timezone")
    .eq("id", event.booking_id)
    .maybeSingle();
  if (bookingError) throw bookingError;
  if (!booking?.customer_phone) return; // No phone on file — nothing to send to; not an error.

  const { data: paymentRequest, error: prError } = await supabaseAdmin
    .from("payment_requests")
    .select("amount_minor_units, currency, payment_link_url")
    .eq("id", event.payment_request_id)
    .maybeSingle();
  if (prError) throw prError;
  if (!paymentRequest) return;

  const amountText = formatAmount(paymentRequest.amount_minor_units, paymentRequest.currency);
  const when = new Date(booking.start_at).toLocaleString("en-IN", { timeZone: booking.timezone });

  let purpose: "payment_confirmation" | "payment_failed" | "payment_expired";
  let bodyText: string;

  switch (event.event_type) {
    case "PAYMENT_CAPTURED":
      purpose = "payment_confirmation";
      bodyText = `Payment received! Your booking for ${when} is confirmed. Amount paid: ${amountText}. Thank you!`;
      break;
    case "PAYMENT_CAPTURED_AFTER_EXPIRY":
      // Money moved, but the hold is gone — never silently claim the
      // booking is confirmed here (spec: never confirm an expired/
      // cancelled booking from a late webhook).
      purpose = "payment_confirmation";
      bodyText = `We received your payment of ${amountText}, but your booking hold had already expired. We'll contact you shortly to confirm a new time or arrange a refund — sorry for the inconvenience.`;
      break;
    case "PAYMENT_FAILED":
      purpose = "payment_failed";
      bodyText = paymentRequest.payment_link_url
        ? `Your payment attempt didn't go through. You can try again here: ${paymentRequest.payment_link_url}`
        : `Your payment attempt didn't go through. Please contact us to try again.`;
      break;
    case "PAYMENT_EXPIRED":
      purpose = "payment_expired";
      bodyText = `Your payment link for the ${when} booking has expired and the hold was released. Please contact us if you'd still like to book.`;
      break;
    default:
      return;
  }

  await sendWhatsAppPaymentMessage(
    supabaseAdmin,
    {
      organizationId: event.organization_id,
      businessId: event.business_id,
      bookingId: event.booking_id,
      paymentRequestId: event.payment_request_id,
      customerPhone: booking.customer_phone,
      purpose,
      bodyText,
    },
    fetchImpl,
  );
}
