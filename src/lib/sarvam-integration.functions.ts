import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin, writeAudit } from "@/lib/platform-admin.server";

/**
 * Platform-admin control of a customer's Sarvam agent integration: the
 * credential its Sarvam HTTP tools use to call ClickAI. The raw token is
 * returned only by issueSarvamIntegrationCredential, once, and is never
 * stored or returned again (only its hash and a display prefix are kept).
 */

async function customerAgent(orgId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: agent } = await supabaseAdmin
    .from("agent_configs")
    .select("id, organization_id, business_id, sarvam_app_id, sarvam_app_version")
    .eq("organization_id", orgId)
    .maybeSingle();
  return { supabaseAdmin, agent };
}

export const getSarvamIntegration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { supabaseAdmin, agent } = await customerAgent(data.orgId);
    if (!agent) return { agent: null, integration: null, recentEvents: [] };
    const [{ data: integration }, { data: events }] = await Promise.all([
      supabaseAdmin
        .from("sarvam_agent_integrations")
        .select(
          "id, status, token_prefix, created_at, rotated_at, last_used_at, expires_at, disabled_at, disabled_reason",
        )
        .eq("agent_config_id", agent.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("sarvam_agent_events")
        .select("kind, status, interaction_id, created_at")
        .eq("organization_id", data.orgId)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    return {
      agent: { sarvamAppId: agent.sarvam_app_id, sarvamAppVersion: agent.sarvam_app_version },
      integration: integration ?? null,
      recentEvents: events ?? [],
    };
  });

interface IssueInput {
  orgId: string;
  reason: string;
  expiresInDays?: number | undefined;
}

/** Creates the integration, or rotates its credential (the old token stops working at once). */
export const issueSarvamIntegrationCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: IssueInput) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    if (
      input.expiresInDays !== undefined &&
      (!Number.isInteger(input.expiresInDays) ||
        input.expiresInDays < 1 ||
        input.expiresInDays > 730)
    )
      throw new Error("expiresInDays must be 1-730");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const { supabaseAdmin, agent } = await customerAgent(data.orgId);
    if (!agent) throw new Error("This customer has no agent yet.");
    const { generateIntegrationToken } = await import("@/lib/sarvam-agent-api.server");
    const { token, hash, prefix } = await generateIntegrationToken();
    const expiresAt = data.expiresInDays
      ? new Date(Date.now() + data.expiresInDays * 86_400_000).toISOString()
      : null;

    const { data: active } = await supabaseAdmin
      .from("sarvam_agent_integrations")
      .select("id")
      .eq("agent_config_id", agent.id)
      .eq("status", "active")
      .maybeSingle();
    let integrationId: string;
    if (active) {
      const { error } = await supabaseAdmin
        .from("sarvam_agent_integrations")
        .update({
          token_hash: hash,
          token_prefix: prefix,
          rotated_at: new Date().toISOString(),
          expires_at: expiresAt,
        })
        .eq("id", active.id)
        .eq("status", "active");
      if (error) throw error;
      integrationId = active.id;
    } else {
      const { data: created, error } = await supabaseAdmin
        .from("sarvam_agent_integrations")
        .insert({
          organization_id: data.orgId,
          agent_config_id: agent.id,
          token_hash: hash,
          token_prefix: prefix,
          expires_at: expiresAt,
          created_by: context.userId,
        })
        .select("id")
        .single();
      if (error) throw error;
      integrationId = created.id;
    }
    await writeAudit(admin, {
      action: active ? "SARVAM_INTEGRATION_ROTATED" : "SARVAM_INTEGRATION_CREATED",
      entityType: "sarvam_agent_integration",
      entityId: integrationId,
      organizationId: data.orgId,
      newValue: { token_prefix: prefix, expires_at: expiresAt },
      reason: data.reason,
    });
    // The only time the raw token leaves the server.
    return { token, tokenPrefix: prefix, rotated: Boolean(active), expiresAt };
  });

export const disableSarvamIntegration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string; reason: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const { supabaseAdmin } = await customerAgent(data.orgId);
    const { data: disabled, error } = await supabaseAdmin
      .from("sarvam_agent_integrations")
      .update({
        status: "disabled",
        disabled_at: new Date().toISOString(),
        disabled_reason: data.reason,
      })
      .eq("organization_id", data.orgId)
      .eq("status", "active")
      .select("id");
    if (error) throw error;
    if (!disabled?.length) throw new Error("No active integration to disconnect.");
    await writeAudit(admin, {
      action: "SARVAM_INTEGRATION_DISABLED",
      entityType: "sarvam_agent_integration",
      entityId: disabled[0]!.id,
      organizationId: data.orgId,
      newValue: { status: "disabled" },
      reason: data.reason,
    });
    return { ok: true as const };
  });

/**
 * Checks without the raw token (which ClickAI does not keep): the public
 * endpoints answer and reject a missing credential, and this customer's
 * agent would receive exactly these variables right now.
 */
export const testSarvamIntegration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { supabaseAdmin, agent } = await customerAgent(data.orgId);
    if (!agent) throw new Error("This customer has no agent yet.");
    const { buildSarvamClientContext } = await import("@/lib/sarvam-client-context.server");
    const { flattenContext } = await import("@/lib/sarvam-agent-api.server");
    const ctx = await buildSarvamClientContext(supabaseAdmin, data.orgId);
    const variables = ctx ? flattenContext(ctx, new Date()) : null;

    const base = process.env["TELEPHONY_WEBHOOK_BASE_URL"]?.replace(/\/+$/, "");
    let endpoint: {
      url: string | null;
      rejectsMissingToken: boolean | null;
      status: number | null;
    } = {
      url: null,
      rejectsMissingToken: null,
      status: null,
    };
    if (base) {
      const url = `${base}/api/public/sarvam/agent/context`;
      try {
        const res = await fetch(url, {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
        });
        endpoint = { url, rejectsMissingToken: res.status === 401, status: res.status };
      } catch {
        endpoint = { url, rejectsMissingToken: false, status: null };
      }
    }
    return { endpoint, variables, contextStatus: variables?.["context_status"] ?? "unavailable" };
  });
