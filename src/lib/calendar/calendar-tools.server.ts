/**
 * The five calendar AI tools (spec section 14): check_calendar_availability,
 * create_calendar_event, get_calendar_event, update_calendar_event,
 * cancel_calendar_event. Each validates tenant ownership, the business's
 * connection status, and the calling agent's tool permission before
 * touching the calendar/booking services — the AI Agent Core calls these,
 * never the provider or the raw services directly (spec section 13's
 * "AI Agent -> Calendar Tool -> Calendar Service -> Provider").
 *
 * Every tool returns a { success, data } | { success, error } result —
 * never throws — because this is the exact boundary an eventual LLM
 * function-calling harness receives verbatim; a raw exception would be a
 * malformed tool result, not a usable one. See the Phase 2 report for the
 * honest state of what calls these today (nothing live yet — no in-process
 * tool-calling loop exists in this codebase's AI Agent Core; this is the
 * ready-to-integrate layer, not a claim that Sarvam/WhatsApp/website chat
 * already invoke it mid-conversation).
 *
 * Tool permissions (spec section 44) are read from the business's one
 * agent_configs row's `capabilities` JSONB — reusing that existing column
 * rather than adding new permission tables. Keys: calendar_read,
 * calendar_book, calendar_reschedule, calendar_cancel. Missing/false means
 * denied; there is no implicit default-allow.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  computeAvailability,
  type AvailabilitySlot,
  type BusinessHourOverride,
} from "./calendar-service.server.ts";
import { businessDayUtcBounds } from "./timezone.ts";
import {
  createBooking,
  rescheduleBooking,
  cancelBooking,
  getBooking,
  BookingError,
  type BookingRecord,
} from "./booking-service.server.ts";
import {
  getCalendarProviderForConnection,
  GoogleCalendarConnectionError,
} from "../google-calendar/google-calendar-connection.server.ts";
import { CalendarProviderError } from "./calendar-provider.ts";
import {
  describeInvalidWeeklyDay,
  describeInvalidOverride,
  logInvalidBusinessHoursOnce,
} from "./business-hours-validation.ts";

type Client = SupabaseClient<Database>;

export type ToolPermission =
  | "calendar_read"
  | "calendar_book"
  | "calendar_reschedule"
  | "calendar_cancel"
  // Phase 4 payment tools (payment-tools.server.ts) — read from the same
  // agent_configs.capabilities column, same default-deny convention.
  | "booking_payment_required"
  | "payment_request";

export type ToolResult<T> =
  { success: true; data: T } | { success: false; error: { code: string; message: string } };

export function fail<T>(code: string, message: string): ToolResult<T> {
  return { success: false, error: { code, message } };
}

export interface ResolvedContext {
  /**
   * Null when this business has no CONNECTED Google Calendar — ClickAI's
   * own database-backed scheduling (business_hours + business_hour_
   * overrides + bookings, via computeAvailability) is the authoritative
   * source of truth either way; a connection is an optional convenience
   * that also mirrors confirmed bookings into an external calendar. Never
   * an error on its own — callers check for null, not an errorCode, to
   * decide whether to skip the Google-specific parts of their own logic.
   */
  connectionId: string | null;
  calendarId: string | null;
  timezone: string;
  businessName: string;
  businessHours: {
    dayOfWeek: number;
    isClosed: boolean;
    intervals: { start: string; end: string }[];
  }[];
}

export async function resolveCalendarContext(
  supabaseAdmin: Client,
  organizationId: string,
  businessId: string,
): Promise<ResolvedContext | { errorCode: string; message: string }> {
  const { data: business, error: businessError } = await supabaseAdmin
    .from("businesses")
    .select("id, organization_id, name, timezone")
    .eq("id", businessId)
    .maybeSingle();
  if (businessError) throw businessError;
  if (!business || business.organization_id !== organizationId) {
    return {
      errorCode: "BUSINESS_NOT_FOUND",
      message: "That business does not belong to your workspace.",
    };
  }

  // Google Calendar is optional (see ResolvedContext's own doc comment) —
  // no connection, or one that isn't CONNECTED/fully configured, is a
  // normal, non-error state: every tool below falls back to ClickAI's own
  // database-backed scheduling instead of failing.
  const { data: connection, error: connectionError } = await supabaseAdmin
    .from("google_calendar_connections")
    .select("id, calendar_id, status")
    .eq("organization_id", organizationId)
    .eq("business_id", businessId)
    .eq("provider", "google")
    .maybeSingle();
  if (connectionError) throw connectionError;
  const hasUsableConnection = Boolean(
    connection && connection.status === "CONNECTED" && connection.calendar_id,
  );

  const { data: hoursRows, error: hoursError } = await supabaseAdmin
    .from("business_hours")
    .select("day_of_week, is_closed, intervals")
    .eq("business_id", businessId);
  if (hoursError) throw hoursError;

  const businessHours = (hoursRows ?? []).map((r) => ({
    dayOfWeek: r.day_of_week,
    isClosed: r.is_closed,
    intervals: (r.intervals as unknown as { start: string; end: string }[]) ?? [],
  }));

  // Fail-closed behavior for a legacy-invalid row (e.g. a reversed
  // {"start":"23:59","end":"00:00"} pair) is already guaranteed by
  // computeAvailability's own range filtering — this only adds a visible,
  // deduplicated server-side trace so the AI voice agent's "no slots" for
  // such a business is diagnosable, not indistinguishable from a normal
  // fully-closed day. No patient data is ever included — only schema
  // identifiers and the offending interval's own HH:mm strings.
  for (const day of businessHours) {
    const warning = describeInvalidWeeklyDay(day);
    if (warning) {
      logInvalidBusinessHoursOnce(`${businessId}:weekly:${day.dayOfWeek}`, {
        businessId,
        dayOfWeek: day.dayOfWeek,
        intervals: day.intervals,
      });
    }
  }

  return {
    connectionId: hasUsableConnection ? connection!.id : null,
    calendarId: hasUsableConnection ? connection!.calendar_id : null,
    timezone: business.timezone,
    businessName: business.name,
    businessHours,
  };
}

/**
 * The single date's daily override (business_hour_overrides), if one
 * exists — shared by both the availability lookup (so the AI never offers
 * a closed/overridden-closed slot) and the atomic booking revalidation
 * (so a staff member closing a slot mid-booking can't be bypassed; see
 * booking-service.server.ts). Returns undefined (not an empty override)
 * when no row exists for that date, so callers can tell "no override" from
 * "an override that opens/closes nothing" — resolveEffectiveIntervals in
 * calendar-service.server.ts already treats both the same way, but keeping
 * the distinction here costs nothing and matches the table's own shape.
 */
export async function resolveOverrideForDate(
  supabaseAdmin: Client,
  businessId: string,
  dateIso: string,
): Promise<BusinessHourOverride | undefined> {
  const { data, error } = await supabaseAdmin
    .from("business_hour_overrides")
    .select("is_full_day_closure, intervals")
    .eq("business_id", businessId)
    .eq("override_date", dateIso)
    .maybeSingle();
  if (error) throw error;
  if (!data) return undefined;
  const override = {
    isFullDayClosure: data.is_full_day_closure,
    intervals:
      (data.intervals as unknown as { start: string; end: string; isOpen: boolean }[]) ?? [],
  };

  const warning = describeInvalidOverride(override, dateIso);
  if (warning) {
    logInvalidBusinessHoursOnce(`${businessId}:override:${dateIso}`, {
      businessId,
      dateIso,
      intervals: override.intervals,
    });
  }

  return override;
}

export async function assertToolPermission(
  supabaseAdmin: Client,
  organizationId: string,
  businessId: string,
  permission: ToolPermission,
): Promise<{ errorCode: string; message: string } | null> {
  const { data: agent, error } = await supabaseAdmin
    .from("agent_configs")
    .select("organization_id, capabilities")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw error;
  if (!agent || agent.organization_id !== organizationId) {
    return { errorCode: "AGENT_NOT_FOUND", message: "No agent is configured for this business." };
  }
  const capabilities = (agent.capabilities as Record<string, unknown>) ?? {};
  if (capabilities[permission] !== true) {
    return {
      errorCode: "TOOL_NOT_PERMITTED",
      message: `This agent is not permitted to use ${permission}.`,
    };
  }
  return null;
}

export interface CheckAvailabilityInput {
  organizationId: string;
  businessId: string;
  dateIso: string;
  durationMinutes: number;
  bufferMinutes?: number;
}

export async function check_calendar_availability(
  supabaseAdmin: Client,
  input: CheckAvailabilityInput,
): Promise<ToolResult<{ slots: AvailabilitySlot[] }>> {
  const permissionError = await assertToolPermission(
    supabaseAdmin,
    input.organizationId,
    input.businessId,
    "calendar_read",
  );
  if (permissionError) return fail(permissionError.errorCode, permissionError.message);

  const ctx = await resolveCalendarContext(supabaseAdmin, input.organizationId, input.businessId);
  if ("errorCode" in ctx) return fail(ctx.errorCode, ctx.message);

  try {
    // Timezone-correct business-day boundary (production bug: the naive
    // `${dateIso}T00:00:00.000Z`..`T23:59:59.999Z` window used here before
    // is only correct when the business timezone is literally UTC — for
    // a timezone ahead of UTC it starts hours after the business day
    // actually begins locally, and for one behind UTC it misses the
    // business's own late-evening hours, which roll into the next UTC
    // calendar date. See businessDayUtcBounds's own doc comment).
    const { start: dayStartUtc, end: dayEndUtc } = businessDayUtcBounds(
      input.dateIso,
      ctx.timezone,
    );
    const dayStart = dayStartUtc.toISOString();
    const dayEnd = dayEndUtc.toISOString();

    // Google Calendar is optional (see resolveCalendarContext's own doc
    // comment) — with no connection, there is no external calendar to
    // recheck, so googleBusyPeriods is simply empty; ClickAI's own
    // bookings table (queried below, scoped by business_id — see why,
    // not calendar_connection_id, in the comment on that query) remains
    // fully authoritative either way.
    const googleBusyPeriodsPromise =
      ctx.connectionId && ctx.calendarId
        ? getCalendarProviderForConnection(supabaseAdmin, ctx.connectionId).then(
            ({ provider, calendarId }) =>
              provider.getBusyPeriods({ calendarId, timeMinIso: dayStart, timeMaxIso: dayEnd }),
          )
        : Promise.resolve([]);

    const [googleBusyPeriods, existingBookingsRes, override] = await Promise.all([
      googleBusyPeriodsPromise,
      supabaseAdmin
        .from("bookings")
        // Scoped by business_id, not calendar_connection_id: this
        // business's own schedule is what must never double-book,
        // regardless of whether any particular row happens to carry a
        // Google connection id — the identical reasoning (and the exact
        // bug this closes) as the business_id-scoped overlap check added
        // to create_booking_atomic/reschedule_booking_atomic in
        // 20261010150000_business_scoped_overlap_and_default_duration.sql.
        // Scoping this read by calendar_connection_id instead would mean
        // `= NULL`, which never matches any row, so a business with no
        // Google connection would see every one of its own existing
        // bookings as "not busy" and the AI would offer already-booked
        // slots as available.
        .select("start_at, end_at")
        .eq("business_id", input.businessId)
        .not("status", "in", "(CANCELLED,NO_SHOW)")
        .gte("start_at", dayStart)
        .lt("start_at", dayEnd),
      resolveOverrideForDate(supabaseAdmin, input.businessId, input.dateIso),
    ]);
    if (existingBookingsRes.error) throw existingBookingsRes.error;

    const slots = computeAvailability({
      dateIso: input.dateIso,
      timezone: ctx.timezone,
      businessHours: ctx.businessHours,
      override,
      durationMinutes: input.durationMinutes,
      bufferMinutes: input.bufferMinutes,
      googleBusyPeriods,
      existingBookings: (existingBookingsRes.data ?? []).map((b) => ({
        start: b.start_at,
        end: b.end_at,
      })),
    });
    return { success: true, data: { slots } };
  } catch (err) {
    return mapToolError(err);
  }
}

export interface CreateCalendarEventInput {
  organizationId: string;
  businessId: string;
  agentConfigId?: string | undefined;
  serviceId?: string | undefined;
  contactId?: string | undefined;
  customerName?: string | undefined;
  customerPhone?: string | undefined;
  customerEmail?: string | undefined;
  startIso: string;
  endIso: string;
  source: "voice" | "whatsapp" | "website" | "manual" | "instagram";
  idempotencyKey?: string | undefined;
  notes?: string | undefined;
}

export async function create_calendar_event(
  supabaseAdmin: Client,
  input: CreateCalendarEventInput,
): Promise<ToolResult<BookingRecord>> {
  const permissionError = await assertToolPermission(
    supabaseAdmin,
    input.organizationId,
    input.businessId,
    "calendar_book",
  );
  if (permissionError) return fail(permissionError.errorCode, permissionError.message);

  const ctx = await resolveCalendarContext(supabaseAdmin, input.organizationId, input.businessId);
  if ("errorCode" in ctx) return fail(ctx.errorCode, ctx.message);

  try {
    // Google Calendar is optional — see resolveCalendarContext's own doc
    // comment. createBooking() itself confirms directly with no external
    // event when provider/calendarId are null.
    const providerInfo = ctx.connectionId
      ? await getCalendarProviderForConnection(supabaseAdmin, ctx.connectionId)
      : null;
    const booking = await createBooking(supabaseAdmin, providerInfo?.provider ?? null, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      calendarConnectionId: ctx.connectionId,
      calendarId: providerInfo?.calendarId ?? null,
      serviceId: input.serviceId ?? null,
      agentConfigId: input.agentConfigId ?? null,
      contactId: input.contactId ?? null,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      customerEmail: input.customerEmail,
      startIso: input.startIso,
      endIso: input.endIso,
      timezone: ctx.timezone,
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      notes: input.notes,
      businessName: ctx.businessName,
    });
    return { success: true, data: booking };
  } catch (err) {
    return mapToolError(err);
  }
}

export interface UpdateCalendarEventInput {
  organizationId: string;
  businessId: string;
  bookingId: string;
  newStartIso: string;
  newEndIso: string;
}

export async function update_calendar_event(
  supabaseAdmin: Client,
  input: UpdateCalendarEventInput,
): Promise<ToolResult<BookingRecord>> {
  const permissionError = await assertToolPermission(
    supabaseAdmin,
    input.organizationId,
    input.businessId,
    "calendar_reschedule",
  );
  if (permissionError) return fail(permissionError.errorCode, permissionError.message);

  const ctx = await resolveCalendarContext(supabaseAdmin, input.organizationId, input.businessId);
  if ("errorCode" in ctx) return fail(ctx.errorCode, ctx.message);

  try {
    // Google Calendar is optional — rescheduleBooking() itself only ever
    // touches the calendar when the booking row it looked up actually has
    // a google_event_id, so passing null here is always safe.
    const providerInfo = ctx.connectionId
      ? await getCalendarProviderForConnection(supabaseAdmin, ctx.connectionId)
      : null;
    const booking = await rescheduleBooking(supabaseAdmin, providerInfo?.provider ?? null, {
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      calendarId: providerInfo?.calendarId ?? null,
      newStartIso: input.newStartIso,
      newEndIso: input.newEndIso,
    });
    return { success: true, data: booking };
  } catch (err) {
    return mapToolError(err);
  }
}

export interface CancelCalendarEventInput {
  organizationId: string;
  businessId: string;
  bookingId: string;
  reason?: string | undefined;
}

export async function cancel_calendar_event(
  supabaseAdmin: Client,
  input: CancelCalendarEventInput,
): Promise<ToolResult<BookingRecord>> {
  const permissionError = await assertToolPermission(
    supabaseAdmin,
    input.organizationId,
    input.businessId,
    "calendar_cancel",
  );
  if (permissionError) return fail(permissionError.errorCode, permissionError.message);

  const ctx = await resolveCalendarContext(supabaseAdmin, input.organizationId, input.businessId);
  if ("errorCode" in ctx) return fail(ctx.errorCode, ctx.message);

  try {
    // Google Calendar is optional — cancelBooking() itself only ever
    // touches the calendar when the cancelled booking row actually has a
    // google_event_id, so passing null here is always safe.
    const providerInfo = ctx.connectionId
      ? await getCalendarProviderForConnection(supabaseAdmin, ctx.connectionId)
      : null;
    const booking = await cancelBooking(supabaseAdmin, providerInfo?.provider ?? null, {
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      calendarId: providerInfo?.calendarId ?? null,
      reason: input.reason,
    });
    return { success: true, data: booking };
  } catch (err) {
    return mapToolError(err);
  }
}

export interface GetCalendarEventInput {
  organizationId: string;
  businessId: string;
  bookingId: string;
}

export async function get_calendar_event(
  supabaseAdmin: Client,
  input: GetCalendarEventInput,
): Promise<ToolResult<BookingRecord | null>> {
  const permissionError = await assertToolPermission(
    supabaseAdmin,
    input.organizationId,
    input.businessId,
    "calendar_read",
  );
  if (permissionError) return fail(permissionError.errorCode, permissionError.message);

  try {
    const booking = await getBooking(supabaseAdmin, {
      organizationId: input.organizationId,
      bookingId: input.bookingId,
    });
    return { success: true, data: booking };
  } catch (err) {
    return mapToolError(err);
  }
}

function mapToolError<T>(err: unknown): ToolResult<T> {
  if (err instanceof BookingError) return fail(err.code, err.message);
  if (err instanceof CalendarProviderError) return fail(err.code, err.message);
  if (err instanceof GoogleCalendarConnectionError) return fail(err.code, err.message);
  return fail("UNKNOWN", "Something went wrong handling that calendar request.");
}
