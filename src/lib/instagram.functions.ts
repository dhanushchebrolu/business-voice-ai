import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertFeatureUnlocked } from "@/lib/feature-gate.server";

/**
 * Customer-facing Instagram connection management + minimal automation
 * rule CRUD — combines the shape of whatsapp-onboarding.functions.ts
 * (starting/completing a Meta OAuth connection) and
 * whatsapp-connection.functions.ts (listing/reassigning/disconnecting),
 * plus google-calendar.functions.ts's redirect-OAuth "start" pattern
 * (createOAuthState + authorizationUrl) since Instagram connects via a
 * plain redirect, not WhatsApp's FB.login() popup — see
 * instagram-config.server.ts's module doc for why.
 *
 * organizationId is derived exclusively from the authenticated user's own
 * organization_members row (never trusted from client input) in every
 * function below — there is deliberately no organizationId field in any
 * input schema here.
 */

async function resolveOrgId(context: {
  supabase: SupabaseClient<Database>;
  userId: string;
}): Promise<string> {
  const { data: membership } = await context.supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", context.userId)
    .limit(1)
    .maybeSingle();
  if (!membership) throw new Error("No workspace found for your account.");
  return membership.organization_id;
}

export const getInstagramIntegrationStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { validateInstagramEnv } = await import("@/lib/instagram/instagram-config.server");
    const { allPresent } = validateInstagramEnv();
    return { configured: allPresent };
  });

const connectInputSchema = z.object({ businessId: z.string().uuid().nullable().optional() });

/** Step 1: mint OAuth state and return Meta's consent-screen URL. The browser is a plain navigation away — no JS SDK involved. */
export const startInstagramConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { businessId?: unknown }) => connectInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    await assertFeatureUnlocked(organizationId, "instagram");

    const { resolveInstagramConfig, buildInstagramAuthorizationUrl } =
      await import("@/lib/instagram/instagram-config.server");
    const config = resolveInstagramConfig();
    if (!config) {
      throw new Error(
        "Instagram is not configured on this deployment yet. Please contact support.",
      );
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createOAuthState } = await import("@/lib/google-calendar/oauth-state.server");
    const state = await createOAuthState(supabaseAdmin, {
      provider: "instagram",
      organizationId,
      businessId: data.businessId ?? null,
      userId: context.userId,
      redirectTo: "/app/integrations",
    });

    return { authorizationUrl: buildInstagramAuthorizationUrl(config, state) };
  });

/** Read path: RLS-scoped client, exactly like listWhatsAppConnections — the SELECT policy + column grant already do all the tenant isolation and secret exclusion this needs. */
export const listInstagramConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const organizationId = await resolveOrgId(context);
    const { data, error } = await context.supabase
      .from("instagram_connections")
      .select(
        "id, business_id, agent_config_id, instagram_business_account_id, facebook_page_id, username, display_name, profile_picture_url, status, webhook_subscribed, last_error, last_connected_at, created_at",
      )
      .eq("organization_id", organizationId)
      .neq("status", "disconnected")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  });

/** Businesses (and their one bot each) the caller's org owns — same shape as listOrgBusinessesForWhatsApp. */
export const listOrgBusinessesForInstagram = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const organizationId = await resolveOrgId(context);
    const [businessesRes, agentsRes] = await Promise.all([
      context.supabase
        .from("businesses")
        .select("id, name")
        .eq("organization_id", organizationId)
        .order("created_at"),
      context.supabase
        .from("agent_configs")
        .select("id, business_id, agent_name")
        .eq("organization_id", organizationId),
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

const assignInputSchema = z.object({
  connectionId: z.string().uuid(),
  agentConfigId: z.string().uuid().nullable(),
});

export const assignInstagramBot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown; agentConfigId: unknown }) =>
    assignInputSchema.parse(input),
  )
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { assignInstagramBot: assignCore } =
      await import("@/lib/instagram/instagram-connection.server");
    await assignCore(supabaseAdmin, {
      organizationId,
      connectionId: data.connectionId,
      agentConfigId: data.agentConfigId,
    });
    return { ok: true as const };
  });

const disconnectInputSchema = z.object({ connectionId: z.string().uuid() });

export const disconnectInstagramConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { connectionId: unknown }) => disconnectInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { disconnectInstagramConnection: disconnectCore } =
      await import("@/lib/instagram/instagram-connection.server");
    await disconnectCore(supabaseAdmin, { organizationId, connectionId: data.connectionId });

    await supabaseAdmin.from("customer_events").insert({
      organization_id: organizationId,
      kind: "instagram_disconnected",
      title: "Instagram disconnected",
      detail: data.connectionId,
      actor_email: (context.claims["email"] as string | undefined) ?? null,
      metadata: { connection_id: data.connectionId },
    });

    return { ok: true as const };
  });

// ============================================================
// Minimal automation rule CRUD (spec §11 — "keep the rule table simple",
// no visual builder). Uses the RLS-scoped client directly: pattern A on
// instagram_automation_rules (FOR ALL, is_org_member) already does every
// bit of tenant isolation this needs — same reasoning as
// listWhatsAppConnections' read path.
// ============================================================

export const listInstagramAutomationRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const organizationId = await resolveOrgId(context);
    const { data, error } = await context.supabase
      .from("instagram_automation_rules")
      .select(
        "id, business_id, instagram_connection_id, name, trigger_type, trigger_config, action_type, action_config, enabled, created_at, updated_at",
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  });

const ruleInputSchema = z.object({
  id: z.string().uuid().optional(),
  instagramConnectionId: z.string().uuid(),
  businessId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(200),
  triggerType: z.enum(["comment_keyword", "comment_any"]),
  triggerConfig: z.object({
    keywords: z.array(z.string().min(1).max(80)).max(20).optional(),
    postId: z.string().max(200).optional(),
  }),
  actionType: z.enum(["public_reply", "private_dm", "ai_dm"]),
  actionConfig: z.object({
    replyText: z.string().max(1000).optional(),
    dmText: z.string().max(1000).optional(),
  }),
  enabled: z.boolean().optional(),
});

/** Creates or updates one automation rule. Ownership of instagram_connection_id is enforced by the RLS FOR ALL policy itself (a foreign connection id from another org simply fails the insert/update's WITH CHECK). */
export const upsertInstagramAutomationRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ruleInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const organizationId = await resolveOrgId(context);

    if (data.triggerType === "comment_keyword" && !(data.triggerConfig.keywords?.length ?? 0)) {
      throw new Error("At least one keyword is required for a keyword trigger.");
    }
    if (data.actionType === "public_reply" && !data.actionConfig.replyText) {
      throw new Error("Reply text is required for a public reply action.");
    }
    if (data.actionType === "private_dm" && !data.actionConfig.dmText) {
      throw new Error("DM text is required for a private DM action.");
    }

    const { data: connection, error: connError } = await context.supabase
      .from("instagram_connections")
      .select("id, organization_id")
      .eq("id", data.instagramConnectionId)
      .maybeSingle();
    if (connError) throw connError;
    if (!connection || connection.organization_id !== organizationId) {
      throw new Error("That Instagram connection does not belong to your workspace.");
    }

    const row = {
      organization_id: organizationId,
      business_id: data.businessId ?? null,
      instagram_connection_id: data.instagramConnectionId,
      name: data.name,
      trigger_type: data.triggerType,
      trigger_config: data.triggerConfig,
      action_type: data.actionType,
      action_config: data.actionConfig,
      enabled: data.enabled ?? true,
    };

    if (data.id) {
      // RLS alone would silently no-op an update to a foreign-org rule id
      // (0 rows matched, no error) — .select().maybeSingle() makes that
      // case an explicit, visible failure instead of a false "success".
      const { data: updated, error } = await context.supabase
        .from("instagram_automation_rules")
        .update(row)
        .eq("id", data.id)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!updated) throw new Error("Automation rule not found.");
      return { id: updated.id };
    }
    const { data: inserted, error } = await context.supabase
      .from("instagram_automation_rules")
      .insert(row)
      .select("id")
      .single();
    if (error) throw error;
    return { id: inserted.id };
  });

const toggleRuleInputSchema = z.object({ id: z.string().uuid(), enabled: z.boolean() });

/** Flips only the enabled flag — a dedicated function rather than routing through upsertInstagramAutomationRule, so a toggle can never accidentally clobber a rule's other fields with stale client-side state. */
export const toggleInstagramAutomationRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: unknown; enabled: unknown }) => toggleRuleInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: updated, error } = await context.supabase
      .from("instagram_automation_rules")
      .update({ enabled: data.enabled })
      .eq("id", data.id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!updated) throw new Error("Automation rule not found.");
    return { ok: true as const };
  });

const deleteRuleInputSchema = z.object({ id: z.string().uuid() });

export const deleteInstagramAutomationRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: unknown }) => deleteRuleInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("instagram_automation_rules")
      .delete()
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true as const };
  });
