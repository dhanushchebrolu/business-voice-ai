/**
 * Booking creation/reschedule/cancel orchestration (spec sections 19-26,
 * 68-69). Ties together: idempotent creation (a retried request returns
 * the existing booking rather than creating a duplicate), an availability
 * re-check immediately before insert (spec section 22's "check, then
 * re-check, then create" flow), Google Calendar event creation, and
 * reconciliation when the booking is created but the calendar event isn't
 * (CALENDAR_SYNC_FAILED — spec section 69: "do not silently lose the
 * booking").
 *
 * Like the other server-side orchestration modules in this codebase, the
 * privileged Supabase client and the CalendarProvider are explicit
 * parameters — callers (calendar-tools.server.ts) own tenant validation
 * and resolving which connection/calendar to use; this module trusts the
 * organizationId/businessId/calendarConnectionId it's given.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { CalendarProvider, NormalizedCalendarEvent } from "./calendar-provider.ts";
import { CalendarProviderError } from "./calendar-provider.ts";
import { normalizePhoneNumber } from "../phone-number.ts";

type Client = SupabaseClient<Database>;

export class BookingError extends Error {
  code:
    | "SLOT_NO_LONGER_AVAILABLE"
    | "NOT_FOUND"
    | "INVALID_INPUT"
    | "SLOT_OUTSIDE_SCHEDULE"
    | "NOT_RESCHEDULABLE"
    | "PAYMENT_PENDING"
    | "INVALID_PHONE";
  constructor(message: string, code: BookingError["code"]) {
    super(message);
    this.code = code;
  }
}

export interface BookingRecord {
  id: string;
  status: string;
  startAt: string;
  endAt: string;
  timezone: string;
  googleEventId: string | null;
  contactId: string | null;
}

function toRecord(row: {
  id: string;
  status: string;
  start_at: string;
  end_at: string;
  timezone: string;
  google_event_id: string | null;
  contact_id: string | null;
}): BookingRecord {
  return {
    id: row.id,
    status: row.status,
    startAt: row.start_at,
    endAt: row.end_at,
    timezone: row.timezone,
    googleEventId: row.google_event_id,
    contactId: row.contact_id,
  };
}

/**
 * Normalizes the customer's phone to E.164 before it reaches the database.
 * contacts.phone is CHECK-constrained to E.164, and resolveContactId below
 * upserts into it before the booking RPC runs — a raw "9876543210" (how the
 * voice runtime and the AI tool path both used to pass a spoken number)
 * failed that constraint, so the whole booking aborted and nothing was
 * written. A national-format number is only interpreted using the
 * business's own country (`phoneCountry`, from businesses.country) — never
 * a blind +91. A number that cannot be normalized is rejected up front as
 * INVALID_PHONE (a targeted, recoverable error the caller can be asked to
 * fix) rather than as an opaque database error. Absent stays absent.
 */
function normalizePhoneInput<
  T extends { customerPhone?: string | undefined; phoneCountry?: string | null | undefined },
>(input: T): T {
  if (input.customerPhone === undefined) return input;
  const result = normalizePhoneNumber(input.customerPhone, input.phoneCountry);
  if (!result.ok) {
    throw new BookingError(
      result.reason === "country_code_required"
        ? "Please give the phone number with its country code."
        : "That phone number doesn't look valid.",
      "INVALID_PHONE",
    );
  }
  return { ...input, customerPhone: result.e164 };
}

async function resolveContactId(
  supabaseAdmin: Client,
  input: {
    organizationId: string;
    businessId: string;
    contactId?: string | null | undefined;
    customerName?: string | undefined;
    customerPhone?: string | undefined;
    customerEmail?: string | undefined;
  },
): Promise<string | null> {
  if (input.contactId) return input.contactId;
  if (!input.customerPhone) return null;

  // Reuse the existing contacts table's own (organization_id, phone)
  // uniqueness rather than creating a new customer record per booking.
  const { data, error } = await supabaseAdmin
    .from("contacts")
    .upsert(
      {
        organization_id: input.organizationId,
        business_id: input.businessId,
        phone: input.customerPhone,
        name: input.customerName ?? null,
        email: input.customerEmail ?? null,
        source: "booking",
      },
      { onConflict: "organization_id,phone", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export interface CreateBookingInput {
  organizationId: string;
  businessId: string;
  /** Optional — ClickAI's own database-backed scheduling (bookings + business_hours/business_hour_overrides) is the source of truth regardless. When present, a Google Calendar event is also created/kept in sync as a convenience; when absent, the booking is confirmed directly with no external event. */
  calendarConnectionId?: string | null | undefined;
  calendarId?: string | null | undefined;
  serviceId?: string | null;
  agentConfigId?: string | null;
  contactId?: string | null;
  customerName?: string | undefined;
  customerPhone?: string | undefined;
  customerEmail?: string | undefined;
  startIso: string;
  endIso: string;
  timezone: string;
  source: "voice" | "whatsapp" | "website" | "manual" | "instagram";
  idempotencyKey?: string | undefined;
  notes?: string | undefined;
  businessName: string; // for the Google event description
  /** The business's country (businesses.country) — how a phone number given without a country code is interpreted. Unknown means only international-format numbers are accepted. */
  phoneCountry?: string | null | undefined;
}

/** Proper interval overlap — see calendar-service.server.ts's own `overlaps` for why this, not an exact-start comparison. */
function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return (
    new Date(aStart).getTime() < new Date(bEnd).getTime() &&
    new Date(bStart).getTime() < new Date(aEnd).getTime()
  );
}

/**
 * Deletes a calendar event this exact call just created, after losing the
 * race to confirm the booking it belongs to (same pattern/rationale as
 * payment-calendar-consumer.server.ts's own cleanupOrphanedEvent — see
 * createBooking()'s doc comment below for the specific race this closes).
 * Ownership/identity are verified by construction: `eventId`/`calendarId`
 * are exactly what this same invocation's own createEvent() call just
 * used, never a separately-read value. "Already gone" (CALENDAR_NOT_FOUND)
 * is treated as success, matching cancelBooking()'s own convention a few
 * lines down. Any other cleanup failure is a genuine, possibly-permanent
 * orphan: logged (message only, never a raw provider error/headers, which
 * could carry tokens) and re-thrown so the caller sees a reconciliation
 * failure rather than a silent success.
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
    console.error("booking_service:orphaned_event_cleanup_failed", {
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
 * Creates a booking. Sequence: insert the booking row first
 * (PENDING_CONFIRMATION), then create the Google event, then mark
 * CONFIRMED only once the event exists — never the reverse, which would
 * let a customer be told "confirmed" before anything durable backs that
 * claim.
 *
 * Concurrency: the idempotency check, the schedule validation (business
 * hours, daily overrides, full-day closures — see
 * validate_booking_schedule), the internal-conflict re-check, and the
 * insert all run inside ONE Postgres transaction via the
 * create_booking_atomic RPC (see its own migration doc comments,
 * 20261009090000 and 20261009120000) — a per-business advisory lock
 * (acquired before the schedule check) and a per-calendar-connection
 * advisory lock (acquired before the overlap check) together serialize
 * concurrent attempts long enough for both checks to be race-free. Two
 * concurrent requests for overlapping-but-different-start times on the
 * same connection can never both succeed, and a staff member closing the
 * slot cannot be bypassed by a booking already in flight — whichever
 * transaction reaches the business lock first commits or rolls back
 * before the other can read the schedule/booking state it depends on.
 *
 * That lock only protects against another ClickAI booking on the same
 * connection — it has no visibility into the EXTERNAL calendar (an event
 * created directly in Google Calendar, or by another integration, between
 * the caller's last availability check and now). Google's Events.insert
 * API has no "reject if overlapping" option (a calendar is not a
 * resource-scheduling system), so the busy-period recheck immediately
 * below is the only available protection for that case — and it still
 * leaves a genuine, acknowledged residual race in the instant between
 * that recheck and the createEvent call a few lines later: closing that
 * completely would require Google itself to offer an atomic
 * check-and-create primitive, which it does not.
 *
 * A second, different race (found by staging-readiness review, fixed
 * here): the confirm UPDATE after createEvent() used to be unconditional
 * (`.eq("id", booking.id)` only). cancel_booking_atomic's own guard list
 * does not exclude PENDING_CONFIRMATION, so a concurrent staff
 * cancellation of this exact booking — landing while the Google Calendar
 * API round trip above is in flight — used to be silently overwritten
 * back to CONFIRMED once that round trip finished, reviving an
 * already-cancelled booking with a freshly created (and now orphaned)
 * calendar event. The confirm UPDATE below is now conditional on the
 * booking still being PENDING_CONFIRMATION; a write that matches zero
 * rows means the race was lost, not that confirmation succeeded, and the
 * event already created for it is cleaned up via cleanupOrphanedEvent()
 * rather than left dangling — same pattern as payment-calendar-consumer.
 * server.ts's handlePaymentCapturedForCalendar().
 *
 * Google Calendar is optional: when `provider`/`input.calendarId` are not
 * given (no connection for this business, or ClickAI's own database-backed
 * scheduling is in use), the RPC inserts the booking directly as CONFIRMED
 * — there is nothing external to wait on, so the PENDING_CONFIRMATION ->
 * createEvent -> CONFIRMED staging below is simply skipped. The external-
 * calendar busy-period recheck above it is skipped the same way (there is
 * no external calendar to race against). Every concurrency guarantee
 * (idempotency, schedule validation, business_id-scoped overlap
 * protection) comes from create_booking_atomic itself and is identical
 * either way.
 */
export async function createBooking(
  supabaseAdmin: Client,
  provider: CalendarProvider | null,
  rawInput: CreateBookingInput,
): Promise<BookingRecord> {
  if (new Date(rawInput.endIso).getTime() <= new Date(rawInput.startIso).getTime()) {
    throw new BookingError("End time must be after start time.", "INVALID_INPUT");
  }
  const input = normalizePhoneInput(rawInput);

  // Cheap early-out for the common "retried after already succeeding" case
  // — avoids the external busy-period fetch and contact upsert below for
  // a request we already know is done. The RPC's own idempotency check
  // (inside the same lock) remains the single source of truth; this is
  // purely an optimization, not a correctness requirement.
  if (input.idempotencyKey) {
    const { data: existing, error } = await supabaseAdmin
      .from("bookings")
      .select("id, status, start_at, end_at, timezone, google_event_id, contact_id")
      .eq("organization_id", input.organizationId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    if (existing) return toRecord(existing);
  }

  const contactId = await resolveContactId(supabaseAdmin, input);

  const hasCalendar = Boolean(provider && input.calendarId);

  if (provider && input.calendarId) {
    // External-calendar race check (see this function's own doc comment) —
    // fetched fresh here, never reused from an earlier availability check.
    const externalBusy = await provider.getBusyPeriods({
      calendarId: input.calendarId,
      timeMinIso: input.startIso,
      timeMaxIso: input.endIso,
    });
    if (externalBusy.some((b) => intervalsOverlap(b.start, b.end, input.startIso, input.endIso))) {
      throw new BookingError("That time slot is no longer available.", "SLOT_NO_LONGER_AVAILABLE");
    }
  }

  const { data: bookingRow, error: rpcError } = await supabaseAdmin.rpc("create_booking_atomic", {
    p_organization_id: input.organizationId,
    p_business_id: input.businessId,
    p_calendar_connection_id: input.calendarConnectionId ?? null,
    p_service_id: input.serviceId ?? null,
    p_agent_config_id: input.agentConfigId ?? null,
    p_contact_id: contactId,
    p_start_at: input.startIso,
    p_end_at: input.endIso,
    p_timezone: input.timezone,
    p_customer_name: input.customerName ?? null,
    p_customer_phone: input.customerPhone ?? null,
    p_customer_email: input.customerEmail ?? null,
    p_source: input.source,
    p_idempotency_key: input.idempotencyKey ?? null,
    // No Google Calendar event to wait on -> confirm directly; otherwise
    // stage through PENDING_CONFIRMATION until the event actually exists
    // (see this function's own doc comment).
    p_status: hasCalendar ? "PENDING_CONFIRMATION" : "CONFIRMED",
    p_hold_expires_at: null,
    p_call_id: null,
    p_notes: input.notes ?? null,
  });
  if (rpcError) {
    // The DB-level exact-start-time unique index (idx_bookings_no_exact_start_clash)
    // is a secondary backstop for any insert path that bypasses this RPC
    // entirely (e.g. a direct admin-dashboard write) — the RPC's own
    // advisory-lock overlap check above is what actually protects callers
    // of this function.
    if (rpcError.message?.includes("SLOT_NO_LONGER_AVAILABLE") || rpcError.code === "23505") {
      throw new BookingError("That time slot is no longer available.", "SLOT_NO_LONGER_AVAILABLE");
    }
    // The RPC's own validate_booking_schedule (inside the same transaction
    // and lock as the insert above) rejected this — the authoritative
    // schedule check now that assertSlotWithinSchedule no longer runs for
    // this entry point. See this function's own doc comment.
    if (rpcError.message?.includes("SLOT_OUTSIDE_SCHEDULE")) {
      throw new BookingError(
        "That time is outside the hospital's working schedule.",
        "SLOT_OUTSIDE_SCHEDULE",
      );
    }
    throw rpcError;
  }
  const booking = bookingRow;
  // The RPC's own idempotency check found an existing row (possibly
  // already CONFIRMED, CALENDAR_SYNC_FAILED, etc. from an earlier,
  // successful call with this same key) — already resolved, same
  // early-return shape as the pre-check above.
  if (booking.status !== "PENDING_CONFIRMATION") {
    return toRecord(booking);
  }
  // Reached only when hasCalendar was true above (that's the only way the
  // RPC was asked for PENDING_CONFIRMATION instead of CONFIRMED), so
  // provider/calendarId are guaranteed non-null here.
  if (!provider || !input.calendarId) {
    throw new Error(
      "Internal error: booking staged for calendar confirmation with no calendar provider.",
    );
  }
  const activeProvider = provider;
  const activeCalendarId = input.calendarId;

  const title = `Appointment - ${input.customerName ?? "Customer"}`;
  const description = [
    `Business: ${input.businessName}`,
    input.customerPhone ? `Phone: ${input.customerPhone}` : null,
    `ClickAI Booking ID: ${booking.id}`,
    "Created by: ClickAI AI Agent",
  ]
    .filter(Boolean)
    .join("\n");

  let event;
  try {
    event = await activeProvider.createEvent({
      calendarId: activeCalendarId,
      title,
      description,
      startIso: input.startIso,
      endIso: input.endIso,
      timezone: input.timezone,
      // Lets a later retry find this event instead of creating a duplicate
      // if the confirm step below never runs.
      clickaiBookingId: booking.id,
    });
  } catch (err) {
    // Reconciliation (spec section 69): the booking already exists and
    // must not be silently lost. Mark it CALENDAR_SYNC_FAILED rather than
    // leaving it PENDING_CONFIRMATION forever or deleting it — but only if
    // the booking is still the one we created: guarded so a booking a
    // concurrent cancellation already moved off PENDING_CONFIRMATION in
    // this same window is never overwritten into a misleading "sync
    // failed" state. No event was ever created here, so there's nothing
    // to clean up calendar-side.
    const message =
      err instanceof CalendarProviderError ? err.message : "Failed to create the calendar event.";
    const { data: failedRows, error: failError } = await supabaseAdmin
      .from("bookings")
      .update({
        status: "CALENDAR_SYNC_FAILED",
        metadata: {
          ...metadataObject((booking as { metadata?: unknown }).metadata),
          calendar_sync_error: message,
          // Schedules the automatic retry (retryDueCalendarSyncFailures).
          calendar_sync_attempts: 0,
          calendar_sync_next_attempt_at: nextCalendarSyncAttemptAt(0, new Date()),
        },
      })
      .eq("id", booking.id)
      .eq("status", "PENDING_CONFIRMATION")
      .select("id, status, start_at, end_at, timezone, google_event_id, contact_id");
    if (failError) throw failError;
    if (!failedRows || failedRows.length === 0) {
      // A concurrent cancellation moved the booking first — it is not
      // this caller's booking any more, so this is a genuine failure.
      console.warn("booking_service:lost_race_before_event_creation", { bookingId: booking.id });
      throw err;
    }
    // The booking IS saved in ClickAI (the source of truth for the slot,
    // which it now occupies) — only the Google Calendar mirror failed.
    // Reporting this as a failed booking would be false (the caller would
    // be told "it didn't work" while the slot stays taken), and reporting
    // it as CONFIRMED would hide the sync failure from staff. It is
    // returned with its real CALENDAR_SYNC_FAILED status (visible on the
    // Bookings dashboard, with metadata.calendar_sync_error) so each caller
    // decides how to describe it — see booking-outcome.ts.
    console.warn("booking_service:calendar_sync_failed_booking_saved", { bookingId: booking.id });
    return toRecord(failedRows[0]!);
  }

  // The event now exists provider-side. From here on, every outcome must
  // either durably link it to this booking (CONFIRMED) or clean it up —
  // never leave it created with nothing in our own DB referencing it.
  const { data: confirmedRows, error: confirmError } = await supabaseAdmin
    .from("bookings")
    .update({ status: "CONFIRMED", google_event_id: event.id })
    .eq("id", booking.id)
    .eq("status", "PENDING_CONFIRMATION")
    .select("id, status, start_at, end_at, timezone, google_event_id, contact_id");

  if (!confirmError && confirmedRows && confirmedRows.length > 0) {
    return toRecord(confirmedRows[0]!);
  }

  // Either a genuine DB error on the UPDATE itself, or we lost the race: a
  // concurrent cancellation moved the booking off PENDING_CONFIRMATION
  // between the RPC's own PENDING_CONFIRMATION result and this UPDATE.
  // Either way, the booking's own status belongs to whichever process
  // already decided it; this function must never touch it again. What it
  // DOES own is the event it just created — clean that up so it never
  // becomes an untracked orphan on the calendar.
  await cleanupOrphanedEvent(activeProvider, activeCalendarId, event.id, booking.id);
  if (confirmError) throw confirmError;
  // A clean, successful cleanup after losing the race still means this
  // call cannot return a confirmed booking — the caller asked to create
  // one and it was cancelled out from under it. None of BookingError's
  // existing codes describe this (it isn't an availability/input/payment
  // problem), so this is a plain Error, same convention this module
  // already uses for its other non-BookingError edge cases; callers that
  // only branch on BookingError already fall back safely for any other
  // thrown error (see calendar-tools.server.ts's mapToolError).
  throw new Error("This booking was cancelled before its calendar event could be confirmed.");
}

export interface RescheduleBookingInput {
  organizationId: string;
  bookingId: string;
  /** Only needed if this booking actually has a google_event_id to update — read from the booking row itself, not required when the business has no Google Calendar connection. */
  calendarId?: string | null | undefined;
  newStartIso: string;
  newEndIso: string;
}

/**
 * Concurrency: the whole read-check-write sequence (row lock, schedule
 * re-validation, per-calendar-connection overlap re-check, update) runs
 * inside ONE Postgres transaction via the reschedule_booking_atomic RPC
 * (20261010130000_atomic_reschedule_and_cancel.sql) — the same per-business
 * and per-calendar-connection advisory locks create_booking_atomic uses, in
 * the same order, so a reschedule can never interleave with a new booking,
 * a staff schedule closure, another reschedule of a different booking into
 * the same slot, or a concurrent cancellation of this exact booking. See
 * that migration's own header comment for the specific races this closes;
 * this function no longer does any of that checking itself.
 */
export async function rescheduleBooking(
  supabaseAdmin: Client,
  provider: CalendarProvider | null,
  input: RescheduleBookingInput,
): Promise<BookingRecord> {
  const { data: booking, error: rpcError } = await supabaseAdmin.rpc("reschedule_booking_atomic", {
    p_organization_id: input.organizationId,
    p_booking_id: input.bookingId,
    p_new_start_at: input.newStartIso,
    p_new_end_at: input.newEndIso,
  });
  if (rpcError) {
    if (rpcError.message?.includes("BOOKING_NOT_FOUND")) {
      throw new BookingError("Booking not found.", "NOT_FOUND");
    }
    if (rpcError.message?.includes("BOOKING_PAYMENT_PENDING")) {
      throw new BookingError(
        "This booking has a pending payment and cannot be rescheduled until it is completed or cancelled.",
        "PAYMENT_PENDING",
      );
    }
    if (rpcError.message?.includes("BOOKING_NOT_RESCHEDULABLE")) {
      throw new BookingError("This booking can no longer be rescheduled.", "NOT_RESCHEDULABLE");
    }
    if (rpcError.message?.includes("SLOT_NO_LONGER_AVAILABLE")) {
      throw new BookingError("That time slot is no longer available.", "SLOT_NO_LONGER_AVAILABLE");
    }
    if (rpcError.message?.includes("SLOT_OUTSIDE_SCHEDULE")) {
      throw new BookingError(
        "That time is outside the hospital's working schedule.",
        "SLOT_OUTSIDE_SCHEDULE",
      );
    }
    throw rpcError;
  }

  if (booking.google_event_id && provider && input.calendarId) {
    try {
      await provider.updateEvent(input.calendarId, booking.google_event_id, {
        startIso: input.newStartIso,
        endIso: input.newEndIso,
        timezone: booking.timezone,
      });
    } catch (err) {
      // The reschedule already committed in the database — reconcile
      // rather than silently lose track of the mismatch (same policy as
      // createBooking()'s own CALENDAR_SYNC_FAILED handling below). Guarded
      // on the booking still being RESCHEDULED (the exact status the RPC
      // above just set): a concurrent cancel_booking_atomic call on this
      // same booking, landing while the Google Calendar updateEvent() round
      // trip is in flight, must never have its CANCELLED result overwritten
      // back into a misleading "sync failed" state.
      const message =
        err instanceof CalendarProviderError ? err.message : "Failed to update the calendar event.";
      const { data: failedRows, error: failError } = await supabaseAdmin
        .from("bookings")
        .update({ status: "CALENDAR_SYNC_FAILED", metadata: { calendar_sync_error: message } })
        .eq("id", booking.id)
        .eq("status", "RESCHEDULED")
        .select("id");
      if (failError) throw failError;
      if (!failedRows || failedRows.length === 0) {
        console.warn("booking_service:reschedule_lost_race_before_sync_failed_write", {
          bookingId: booking.id,
        });
      }
      throw err;
    }
  } else if (booking.google_event_id) {
    // This booking does have a Google Calendar event, but the caller
    // didn't supply a provider/calendarId to update it with — the DB
    // reschedule still committed (it's the source of truth), but the
    // external event is now stale at the old time. Not thrown as an error
    // (the reschedule itself genuinely succeeded), but never silently
    // dropped either.
    console.warn("booking_service:reschedule_skipped_stale_calendar_event", {
      bookingId: booking.id,
    });
  }

  return toRecord(booking);
}

export interface CancelBookingInput {
  organizationId: string;
  bookingId: string;
  /** Only needed if this booking actually has a google_event_id to delete — read from the booking row itself, not required when the business has no Google Calendar connection. */
  calendarId?: string | null | undefined;
  reason?: string | undefined;
}

/**
 * Concurrency: cancel_booking_atomic (20261010130000_atomic_reschedule_and_
 * cancel.sql) takes a `SELECT ... FOR UPDATE` row lock on the booking
 * before reading or changing anything, so it's correctly serialized against
 * a concurrent reschedule_booking_atomic on the same row — whichever
 * reaches the lock first determines what the other sees. Cancelling an
 * already-cancelled booking is idempotent (returns the existing row, not
 * an error).
 *
 * Ordering: the DB-level cancel runs FIRST, then the Google event is
 * deleted using the google_event_id the RPC's own locked read returned —
 * not a separately-read, potentially-stale value. If the booking is
 * already durably CANCELLED and the Google deletion fails, that failure
 * is reported to the caller but the booking's own state is never left
 * ambiguous (unlike deleting the event first, which could succeed while
 * the subsequent DB update failed, silently orphaning the calendar side).
 */
export async function cancelBooking(
  supabaseAdmin: Client,
  provider: CalendarProvider | null,
  input: CancelBookingInput,
): Promise<BookingRecord> {
  const { data: cancelled, error: rpcError } = await supabaseAdmin.rpc("cancel_booking_atomic", {
    p_organization_id: input.organizationId,
    p_booking_id: input.bookingId,
    p_reason: input.reason ?? null,
  });
  if (rpcError) {
    if (rpcError.message?.includes("BOOKING_NOT_FOUND")) {
      throw new BookingError("Booking not found.", "NOT_FOUND");
    }
    throw rpcError;
  }

  if (cancelled.google_event_id && provider && input.calendarId) {
    try {
      await provider.deleteEvent(input.calendarId, cancelled.google_event_id);
    } catch (err) {
      // Deleting an already-gone event is not a failure — the desired end
      // state (no event) already holds.
      if (!(err instanceof CalendarProviderError && err.code === "CALENDAR_NOT_FOUND")) throw err;
    }
  } else if (cancelled.google_event_id) {
    // The booking is durably CANCELLED (the source of truth), but no
    // provider/calendarId was supplied to delete its Google Calendar
    // event — not thrown as an error, but never silently dropped.
    console.warn("booking_service:cancel_skipped_stale_calendar_event", {
      bookingId: cancelled.id,
    });
  }

  return toRecord(cancelled);
}

export async function getBooking(
  supabaseAdmin: Client,
  input: { organizationId: string; bookingId: string },
): Promise<BookingRecord | null> {
  const { data, error } = await supabaseAdmin
    .from("bookings")
    .select("id, organization_id, status, start_at, end_at, timezone, google_event_id, contact_id")
    .eq("id", input.bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.organization_id !== input.organizationId) return null;
  return toRecord(data);
}

/**
 * Phase 4: the AI/customer payment-required booking path (spec: "check
 * availability, create a temporary PENDING_PAYMENT booking/hold, do NOT
 * create the final Google Calendar event yet"). Deliberately a SEPARATE
 * function from createBooking() above, not a parameterized variant of it —
 * the existing manual/staff booking path (createBookingManual in
 * bookings.functions.ts, which calls createBooking()) must keep working
 * exactly as it does today, completely unaffected by this addition.
 *
 * Unlike createBooking()'s JS-level check-then-insert (adequate for a
 * booking that resolves to CONFIRMED within the same function call), a
 * payment hold can sit open for several minutes, which widens the
 * double-booking race window significantly. This calls the
 * create_booking_payment_hold Postgres function, a thin wrapper over
 * create_booking_atomic (see 20261009090000 and 20261009120000's own doc
 * comments), so the idempotency check, the per-business schedule
 * validation, the per-calendar-connection advisory lock, the full
 * time-range overlap re-check, and the insert all run inside one database
 * transaction — the same authoritative schedule check createBooking() now
 * relies on; no separate JS-level pre-check is needed here either.
 */
export type PaymentHoldRecord = BookingRecord & {
  holdExpiresAt: string | null;
  callId: string | null;
};

function toPaymentHoldRecord(row: {
  id: string;
  status: string;
  start_at: string;
  end_at: string;
  timezone: string;
  google_event_id: string | null;
  contact_id: string | null;
  hold_expires_at: string | null;
  call_id: string | null;
}): PaymentHoldRecord {
  return { ...toRecord(row), holdExpiresAt: row.hold_expires_at, callId: row.call_id };
}

export interface CreatePaymentRequiredBookingInput {
  organizationId: string;
  businessId: string;
  /** Optional — the deferred Google Calendar event (created by payment-calendar-consumer.server.ts on capture) is a convenience, not a requirement; the hold and its eventual confirmation are fully DB-backed either way. */
  calendarConnectionId?: string | null | undefined;
  serviceId?: string | null;
  agentConfigId?: string | null;
  contactId?: string | null;
  customerName?: string | undefined;
  customerPhone?: string | undefined;
  customerEmail?: string | undefined;
  startIso: string;
  endIso: string;
  timezone: string;
  source: "voice" | "whatsapp" | "website" | "manual" | "instagram";
  /** Required (unlike createBooking()'s optional field) — a payment hold must always be safely retryable, since the AI/customer flow may retry after a network hiccup before any payment has been requested. */
  idempotencyKey: string;
  /** How long the hold is honored before the expiration sweep releases it. Defaults to DEFAULT_HOLD_DURATION_MINUTES. */
  holdDurationMinutes?: number;
  /** The live voice call this hold was created from, if any — lets a later PaymentCaptured event find the right in-progress call to notify. */
  callId?: string | undefined;
  /** See CreateBookingInput.phoneCountry. */
  phoneCountry?: string | null | undefined;
}

const DEFAULT_HOLD_DURATION_MINUTES = 15;

export async function createPaymentRequiredBooking(
  supabaseAdmin: Client,
  rawInput: CreatePaymentRequiredBookingInput,
): Promise<PaymentHoldRecord> {
  if (new Date(rawInput.endIso).getTime() <= new Date(rawInput.startIso).getTime()) {
    throw new BookingError("End time must be after start time.", "INVALID_INPUT");
  }
  const input = normalizePhoneInput(rawInput);

  const contactId = await resolveContactId(supabaseAdmin, input);
  const holdExpiresAt = new Date(
    Date.now() + (input.holdDurationMinutes ?? DEFAULT_HOLD_DURATION_MINUTES) * 60_000,
  ).toISOString();

  const { data, error } = await supabaseAdmin.rpc("create_booking_payment_hold", {
    p_organization_id: input.organizationId,
    p_business_id: input.businessId,
    p_calendar_connection_id: input.calendarConnectionId ?? null,
    p_service_id: input.serviceId ?? null,
    p_agent_config_id: input.agentConfigId ?? null,
    p_contact_id: contactId,
    p_start_at: input.startIso,
    p_end_at: input.endIso,
    p_timezone: input.timezone,
    p_customer_name: input.customerName ?? null,
    p_customer_phone: input.customerPhone ?? null,
    p_customer_email: input.customerEmail ?? null,
    p_source: input.source,
    p_idempotency_key: input.idempotencyKey,
    p_hold_expires_at: holdExpiresAt,
    p_call_id: input.callId ?? null,
  });
  if (error) {
    if (error.message?.includes("SLOT_NO_LONGER_AVAILABLE")) {
      throw new BookingError("That time slot is no longer available.", "SLOT_NO_LONGER_AVAILABLE");
    }
    if (error.message?.includes("SLOT_OUTSIDE_SCHEDULE")) {
      throw new BookingError(
        "That time is outside the hospital's working schedule.",
        "SLOT_OUTSIDE_SCHEDULE",
      );
    }
    throw error;
  }
  return toPaymentHoldRecord(data);
}

// ============================================================
// Google Calendar sync recovery for CALENDAR_SYNC_FAILED bookings
// ============================================================
//
// A CALENDAR_SYNC_FAILED booking is saved in ClickAI and holds its slot;
// only its Google Calendar event is missing (or, after a failed
// reschedule, out of date). Recovery re-attempts the event and moves the
// booking to CONFIRMED only after re-reading the event from Google and
// checking it is the right one. No new columns: the retry bookkeeping
// lives in bookings.metadata —
//   calendar_sync_attempts        retries made so far (automatic + staff)
//   calendar_sync_next_attempt_at earliest next automatic retry (ISO)
//   calendar_sync_error           last failure, customer-safe text
//   calendar_sync_last_attempt_at / calendar_sync_resolved_at

/** Automatic retries stop after this many attempts; staff can still retry. */
export const MAX_AUTOMATIC_CALENDAR_SYNC_ATTEMPTS = 3;
/** Wait before automatic attempt n+1, indexed by attempts already made. */
export const CALENDAR_SYNC_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;
/** Upper bound on bookings one automatic sweep will retry. */
export const CALENDAR_SYNC_RETRY_BATCH_SIZE = 20;

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/** When the next automatic retry is due, or null once automatic retries are exhausted. */
export function nextCalendarSyncAttemptAt(attemptsMade: number, now: Date): string | null {
  if (attemptsMade >= MAX_AUTOMATIC_CALENDAR_SYNC_ATTEMPTS) return null;
  const delay = CALENDAR_SYNC_BACKOFF_MS[attemptsMade] ?? CALENDAR_SYNC_BACKOFF_MS.at(-1)!;
  return new Date(now.getTime() + delay).toISOString();
}

export function calendarSyncAttempts(metadata: unknown): number {
  const raw = metadataObject(metadata)["calendar_sync_attempts"];
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

/** Whether an automatic sweep may retry this booking now. */
export function isCalendarSyncRetryDue(
  booking: { status: string; start_at: string; metadata: unknown },
  now: Date,
): boolean {
  if (booking.status !== "CALENDAR_SYNC_FAILED") return false;
  if (new Date(booking.start_at).getTime() <= now.getTime()) return false;
  const attempts = calendarSyncAttempts(booking.metadata);
  if (attempts >= MAX_AUTOMATIC_CALENDAR_SYNC_ATTEMPTS) return false;
  const nextAt = metadataObject(booking.metadata)["calendar_sync_next_attempt_at"];
  if (typeof nextAt === "string" && new Date(nextAt).getTime() > now.getTime()) return false;
  return true;
}

function sameInstant(a: string, b: string): boolean {
  const ta = new Date(a).getTime();
  return Number.isFinite(ta) && ta === new Date(b).getTime();
}

/** The event is the live, ClickAI-tagged event for this booking at exactly the booked time. */
export function eventMatchesBooking(
  event: NormalizedCalendarEvent | null,
  booking: { id: string; start_at: string; end_at: string },
): boolean {
  return Boolean(
    event &&
    event.id &&
    event.status !== "cancelled" &&
    event.clickaiBookingId === booking.id &&
    sameInstant(event.start, booking.start_at) &&
    sameInstant(event.end, booking.end_at),
  );
}

export type CalendarSyncRetryOutcome =
  | { outcome: "confirmed"; bookingId: string; googleEventId: string; reusedExistingEvent: boolean }
  | {
      outcome: "skipped";
      bookingId: string;
      reason:
        | "not_found"
        | "not_sync_failed"
        | "in_past"
        | "attempts_exhausted"
        | "not_due"
        | "no_calendar_connection"
        | "already_in_progress";
    }
  | { outcome: "failed"; bookingId: string; code: string; attempts: number }
  | { outcome: "lost_race"; bookingId: string };

export type ResolveCalendarProvider = (
  connectionId: string,
) => Promise<{ provider: CalendarProvider; calendarId: string }>;

const RETRY_BOOKING_COLUMNS =
  "id, organization_id, business_id, status, start_at, end_at, timezone, customer_name, google_event_id, calendar_connection_id, metadata, updated_at";

/**
 * Retries the Google Calendar event for one CALENDAR_SYNC_FAILED booking.
 *
 * - Tenant-scoped: the booking must belong to `organizationId`, and the
 *   Google connection used must be a CONNECTED one of the same
 *   organization and business.
 * - Future bookings only. `trigger: "automatic"` additionally respects the
 *   attempt cap and backoff; a staff retry is an explicit human action and
 *   is allowed past the cap.
 * - Claims the attempt with an optimistic update (status still
 *   CALENDAR_SYNC_FAILED and updated_at unchanged) so a cron sweep and a
 *   staff click can never both create an event.
 * - Idempotent event creation: re-uses the booking's existing event, or an
 *   event a previous attempt already tagged with this booking id, before
 *   ever creating one.
 * - Confirms only after re-reading the event from Google and checking id,
 *   booking tag, status and exact start/end (eventMatchesBooking).
 * - Logs ids, codes and counts only — never tokens, phone numbers or names.
 */
export async function retryBookingCalendarSync(
  supabaseAdmin: Client,
  resolveProvider: ResolveCalendarProvider,
  input: {
    organizationId: string;
    bookingId: string;
    trigger: "automatic" | "staff";
    now?: Date | undefined;
  },
): Promise<CalendarSyncRetryOutcome> {
  const now = input.now ?? new Date();
  const bookingId = input.bookingId;
  const LOG = "booking_service:calendar_sync_retry";

  const { data: booking, error } = await supabaseAdmin
    .from("bookings")
    .select(RETRY_BOOKING_COLUMNS)
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!booking || booking.organization_id !== input.organizationId) {
    return { outcome: "skipped", bookingId, reason: "not_found" };
  }
  if (booking.status !== "CALENDAR_SYNC_FAILED") {
    return { outcome: "skipped", bookingId, reason: "not_sync_failed" };
  }
  if (new Date(booking.start_at).getTime() <= now.getTime()) {
    return { outcome: "skipped", bookingId, reason: "in_past" };
  }
  const attempts = calendarSyncAttempts(booking.metadata);
  if (input.trigger === "automatic") {
    if (attempts >= MAX_AUTOMATIC_CALENDAR_SYNC_ATTEMPTS) {
      return { outcome: "skipped", bookingId, reason: "attempts_exhausted" };
    }
    if (!isCalendarSyncRetryDue(booking, now)) {
      return { outcome: "skipped", bookingId, reason: "not_due" };
    }
  }

  // The connection must be live and belong to this booking's own
  // organization and business — never another tenant's calendar.
  let connectionQuery = supabaseAdmin
    .from("google_calendar_connections")
    .select("id")
    .eq("organization_id", booking.organization_id)
    .eq("business_id", booking.business_id)
    .eq("status", "CONNECTED");
  if (booking.calendar_connection_id) {
    connectionQuery = connectionQuery.eq("id", booking.calendar_connection_id);
  }
  const { data: connection, error: connectionError } = await connectionQuery.limit(1).maybeSingle();
  if (connectionError) throw connectionError;
  if (!connection) {
    return { outcome: "skipped", bookingId, reason: "no_calendar_connection" };
  }

  // Claim this attempt. The updated_at trigger bumps updated_at on every
  // write, so a concurrent claimant's guarded update matches zero rows.
  const attemptNumber = attempts + 1;
  const baseMetadata = metadataObject(booking.metadata);
  const claimedMetadata = {
    ...baseMetadata,
    calendar_sync_attempts: attemptNumber,
    calendar_sync_last_attempt_at: now.toISOString(),
    calendar_sync_next_attempt_at: nextCalendarSyncAttemptAt(attemptNumber, now),
  };
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("bookings")
    .update({ metadata: claimedMetadata })
    .eq("id", bookingId)
    .eq("status", "CALENDAR_SYNC_FAILED")
    .eq("updated_at", booking.updated_at)
    .select("id");
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) {
    return { outcome: "skipped", bookingId, reason: "already_in_progress" };
  }

  let createdEventId: string | null = null;
  let verifiedEvent: NormalizedCalendarEvent | null = null;
  let reusedExistingEvent = false;
  let provider: CalendarProvider | null = null;
  let calendarId: string | null = null;
  try {
    const resolved = await resolveProvider(connection.id);
    provider = resolved.provider;
    calendarId = resolved.calendarId;

    // 1. An event this booking already points at (e.g. a failed
    //    reschedule left it at the old time) — patch it into place.
    let candidate: NormalizedCalendarEvent | null = null;
    if (booking.google_event_id) {
      const current = await provider.getEvent(calendarId, booking.google_event_id);
      if (current && current.status !== "cancelled") candidate = current;
    }
    // 2. An event a previous, partially failed attempt created and tagged.
    if (!candidate && provider.findEventByBookingId) {
      candidate = await provider.findEventByBookingId(calendarId, bookingId);
    }

    if (candidate) {
      reusedExistingEvent = true;
      if (!eventMatchesBooking(candidate, booking)) {
        await provider.updateEvent(calendarId, candidate.id, {
          startIso: booking.start_at,
          endIso: booking.end_at,
          timezone: booking.timezone,
        });
      }
      verifiedEvent = await provider.getEvent(calendarId, candidate.id);
      // An event created before tagging existed can be the booking's own
      // google_event_id without the tag; accept it only via that link.
      if (
        verifiedEvent &&
        !verifiedEvent.clickaiBookingId &&
        verifiedEvent.id === booking.google_event_id
      ) {
        verifiedEvent = { ...verifiedEvent, clickaiBookingId: bookingId };
      }
    } else {
      const created = await provider.createEvent({
        calendarId,
        title: `Appointment - ${booking.customer_name ?? "Customer"}`,
        description: [`ClickAI Booking ID: ${bookingId}`, "Created by: ClickAI"].join("\n"),
        startIso: booking.start_at,
        endIso: booking.end_at,
        timezone: booking.timezone,
        clickaiBookingId: bookingId,
      });
      createdEventId = created.id;
      verifiedEvent = await provider.getEvent(calendarId, created.id);
    }

    if (!eventMatchesBooking(verifiedEvent, booking)) {
      throw new CalendarProviderError(
        "CALENDAR_CONFLICT",
        "The calendar event could not be verified after it was written.",
      );
    }
  } catch (err) {
    const code = err instanceof CalendarProviderError ? err.code : (err as { code?: string })?.code;
    const safeCode = typeof code === "string" ? code : "UNKNOWN";
    if (createdEventId && provider && calendarId) {
      // Never leave an unverified event behind; the next attempt starts clean.
      await cleanupOrphanedEvent(provider, calendarId, createdEventId, bookingId);
    }
    await supabaseAdmin
      .from("bookings")
      .update({
        metadata: {
          ...claimedMetadata,
          calendar_sync_error:
            err instanceof CalendarProviderError
              ? err.message
              : "Failed to create the calendar event.",
        },
      })
      .eq("id", bookingId)
      .eq("status", "CALENDAR_SYNC_FAILED");
    console.warn(`${LOG}:failed`, {
      bookingId,
      trigger: input.trigger,
      attempt: attemptNumber,
      code: safeCode,
    });
    return { outcome: "failed", bookingId, code: safeCode, attempts: attemptNumber };
  }

  // Verified: resolve to CONFIRMED, exactly like a booking whose event was
  // created on the first try (status + google_event_id), guarded so a
  // booking cancelled/rescheduled meanwhile is never overwritten.
  const eventId = verifiedEvent!.id;
  const resolvedMetadata = { ...claimedMetadata, calendar_sync_resolved_at: now.toISOString() };
  delete (resolvedMetadata as Record<string, unknown>)["calendar_sync_error"];
  delete (resolvedMetadata as Record<string, unknown>)["calendar_sync_next_attempt_at"];
  const { data: confirmed, error: confirmError } = await supabaseAdmin
    .from("bookings")
    .update({ status: "CONFIRMED", google_event_id: eventId, metadata: resolvedMetadata })
    .eq("id", bookingId)
    .eq("status", "CALENDAR_SYNC_FAILED")
    .select("id");
  if (confirmError || !confirmed || confirmed.length === 0) {
    if (createdEventId && provider && calendarId) {
      await cleanupOrphanedEvent(provider, calendarId, createdEventId, bookingId);
    }
    if (confirmError) throw confirmError;
    console.warn(`${LOG}:lost_race`, { bookingId, trigger: input.trigger });
    return { outcome: "lost_race", bookingId };
  }

  console.info(`${LOG}:confirmed`, {
    bookingId,
    trigger: input.trigger,
    attempt: attemptNumber,
    reusedExistingEvent,
  });
  return { outcome: "confirmed", bookingId, googleEventId: eventId, reusedExistingEvent };
}

/**
 * One bounded automatic sweep: future CALENDAR_SYNC_FAILED bookings whose
 * backoff has elapsed and that have attempts left, soonest appointment
 * first, at most `limit` per run. Each booking is retried in its own
 * organization's scope; one failure never stops the sweep.
 */
export async function retryDueCalendarSyncFailures(
  supabaseAdmin: Client,
  resolveProvider: ResolveCalendarProvider,
  options: { now?: Date | undefined; limit?: number | undefined } = {},
): Promise<{ examined: number; attempted: number; confirmed: number; failed: number }> {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? CALENDAR_SYNC_RETRY_BATCH_SIZE, 100));
  const { data, error } = await supabaseAdmin
    .from("bookings")
    .select("id, organization_id, status, start_at, metadata")
    .eq("status", "CALENDAR_SYNC_FAILED")
    .gt("start_at", now.toISOString())
    .order("start_at", { ascending: true })
    .limit(limit * 5);
  if (error) throw error;

  const due = (data ?? []).filter((b) => isCalendarSyncRetryDue(b, now)).slice(0, limit);
  let confirmed = 0;
  let failed = 0;
  for (const b of due) {
    try {
      const result = await retryBookingCalendarSync(supabaseAdmin, resolveProvider, {
        organizationId: b.organization_id,
        bookingId: b.id,
        trigger: "automatic",
        now,
      });
      if (result.outcome === "confirmed") confirmed++;
      else if (result.outcome === "failed") failed++;
    } catch {
      failed++;
      console.warn("booking_service:calendar_sync_retry:error", { bookingId: b.id });
    }
  }
  return { examined: (data ?? []).length, attempted: due.length, confirmed, failed };
}
