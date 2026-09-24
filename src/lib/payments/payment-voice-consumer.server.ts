/**
 * PaymentCaptured/Failed/Expired -> voice notification consumer — the
 * "voice" slot in payment-events.server.ts's DispatchConsumers.
 *
 * Full event architecture, per spec: Razorpay webhook -> verification ->
 * database transition -> PaymentCaptured domain event -> event consumers
 * -> ... -> voice-session consumer (this file). The webhook NEVER calls
 * the AI/voice runtime directly — this consumer is the only bridge, and
 * it only ever composes a message and hands it to
 * voice-runtime.server.ts's injectPaymentEvent(), which owns all runtime
 * state/timer mechanics. This file has no knowledge of RuntimeState.
 *
 * Reaches the live call the same way telephony-runtime.ts's own
 * routeToAgentRuntime/terminateAgentRuntime do: via the
 * CallSessionDurableObject RPC surface when the CALL_SESSION binding is
 * configured (production), falling back to calling
 * voice-runtime.server.ts directly when it isn't (local dev/tests,
 * everything in one process) — same fallback convention, not a new one.
 *
 * Ended-call fallback: if the booking never had a call_id, the DO/direct
 * call reports {handled:false} (no active session), or the DO itself is
 * unreachable in a way that clearly means "there is nothing to notify"
 * (never found), this consumer returns normally rather than throwing —
 * payment/booking truth already does not depend on this, and the
 * WhatsApp consumer (a separate, independently-dispatched slot) still
 * delivers its own confirmation regardless. A genuine delivery failure
 * (the DO reachable but erroring) DOES throw, so dispatchPaymentDomainEvent
 * records it in payment_domain_events.voice_error for observability.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { PaymentDomainEventRow } from "./payment-events.server.ts";

type Client = SupabaseClient<Database>;

function formatAmount(amountMinorUnits: number, currency: string): string {
  const major = (amountMinorUnits / 100).toFixed(2);
  return `${currency} ${major}`;
}

function composeVoiceMessage(
  eventType: PaymentDomainEventRow["event_type"],
  amountText: string,
  paymentLinkUrl: string | null,
): string | null {
  switch (eventType) {
    case "PAYMENT_CAPTURED":
      return `Good news — your payment of ${amountText} just came through, and your booking is confirmed. Thank you!`;
    case "PAYMENT_CAPTURED_AFTER_EXPIRY":
      // Money moved, but the hold is gone — same honesty rule the
      // WhatsApp consumer follows: never claim the booking is confirmed
      // here.
      return `I see your payment of ${amountText} went through, but the hold on that time slot had already expired. We'll follow up shortly to confirm a new time or arrange a refund — sorry about that.`;
    case "PAYMENT_FAILED":
      return paymentLinkUrl
        ? `It looks like that payment attempt didn't go through. You can try again using the link I sent, or I can send a new one.`
        : `It looks like that payment attempt didn't go through — let me know if you'd like me to send the payment link again.`;
    case "PAYMENT_EXPIRED":
      return `The payment link for your booking has expired, so that hold has been released. Let me know if you'd still like to book — I can start a new request for you.`;
    default:
      return null;
  }
}

export async function handlePaymentEventForVoice(
  supabaseAdmin: Client,
  event: PaymentDomainEventRow,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const { data: booking, error: bookingError } = await supabaseAdmin
    .from("bookings")
    .select("call_id")
    .eq("id", event.booking_id)
    .maybeSingle();
  if (bookingError) throw bookingError;
  if (!booking?.call_id) return; // no live call was ever associated with this booking

  const { data: paymentRequest, error: prError } = await supabaseAdmin
    .from("payment_requests")
    .select("amount_minor_units, currency, payment_link_url")
    .eq("id", event.payment_request_id)
    .maybeSingle();
  if (prError) throw prError;
  if (!paymentRequest) return;

  const amountText = formatAmount(paymentRequest.amount_minor_units, paymentRequest.currency);
  const message = composeVoiceMessage(
    event.event_type,
    amountText,
    paymentRequest.payment_link_url,
  );
  if (!message) return; // unrecognized event type — nothing to say

  const { getCallSessionStub } = await import("../telephony/cloudflare-env.server.ts");
  const doStub = getCallSessionStub();

  if (doStub) {
    let response: Response;
    try {
      response = await doStub.fetch("https://call-session/internal/payment-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId: booking.call_id, message }),
      });
    } catch (err) {
      throw new Error(
        `Failed to reach the call session coordinator: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Call session coordinator returned ${response.status} for the payment event.`,
      );
    }
    // A 2xx response with {handled:false} means the DO found no active
    // session for this call (already ended) — the expected ended-call
    // fallback, not an error; nothing further to do.
    return;
  }

  // Local/dev/test fallback — same convention telephony-runtime.ts uses
  // when CALL_SESSION isn't configured: call the in-process runtime
  // directly, since everything runs in one process there.
  const { injectPaymentEvent } = await import("../voice-runtime.server.ts");
  await injectPaymentEvent(booking.call_id, message);

  void fetchImpl; // unused in this branch; kept for consumer-signature/DI parity with the calendar/whatsapp consumers
}
