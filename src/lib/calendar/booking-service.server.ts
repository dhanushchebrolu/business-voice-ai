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
import type { CalendarProvider } from "./calendar-provider.ts";
import { CalendarProviderError } from "./calendar-provider.ts";

type Client = SupabaseClient<Database>;

export class BookingError extends Error {
  code: "SLOT_NO_LONGER_AVAILABLE" | "NOT_FOUND" | "INVALID_INPUT";
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
  calendarConnectionId: string;
  calendarId: string;
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
}

/** Proper interval overlap — see calendar-service.server.ts's own `overlaps` for why this, not an exact-start comparison. */
function intervalsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return (
    new Date(aStart).getTime() < new Date(bEnd).getTime() &&
    new Date(bStart).getTime() < new Date(aEnd).getTime()
  );
}

/**
 * Creates a booking. Sequence: insert the booking row first
 * (PENDING_CONFIRMATION), then create the Google event, then mark
 * CONFIRMED only once the event exists — never the reverse, which would
 * let a customer be told "confirmed" before anything durable backs that
 * claim.
 *
 * Concurrency: the idempotency check, the internal-conflict re-check, and
 * the insert all run inside ONE Postgres transaction via the
 * create_booking_atomic RPC (see its own migration doc comment) —
 * pg_advisory_xact_lock keyed on the calendar connection serializes
 * concurrent attempts long enough for a FULL time-range overlap check
 * (not just an exact-start-time index) to be race-free. Two concurrent
 * requests for overlapping-but-different-start times on the same
 * connection can never both succeed.
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
 */
export async function createBooking(
  supabaseAdmin: Client,
  provider: CalendarProvider,
  input: CreateBookingInput,
): Promise<BookingRecord> {
  if (new Date(input.endIso).getTime() <= new Date(input.startIso).getTime()) {
    throw new BookingError("End time must be after start time.", "INVALID_INPUT");
  }

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

  const { data: bookingRow, error: rpcError } = await supabaseAdmin.rpc("create_booking_atomic", {
    p_organization_id: input.organizationId,
    p_business_id: input.businessId,
    p_calendar_connection_id: input.calendarConnectionId,
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
    p_status: "PENDING_CONFIRMATION",
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

  const title = `Appointment - ${input.customerName ?? "Customer"}`;
  const description = [
    `Business: ${input.businessName}`,
    input.customerPhone ? `Phone: ${input.customerPhone}` : null,
    `ClickAI Booking ID: ${booking.id}`,
    "Created by: ClickAI AI Agent",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const event = await provider.createEvent({
      calendarId: input.calendarId,
      title,
      description,
      startIso: input.startIso,
      endIso: input.endIso,
      timezone: input.timezone,
    });
    const { data: confirmed, error: confirmError } = await supabaseAdmin
      .from("bookings")
      .update({ status: "CONFIRMED", google_event_id: event.id })
      .eq("id", booking.id)
      .select("id, status, start_at, end_at, timezone, google_event_id, contact_id")
      .single();
    if (confirmError) throw confirmError;
    return toRecord(confirmed);
  } catch (err) {
    // Reconciliation (spec section 69): the booking already exists and
    // must not be silently lost. Mark it CALENDAR_SYNC_FAILED rather than
    // leaving it PENDING_CONFIRMATION forever or deleting it.
    const message =
      err instanceof CalendarProviderError ? err.message : "Failed to create the calendar event.";
    await supabaseAdmin
      .from("bookings")
      .update({ status: "CALENDAR_SYNC_FAILED", metadata: { calendar_sync_error: message } })
      .eq("id", booking.id);
    throw err;
  }
}

export interface RescheduleBookingInput {
  organizationId: string;
  bookingId: string;
  calendarId: string;
  newStartIso: string;
  newEndIso: string;
}

export async function rescheduleBooking(
  supabaseAdmin: Client,
  provider: CalendarProvider,
  input: RescheduleBookingInput,
): Promise<BookingRecord> {
  const { data: booking, error } = await supabaseAdmin
    .from("bookings")
    .select("id, organization_id, calendar_connection_id, google_event_id, timezone, status")
    .eq("id", input.bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!booking || booking.organization_id !== input.organizationId) {
    throw new BookingError("Booking not found.", "NOT_FOUND");
  }

  if (booking.calendar_connection_id) {
    const { data: conflicting, error: conflictError } = await supabaseAdmin
      .from("bookings")
      .select("id")
      .eq("calendar_connection_id", booking.calendar_connection_id)
      .neq("id", input.bookingId)
      .not("status", "in", "(CANCELLED,NO_SHOW)")
      .lt("start_at", input.newEndIso)
      .gt("end_at", input.newStartIso)
      .limit(1);
    if (conflictError) throw conflictError;
    if (conflicting && conflicting.length > 0) {
      throw new BookingError("That time slot is no longer available.", "SLOT_NO_LONGER_AVAILABLE");
    }
  }

  if (booking.google_event_id) {
    await provider.updateEvent(input.calendarId, booking.google_event_id, {
      startIso: input.newStartIso,
      endIso: input.newEndIso,
      timezone: booking.timezone,
    });
  }

  const { data: updated, error: updateError } = await supabaseAdmin
    .from("bookings")
    .update({ start_at: input.newStartIso, end_at: input.newEndIso, status: "RESCHEDULED" })
    .eq("id", input.bookingId)
    .select("id, status, start_at, end_at, timezone, google_event_id, contact_id")
    .single();
  if (updateError) throw updateError;
  return toRecord(updated);
}

export interface CancelBookingInput {
  organizationId: string;
  bookingId: string;
  calendarId: string;
  reason?: string | undefined;
}

export async function cancelBooking(
  supabaseAdmin: Client,
  provider: CalendarProvider,
  input: CancelBookingInput,
): Promise<BookingRecord> {
  const { data: booking, error } = await supabaseAdmin
    .from("bookings")
    .select("id, organization_id, google_event_id, notes")
    .eq("id", input.bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!booking || booking.organization_id !== input.organizationId) {
    throw new BookingError("Booking not found.", "NOT_FOUND");
  }

  if (booking.google_event_id) {
    try {
      await provider.deleteEvent(input.calendarId, booking.google_event_id);
    } catch (err) {
      // Deleting an already-gone event is not a failure — the desired end
      // state (no event) already holds.
      if (!(err instanceof CalendarProviderError && err.code === "CALENDAR_NOT_FOUND")) throw err;
    }
  }

  const notes = input.reason
    ? [booking.notes, `Cancelled: ${input.reason}`].filter(Boolean).join("\n")
    : booking.notes;

  const { data: cancelled, error: updateError } = await supabaseAdmin
    .from("bookings")
    .update({ status: "CANCELLED", notes })
    .eq("id", input.bookingId)
    .select("id, status, start_at, end_at, timezone, google_event_id, contact_id")
    .single();
  if (updateError) throw updateError;
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
 * create_booking_payment_hold Postgres function (see the Phase 4 DB
 * migration's own doc comment for exactly why a JS-level advisory lock
 * cannot provide this guarantee across separate PostgREST calls) so the
 * idempotency check, the advisory lock, the full time-range overlap
 * re-check, and the insert all run inside one database transaction.
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
  calendarConnectionId: string;
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
}

const DEFAULT_HOLD_DURATION_MINUTES = 15;

export async function createPaymentRequiredBooking(
  supabaseAdmin: Client,
  input: CreatePaymentRequiredBookingInput,
): Promise<PaymentHoldRecord> {
  if (new Date(input.endIso).getTime() <= new Date(input.startIso).getTime()) {
    throw new BookingError("End time must be after start time.", "INVALID_INPUT");
  }

  const contactId = await resolveContactId(supabaseAdmin, input);
  const holdExpiresAt = new Date(
    Date.now() + (input.holdDurationMinutes ?? DEFAULT_HOLD_DURATION_MINUTES) * 60_000,
  ).toISOString();

  const { data, error } = await supabaseAdmin.rpc("create_booking_payment_hold", {
    p_organization_id: input.organizationId,
    p_business_id: input.businessId,
    p_calendar_connection_id: input.calendarConnectionId,
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
    throw error;
  }
  return toPaymentHoldRecord(data);
}
