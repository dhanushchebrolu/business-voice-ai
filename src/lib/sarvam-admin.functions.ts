import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin, writeAudit } from "@/lib/platform-admin.server";
import { getTelephonyAdapter, validateSarvamEnv } from "@/lib/telephony.server";
import { SarvamTelephonyAdapter } from "@/lib/telephony/sarvam-provider.server";
import { TelephonyAdapterError } from "@/lib/telephony/adapter";
import { createInboundDeploymentForNumbers } from "@/lib/sarvam-inbound-deployment.server";
import { sendSarvamInstantOutboundCall } from "@/lib/sarvam-outbound-call.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

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
 * more Klyro phone numbers. The validation, tenant-safety checks, and the
 * actual Sarvam API call all live in createInboundDeploymentForNumbers
 * (sarvam-inbound-deployment.server.ts) — the automatic provisioning
 * orchestrator calls that exact same function, so this admin path and the
 * automatic path can never drift apart. This handler's own job is just the
 * admin gate and the audit record. Does not fake success: no audit record
 * is written unless the shared function's Sarvam call actually succeeded
 * (see SarvamTelephonyAdapter.createInboundDeployment's doc for that call's
 * verification status).
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

    const result = await createInboundDeploymentForNumbers(supabaseAdmin, {
      phoneNumberIds: data.phoneNumberIds,
      name: data.name,
    });

    await writeAudit(admin, {
      action: "SARVAM_DEPLOYMENT_CREATED",
      entityType: "phone_number",
      entityId: data.phoneNumberIds[0] ?? null,
      organizationId: result.organizationId,
      newValue: {
        deployment_id: result.deploymentId,
        phone_number_ids: data.phoneNumberIds,
      },
      reason: data.reason,
    });

    return { ok: true as const, deploymentId: result.deploymentId };
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

/* ------------------------------------------------------------------ */
/* 6. Provider connectivity + single-target live tests                  */
/* ------------------------------------------------------------------ */

export interface SarvamConnectivityTestResult {
  env: ReturnType<typeof validateSarvamEnv>;
  outboundProbe: {
    attempted: boolean;
    ok: boolean;
    status: number | null;
    message: string | null;
  };
}

/**
 * Read-only "is Sarvam actually reachable" check for the admin Settings
 * page. Never places a call or creates a deployment — the only network
 * request it ever makes is listCampaigns(), a real, already-implemented
 * GET request (see sarvam-provider.server.ts's listCampaigns / the
 * verified scheduling/v1/.../campaigns endpoint) that is inherently
 * read-only and side-effect-free, using the OUTBOUND key + org/workspace
 * scope.
 *
 * The inbound key's liveness is NOT independently verified here: no
 * confirmed read-only inbound-management endpoint exists to probe with
 * (see the module doc's "Sarvam app/agent creation... no public API was
 * found" note) — inventing one would violate the "do not invent
 * endpoints" instruction. Only its *presence* is checked (via
 * validateSarvamEnv). The inbound key's actual validity against Sarvam is
 * exercised for real by testSarvamInboundDeployment below, which is the
 * honest way to test it: by doing the one real thing that key is for.
 *
 * Naturally runs as a no-op probe everywhere the required env vars are
 * unset (any non-production environment among them) — there is no
 * separate "is this deployed" flag to invent; env-var presence already is
 * that signal here.
 */
export const testSarvamConnectivity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SarvamConnectivityTestResult> => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "customers.read");

    const env = validateSarvamEnv();
    const result: SarvamConnectivityTestResult = {
      env,
      outboundProbe: { attempted: false, ok: false, status: null, message: null },
    };

    if (env.outboundApiKeyPresent && env.orgIdPresent && env.workspaceIdPresent) {
      result.outboundProbe.attempted = true;
      const adapter = getTelephonyAdapter("sarvam");
      try {
        if (!adapter || !(adapter instanceof SarvamTelephonyAdapter))
          throw new Error("Sarvam adapter is not available.");
        const campaigns = await adapter.listCampaigns();
        result.outboundProbe.ok = true;
        result.outboundProbe.status = 200;
        result.outboundProbe.message = `Authenticated — ${campaigns.length} campaign(s) visible to this org/workspace.`;
      } catch (err) {
        // TelephonyAdapterError messages are constructed to never include
        // the API key or request headers (see sarvam-api-client.server.ts's
        // mapErrorResponse) — safe to surface as-is to an admin.
        result.outboundProbe.ok = false;
        result.outboundProbe.status = err instanceof TelephonyAdapterError ? err.status : null;
        result.outboundProbe.message = (err as Error).message;
      }
    }

    await writeAudit(admin, {
      action: "SARVAM_CONNECTIVITY_TEST",
      entityType: "platform",
      entityId: null,
      organizationId: null,
      newValue: result as unknown as Json,
      reason: "Provider connectivity test",
    });

    return result;
  });

/**
 * Verifies a phone number's organization is restricted to a demo/test
 * account before any live-test action below is allowed to touch it —
 * reuses the existing businesses.is_demo flag (already used for demo
 * data seeding) rather than inventing a new "is_test" column. Throws with
 * a clear, actionable message when the target isn't a demo org.
 */
async function assertDemoOrganization(
  supabaseAdmin: SupabaseClient<Database>,
  organizationId: string,
): Promise<void> {
  const { data: business } = await supabaseAdmin
    .from("businesses")
    .select("is_demo")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!business?.is_demo) {
    throw new Error(
      "Live provider tests are restricted to a demo/test organization (businesses.is_demo must be true). " +
        "Mark a dedicated test organization's business record as demo before running this.",
    );
  }
}

interface TestSarvamInboundDeploymentInput {
  phoneNumberId: string;
  confirmTest: boolean;
  reason: string;
}

/**
 * One-number, explicitly-confirmed live test of real inbound deployment
 * creation — calls the exact same createInboundDeploymentForNumbers the
 * automatic orchestrator and the regular admin action use (Task #92), so
 * this test proves the real path works, not a parallel one. Restricted to
 * a single phoneNumberId (never an array/bulk input) belonging to a
 * businesses.is_demo organization, and requires confirmTest: true as a
 * second, explicit safety gate beyond the usual admin authorization.
 */
export const testSarvamInboundDeployment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: TestSarvamInboundDeploymentInput) => {
    if (!input?.phoneNumberId) throw new Error("phoneNumberId is required");
    if (input.confirmTest !== true)
      throw new Error("This creates a real Sarvam deployment — explicit confirmation is required.");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: numberRow } = await supabaseAdmin
      .from("phone_numbers")
      .select("id, organization_id")
      .eq("id", data.phoneNumberId)
      .maybeSingle();
    if (!numberRow) throw new Error("Phone number not found.");
    if (!numberRow.organization_id)
      throw new Error("This phone number has no organization assigned.");
    await assertDemoOrganization(supabaseAdmin, numberRow.organization_id);

    const result = await createInboundDeploymentForNumbers(supabaseAdmin, {
      phoneNumberIds: [data.phoneNumberId],
      name: `Klyro TEST deployment — ${new Date().toISOString()}`,
    });

    await writeAudit(admin, {
      action: "SARVAM_TEST_INBOUND_DEPLOYMENT",
      entityType: "phone_number",
      entityId: data.phoneNumberId,
      organizationId: result.organizationId,
      newValue: { deploymentId: result.deploymentId },
      reason: data.reason,
    });

    return result;
  });

interface TestSarvamOutboundCallInput {
  phoneNumberId: string;
  toE164: string;
  confirmTest: boolean;
  reason: string;
}

/**
 * One-call, explicitly-confirmed live test of real outbound dialing —
 * calls the exact same sendSarvamInstantOutboundCall the customer-facing
 * path uses. Restricted to a single destination number belonging to a
 * businesses.is_demo organization's phone number, and requires
 * confirmTest: true. The admin is responsible for entering only a real
 * test number they control — this function has no separate "test contact
 * registry" to invent, and never accepts more than one destination.
 */
export const testSarvamOutboundCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: TestSarvamOutboundCallInput) => {
    if (!input?.phoneNumberId) throw new Error("phoneNumberId is required");
    if (!input.toE164 || !/^\+\d{6,15}$/.test(input.toE164))
      throw new Error("A valid E.164 destination number is required");
    if (input.confirmTest !== true)
      throw new Error("This places a real outbound call — explicit confirmation is required.");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: numberRow } = await supabaseAdmin
      .from("phone_numbers")
      .select("id, organization_id")
      .eq("id", data.phoneNumberId)
      .maybeSingle();
    if (!numberRow) throw new Error("Phone number not found.");
    if (!numberRow.organization_id)
      throw new Error("This phone number has no organization assigned.");
    await assertDemoOrganization(supabaseAdmin, numberRow.organization_id);

    const result = await sendSarvamInstantOutboundCall(supabaseAdmin, {
      phoneNumberId: data.phoneNumberId,
      toE164: data.toE164,
    });

    await writeAudit(admin, {
      action: "SARVAM_TEST_OUTBOUND_CALL",
      entityType: "call_log",
      entityId: result.callId,
      organizationId: numberRow.organization_id,
      newValue: { toE164: data.toE164, interactionId: result.interactionId },
      reason: data.reason,
    });

    return result;
  });
