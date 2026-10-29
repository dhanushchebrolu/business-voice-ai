/**
 * Authorization for managing a WhatsApp connection (connect a number,
 * choose which bot answers it, disconnect it).
 *
 * Only organization owners and admins may do this — the same product
 * decision as the Google Calendar integration (calendar-access.server.ts):
 * connecting a number lets ClickAI message customers as the business, and
 * the assigned bot is what answers them, so these are workspace-
 * administration actions, not day-to-day staff ones (member_role is
 * owner/admin/manager/staff/viewer). Messaging settings keep their own
 * finer-grained roles (whatsapp-messaging.functions.ts).
 *
 * The organization comes from the TARGET (the business being connected or
 * the existing connection being changed), never from the caller's "first
 * membership" and never from client input; the caller must then be an
 * owner/admin of exactly that organization. Without a target business, the
 * caller's workspace is used only when they belong to exactly one, so a
 * user in several organizations can't connect a number to whichever
 * membership happens to sort first. A target that doesn't exist and one in
 * another organization fail with the same NOT_FOUND message, so a response
 * never confirms another tenant's ids.
 *
 * Every query here uses the service-role client, so each one is filtered
 * explicitly; nothing relies on RLS.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type Client = SupabaseClient<Database>;

export const WHATSAPP_MANAGER_ROLES: readonly string[] = ["owner", "admin"];

export class WhatsAppAccessError extends Error {
  code: "NOT_FOUND" | "FORBIDDEN" | "NO_WORKSPACE" | "AMBIGUOUS_WORKSPACE";
  constructor(message: string, code: WhatsAppAccessError["code"]) {
    super(message);
    this.code = code;
  }
}

export type WhatsAppAccessTarget =
  { connectionId: string } | { businessId: string } | { workspace: true };

export interface WhatsAppManagerScope {
  organizationId: string;
  /** The target business, or the connection's business (may be null on an older connection). */
  businessId: string | null;
  /** Present when the target was an existing connection. */
  connectionId: string | null;
}

const NOT_FOUND_MESSAGE = "That business or WhatsApp connection was not found in your workspace.";
const FORBIDDEN_MESSAGE = "Only workspace owners and admins can manage the WhatsApp connection.";

export async function requireWhatsAppManager(
  supabaseAdmin: Client,
  userId: string,
  target: WhatsAppAccessTarget,
): Promise<WhatsAppManagerScope> {
  let scope: WhatsAppManagerScope;
  if ("connectionId" in target) {
    const { data, error } = await supabaseAdmin
      .from("whatsapp_connections")
      .select("id, organization_id, business_id")
      .eq("id", target.connectionId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new WhatsAppAccessError(NOT_FOUND_MESSAGE, "NOT_FOUND");
    scope = {
      organizationId: data.organization_id,
      businessId: data.business_id,
      connectionId: data.id,
    };
  } else if ("businessId" in target) {
    const { data, error } = await supabaseAdmin
      .from("businesses")
      .select("id, organization_id")
      .eq("id", target.businessId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new WhatsAppAccessError(NOT_FOUND_MESSAGE, "NOT_FOUND");
    scope = { organizationId: data.organization_id, businessId: data.id, connectionId: null };
  } else {
    const { data, error } = await supabaseAdmin
      .from("organization_members")
      .select("organization_id, role")
      .eq("user_id", userId)
      .limit(2);
    if (error) throw error;
    const memberships = (data ?? []) as { organization_id: string; role: string }[];
    if (memberships.length === 0) {
      throw new WhatsAppAccessError("No workspace found for your account.", "NO_WORKSPACE");
    }
    if (memberships.length > 1) {
      throw new WhatsAppAccessError(
        "You belong to more than one workspace. Choose the business to connect WhatsApp to.",
        "AMBIGUOUS_WORKSPACE",
      );
    }
    if (!WHATSAPP_MANAGER_ROLES.includes(memberships[0]!.role)) {
      throw new WhatsAppAccessError(FORBIDDEN_MESSAGE, "FORBIDDEN");
    }
    return {
      organizationId: memberships[0]!.organization_id,
      businessId: null,
      connectionId: null,
    };
  }

  const { data: membership, error: memberError } = await supabaseAdmin
    .from("organization_members")
    .select("role")
    .eq("organization_id", scope.organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!membership) throw new WhatsAppAccessError(NOT_FOUND_MESSAGE, "NOT_FOUND");
  if (!WHATSAPP_MANAGER_ROLES.includes(membership.role)) {
    throw new WhatsAppAccessError(FORBIDDEN_MESSAGE, "FORBIDDEN");
  }
  return scope;
}

/**
 * Assigns (or clears) the bot that answers a connection. The bot must
 * belong to the connection's own organization (the database trigger from
 * 20261019090000 enforces the same rule for every writer).
 */
export async function assignWhatsAppBotForUser(
  supabaseAdmin: Client,
  userId: string,
  input: { connectionId: string; agentConfigId: string | null },
): Promise<{ ok: true }> {
  const scope = await requireWhatsAppManager(supabaseAdmin, userId, {
    connectionId: input.connectionId,
  });

  if (input.agentConfigId) {
    const { data: agentConfig, error } = await supabaseAdmin
      .from("agent_configs")
      .select("id, organization_id")
      .eq("id", input.agentConfigId)
      .maybeSingle();
    if (error) throw error;
    if (!agentConfig || agentConfig.organization_id !== scope.organizationId) {
      throw new WhatsAppAccessError("That bot does not belong to your workspace.", "NOT_FOUND");
    }
  }

  const { data: updated, error } = await supabaseAdmin
    .from("whatsapp_connections")
    .update({ agent_config_id: input.agentConfigId })
    .eq("id", input.connectionId)
    .eq("organization_id", scope.organizationId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!updated) throw new WhatsAppAccessError(NOT_FOUND_MESSAGE, "NOT_FOUND");
  return { ok: true };
}

/**
 * Marks a connection disconnected. The row and its conversations/messages
 * are kept; inbound messages for a disconnected number are no longer
 * answered (whatsapp-ai-reply.server.ts checks the connection's status).
 * Disconnecting an already-disconnected connection is a no-op.
 */
export async function disconnectWhatsAppConnectionForUser(
  supabaseAdmin: Client,
  userId: string,
  input: { connectionId: string },
): Promise<{ organizationId: string; connectionId: string; changed: boolean }> {
  const scope = await requireWhatsAppManager(supabaseAdmin, userId, {
    connectionId: input.connectionId,
  });

  const { data: updated, error } = await supabaseAdmin
    .from("whatsapp_connections")
    .update({ status: "disconnected", disconnected_at: new Date().toISOString() })
    .eq("id", input.connectionId)
    .eq("organization_id", scope.organizationId)
    .neq("status", "disconnected")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return {
    organizationId: scope.organizationId,
    connectionId: input.connectionId,
    changed: Boolean(updated),
  };
}
