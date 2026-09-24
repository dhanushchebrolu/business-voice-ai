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
import type { PaymentDomainEventRow } from "./payment-events.server.ts";

type Client = SupabaseClient<Database>;

/**
 * Only a real, in-time PAYMENT_CAPTURED confirms a booking and creates a
 * calendar event. PAYMENT_CAPTURED_AFTER_EXPIRY (money moved, but the hold
 * already expired/was cancelled) deliberately does nothing here — the
 * booking stays in whatever terminal state it was already in, and the row
 * is left for manual reconciliation rather than silently confirming a
 * slot that may since have been given away.
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
  // second time) must never create a second calendar event.
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

  try {
    const calEvent = await provider.createEvent({
      calendarId: connection.calendar_id,
      title,
      description,
      startIso: booking.start_at,
      endIso: booking.end_at,
      timezone: booking.timezone,
    });
    const { error: confirmError } = await supabaseAdmin
      .from("bookings")
      .update({ status: "CONFIRMED", google_event_id: calEvent.id })
      .eq("id", booking.id);
    if (confirmError) throw confirmError;
  } catch (err) {
    await supabaseAdmin
      .from("bookings")
      .update({
        status: "CALENDAR_SYNC_FAILED",
        metadata: {
          calendar_sync_error: err instanceof Error ? err.message : "Unknown calendar sync error.",
        },
      })
      .eq("id", booking.id);
    throw err;
  }
}
