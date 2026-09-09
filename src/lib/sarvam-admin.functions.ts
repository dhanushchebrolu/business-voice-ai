import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin, writeAudit } from "@/lib/platform-admin.server";
import { getTelephonyAdapter } from "@/lib/telephony.server";
import { SarvamTelephonyAdapter } from "@/lib/telephony/sarvam-provider.server";
import type { Json } from "@/integrations/supabase/types";

/**
 * A Sarvam campaign's raw response body, as passed through to the admin
 * caller for now (no Klyro-side campaign schema exists yet — out of scope
 * for this phase). Cast from Record<string, unknown> to Json at the
 * boundary: it always originates from a real, already-JSON-parsed HTTP
 * response body (see sarvam-api-client.server.ts), so this is a type-level
 * bridge, not a data-shape assumption — createServerFn's serialization
 * validator requires a concrete JSON-compatible type, and `unknown` values
 * inside a plain object do not satisfy it.
 */
function toJson(value: Record<string, unknown>): Json {
  return value as unknown as Json;
}

/**
 * Admin-only Sarvam provider-mapping control plane (V1 manual-onboarding
 * architecture — see SARVAM_TELEPHONY_MIGRATION_FINAL_REPORT.md and the
 * approved design/security review for the full rationale).
 *
 * Sarvam app/agent creation, connection creation, and managed-number
 * rental are manual steps performed in Sarvam's own dashboard — no public
 * API was found for any of them, and none is guessed here. What these
 * functions automate is everything AFTER that manual step: recording the
 * resulting Sarvam identifiers against Klyro's own records, and calling
 * Sarvam's management APIs (deployments, campaigns) to act on them — each
 * such call is a real HTTP request (see sarvam-provider.server.ts /
 * sarvam-api-client.server.ts for verification status), never faked.
 *
 * Every mutation here goes through assertPlatformAdmin and is audited,
 * exactly like telephony-admin.functions.ts. Customers never reach these
 * functions; their own read-only views go straight to Supabase under RLS
 * plus the column-level grants the Sarvam migration added (see the
 * 20260908110000 migration's comments for exactly why agent_configs needed
 * a grant correction and phone_numbers/telephony_connections did not).
 */

/* ------------------------------------------------------------------ */
/* 1. Klyro agent -> Sarvam app mapping                                 */
/* ------------------------------------------------------------------ */

interface SetSarvamAppMappingInput {
  agentConfigId: string;
  sarvamAppId: string;
  sarvamAppVersion: number;
  reason: string;
}

export const setSarvamAppMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: SetSarvamAppMappingInput) => {
    if (!input?.agentConfigId) throw new Error("agentConfigId is required");
    if (!input.sarvamAppId?.trim()) throw new Error("sarvamAppId is required");
    if (!Number.isInteger(input.sarvamAppVersion) || input.sarvamAppVersion < 1)
      throw new Error("sarvamAppVersion must be a positive integer");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: before } = await supabaseAdmin
      .from("agent_configs")
      .select("id, organization_id, sarvam_app_id, sarvam_app_version")
      .eq("id", data.agentConfigId)
      .maybeSingle();
    if (!before) throw new Error("Agent not found");

    const { error } = await supabaseAdmin
      .from("agent_configs")
      .update({ sarvam_app_id: data.sarvamAppId, sarvam_app_version: data.sarvamAppVersion })
      .eq("id", data.agentConfigId);
    if (error) {
      // idx_agent_configs_sarvam_app_id — this Sarvam app is already mapped
      // to a different agent_configs row.
      if ((error as { code?: string }).code === "23505")
        throw new Error("This Sarvam app is already mapped to a different agent.");
      throw error;
    }

    await writeAudit(admin, {
      action: "SARVAM_APP_MAPPING_SET",
      entityType: "agent_config",
      entityId: data.agentConfigId,
      organizationId: before.organization_id,
      oldValue: {
        sarvam_app_id: before.sarvam_app_id,
        sarvam_app_version: before.sarvam_app_version,
      },
      newValue: { sarvam_app_id: data.sarvamAppId, sarvam_app_version: data.sarvamAppVersion },
      reason: data.reason,
    });

    return { ok: true as const };
  });

/* ------------------------------------------------------------------ */
/* 2. Klyro connection -> Sarvam connection mapping                     */
/* ------------------------------------------------------------------ */

interface RegisterTelephonyConnectionInput {
  orgId: string;
  providerConnectionId: string;
  label?: string;
  reason: string;
}

export const registerTelephonyConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: RegisterTelephonyConnectionInput) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!input.providerConnectionId?.trim()) throw new Error("providerConnectionId is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: org } = await supabaseAdmin
      .from("organizations")
      .select("id")
      .eq("id", data.orgId)
      .maybeSingle();
    if (!org) throw new Error("Client not found");

    // One row per (org, provider) — an admin re-running this for an org
    // that already has a sarvam connection updates it in place rather than
    // accumulating duplicate rows.
    const { data: existing } = await supabaseAdmin
      .from("telephony_connections")
      .select("id, provider_connection_id, label")
      .eq("organization_id", data.orgId)
      .eq("provider", "sarvam")
      .maybeSingle();

    let connectionRowId: string;
    let oldValue: { provider_connection_id: string | null; label: string | null } | null = null;

    if (existing) {
      oldValue = { provider_connection_id: existing.provider_connection_id, label: existing.label };
      const { error } = await supabaseAdmin
        .from("telephony_connections")
        .update({
          provider_connection_id: data.providerConnectionId,
          label: data.label ?? existing.label,
          status: "connected",
        })
        .eq("id", existing.id);
      if (error) {
        if ((error as { code?: string }).code === "23505")
          throw new Error(
            "This Sarvam connection ID is already registered to a different organization.",
          );
        throw error;
      }
      connectionRowId = existing.id;
    } else {
      const { data: row, error } = await supabaseAdmin
        .from("telephony_connections")
        .insert({
          organization_id: data.orgId,
          provider: "sarvam",
          provider_connection_id: data.providerConnectionId,
          label: data.label ?? null,
          status: "connected",
        })
        .select("id")
        .single();
      if (error) {
        if ((error as { code?: string }).code === "23505")
          throw new Error(
            "This Sarvam connection ID is already registered to a different organization.",
          );
        throw error;
      }
      connectionRowId = row.id;
    }

    await writeAudit(admin, {
      action: "SARVAM_CONNECTION_REGISTERED",
      entityType: "telephony_connection",
      entityId: connectionRowId,
      organizationId: data.orgId,
      oldValue,
      newValue: { provider_connection_id: data.providerConnectionId, label: data.label ?? null },
      reason: data.reason,
    });

    return { ok: true as const, connectionId: connectionRowId };
  });

/* ------------------------------------------------------------------ */
/* 3. Sarvam inbound deployment creation                                */
/* ------------------------------------------------------------------ */

interface CreateSarvamInboundDeploymentInput {
  phoneNumberIds: string[];
  name: string;
  reason: string;
}

/**
 * Validates and attempts to create a Sarvam inbound deployment for one or
 * more Klyro phone numbers. All validation below runs — and is fully real,
 * tested, working code — before the actual Sarvam API call at the end,
 * which is now a real HTTP request (see SarvamTelephonyAdapter
 * .createInboundDeployment's doc for its verification status: code exists
 * and sends a real request, but has never been exercised against a live
 * Sarvam response in this environment). This function does not fake success
 * — it propagates that adapter's error rather than writing
 * provider_deployment_id or an audit record for something that didn't
 * happen.
 */
export const createSarvamInboundDeployment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CreateSarvamInboundDeploymentInput) => {
    if (!input?.phoneNumberIds?.length) throw new Error("At least one phoneNumberId is required");
    if (!input.name?.trim()) throw new Error("name is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: numbers, error: numbersError } = await supabaseAdmin
      .from("phone_numbers")
      .select("id, e164, organization_id, connection_id, agent_config_id")
      .in("id", data.phoneNumberIds);
    if (numbersError) throw numbersError;
    if (!numbers || numbers.length !== data.phoneNumberIds.length)
      throw new Error("One or more phone numbers were not found.");

    // A single deployment binds one connection + one app to a set of
    // numbers — every number in the request must share both, and (as a
    // direct consequence) the same organization. Rejecting a mixed set
    // here is what makes "cross-tenant mapping" structurally impossible:
    // there is no way to smuggle a number from a different organization
    // into a deployment for this one.
    const orgIds = new Set(numbers.map((n) => n.organization_id));
    if (orgIds.size > 1)
      throw new Error("All phone numbers in one deployment must belong to the same organization.");
    const connectionIds = new Set(numbers.map((n) => n.connection_id));
    if (connectionIds.size > 1 || numbers.some((n) => !n.connection_id))
      throw new Error(
        "All phone numbers in one deployment must share the same telephony connection.",
      );
    const agentConfigIds = new Set(numbers.map((n) => n.agent_config_id));
    if (agentConfigIds.size > 1 || numbers.some((n) => !n.agent_config_id))
      throw new Error("All phone numbers in one deployment must share the same agent.");

    const organizationId = numbers[0]!.organization_id;
    const connectionId = numbers[0]!.connection_id!;
    const agentConfigId = numbers[0]!.agent_config_id!;

    const { data: connection } = await supabaseAdmin
      .from("telephony_connections")
      .select("id, provider, provider_connection_id")
      .eq("id", connectionId)
      .maybeSingle();
    if (!connection) throw new Error("Telephony connection not found.");
    if (connection.provider !== "sarvam")
      throw new Error("This deployment flow only applies to sarvam connections.");
    if (!connection.provider_connection_id)
      throw new Error(
        "This connection has not been registered with Sarvam yet — call registerTelephonyConnection first.",
      );

    const { data: agentConfig } = await supabaseAdmin
      .from("agent_configs")
      .select("id, organization_id, sarvam_app_id, sarvam_app_version")
      .eq("id", agentConfigId)
      .maybeSingle();
    if (!agentConfig) throw new Error("Agent not found.");
    if (agentConfig.organization_id !== organizationId)
      throw new Error("The agent's organization does not match the phone numbers' organization.");
    if (!agentConfig.sarvam_app_id || !agentConfig.sarvam_app_version)
      throw new Error(
        "This agent has not been mapped to a Sarvam app yet — call setSarvamAppMapping first.",
      );

    const adapter = getTelephonyAdapter("sarvam");
    if (!adapter) throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");
    if (!(adapter instanceof SarvamTelephonyAdapter))
      throw new Error("Unexpected adapter type for provider 'sarvam'.");

    // This call is a real HTTP request against Sarvam's documented
    // deployment-creation endpoint — see SarvamTelephonyAdapter
    // .createInboundDeployment's doc comment for its verification status.
    // No provider_deployment_id write and no audit entry happen unless it
    // genuinely succeeds.
    const created = await adapter.createInboundDeployment({
      name: data.name,
      appId: agentConfig.sarvam_app_id,
      appVersion: agentConfig.sarvam_app_version,
      connectionId: connection.provider_connection_id,
      phoneNumbers: numbers.map((n) => n.e164),
    });

    const { error: updateError } = await supabaseAdmin
      .from("phone_numbers")
      .update({ provider_deployment_id: created.deploymentId })
      .in("id", data.phoneNumberIds);
    if (updateError) throw updateError;

    await writeAudit(admin, {
      action: "SARVAM_DEPLOYMENT_CREATED",
      entityType: "phone_number",
      entityId: data.phoneNumberIds[0] ?? null,
      organizationId,
      newValue: { deployment_id: created.deploymentId, phone_number_ids: data.phoneNumberIds },
      reason: data.reason,
    });

    return { ok: true as const, deploymentId: created.deploymentId };
  });

/* ------------------------------------------------------------------ */
/* 4. Sarvam inbound deployment update                                  */
/* ------------------------------------------------------------------ */

interface UpdateSarvamInboundDeploymentInput {
  /** The Klyro phone numbers already sharing the deployment being updated — identifies it. */
  phoneNumberIds: string[];
  name?: string;
  description?: string;
  reason: string;
}

/**
 * Updates an existing Sarvam inbound deployment's name/description. The
 * deployment being updated is derived server-side from the phone numbers
 * that already carry its provider_deployment_id — never taken as a raw ID
 * from client input — so tenant ownership falls out of the same
 * organization/consistency checks used by createSarvamInboundDeployment.
 * Membership (which numbers belong to the deployment) is not changed here —
 * out of scope for this phase, same as campaigns having no UI yet.
 */
export const updateSarvamInboundDeployment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: UpdateSarvamInboundDeploymentInput) => {
    if (!input?.phoneNumberIds?.length) throw new Error("At least one phoneNumberId is required");
    if (!input.name?.trim() && !input.description?.trim())
      throw new Error("At least one of name or description must be provided");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: numbers, error: numbersError } = await supabaseAdmin
      .from("phone_numbers")
      .select("id, organization_id, provider_deployment_id")
      .in("id", data.phoneNumberIds);
    if (numbersError) throw numbersError;
    if (!numbers || numbers.length !== data.phoneNumberIds.length)
      throw new Error("One or more phone numbers were not found.");

    const orgIds = new Set(numbers.map((n) => n.organization_id));
    if (orgIds.size > 1)
      throw new Error("All phone numbers in one deployment must belong to the same organization.");
    const deploymentIds = new Set(numbers.map((n) => n.provider_deployment_id));
    if (deploymentIds.size > 1 || numbers.some((n) => !n.provider_deployment_id))
      throw new Error("These phone numbers do not all share the same existing Sarvam deployment.");

    const organizationId = numbers[0]!.organization_id;
    const deploymentId = numbers[0]!.provider_deployment_id!;

    const adapter = getTelephonyAdapter("sarvam");
    if (!adapter) throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");
    if (!(adapter instanceof SarvamTelephonyAdapter))
      throw new Error("Unexpected adapter type for provider 'sarvam'.");

    // Real HTTP PATCH request — see SarvamTelephonyAdapter
    // .updateInboundDeployment's doc comment for its verification status.
    const updated = await adapter.updateInboundDeployment(deploymentId, {
      name: data.name?.trim() || undefined,
      description: data.description?.trim() || undefined,
    });

    await writeAudit(admin, {
      action: "SARVAM_DEPLOYMENT_UPDATED",
      entityType: "phone_number",
      entityId: data.phoneNumberIds[0] ?? null,
      organizationId,
      newValue: {
        deployment_id: updated.deploymentId,
        name: data.name,
        description: data.description,
      },
      reason: data.reason,
    });

    return { ok: true as const, deploymentId: updated.deploymentId };
  });

/* ------------------------------------------------------------------ */
/* 5. Sarvam campaigns — adapter/server boundary only (no UI this phase) */
/* ------------------------------------------------------------------ */

/**
 * Campaigns are a Sarvam org/workspace-wide concept with no Klyro-side
 * table or per-customer ownership model yet (out of scope for this phase —
 * "implement only the provider adapter/server boundary"), so these three
 * functions are platform-admin-gated only, with no per-organization tenant
 * check to perform (there is no Klyro-owned campaign record to check
 * ownership against). Every call is a real HTTP request against Sarvam's
 * documented campaigns endpoints — see SarvamTelephonyAdapter's doc comment
 * for verification status.
 */
export const listSarvamCampaigns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const adapter = getTelephonyAdapter("sarvam");
    if (!adapter) throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");
    if (!(adapter instanceof SarvamTelephonyAdapter))
      throw new Error("Unexpected adapter type for provider 'sarvam'.");
    const campaigns = await adapter.listCampaigns();
    return {
      campaigns: campaigns.map((c) => ({ campaignId: c.campaignId, raw: toJson(c.raw) })),
    };
  });

interface GetSarvamCampaignInput {
  campaignId: string;
}

export const getSarvamCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: GetSarvamCampaignInput) => {
    if (!input?.campaignId?.trim()) throw new Error("campaignId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const adapter = getTelephonyAdapter("sarvam");
    if (!adapter) throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");
    if (!(adapter instanceof SarvamTelephonyAdapter))
      throw new Error("Unexpected adapter type for provider 'sarvam'.");
    const campaign = await adapter.getCampaign(data.campaignId);
    return { campaignId: campaign.campaignId, raw: toJson(campaign.raw) };
  });

interface UpdateSarvamCampaignInput {
  campaignId: string;
  name?: string;
  status?: string;
  reason: string;
}

export const updateSarvamCampaign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: UpdateSarvamCampaignInput) => {
    if (!input?.campaignId?.trim()) throw new Error("campaignId is required");
    if (!input.name?.trim() && !input.status?.trim())
      throw new Error("At least one of name or status must be provided");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const adapter = getTelephonyAdapter("sarvam");
    if (!adapter) throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");
    if (!(adapter instanceof SarvamTelephonyAdapter))
      throw new Error("Unexpected adapter type for provider 'sarvam'.");

    const updated = await adapter.updateCampaign(data.campaignId, {
      name: data.name?.trim() || undefined,
      status: data.status?.trim() || undefined,
    });

    await writeAudit(admin, {
      action: "SARVAM_CAMPAIGN_UPDATED",
      entityType: "sarvam_campaign",
      entityId: data.campaignId,
      organizationId: null,
      newValue: { name: data.name, status: data.status },
      reason: data.reason,
    });

    return { ok: true as const, campaignId: updated.campaignId };
  });
