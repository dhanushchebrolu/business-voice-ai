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
import { computeAvailability, type AvailabilitySlot } from "./calendar-service.server.ts";
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

type Client = SupabaseClient<Database>;

export type ToolPermission =
  "calendar_read" | "calendar_book" | "calendar_reschedule" | "calendar_cancel";

export type ToolResult<T> =
  { success: true; data: T } | { success: false; error: { code: string; message: string } };

function fail<T>(code: string, message: string): ToolResult<T> {
  return { success: false, error: { code, message } };
}

interface ResolvedContext {
  connectionId: string;
  calendarId: string;
  timezone: string;
  businessName: string;
  businessHours: {
    dayOfWeek: number;
    isClosed: boolean;
    intervals: { start: string; end: string }[];
  }[];
}

async function resolveCalendarContext(
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

  const { data: connection, error: connectionError } = await supabaseAdmin
    .from("google_calendar_connections")
    .select("id, calendar_id, status")
    .eq("organization_id", organizationId)
    .eq("business_id", businessId)
    .eq("provider", "google")
    .maybeSingle();
  if (connectionError) throw connectionError;
  if (!connection || connection.status !== "CONNECTED" || !connection.calendar_id) {
    return {
      errorCode: "GOOGLE_AUTH_REQUIRED",
      message: "This business has not connected a Google Calendar yet.",
    };
  }

  const { data: hoursRows, error: hoursError } = await supabaseAdmin
    .from("business_hours")
    .select("day_of_week, is_closed, intervals")
    .eq("business_id", businessId);
  if (hoursError) throw hoursError;

  return {
    connectionId: connection.id,
    calendarId: connection.calendar_id,
    timezone: business.timezone,
    businessName: business.name,
    businessHours: (hoursRows ?? []).map((r) => ({
      dayOfWeek: r.day_of_week,
      isClosed: r.is_closed,
      intervals: (r.intervals as unknown as { start: string; end: string }[]) ?? [],
    })),
  };
}

async function assertToolPermission(
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
    const { provider, calendarId } = await getCalendarProviderForConnection(
      supabaseAdmin,
      ctx.connectionId,
    );

    const dayStart = `${input.dateIso}T00:00:00.000Z`;
    const dayEnd = `${input.dateIso}T23:59:59.999Z`;
    const [googleBusyPeriods, existingBookingsRes] = await Promise.all([
      provider.getBusyPeriods({ calendarId, timeMinIso: dayStart, timeMaxIso: dayEnd }),
      supabaseAdmin
        .from("bookings")
        .select("start_at, end_at")
        .eq("calendar_connection_id", ctx.connectionId)
        .not("status", "in", "(CANCELLED,NO_SHOW)")
        .gte("start_at", dayStart)
        .lte("start_at", dayEnd),
    ]);
    if (existingBookingsRes.error) throw existingBookingsRes.error;

    const slots = computeAvailability({
      dateIso: input.dateIso,
      timezone: ctx.timezone,
      businessHours: ctx.businessHours,
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
  source: "voice" | "whatsapp" | "website" | "manual";
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
    const { provider, calendarId } = await getCalendarProviderForConnection(
      supabaseAdmin,
      ctx.connectionId,
    );
    const booking = await createBooking(supabaseAdmin, provider, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      calendarConnectionId: ctx.connectionId,
      calendarId,
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
    const { provider, calendarId } = await getCalendarProviderForConnection(
      supabaseAdmin,
      ctx.connectionId,
    );
    const booking = await rescheduleBooking(supabaseAdmin, provider, {
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      calendarId,
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
    const { provider, calendarId } = await getCalendarProviderForConnection(
      supabaseAdmin,
      ctx.connectionId,
    );
    const booking = await cancelBooking(supabaseAdmin, provider, {
      organizationId: input.organizationId,
      bookingId: input.bookingId,
      calendarId,
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
