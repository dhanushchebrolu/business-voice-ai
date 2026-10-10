/**
 * PaymentCaptured consumer: creates the deferred Google Calendar event and
 * confirms the booking (spec: "Deferred Google Calendar event creation
 * until payment is CAPTURED"). Reuses the existing, already-tested
 * calendar connection + provider machinery from Phase 2 —
 * getCalendarProviderForConnection() — this file adds no new Google
 * Calendar API logic of its own; it's an orchestration layer that decides
 * WHEN to call it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getCalendarProviderForConnection } from "../google-calendar/google-calendar-connection.server.ts";
import { CalendarProviderError, type CalendarProvider } from "../calendar/calendar-provider.ts";
import type { PaymentDomainEventRow } from "./payment-events.server.ts";

type Client = SupabaseClient<Database>;

/**
 * Deletes a calendar event this exact function call just created, after
 * losing the race to confirm the booking it belongs to (see the
 * handlePaymentCapturedForCalendar's own doc comment below for the race).
 * Ownership/identity are verified by construction, not by a separate
 * lookup: `eventId` is the id this same invocation's own createEvent()
 * call returned a moment ago, and `calendarId` is the same value just used
 * to create it — never a separately-read, potentially-stale
 * booking.google_event_id that could point at a different event entirely.
 *
 * "Already gone" (CALENDAR_NOT_FOUND — e.g. a retried dispatch already
 * cleaned this exact event up) is treated as success, matching
 * cancelBooking()'s own convention in booking-service.server.ts. Any
 * other cleanup failure is a genuine, possibly-permanent orphan: logged
 * (message only, never the raw provider error/headers, which could carry
 * tokens) and re-thrown so dispatchPaymentDomainEvent's existing
 * per-consumer failure tracking (calendar_error on the payment_domain_
 * events row) records it for manual reconciliation — no new
 * infrastructure needed for that part.
 */
async function cleanupOrphanedEvent(
  provider: CalendarProvider,
  calendarId: string,
  eventId: string,
  bookingId: string,
): Promise<void> {
  try {
    await provider.deleteEvent(calendarId, eventId);
  } catch (err) {
    if (err instanceof CalendarProviderError && err.code === "CALENDAR_NOT_FOUND") return;
    const cleanupMessage = err instanceof Error ? err.message : "Unknown calendar cleanup error.";
    console.error("payment_calendar_consumer:orphaned_event_cleanup_failed", {
      bookingId,
      calendarId,
      eventId,
      cleanupError: cleanupMessage,
    });
    throw new Error(
      `Booking ${bookingId} lost the confirmation race and its calendar event ${eventId} ` +
        `(calendar ${calendarId}) could not be cleaned up: ${cleanupMessage}. Manual ` +
        `reconciliation required — the booking itself was left untouched.`,
    );
  }
}

/**
 * Only a real, in-time PAYMENT_CAPTURED confirms a booking and creates a
 * calendar event. PAYMENT_CAPTURED_AFTER_EXPIRY (money moved, but the hold
 * already expired/was cancelled) deliberately does nothing here — the
 * booking stays in whatever terminal state it was already in, and the row
 * is left for manual reconciliation rather than silently confirming a
 * slot that may since have been given away.
 *
 * Race (found by staging-readiness review, fixed here): the guard above
 * only reads the booking's status ONCE, before the Google Calendar API
 * round trip below. If expirePendingPayments() (payment-expiration.
 * server.ts) or a concurrent cancellation moves this exact booking off
 * PENDING_PAYMENT while that round trip is in flight, this function used
 * to still overwrite the booking back to CONFIRMED unconditionally —
 * reviving an already-expired/cancelled booking and leaving its slot
 * double-booked against whatever create_booking_atomic may since have
 * allowed into it (PAYMENT_EXPIRED is excluded from that overlap check).
 * Every status-changing write below is now conditional on the booking
 * still being PENDING_PAYMENT at write time; a write that matches zero
 * rows means the race was lost, not that confirmation succeeded, and any
 * calendar event already created for it is cleaned up via
 * cleanupOrphanedEvent() rather than left dangling.
 */
export async function handlePaymentCapturedForCalendar(
  supabaseAdmin: Client,
  event: PaymentDomainEventRow,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (event.event_type !== "PAYMENT_CAPTURED") return;

  const { data: booking, error } = await supabaseAdmin
    .from("bookings")
    .select(
      "id, status, calendar_connection_id, start_at, end_at, timezone, customer_name, customer_phone, business_id",
    )
    .eq("id", event.booking_id)
    .maybeSingle();
  if (error) throw error;
  if (!booking) throw new Error("Booking not found for PaymentCaptured event.");

  // Duplicate-webhook guard: a booking already moved past PENDING_PAYMENT
  // (e.g. a retried/duplicate webhook delivery reaching this consumer a
  // second time) must never create a second calendar event. This is only
  // the FIRST check — see the final conditional UPDATE below for the one
  // that actually matters once the Google Calendar round trip is in play.
  if (booking.status !== "PENDING_PAYMENT") return;
  if (!booking.calendar_connection_id) {
    throw new Error("Booking has no calendar connection — cannot create the confirmation event.");
  }

  const { data: business } = await supabaseAdmin
    .from("businesses")
    .select("name")
    .eq("id", booking.business_id)
    .maybeSingle();

  const { data: connection } = await supabaseAdmin
    .from("google_calendar_connections")
    .select("calendar_id")
    .eq("id", booking.calendar_connection_id)
    .maybeSingle();
  if (!connection?.calendar_id) {
    throw new Error("Calendar connection has no selected calendar.");
  }

  const { provider } = await getCalendarProviderForConnection(
    supabaseAdmin,
    booking.calendar_connection_id,
    fetchImpl,
  );

  const title = `Appointment - ${booking.customer_name ?? "Customer"}`;
  const description = [
    `Business: ${business?.name ?? ""}`,
    booking.customer_phone ? `Phone: ${booking.customer_phone}` : null,
    `ClickAI Booking ID: ${booking.id}`,
    "Created by: ClickAI AI Agent (payment confirmed)",
  ]
    .filter(Boolean)
    .join("\n");

  let calEvent;
  try {
    calEvent = await provider.createEvent({
      calendarId: connection.calendar_id,
      title,
      description,
      startIso: booking.start_at,
      endIso: booking.end_at,
      timezone: booking.timezone,
    });
  } catch (err) {
    // No event was ever created provider-side yet — nothing to clean up.
    // Mark CALENDAR_SYNC_FAILED, but only if the booking is still the one
    // we read: guarded so a booking the expiration sweep or a concurrent
    // cancellation already moved off PENDING_PAYMENT in this same window
    // is never overwritten into a misleading "sync failed" state.
    const { data: failedRows, error: failError } = await supabaseAdmin
      .from("bookings")
      .update({
        status: "CALENDAR_SYNC_FAILED",
        metadata: {
          calendar_sync_error: err instanceof Error ? err.message : "Unknown calendar sync error.",
        },
      })
      .eq("id", booking.id)
      .eq("status", "PENDING_PAYMENT")
      .select("id");
    if (failError) throw failError;
    if (!failedRows || failedRows.length === 0) {
      console.warn("payment_calendar_consumer:lost_race_before_event_creation", {
        bookingId: booking.id,
      });
    }
    throw err;
  }

  // The event now exists provider-side. From here on, every outcome must
  // either durably link it to this booking (CONFIRMED) or clean it up —
  // never leave it created with nothing in our own DB referencing it.
  const { data: confirmedRows, error: confirmError } = await supabaseAdmin
    .from("bookings")
    .update({ status: "CONFIRMED", google_event_id: calEvent.id })
    .eq("id", booking.id)
    .eq("status", "PENDING_PAYMENT")
    .select("id");

  if (!confirmError && confirmedRows && confirmedRows.length > 0) {
    return;
  }

  // Either a genuine DB error on the UPDATE itself, or we lost the race:
  // the booking moved off PENDING_PAYMENT between the guard check above
  // and this UPDATE — most likely the expiration sweep, or a concurrent
  // cancellation, completing while the Google Calendar API round trip was
  // in flight. Either way, the booking's own status belongs to whichever
  // process already decided it; this consumer must never touch it again.
  // What it DOES own is the event it just created — clean that up so it
  // never becomes an untracked orphan on the calendar.
  await cleanupOrphanedEvent(provider, connection.calendar_id, calEvent.id, booking.id);
  if (confirmError) throw confirmError;
  // A clean, successful cleanup after losing the race is not a failure of
  // this consumer — it did exactly what it should: no booking revived, no
  // orphaned event left behind.
}
