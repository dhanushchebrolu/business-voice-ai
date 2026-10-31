/**
 * What a persisted booking's status means for the person who asked for it —
 * the single interpretation shared by the AI tool layer (ai-tools.server.ts)
 * and the voice runtime, so nobody is told "booked" unless the stored row
 * says so.
 *
 * - "confirmed": an active, confirmed appointment.
 * - "saved_calendar_sync_failed": saved in ClickAI and holding the slot,
 *   but its Google Calendar event could not be created (CALENDAR_SYNC_FAILED,
 *   visible to staff on the Bookings dashboard). Not "confirmed" — the
 *   caller is told it's saved and that the team will confirm it.
 * - "pending": exists but not yet confirmed (e.g. a concurrent request is
 *   still confirming it, or a payment hold).
 * - "not_booked": the row exists but is no longer an active appointment
 *   (cancelled, no-show, payment failed/expired) — e.g. an idempotent retry
 *   that found an earlier attempt which has since been cancelled.
 */
export type BookingOutcome = "confirmed" | "saved_calendar_sync_failed" | "pending" | "not_booked";

export function classifyBookingStatus(status: string | null | undefined): BookingOutcome {
  switch (status) {
    case "CONFIRMED":
    case "RESCHEDULED":
      return "confirmed";
    case "CALENDAR_SYNC_FAILED":
      return "saved_calendar_sync_failed";
    case "PENDING_CONFIRMATION":
    case "PENDING_PAYMENT":
    case "DRAFT":
      return "pending";
    default:
      return "not_booked";
  }
}

/**
 * The idempotency key of a booking made on a call: the same call asking for
 * the same slot again gets the row already created, never a second one. The
 * voice runtime uses the same key to look a booking up when its request
 * timed out (see attemptBooking's reconciliation).
 */
export function voiceBookingIdempotencyKey(
  callId: string,
  startIso: string,
  endIso: string,
): string {
  return `voice:${callId}:${startIso}:${endIso}`;
}

/** An outcome where the slot is really held for this caller (confirmed, or saved pending calendar sync). */
export function bookingIsHeld(outcome: BookingOutcome): boolean {
  return outcome === "confirmed" || outcome === "saved_calendar_sync_failed";
}
