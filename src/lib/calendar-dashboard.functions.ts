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
import { newCorrelationId, timedStep } from "@/lib/observability/server-fn-diagnostics";

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
  const { data: membership, error } = await supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", context.userId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
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
    const correlationId = newCorrelationId();
    const LOG = "calendar_day_view";

    const { organizationId, role } = await timedStep(
      "resolve_org_context",
      correlationId,
      LOG,
      () => resolveOrgContext(context),
    );
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const business = await timedStep("resolve_business", correlationId, LOG, () =>
      resolveBusiness(supabaseAdmin, organizationId, data.businessId),
    );

    // Each of these four tables is queried by its own timedStep (run in
    // parallel, not sequentially — Promise.all below) rather than one
    // combined "fetch_schedule_and_sync_state" step: business_hours and
    // google_calendar_connections predate the hospital-calendar feature
    // and are read by several other pages too, while business_hour_
    // overrides and calendar_sync_conflicts were introduced by, and are
    // read ONLY by, this one feature (20261009100000_hospital_calendar_
    // overrides_and_gcal_sync.sql) — a PGRST205 ("table not in schema
    // cache") on one of the latter two, with every other calendar/booking
    // page unaffected, is a materially different diagnosis (that one
    // migration's tables specifically) than on one of the former two
    // (something broader). A combined step name couldn't tell these apart.
    const [hoursRes, overrideRes, connectionRes, conflictsRes] = await Promise.all([
      timedStep("fetch_business_hours", correlationId, LOG, async () => {
        const res = await supabaseAdmin
          .from("business_hours")
          .select("day_of_week, is_closed, intervals")
          .eq("business_id", data.businessId);
        if (res.error) throw res.error;
        return res;
      }),
      timedStep("fetch_business_hour_overrides", correlationId, LOG, async () => {
        const res = await supabaseAdmin
          .from("business_hour_overrides")
          .select("id, is_full_day_closure, intervals, reason")
          .eq("business_id", data.businessId)
          .eq("override_date", data.dateIso)
          .maybeSingle();
        if (res.error) throw res.error;
        return res;
      }),
      timedStep("fetch_google_calendar_connection", correlationId, LOG, async () => {
        const res = await supabaseAdmin
          .from("google_calendar_connections")
          .select("id, status, last_sync_at, last_error")
          .eq("business_id", data.businessId)
          .eq("provider", "google")
          .maybeSingle();
        if (res.error) throw res.error;
        return res;
      }),
      timedStep("fetch_calendar_sync_conflicts", correlationId, LOG, async () => {
        const res = await supabaseAdmin
          .from("calendar_sync_conflicts")
          .select("id, booking_id, conflict_type, details, created_at")
          .eq("business_id", data.businessId)
          .eq("status", "OPEN")
          .order("created_at", { ascending: false });
        if (res.error) throw res.error;
        return res;
      }),
    ]);

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

    // Not awaited (pure, synchronous JS) — still wrapped because a
    // malformed business.timezone (e.g. not a real IANA zone) throws a
    // RangeError here, and this step name is what tells that case apart
    // from an actual database failure above.
    const { start: dayStartUtc, end: dayEndUtc } = await timedStep(
      "compute_day_bounds",
      correlationId,
      LOG,
      () => Promise.resolve(businessDayUtcBounds(data.dateIso, business.timezone)),
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
        timedStep("fetch_bookings", correlationId, LOG, async () => {
          const res = await supabaseAdmin
            .from("bookings")
            .select("id, start_at, end_at, customer_name")
            .eq("calendar_connection_id", connection.id)
            .not("status", "in", "(CANCELLED,NO_SHOW)")
            .lt("start_at", dayEndUtc.toISOString())
            .gt("end_at", dayStartUtc.toISOString());
          if (res.error) throw res.error;
          return res;
        }),
        timedStep("fetch_external_calendar_events", correlationId, LOG, async () => {
          const res = await supabaseAdmin
            .from("external_calendar_events")
            .select("start_at, end_at")
            .eq("calendar_connection_id", connection.id)
            .neq("status", "cancelled")
            .lt("start_at", dayEndUtc.toISOString())
            .gt("end_at", dayStartUtc.toISOString());
          if (res.error) throw res.error;
          return res;
        }),
      ]);
      confirmedBookings = bookingsRes.data ?? [];
      externalBusy = externalRes.data ?? [];
    }

    const openRanges = await timedStep("resolve_effective_open_ranges", correlationId, LOG, () =>
      Promise.resolve(
        resolveEffectiveOpenRangesUtc(data.dateIso, business.timezone, weeklyHours, override),
      ),
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

/**
 * Delegates to set_business_weekly_hours (20261009120000's own doc
 * comment) rather than a direct .update() — that RPC takes the same
 * per-business advisory lock create_booking_atomic now takes before its
 * own schedule validation, so this write can never interleave with an
 * in-flight booking's validate-then-insert. resolveBusiness() is still
 * called first purely for the explicit, friendly ownership error; the
 * RPC's own WHERE...EXISTS ownership check is the actual (belt-and-
 * suspenders) tenant-safety boundary, same two-layer pattern as the rest
 * of this codebase's server functions.
 */
export const setWeeklyHours = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => setWeeklyHoursInputSchema.parse(input))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { organizationId, role } = await resolveOrgContext(context);
    requireWriteRole(role);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await resolveBusiness(supabaseAdmin, organizationId, data.businessId);

    const { error } = await supabaseAdmin.rpc("set_business_weekly_hours", {
      p_organization_id: organizationId,
      p_business_id: data.businessId,
      p_day_of_week: data.dayOfWeek,
      p_is_closed: data.isClosed,
      p_intervals: data.isClosed ? [] : data.intervals,
    });
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
 *
 * Delegates to apply_business_schedule_override (20261009120000's own doc
 * comment), which takes the same per-business advisory lock
 * create_booking_atomic takes, so this write and a concurrent booking's
 * validate-then-insert can never interleave — whichever reaches the lock
 * first wins outright; the other either sees the new, already-committed
 * state, or proceeds on the old state before this write can start. The
 * RPC also rejects (CANNOT_CLOSE_SLOT_WITH_ACTIVE_BOOKING) any attempt to
 * close a period that already has a confirmed/pending booking — never
 * silently invalidating it, per the task's own explicit requirement.
 */
export const applyDailyOverride = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => applyOverrideInputSchema.parse(input))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { organizationId, role } = await resolveOrgContext(context);
    requireWriteRole(role);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const business = await resolveBusiness(supabaseAdmin, organizationId, data.businessId);

    const { error } = await supabaseAdmin.rpc("apply_business_schedule_override", {
      p_organization_id: organizationId,
      p_business_id: data.businessId,
      p_override_date: data.dateIso,
      p_is_full_day_closure: data.isFullDayClosure,
      p_intervals: data.isFullDayClosure ? [] : data.intervals,
      p_reason: data.reason ?? null,
    });
    if (error) {
      if (error.message?.includes("CANNOT_CLOSE_SLOT_WITH_ACTIVE_BOOKING")) {
        throw new Error(
          "This would close a slot that already has an active booking. Cancel or reschedule that booking first.",
        );
      }
      throw error;
    }
    return { ok: true, timezone: business.timezone };
  });

const removeOverrideInputSchema = z.object({
  businessId: z.string().uuid(),
  dateIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
});

/**
 * Deletes the override row — restores the recurring weekly schedule for
 * that date with no other side effect (there is deliberately no
 * soft-delete; see the migration's own doc comment). Delegates to
 * remove_business_schedule_override, which takes the same per-business
 * lock as every other schedule-mutating operation — removal can never
 * silently invalidate a booking (it only ever widens what's open, and an
 * existing booking's own protection comes from create_booking_atomic's
 * overlap check, not from the override), so no conflict check is needed
 * here, only the lock for coordination.
 */
export const removeDailyOverride = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => removeOverrideInputSchema.parse(input))
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { organizationId, role } = await resolveOrgContext(context);
    requireWriteRole(role);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await resolveBusiness(supabaseAdmin, organizationId, data.businessId);

    const { error } = await supabaseAdmin.rpc("remove_business_schedule_override", {
      p_organization_id: organizationId,
      p_business_id: data.businessId,
      p_override_date: data.dateIso,
    });
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
