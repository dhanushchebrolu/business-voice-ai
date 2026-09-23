import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Customer-facing WhatsApp connection management (Phase 3): listing the
 * org's own connections, assigning which bot handles one, and
 * disconnecting. Deliberately does NOT touch Meta or re-implement any
 * part of onboarding — that stays exclusively in whatsapp-onboarding.
 * functions.ts's completeWhatsAppOnboarding (Phase 2). This file is pure
 * data access + tenant validation over rows Phase 2 already wrote.
 */

/**
 * Read path: uses the RLS-scoped client directly (context.supabase), not
 * supabaseAdmin — whatsapp_connections' Phase 1 SELECT policy
 * (is_org_member(organization_id)) already does exactly the tenant
 * isolation this needs, and the column-level GRANT already excludes
 * access_token_ciphertext/two_step_pin_ciphertext, so there is nothing
 * privileged this needs service-role access for.
 */
export const listWhatsAppConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: membership } = await context.supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", context.userId)
      .limit(1)
      .maybeSingle();
    if (!membership) throw new Error("No workspace found for your account.");

    const { data, error } = await context.supabase
      .from("whatsapp_connections")
      .select(
        "id, business_id, agent_config_id, waba_id, phone_number_id, display_phone_number, verified_name, business_name, status, webhook_subscribed, last_error, last_connected_at, created_at",
      )
      .eq("organization_id", membership.organization_id)
      .neq("status", "disconnected")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  });

/**
 * Businesses (and their one agent each) the caller's organization actually
 * owns — the reusable existing model (organization -> businesses ->
 * agent_configs, Phase 1's original schema; agent_configs.business_id is
 * UNIQUE, so each business has at most one bot), never a second bot
 * concept. Powers the business/bot selector; RLS-scoped, same isolation
 * as above.
 *
 * Two flat queries joined in application code, rather than a single
 * nested `businesses(..., agent_configs(...))` embed — PostgREST's
 * embedding shape (single object vs. one-element array) for a one-to-one
 * relationship depends on schema-cache details this session cannot verify
 * against a live database, so this avoids that ambiguity entirely.
 */
export const listOrgBusinessesForWhatsApp = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: membership } = await context.supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", context.userId)
      .limit(1)
      .maybeSingle();
    if (!membership) throw new Error("No workspace found for your account.");

    const [businessesRes, agentsRes] = await Promise.all([
      context.supabase
        .from("businesses")
        .select("id, name")
        .eq("organization_id", membership.organization_id)
        .order("created_at"),
      context.supabase
        .from("agent_configs")
        .select("id, business_id, agent_name")
        .eq("organization_id", membership.organization_id),
    ]);
    if (businessesRes.error) throw businessesRes.error;
    if (agentsRes.error) throw agentsRes.error;

    const agentByBusinessId = new Map(
      (agentsRes.data ?? []).map((a) => [a.business_id, { id: a.id, agentName: a.agent_name }]),
    );
    return (businessesRes.data ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      agentConfig: agentByBusinessId.get(b.id) ?? null,
    }));
  });

interface AssignWhatsAppBotInput {
  connectionId: unknown;
  agentConfigId: unknown;
}

const assignInputSchema = z.object({
  connectionId: z.string().uuid(),
  agentConfigId: z.string().uuid().nullable(),
});

/**
 * Assigns (or clears) which bot handles a connection. Uses the RLS-scoped
 * client for the actual UPDATE — Phase 1's whatsapp_connections policy
 * already grants customers UPDATE on exactly the agent_config_id column,
 * scoped to rows in their own organization (is_org_member). That row-level
 * check alone isn't enough on its own, though: RLS validates which ROW is
 * being touched, not that the NEW agent_config_id value being written
 * belongs to the same organization as that row — a caller could otherwise
 * name a real agent_config_id from a DIFFERENT tenant and have it accepted.
 * This function closes that gap with an explicit ownership check before
 * the update, exactly like completeWhatsAppOnboarding's businessId check
 * in Phase 2.
 */
export const assignWhatsAppBot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: AssignWhatsAppBotInput) => assignInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: membership } = await context.supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", context.userId)
      .limit(1)
      .maybeSingle();
    if (!membership) throw new Error("No workspace found for your account.");
    const organizationId = membership.organization_id;

    if (data.agentConfigId) {
      const { data: agentConfig } = await context.supabase
        .from("agent_configs")
        .select("id, organization_id")
        .eq("id", data.agentConfigId)
        .maybeSingle();
      if (!agentConfig || agentConfig.organization_id !== organizationId) {
        throw new Error("That bot does not belong to your workspace.");
      }
    }

    // The RLS policy's own USING/WITH CHECK (is_org_member(organization_id))
    // additionally guarantees this .eq("id", ...) can only ever match a row
    // already in the caller's organization — a connectionId belonging to
    // another tenant simply matches zero rows here, never silently updates
    // someone else's connection.
    const { data: updated, error } = await context.supabase
      .from("whatsapp_connections")
      .update({ agent_config_id: data.agentConfigId })
      .eq("id", data.connectionId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!updated) throw new Error("WhatsApp connection not found.");

    return { ok: true as const };
  });

interface DisconnectWhatsAppConnectionInput {
  connectionId: unknown;
}

const disconnectInputSchema = z.object({ connectionId: z.string().uuid() });

/**
 * Marks a connection disconnected — never deletes the row (or its
 * historical whatsapp_conversations/whatsapp_messages, once those exist
 * in a later phase). status isn't in Phase 1's customer-grantable column
 * list (only agent_config_id is), so this goes through supabaseAdmin like
 * Phase 2's onboarding does, with the same explicit tenant-derivation and
 * ownership check pattern — organizationId is never trusted from input,
 * and the connection's own organization_id is checked before any write.
 */
export const disconnectWhatsAppConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: DisconnectWhatsAppConnectionInput) => disconnectInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: membership } = await context.supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", context.userId)
      .limit(1)
      .maybeSingle();
    if (!membership) throw new Error("No workspace found for your account.");
    const organizationId = membership.organization_id;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: connection } = await supabaseAdmin
      .from("whatsapp_connections")
      .select("id, organization_id")
      .eq("id", data.connectionId)
      .maybeSingle();
    if (!connection || connection.organization_id !== organizationId) {
      throw new Error("WhatsApp connection not found.");
    }

    const { error } = await supabaseAdmin
      .from("whatsapp_connections")
      .update({ status: "disconnected", disconnected_at: new Date().toISOString() })
      .eq("id", data.connectionId);
    if (error) throw error;

    await supabaseAdmin.from("customer_events").insert({
      organization_id: organizationId,
      kind: "whatsapp_disconnected",
      title: "WhatsApp disconnected",
      detail: connection.id,
      actor_email: (context.claims["email"] as string | undefined) ?? null,
      metadata: { connection_id: connection.id },
    });

    return { ok: true as const };
  });
