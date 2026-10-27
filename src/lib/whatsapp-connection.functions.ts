import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Customer-facing WhatsApp connection management (Phase 3): listing the
 * org's own connections, assigning which bot handles one, and
 * disconnecting. Deliberately does NOT call Vobiz or re-implement any
 * part of onboarding — that stays in whatsapp-onboarding.functions.ts (the
 * three Vobiz connection options). This file is pure data access + tenant
 * validation over rows onboarding already wrote.
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
 * Assigns (or clears) which bot handles a connection. Owners/admins of the
 * connection's own organization only, and the bot must belong to that
 * organization (whatsapp-access.server.ts). The write uses the service role
 * with an explicit organization filter; the RLS policy on
 * whatsapp_connections additionally limits direct browser updates of
 * agent_config_id to owners/admins
 * (20261026090000_whatsapp_connection_manager_policy.sql).
 */
export const assignWhatsAppBot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: AssignWhatsAppBotInput) => assignInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { assignWhatsAppBotForUser } = await import("@/lib/whatsapp/whatsapp-access.server");
    return assignWhatsAppBotForUser(supabaseAdmin, context.userId, {
      connectionId: data.connectionId,
      agentConfigId: data.agentConfigId,
    });
  });

interface DisconnectWhatsAppConnectionInput {
  connectionId: unknown;
}

const disconnectInputSchema = z.object({ connectionId: z.string().uuid() });

/**
 * Marks a connection disconnected — never deletes the row or its
 * conversations/messages. Owners/admins of the connection's own
 * organization only (whatsapp-access.server.ts); organizationId is never
 * trusted from input. A repeat call on an already-disconnected connection
 * changes nothing and records no second timeline event.
 */
export const disconnectWhatsAppConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: DisconnectWhatsAppConnectionInput) => disconnectInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { disconnectWhatsAppConnectionForUser } =
      await import("@/lib/whatsapp/whatsapp-access.server");
    const result = await disconnectWhatsAppConnectionForUser(supabaseAdmin, context.userId, {
      connectionId: data.connectionId,
    });

    if (result.changed) {
      await supabaseAdmin.from("customer_events").insert({
        organization_id: result.organizationId,
        kind: "whatsapp_disconnected",
        title: "WhatsApp disconnected",
        detail: result.connectionId,
        actor_email: (context.claims["email"] as string | undefined) ?? null,
        metadata: { connection_id: result.connectionId },
      });
    }

    return { ok: true as const };
  });
