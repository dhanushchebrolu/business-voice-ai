import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * Who may act on outbound calling. The workspace always comes from the record
 * being acted on (the campaign, or the caller number), never from "the user's
 * first workspace", so someone in several workspaces acts on the right one.
 * Membership is read through the caller's own client (RLS: they only ever see
 * their own memberships).
 *
 *   dial   (single call, launch, resume)  owner or admin
 *   manage (pause, cancel, contacts, stats) any member
 */

type Client = SupabaseClient<Database>;

export const OUTBOUND_DIAL_ROLES: readonly string[] = ["owner", "admin"];
export const OUTBOUND_ROLE_MESSAGE = "Only a workspace owner or admin can start outbound calls.";

export interface CallerClients {
  /** The signed-in user's own client. */
  supabase: Client;
  supabaseAdmin: Client;
}

/** The caller's role in the organization, or null when they are not a member. */
export async function memberRole(
  supabase: Client,
  userId: string,
  organizationId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("role")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return (data?.role as string | undefined) ?? null;
}

/** Returns the organization once the caller is a member (and, to dial, an owner or admin). */
export async function requireRole(
  clients: CallerClients,
  userId: string,
  organizationId: string,
  dial: boolean,
  notFoundMessage: string,
): Promise<string> {
  const role = await memberRole(clients.supabase, userId, organizationId);
  // Not a member: the same answer as a missing record, so nothing leaks.
  if (!role) throw new Error(notFoundMessage);
  if (dial && !OUTBOUND_DIAL_ROLES.includes(role)) throw new Error(OUTBOUND_ROLE_MESSAGE);
  return organizationId;
}

/** The campaign's organization, once the caller is allowed to act on it. */
export async function campaignOrganizationForCaller(
  clients: CallerClients,
  userId: string,
  campaignId: string,
  options: { dial: boolean; notFoundMessage?: string },
): Promise<string> {
  const notFound = options.notFoundMessage ?? "Campaign not found.";
  const { data, error } = await clients.supabaseAdmin
    .from("campaigns")
    .select("organization_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.organization_id) throw new Error(notFound);
  return requireRole(clients, userId, data.organization_id, options.dial, notFound);
}

/** The caller number's organization, once the caller may dial from it (owner or admin). */
export async function outboundNumberOrganizationForCaller(
  clients: CallerClients,
  userId: string,
  phoneNumberId: string,
): Promise<string> {
  const notFound = "This phone number is not assigned to your workspace.";
  const { data, error } = await clients.supabaseAdmin
    .from("phone_numbers")
    .select("organization_id")
    .eq("id", phoneNumberId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.organization_id) throw new Error(notFound);
  return requireRole(clients, userId, data.organization_id, true, notFound);
}
