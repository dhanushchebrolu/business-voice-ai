/**
 * In-memory BookingBackend for tests and local development. Reproduces the
 * behaviours of klyro's booking path that the agent depends on: an atomic
 * slot claim (a lost race returns slot_taken), idempotent retries (klyro
 * keys a voice booking by call + slot), transient failures, and a Google
 * Calendar mirror that can fail after the booking is saved.
 */
import type { AvailabilityResult, BookResult, BookingBackend } from "./types.ts";

export interface InMemoryOptions {
  timeZoneOffset: string; // e.g. "+05:30"
  openHours: string[]; // "HH:MM" slot starts
  latencyMs?: number;
  failAvailability?: number;
  failBooking?: number;
  /** The booking saves, but its calendar copy fails (outcome saved_calendar_sync_failed). */
  calendarSyncFails?: boolean;
  /** Identifies the call, as klyro's voice idempotency key does. */
  callId?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class InMemoryBookingBackend implements BookingBackend {
  readonly bookings = new Map<string, { id: string; slotStart: string; key: string }>();
  private readonly byKey = new Map<string, string>();
  private readonly taken = new Set<string>();
  private readonly o: InMemoryOptions;
  private seq = 0;
  calls = { availability: 0, book: 0 };

  constructor(o: InMemoryOptions) {
    this.o = { ...o };
  }

  /** A second view of the same calendar for another call (concurrency tests). */
  forCall(callId: string): BookingBackend {
    return {
      checkAvailability: (q) => this.checkAvailability(q),
      book: (r) => this.bookFor(callId, r),
    };
  }

  async checkAvailability(
    q: Parameters<BookingBackend["checkAvailability"]>[0],
  ): Promise<AvailabilityResult> {
    this.calls.availability++;
    await sleep(this.o.latencyMs ?? 0);
    if ((this.o.failAvailability ?? 0) > 0) {
      this.o.failAvailability!--;
      return { ok: false, error: "calendar_unreachable", retryable: true };
    }
    const slots = this.o.openHours
      .filter((h) => (!q.notBefore || h >= q.notBefore) && (!q.notAfter || h <= q.notAfter))
      .map((h) => {
        const start = new Date(`${q.date}T${h}:00${this.o.timeZoneOffset}`);
        return {
          startIso: start.toISOString(),
          endIso: new Date(start.getTime() + q.durationMinutes * 60_000).toISOString(),
        };
      })
      .filter((s) => !this.taken.has(s.startIso));
    return { ok: true, slots };
  }

  book(req: Parameters<BookingBackend["book"]>[0]): Promise<BookResult> {
    return this.bookFor(this.o.callId ?? "call", req);
  }

  private async bookFor(
    callId: string,
    req: Parameters<BookingBackend["book"]>[0],
  ): Promise<BookResult> {
    this.calls.book++;
    const key = `voice:${callId}:${req.slot.startIso}:${req.slot.endIso}`;
    const existing = this.byKey.get(key);
    if (existing) {
      return {
        ok: true,
        bookingId: existing,
        outcome: this.o.calendarSyncFails ? "saved_calendar_sync_failed" : "confirmed",
        slot: req.slot,
      };
    }
    if (this.taken.has(req.slot.startIso)) {
      await sleep(this.o.latencyMs ?? 0);
      return {
        ok: false,
        error: "slot_taken",
        retryable: false,
        message: "That time was just booked by someone else.",
      };
    }
    if ((this.o.failBooking ?? 0) > 0) {
      this.o.failBooking!--;
      await sleep(this.o.latencyMs ?? 0);
      return {
        ok: false,
        error: "backend_unavailable",
        retryable: true,
        message: "The booking system did not respond.",
      };
    }
    this.taken.add(req.slot.startIso);
    const id = `bk_${++this.seq}`;
    this.bookings.set(id, { id, slotStart: req.slot.startIso, key });
    this.byKey.set(key, id);
    await sleep(this.o.latencyMs ?? 0);
    return {
      ok: true,
      bookingId: id,
      outcome: this.o.calendarSyncFails ? "saved_calendar_sync_failed" : "confirmed",
      slot: req.slot,
    };
  }
}
