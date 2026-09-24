/**
 * Payment/booking-hold expiration sweep — the bounded-wait side of the
 * payment-hold flow. A PENDING_PAYMENT booking's hold_expires_at is set
 * at creation time (create_booking_payment_hold, DEFAULT_HOLD_DURATION_
 * MINUTES); nothing automatically releases it once that time passes
 * except this sweep, run periodically via the cron-authenticated route
 * (src/routes/api/public/cron/expire-payments.ts).
 *
 * RACE SAFETY (the explicit requirement: "the webhook confirming an
 * expired/cancelled booking" must never happen, and a simultaneously-
 * arriving capture must not be silently lost or double-counted):
 *
 *   - The booking's own transition is a single conditional UPDATE
 *     (`.eq("status", "PENDING_PAYMENT")`) — if a webhook capture already
 *     confirmed it between this sweep's SELECT and its UPDATE, this
 *     conditional UPDATE simply matches zero rows and that booking is
 *     skipped (`.select().maybeSingle()` returns null), never clobbering
 *     a real confirmation.
 *   - The payment_requests transition is likewise conditional
 *     (`.in("status", ["CREATED", "PENDING"])`) — a request the webhook
 *     already moved to CAPTURED (or FAILED/EXPIRED/CANCELLED) is left
 *     untouched.
 *   - A PAYMENT_EXPIRED domain event is only ever recorded for the exact
 *     payment_requests row(s) this sweep's own UPDATE actually affected
 *     (via `.select()` on the UPDATE itself, not a separate follow-up
 *     read) — closing the remaining race where a request could be
 *     captured in the gap between two independent reads and this sweep
 *     would otherwise announce "expired" for an already-captured payment.
 *
 * The reverse race (this sweep runs first, a capture webhook arrives a
 * moment later for the same payment) is already handled on the webhook's
 * side: payment-webhook.server.ts's capture path re-reads the booking's
 * CURRENT status right before deciding whether to emit PAYMENT_CAPTURED
 * or PAYMENT_CAPTURED_AFTER_EXPIRY — money is still recorded as captured
 * either way (payment truth is preserved), but a booking that already
 * left PENDING_PAYMENT is never silently re-confirmed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  recordPaymentDomainEvent,
  dispatchPaymentDomainEvent,
  type DispatchConsumers,
} from "./payment-events.server.ts";

type Client = SupabaseClient<Database>;

export interface ExpirePendingPaymentsResult {
  candidatesFound: number;
  bookingsExpired: number;
  paymentRequestsExpired: number;
  domainEventsDispatched: number;
}

export async function expirePendingPayments(
  supabaseAdmin: Client,
  consumers: DispatchConsumers,
  fetchImpl: typeof fetch = fetch,
): Promise<ExpirePendingPaymentsResult> {
  const nowIso = new Date().toISOString();

  const { data: candidates, error: findError } = await supabaseAdmin
    .from("bookings")
    .select("id, organization_id, business_id")
    .eq("status", "PENDING_PAYMENT")
    .lt("hold_expires_at", nowIso);
  if (findError) throw findError;

  const result: ExpirePendingPaymentsResult = {
    candidatesFound: candidates?.length ?? 0,
    bookingsExpired: 0,
    paymentRequestsExpired: 0,
    domainEventsDispatched: 0,
  };

  for (const booking of candidates ?? []) {
    const { data: updatedBooking, error: bookingUpdateError } = await supabaseAdmin
      .from("bookings")
      .update({ status: "PAYMENT_EXPIRED" })
      .eq("id", booking.id)
      .eq("status", "PENDING_PAYMENT")
      .select("id")
      .maybeSingle();
    if (bookingUpdateError) throw bookingUpdateError;
    // Lost the race to a concurrent webhook capture (or some other
    // process) that already moved this booking off PENDING_PAYMENT —
    // never overwrite whatever it transitioned to.
    if (!updatedBooking) continue;
    result.bookingsExpired++;

    const { data: expiredRequests, error: prError } = await supabaseAdmin
      .from("payment_requests")
      .update({ status: "EXPIRED" })
      .eq("booking_id", booking.id)
      .in("status", ["CREATED", "PENDING"])
      .select("id");
    if (prError) throw prError;
    result.paymentRequestsExpired += expiredRequests?.length ?? 0;

    for (const paymentRequest of expiredRequests ?? []) {
      const domainEvent = await recordPaymentDomainEvent(supabaseAdmin, {
        eventType: "PAYMENT_EXPIRED",
        organizationId: booking.organization_id,
        businessId: booking.business_id,
        paymentRequestId: paymentRequest.id,
        bookingId: booking.id,
        payload: { reason: "hold_expired" },
      });
      await dispatchPaymentDomainEvent(supabaseAdmin, domainEvent, consumers, fetchImpl);
      result.domainEventsDispatched++;
    }
  }

  return result;
}
