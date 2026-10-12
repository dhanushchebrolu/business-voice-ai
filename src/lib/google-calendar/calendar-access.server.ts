/**
 * Authorization for managing a business's Google Calendar connection
 * (connect, choose a calendar, test, reconnect, disconnect).
 *
 * Product decision: only organization owners and admins may manage the
 * integration — it grants ClickAI write access to someone's Google
 * Calendar, so it is a workspace-administration action, not a day-to-day
 * staff one (the member_role enum is owner/admin/manager/staff/viewer).
 *
 * The organization is derived from the TARGET row (the business being
 * connected, or the existing connection being changed), never from the
 * caller's "first membership" and never from client input. The caller's
 * own organization_members row for exactly that organization is then
 * required to carry an owner/admin role. This closes two holes the old
 * resolveOrgId-based checks had: a plain member could manage the
 * integration, and a user belonging to several organizations was checked
 * against whichever membership happened to sort first.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

export const CALENDAR_MANAGER_ROLES: readonly string[] = ["owner", "admin"];

export class CalendarAccessError extends Error {
  code: "NOT_FOUND" | "FORBIDDEN";
  constructor(message: string, code: CalendarAccessError["code"]) {
    super(message);
    this.code = code;
  }
}

export type CalendarAccessTarget = { businessId: string } | { connectionId: string };

export interface CalendarManagerScope {
  organizationId: string;
  businessId: string;
  /** Present when the target was an existing connection. */
  connectionId: string | null;
}

const NOT_FOUND_MESSAGE = "That business or calendar connection was not found in your workspace.";

/**
 * Resolves the organization/business a calendar-management action targets
 * and verifies the user is an owner/admin of THAT organization. A target
 * that does not exist and a target in an organization the user does not
 * belong to produce the same NOT_FOUND error, so the response never
 * confirms another tenant's ids.
 */
export async function requireCalendarManager(
  supabaseAdmin: Client,
  userId: string,
  target: CalendarAccessTarget,
): Promise<CalendarManagerScope> {
  let scope: CalendarManagerScope;
  if ("connectionId" in target) {
    const { data, error } = await supabaseAdmin
      .from("google_calendar_connections")
      .select("id, organization_id, business_id")
      .eq("id", target.connectionId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new CalendarAccessError(NOT_FOUND_MESSAGE, "NOT_FOUND");
    scope = {
      organizationId: data.organization_id,
      businessId: data.business_id,
      connectionId: data.id,
    };
  } else {
    const { data, error } = await supabaseAdmin
      .from("businesses")
      .select("id, organization_id")
      .eq("id", target.businessId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new CalendarAccessError(NOT_FOUND_MESSAGE, "NOT_FOUND");
    scope = { organizationId: data.organization_id, businessId: data.id, connectionId: null };
  }

  const { data: membership, error: memberError } = await supabaseAdmin
    .from("organization_members")
    .select("role")
    .eq("organization_id", scope.organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!membership) throw new CalendarAccessError(NOT_FOUND_MESSAGE, "NOT_FOUND");
  if (!CALENDAR_MANAGER_ROLES.includes(membership.role)) {
    throw new CalendarAccessError(
      "Only workspace owners and admins can manage the Google Calendar connection.",
      "FORBIDDEN",
    );
  }
  return scope;
}
