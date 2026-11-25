import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin, writeAudit } from "@/lib/platform-admin.server";
import { isAgentRole, type AgentRole } from "@/lib/agent-roles";

/**
 * Platform-admin control of a customer's Sarvam agent integration: the
 * credential its Sarvam HTTP tools use to call ClickAI. The raw token is
 * returned only by issueSarvamIntegrationCredential, once, and is never
 * stored or returned again (only its hash and a display prefix are kept).
 *
 * Each customer has one credential per agent role (agent-roles.ts): the
 * inbound agent's and the outbound agent's. ClickAI's agent API refuses every
 * write tool for the outbound one, so the two must never be swapped.
 */

/** Optional role input; absent means "inbound" (what existed before dual agents). */
function roleOf(input: { role?: unknown }): AgentRole {
  if (input.role === undefined) return "inbound";
  if (!isAgentRole(input.role)) throw new Error("role must be inbound or outbound");
  return input.role;
}

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
    if (!agent)
      return { agent: null, integration: null, outboundIntegration: null, recentEvents: [] };
    const latest = (role: AgentRole) =>
      supabaseAdmin
        .from("sarvam_agent_integrations")
        .select(
          "id, role, status, token_prefix, created_at, rotated_at, last_used_at, expires_at, disabled_at, disabled_reason, test_caller_numbers",
        )
        .eq("agent_config_id", agent.id)
        .eq("role", role)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    const [{ data: integration }, { data: outboundIntegration }, { data: events }] =
      await Promise.all([
        latest("inbound"),
        latest("outbound"),
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
      outboundIntegration: outboundIntegration ?? null,
      recentEvents: events ?? [],
    };
  });

interface IssueInput {
  orgId: string;
  reason: string;
  expiresInDays?: number | undefined;
  /** Which agent the credential is for; default inbound. */
  role?: AgentRole | undefined;
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
    return { ...input, role: roleOf(input) };
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const { supabaseAdmin, agent } = await customerAgent(data.orgId);
    if (!agent) throw new Error("This customer has no agent yet.");
    const role = data.role;
    const { issueIntegrationCredential } =
      await import("@/lib/sarvam-integration-credential.server");
    const issued = await issueIntegrationCredential(supabaseAdmin, {
      organizationId: data.orgId,
      agentConfigId: agent.id,
      role,
      expiresInDays: data.expiresInDays,
      createdBy: context.userId,
    });
    const { token, prefix, expiresAt } = issued;
    const active = issued.rotated;
    const integrationId = issued.integrationId;
    await writeAudit(admin, {
      action: active ? "SARVAM_INTEGRATION_ROTATED" : "SARVAM_INTEGRATION_CREATED",
      entityType: "sarvam_agent_integration",
      entityId: integrationId,
      organizationId: data.orgId,
      newValue: { token_prefix: prefix, expires_at: expiresAt, role },
      reason: data.reason,
    });
    // The only time the raw token leaves the server.
    return { token, tokenPrefix: prefix, rotated: Boolean(active), expiresAt, role };
  });

export const disableSarvamIntegration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string; reason: string; role?: AgentRole | undefined }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    // No role: disconnect both agents (what "disconnect" meant before dual agents).
    if (input.role !== undefined) roleOf(input);
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const { supabaseAdmin } = await customerAgent(data.orgId);
    let disable = supabaseAdmin
      .from("sarvam_agent_integrations")
      .update({
        status: "disabled",
        disabled_at: new Date().toISOString(),
        disabled_reason: data.reason,
      })
      .eq("organization_id", data.orgId)
      .eq("status", "active");
    if (data.role) disable = disable.eq("role", data.role);
    const { data: disabled, error } = await disable.select("id");
    if (error) throw error;
    if (!disabled?.length) throw new Error("No active integration to disconnect.");
    await writeAudit(admin, {
      action: "SARVAM_INTEGRATION_DISABLED",
      entityType: "sarvam_agent_integration",
      entityId: disabled[0]!.id,
      organizationId: data.orgId,
      newValue: { status: "disabled", role: data.role ?? "all", count: disabled.length },
      reason: data.reason,
    });
    return { ok: true as const };
  });

/**
 * Sets the numbers whose calls to this customer's agent are tests: bookings are checked but
 * never written, and no lead is created. Numbers must include the country code.
 */
export const setSarvamTestCallers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string; numbers: string[]; reason: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!Array.isArray(input.numbers)) throw new Error("numbers must be a list");
    if (input.numbers.length > 20) throw new Error("At most 20 test numbers");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const { normalizeCustomerPhone } = await import("@/lib/phone-number");
    const numbers = [
      ...new Set(
        data.numbers.map((raw) => {
          const e164 = raw.trim().startsWith("+") ? normalizeCustomerPhone(raw.trim(), null) : null;
          if (!e164) throw new Error(`Not a phone number with country code: ${raw}`);
          return e164;
        }),
      ),
    ];
    const { supabaseAdmin } = await customerAgent(data.orgId);
    const { data: before } = await supabaseAdmin
      .from("sarvam_agent_integrations")
      .select("id, test_caller_numbers")
      .eq("organization_id", data.orgId)
      .eq("role", "inbound")
      .eq("status", "active")
      .maybeSingle();
    if (!before) throw new Error("No active integration for this customer.");
    const { error } = await supabaseAdmin
      .from("sarvam_agent_integrations")
      .update({ test_caller_numbers: numbers })
      .eq("id", before.id);
    if (error) throw error;
    await writeAudit(admin, {
      action: "SARVAM_TEST_CALLERS_SET",
      entityType: "sarvam_agent_integration",
      entityId: before.id,
      organizationId: data.orgId,
      oldValue: { test_caller_numbers: before.test_caller_numbers },
      newValue: { test_caller_numbers: numbers },
      reason: data.reason,
    });
    return { ok: true as const, numbers };
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
