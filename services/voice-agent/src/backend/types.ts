/**
 * What the agent may ask of the business backend. In production this is
 * klyro (klyro-backend.ts), the only source of truth for availability,
 * prices and bookings; tests use in-memory.ts with the same semantics.
 */

export interface Slot {
  startIso: string;
  endIso: string;
}

export type AvailabilityResult =
  { ok: true; slots: Slot[] } | { ok: false; error: string; retryable: boolean };

/**
 * The persisted booking's meaning, exactly as klyro classifies it
 * (src/lib/calendar/booking-outcome.ts):
 *   confirmed                   active and confirmed
 *   saved_calendar_sync_failed  saved and holding the slot; Google Calendar
 *                               copy failed -> "saved, the team will confirm"
 *   pending                     exists but not confirmed yet
 */
export type BookingOutcome = "confirmed" | "saved_calendar_sync_failed" | "pending";

export type BookResult =
  | { ok: true; bookingId: string; outcome: BookingOutcome; slot: Slot }
  | {
      ok: false;
      error: "slot_taken" | "backend_unavailable" | "invalid_request" | "not_allowed";
      retryable: boolean;
      message: string;
    };

export interface BookingBackend {
  checkAvailability(q: {
    serviceId: string | null;
    date: string; // YYYY-MM-DD in the business time zone
    durationMinutes: number;
    notBefore?: string | undefined; // HH:MM, business time zone
    notAfter?: string | undefined;
  }): Promise<AvailabilityResult>;
  book(req: {
    serviceId: string | null;
    slot: Slot;
    customerName: string;
    customerPhone: string;
    serviceName: string;
  }): Promise<BookResult>;
}
