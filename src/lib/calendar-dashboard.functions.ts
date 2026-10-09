import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  dayOfWeekInTimezone,
  businessDayUtcBounds,
  zonedWallTimeToUtc,
} from "@/lib/calendar/timezone";
import {
  resolveEffectiveOpenRangesUtc,
  type BusinessHoursDay,
  type BusinessHourOverride,
} from "@/lib/calendar/calendar-service.server";

/**
 * Hospital dashboard calendar — day view + weekly-hours + daily-override
 * server functions (hospital calendar spec section 2). Follows
 * bookings.functions.ts's exact established pattern: a staff member acting
 * from their own dashboard is authorizing themselves directly (tenant
 * membership + role), never an AI agent's capabilities JSONB — that gate
 * lives in calendar-tools.server.ts and is a completely separate
 * authorization boundary from this one.
 *
 * Role-based authorization (spec: "server-side... role-based
 * authorization"): this codebase already defines organization_members.role
 * (the member_role enum: owner/admin/manager/staff/viewer) but, before this
 * change, no server function anywhere actually checked it — only tenant
 * membership. requireWriteRole below is the first enforcement point: any
 * role other than 'viewer' may write; 'viewer' is read-only. This is a
 * deliberately minimal policy matching the enum's own apparent intent,
 * not a new, bespoke permission model invented for this one feature.
 */

type SlotState = "open" | "closed" | "booked" | "externally_busy";

interface DaySlot {
  startIso: string;
  endIso: string;
  state: SlotState;
}

async function resolveOrgContext(context: {
  supabase: unknown;
  userId: string;
}): Promise<{ organizationId: string; role: string }> {
  const supabase = context.supabase as import("@supabase/supabase-js").SupabaseClient<
    import("@/integrations/supabase/types").Database
  >;
  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", context.userId)
    .limit(1)
    .maybeSingle();
  if (!membership) throw new Error("No workspace found for your account.");
  return { organizationId: membership.organization_id, role: membership.role };
}

function requireWriteRole(role: string): void {
  if (role === "viewer") {
    throw new Error("Your role only allows viewing the calendar, not making changes.");
  }
}

async function resolveBusiness(
  supabaseAdmin: import("@supabase/supabase-js").SupabaseClient<
    import("@/integrations/supabase/types").Database
  >,
  organizationId: string,
  businessId: string,
) {
  const { data: business, error } = await supabaseAdmin
    .from("businesses")
    .select("id, organization_id, name, timezone")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw error;
  if (!business || business.organization_id !== organizationId) {
    throw new Error("That business does not belong to your workspace.");
  }
  return business;
}

const dayViewInputSchema = z.object({
  businessId: z.string().uuid(),
  dateIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
});

export const getCalendarDayView = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => dayViewInputSchema.parse(input))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { organizationId, role } = await resolveOrgContext(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const business = await resolveBusiness(supabaseAdmin, organizationId, data.businessId);

    const [hoursRes, overrideRes, connectionRes, conflictsRes] = await Promise.all([
      supabaseAdmin
        .from("business_hours")
        .select("day_of_week, is_closed, intervals")
        .eq("business_id", data.businessId),
      supabaseAdmin
        .from("business_hour_overrides")
        .select("id, is_full_day_closure, intervals, reason")
        .eq("business_id", data.businessId)
        .eq("override_date", data.dateIso)
        .maybeSingle(),
      supabaseAdmin
        .from("google_calendar_connections")
        .select("id, status, last_sync_at, last_error")
        .eq("business_id", data.businessId)
        .eq("provider", "google")
        .maybeSingle(),
      supabaseAdmin
        .from("calendar_sync_conflicts")
        .select("id, booking_id, conflict_type, details, created_at")
        .eq("business_id", data.businessId)
        .eq("status", "OPEN")
        .order("created_at", { ascending: false }),
    ]);
    if (hoursRes.error) throw hoursRes.error;
    if (overrideRes.error) throw overrideRes.error;
    if (connectionRes.error) throw connectionRes.error;
    if (conflictsRes.error) throw conflictsRes.error;

    const weeklyHours: BusinessHoursDay[] = (hoursRes.data ?? []).map((r) => ({
      dayOfWeek: r.day_of_week,
      isClosed: r.is_closed,
      intervals: (r.intervals as unknown as { start: string; end: string }[]) ?? [],
    }));
    const override: BusinessHourOverride | undefined = overrideRes.data
      ? {
          isFullDayClosure: overrideRes.data.is_full_day_closure,
          intervals:
            (overrideRes.data.intervals as unknown as {
              start: string;
              end: string;
              isOpen: boolean;
            }[]) ?? [],
        }
      : undefined;

    const { start: dayStartUtc, end: dayEndUtc } = businessDayUtcBounds(
      data.dateIso,
      business.timezone,
    );
    const connection = connectionRes.data;

    let confirmedBookings: {
      start_at: string;
      end_at: string;
      id: string;
      customer_name: string | null;
    }[] = [];
    let externalBusy: { start_at: string | null; end_at: string | null }[] = [];
    if (connection) {
      const [bookingsRes, externalRes] = await Promise.all([
        supabaseAdmin
          .from("bookings")
          .select("id, start_at, end_at, customer_name")
          .eq("calendar_connection_id", connection.id)
          .not("status", "in", "(CANCELLED,NO_SHOW)")
          .lt("start_at", dayEndUtc.toISOString())
          .gt("end_at", dayStartUtc.toISOString()),
        supabaseAdmin
          .from("external_calendar_events")
          .select("start_at, end_at")
          .eq("calendar_connection_id", connection.id)
          .neq("status", "cancelled")
          .lt("start_at", dayEndUtc.toISOString())
          .gt("end_at", dayStartUtc.toISOString()),
      ]);
      if (bookingsRes.error) throw bookingsRes.error;
      if (externalRes.error) throw externalRes.error;
      confirmedBookings = bookingsRes.data ?? [];
      externalBusy = externalRes.data ?? [];
    }

    const openRanges = resolveEffectiveOpenRangesUtc(
      data.dateIso,
      business.timezone,
      weeklyHours,
      override,
    );

    const SLOT_MINUTES = 30;
    const slots: DaySlot[] = [];
    for (
      let cursor = dayStartUtc.getTime();
      cursor < dayEndUtc.getTime();
      cursor += SLOT_MINUTES * 60_000
    ) {
      const slotStart = new Date(cursor);
      const slotEnd = new Date(cursor + SLOT_MINUTES * 60_000);
      const overlapsBooking = confirmedBookings.some(
        (b) => slotStart < new Date(b.end_at) && new Date(b.start_at) < slotEnd,
      );
      const overlapsExternal =
        !overlapsBooking &&
        externalBusy.some(
          (b) =>
            b.start_at &&
            b.end_at &&
            slotStart < new Date(b.end_at) &&
            new Date(b.start_at) < slotEnd,
        );
      const withinOpenRange =
        !overlapsBooking &&
        !overlapsExternal &&
        openRanges.some((r) => slotStart >= r.start && slotEnd <= r.end);

      const state: SlotState = overlapsBooking
        ? "booked"
        : overlapsExternal
          ? "externally_busy"
          : withinOpenRange
            ? "open"
            : "closed";

      slots.push({ startIso: slotStart.toISOString(), endIso: slotEnd.toISOString(), state });
    }

    const lastSyncAt = connection?.last_sync_at ?? null;
    const syncStale =
      !connection ||
      connection.status !== "CONNECTED" ||
      !lastSyncAt ||
      Date.now() - new Date(lastSyncAt).getTime() > 60 * 60 * 1000;

    return {
      role,
      business: { id: business.id, name: business.name, timezone: business.timezone },
      weeklyHours,
      override: overrideRes.data
        ? {
            isFullDayClosure: overrideRes.data.is_full_day_closure,
            intervals: override!.intervals,
            reason: overrideRes.data.reason,
          }
        : null,
      slots,
      confirmedBookings,
      pendingSync: syncStale,
      connectionStatus: connection?.status ?? "DISCONNECTED",
      connectionError: connection?.last_error ?? null,
      openConflicts: conflictsRes.data ?? [],
    };
  });

const setWeeklyHoursInputSchema = z.object({
  businessId: z.string().uuid(),
  dayOfWeek: z.number().int().min(0).max(6),
  isClosed: z.boolean(),
  intervals: z.array(z.object({ start: z.string(), end: z.string() })),
});

export const setWeeklyHours = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => setWeeklyHoursInputSchema.parse(input))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { organizationId, role } = await resolveOrgContext(context);
    requireWriteRole(role);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await resolveBusiness(supabaseAdmin, organizationId, data.businessId);

    const { error } = await supabaseAdmin
      .from("business_hours")
      .update({ is_closed: data.isClosed, intervals: data.isClosed ? [] : data.intervals })
      .eq("business_id", data.businessId)
      .eq("day_of_week", data.dayOfWeek);
    if (error) throw error;
    return { ok: true };
  });

const overrideIntervalSchema = z.object({
  start: z.string(),
  end: z.string(),
  isOpen: z.boolean(),
});

const applyOverrideInputSchema = z.object({
  businessId: z.string().uuid(),
  dateIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  isFullDayClosure: z.boolean(),
  intervals: z.array(overrideIntervalSchema),
  reason: z.string().optional(),
});

/**
 * Upserts the COMPLETE desired override state for one date — the client
 * always sends the full {isFullDayClosure, intervals} it wants in effect
 * (computed from the day-view data it already has plus whichever single
 * action the staff member just took), never a partial delta. This is what
 * lets "open one slot", "close one slot", "close the whole day", and "bulk
 * open every closed slot" all share one server function instead of each
 * needing their own merge logic server-side (spec: "reuse existing
 * structures", applied here to the override ROW itself as the one unit of
 * change, matching its own UNIQUE(business_id, override_date) shape).
 */
export const applyDailyOverride = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => applyOverrideInputSchema.parse(input))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { organizationId, role } = await resolveOrgContext(context);
    requireWriteRole(role);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const business = await resolveBusiness(supabaseAdmin, organizationId, data.businessId);

    const { error } = await supabaseAdmin.from("business_hour_overrides").upsert(
      {
        organization_id: organizationId,
        business_id: data.businessId,
        override_date: data.dateIso,
        is_full_day_closure: data.isFullDayClosure,
        intervals: data.isFullDayClosure ? [] : data.intervals,
        reason: data.reason ?? null,
      },
      { onConflict: "business_id,override_date" },
    );
    if (error) throw error;
    return { ok: true, timezone: business.timezone };
  });

const removeOverrideInputSchema = z.object({
  businessId: z.string().uuid(),
  dateIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
});

/** Deletes the override row — restores the recurring weekly schedule for that date with no other side effect (there is deliberately no soft-delete; see the migration's own doc comment). */
export const removeDailyOverride = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => removeOverrideInputSchema.parse(input))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { organizationId, role } = await resolveOrgContext(context);
    requireWriteRole(role);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await resolveBusiness(supabaseAdmin, organizationId, data.businessId);

    const { error } = await supabaseAdmin
      .from("business_hour_overrides")
      .delete()
      .eq("business_id", data.businessId)
      .eq("override_date", data.dateIso);
    if (error) throw error;
    return { ok: true };
  });

const resolveConflictInputSchema = z.object({
  conflictId: z.string().uuid(),
  status: z.enum(["RESOLVED", "DISMISSED"]),
  resolutionNotes: z.string().optional(),
});

export const resolveSyncConflict = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => resolveConflictInputSchema.parse(input))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { organizationId, role } = await resolveOrgContext(context);
    requireWriteRole(role);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: conflict, error } = await supabaseAdmin
      .from("calendar_sync_conflicts")
      .select("id, organization_id")
      .eq("id", data.conflictId)
      .maybeSingle();
    if (error) throw error;
    if (!conflict || conflict.organization_id !== organizationId) {
      throw new Error("That sync conflict does not belong to your workspace.");
    }

    const { error: updateError } = await supabaseAdmin
      .from("calendar_sync_conflicts")
      .update({
        status: data.status,
        resolution_notes: data.resolutionNotes ?? null,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", data.conflictId);
    if (updateError) throw updateError;
    return { ok: true };
  });

// Re-exported for the dashboard route's own local time-conversion needs
// (rendering slot times in the business's timezone) without a second
// import path.
export { zonedWallTimeToUtc, dayOfWeekInTimezone };
