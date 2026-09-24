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
  source: "voice" | "whatsapp" | "website" | "manual";
  idempotencyKey?: string | undefined;
  notes?: string | undefined;
  businessName: string; // for the Google event description
}

/**
 * Creates a booking. Sequence exactly matches spec section 21: insert the
 * booking row first (PENDING_CONFIRMATION), then create the Google event,
 * then mark CONFIRMED only once the event exists — never the reverse,
 * which would let a customer be told "confirmed" before anything durable
 * backs that claim.
 */
export async function createBooking(
  supabaseAdmin: Client,
  provider: CalendarProvider,
  input: CreateBookingInput,
): Promise<BookingRecord> {
  if (new Date(input.endIso).getTime() <= new Date(input.startIso).getTime()) {
    throw new BookingError("End time must be after start time.", "INVALID_INPUT");
  }

  // Idempotent creation: a retried request with the same key returns the
  // existing booking instead of creating a duplicate Google event.
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

  // Re-check availability immediately before insert (spec section 22) —
  // the caller already ran computeAvailability once to present slots to
  // the customer, but time has passed since then, so re-verify against
  // the current state of this exact calendar connection.
  const { data: conflicting, error: conflictError } = await supabaseAdmin
    .from("bookings")
    .select("id")
    .eq("calendar_connection_id", input.calendarConnectionId)
    .not("status", "in", "(CANCELLED,NO_SHOW)")
    .lt("start_at", input.endIso)
    .gt("end_at", input.startIso)
    .limit(1);
  if (conflictError) throw conflictError;
  if (conflicting && conflicting.length > 0) {
    throw new BookingError("That time slot is no longer available.", "SLOT_NO_LONGER_AVAILABLE");
  }

  const contactId = await resolveContactId(supabaseAdmin, input);

  const { data: booking, error: insertError } = await supabaseAdmin
    .from("bookings")
    .insert({
      organization_id: input.organizationId,
      business_id: input.businessId,
      calendar_connection_id: input.calendarConnectionId,
      service_id: input.serviceId ?? null,
      agent_config_id: input.agentConfigId ?? null,
      contact_id: contactId,
      status: "PENDING_CONFIRMATION",
      start_at: input.startIso,
      end_at: input.endIso,
      timezone: input.timezone,
      customer_name: input.customerName ?? null,
      customer_phone: input.customerPhone ?? null,
      customer_email: input.customerEmail ?? null,
      source: input.source,
      idempotency_key: input.idempotencyKey ?? null,
      notes: input.notes ?? null,
    })
    .select("id, status, start_at, end_at, timezone, google_event_id, contact_id")
    .single();
  if (insertError) {
    // The DB-level exact-start-time unique index (idx_bookings_no_exact_start_clash)
    // is the last line of defense against the race the application-level
    // re-check above narrows but cannot fully close without btree_gist.
    if (insertError.code === "23505") {
      throw new BookingError("That time slot is no longer available.", "SLOT_NO_LONGER_AVAILABLE");
    }
    throw insertError;
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
