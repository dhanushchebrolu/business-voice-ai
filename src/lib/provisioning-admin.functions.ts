import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin, writeAudit } from "@/lib/platform-admin.server";
import {
  outboundRegistrationGate,
  registrationGate,
  queueStatus,
  type ChecklistInput,
  type OutboundChecklistInput,
  type QueueStatus,
} from "@/lib/provisioning-view";

/**
 * Admin provisioning dashboard (queue + per-customer detail + agent
 * registration). Every function checks assertPlatformAdmin server-side
 * before touching data. Reads never include integration token hashes or
 * any provider secret; the raw credential is only ever returned once, by
 * issueSarvamIntegrationCredential (sarvam-integration.functions.ts), which
 * the detail page reuses. Retry/verify/activate reuses retryProvisioning
 * (telephony-admin.functions.ts) -> runProvisioning -> the pipeline.
 */

/** Columns safe to show admins; never token_hash. */
export const INTEGRATION_SAFE_COLUMNS =
  "id, role, status, token_prefix, expires_at, last_used_at, rotated_at, created_at, disabled_at, disabled_reason";

const RUN_COLUMNS =
  "id, organization_id, trigger, status, current_step, attempts, last_error, last_error_at, note, phone_number_id, sarvam_deployment_id, agent_config_fingerprint, deployment_verified_at, verification, started_at, finished_at, created_at, updated_at, current_job_step, step_states, last_checkpoint, failure_code, retryable, next_attempt_at, max_attempts, diagnostics, customer_message, idempotency_key, sarvam_agent_id";

export interface QueueRow {
  runId: string;
  organizationId: string;
  customer: string;
  clientId: string | null;
  number: string | null;
  status: QueueStatus;
  currentStep: string | null;
  attempts: number;
  lastError: string | null;
  /** Machine failure code and whether another try can help (false = permanent until fixed). */
  failureCode: string | null;
  retryable: boolean | null;
  jobStep: string | null;
  updatedAt: string;
  createdAt: string;
}

export const listProvisioningQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { status?: QueueStatus | "all"; search?: string } | undefined) => ({
    status: input?.status ?? "all",
    search: (input?.search ?? "").trim().slice(0, 100).toLowerCase(),
  }))
  .handler(async ({ data, context }): Promise<{ rows: QueueRow[] }> => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: runs, error } = await supabaseAdmin
      .from("provisioning_runs")
      .select(
        "id, organization_id, status, current_step, attempts, last_error, created_at, updated_at, next_attempt_at, failure_code, retryable, current_job_step",
      )
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    // Latest run per organization.
    const latest = new Map<string, NonNullable<typeof runs>[number]>();
    for (const r of runs ?? [])
      if (!latest.has(r.organization_id)) latest.set(r.organization_id, r);
    const orgIds = [...latest.keys()];
    if (!orgIds.length) return { rows: [] };

    const [{ data: orgs, error: orgError }, { data: numbers, error: numError }] = await Promise.all(
      [
        supabaseAdmin.from("organizations").select("id, name, client_id").in("id", orgIds),
        supabaseAdmin
          .from("phone_numbers")
          .select("organization_id, e164, status")
          .in("organization_id", orgIds)
          .eq("provider", "sarvam")
          .neq("status", "released"),
      ],
    );
    if (orgError) throw orgError;
    if (numError) throw numError;
    const orgById = new Map((orgs ?? []).map((o) => [o.id, o]));
    const numberByOrg = new Map((numbers ?? []).map((n) => [n.organization_id, n.e164]));

    const rows: QueueRow[] = [...latest.values()].map((r) => ({
      runId: r.id,
      organizationId: r.organization_id,
      customer: orgById.get(r.organization_id)?.name ?? "(unknown)",
      clientId: orgById.get(r.organization_id)?.client_id ?? null,
      number: numberByOrg.get(r.organization_id) ?? null,
      status: queueStatus(r),
      currentStep: r.current_step,
      attempts: r.attempts,
      lastError: r.last_error,
      failureCode: r.failure_code,
      retryable: r.retryable,
      jobStep: r.current_job_step,
      updatedAt: r.updated_at,
      createdAt: r.created_at,
    }));
    return {
      rows: rows.filter(
        (row) =>
          (data.status === "all" || row.status === data.status) &&
          (!data.search ||
            [row.customer, row.clientId ?? "", row.number ?? ""].some((v) =>
              v.toLowerCase().includes(data.search),
            )),
      ),
    };
  });

/** Loads everything the detail page and the registration gate need, for one customer. */
async function loadDetail(orgId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { masterAgentAppId, outboundMasterAgentAppId } =
    await import("@/lib/sarvam-agent-registration.server");

  const { data: org, error: orgError } = await supabaseAdmin
    .from("organizations")
    .select("id, name, client_id, lifecycle_status, contact_email, provisioning_note")
    .eq("id", orgId)
    .maybeSingle();
  if (orgError) throw orgError;
  if (!org) throw new Error("Customer not found");

  const [agentRes, numbersRes, connRes, runsRes, auditRes] = await Promise.all([
    supabaseAdmin
      .from("agent_configs")
      .select(
        "id, business_id, sarvam_app_id, sarvam_app_version, sarvam_outbound_ready_app_id, sarvam_outbound_ready_version, sarvam_outbound_app_id, sarvam_outbound_app_version, sarvam_outbound_registered_at",
      )
      .eq("organization_id", orgId)
      .maybeSingle(),
    supabaseAdmin
      .from("phone_numbers")
      .select(
        "id, e164, status, provider, inbound_enabled, outbound_enabled, provider_deployment_id, connection_id, agent_config_id, sarvam_number_confirmed_at, verified_deployment_id, verified_sarvam_app_id, verified_sarvam_app_version, deployment_verified_at, admission_blocked_at, admission_blocked_reason",
      )
      .eq("organization_id", orgId)
      .neq("status", "released")
      .order("created_at", { ascending: true }),
    supabaseAdmin
      .from("telephony_connections")
      .select("id, provider_connection_id, label, status")
      .eq("organization_id", orgId)
      .eq("provider", "sarvam")
      .maybeSingle(),
    supabaseAdmin
      .from("provisioning_runs")
      .select(RUN_COLUMNS)
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(20),
    // Audit history: who did what and why. Only these columns are read
    // (writeAudit never stores credentials in any of them).
    supabaseAdmin
      .from("audit_logs")
      .select("id, action, admin_email, reason, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(30),
  ]);
  for (const r of [agentRes, numbersRes, connRes, runsRes, auditRes]) if (r.error) throw r.error;
  // Event trail of the latest job (sanitized when written; never a raw provider payload).
  const latestRunId = runsRes.data?.[0]?.id ?? null;
  const { data: jobEvents, error: eventsError } = latestRunId
    ? await supabaseAdmin
        .from("provisioning_run_events")
        .select("id, step, event, detail, created_at")
        .eq("run_id", latestRunId)
        .eq("organization_id", orgId)
        .order("created_at", { ascending: true })
        .limit(100)
    : { data: [], error: null };
  if (eventsError) throw eventsError;
  const agent = agentRes.data;

  const activeCredential = (role: "inbound" | "outbound") =>
    agent
      ? supabaseAdmin
          .from("sarvam_agent_integrations")
          .select(INTEGRATION_SAFE_COLUMNS)
          .eq("agent_config_id", agent.id)
          .eq("role", role)
          .eq("status", "active")
          .maybeSingle()
      : Promise.resolve({ data: null, error: null });
  const [
    { data: credential, error: credError },
    { data: outboundCredential, error: outboundCredError },
  ] = await Promise.all([activeCredential("inbound"), activeCredential("outbound")]);
  if (credError) throw credError;
  if (outboundCredError) throw outboundCredError;

  const { data: voiceLanguage, error: vlError } = agent
    ? await supabaseAdmin
        .from("agent_voice_language_settings")
        .select(
          "organization_id, default_language, allowed_languages, auto_language_switch, sarvam_voice_internal_id, sarvam_voice_name, status, applied_sarvam_app_id, applied_sarvam_app_version, applied_at, updated_at",
        )
        .eq("agent_config_id", agent.id)
        .eq("organization_id", orgId)
        .maybeSingle()
    : { data: null, error: null };
  if (vlError) throw vlError;

  let business: { name: string; business_type: string } | null = null;
  let config: import("@/lib/universal-agent-config").UniversalAgentConfig | null = null;
  let outboundConfig: import("@/lib/universal-agent-config").OutboundAgentConfig | null = null;
  if (agent?.business_id) {
    const { loadSnapshot } = await import("@/lib/agent-service.server");
    const { buildUniversalAgentConfig, buildOutboundAgentConfig } =
      await import("@/lib/universal-agent-config");
    const snapshot = await loadSnapshot(supabaseAdmin, agent.business_id);
    business = { name: snapshot.business.name, business_type: snapshot.business.business_type };
    config = buildUniversalAgentConfig(snapshot, voiceLanguage ?? null);
    outboundConfig = buildOutboundAgentConfig(snapshot, voiceLanguage ?? null);
  }
  // What the operator copies into Sarvam for each agent (no secrets: the
  // credential is referenced by name, its value is shown once at issue time).
  const base = process.env["TELEPHONY_WEBHOOK_BASE_URL"]?.replace(/\/+$/, "");
  const { sarvamToolConfiguration } = await import("@/lib/sarvam-agent-api.server");
  const { HEALTHCARE_BUSINESS_TYPES } = await import("@/lib/sarvam-agent-prompt");
  // The prompts follow this customer's own tools and business category.
  const healthcare = HEALTHCARE_BUSINESS_TYPES.includes(business?.business_type ?? "");
  const templates = base
    ? {
        inbound: sarvamToolConfiguration(base, "inbound", {
          healthcare,
          ...(config ? { tools: config.tools.enable } : {}),
        }),
        outbound: sarvamToolConfiguration(base, "outbound", {
          healthcare,
          ...(outboundConfig ? { tools: outboundConfig.tools.enable } : {}),
        }),
      }
    : null;

  const number = (numbersRes.data ?? []).find((n) => n.provider === "sarvam") ?? null;
  const runs = runsRes.data ?? [];
  const lastVerification = (runs.find((r) => r.verification)?.verification ?? null) as {
    checks: { id: string; ok: boolean; label: string; detail: string }[];
  } | null;

  const gateInput: ChecklistInput = {
    blockers: config
      ? config.blockers
      : ["The customer has not finished onboarding (no business profile or agent yet)."],
    number: number
      ? {
          e164: number.e164,
          status: number.status,
          deploymentId: number.provider_deployment_id,
          confirmedInSarvam: Boolean(number.sarvam_number_confirmed_at),
          verifiedDeploymentId: number.verified_deployment_id,
          admissionBlockedReason: number.admission_blocked_at
            ? (number.admission_blocked_reason ?? "blocked")
            : null,
        }
      : null,
    connectionRegistered: Boolean(connRes.data?.provider_connection_id),
    credential: credential ? { status: credential.status, expiresAt: credential.expires_at } : null,
    agent: { appId: agent?.sarvam_app_id ?? null, appVersion: agent?.sarvam_app_version ?? null },
    masterAgentAppId: masterAgentAppId(),
    verification: lastVerification,
    voiceLanguage: {
      problem: config
        ? config.voiceLanguageProblem
        : "Voice and languages are not set for this customer yet.",
      appliedAppId:
        voiceLanguage?.status === "applied" ? voiceLanguage.applied_sarvam_app_id : null,
      appliedVersion:
        voiceLanguage?.status === "applied" ? voiceLanguage.applied_sarvam_app_version : null,
    },
    now: new Date(),
  };

  const outboundGateInput: OutboundChecklistInput = {
    inboundAppId: agent?.sarvam_app_id ?? null,
    credential: outboundCredential
      ? { status: outboundCredential.status, expiresAt: outboundCredential.expires_at }
      : null,
    appId: agent?.sarvam_outbound_app_id ?? null,
    appVersion: agent?.sarvam_outbound_app_version ?? null,
    readyAppId: agent?.sarvam_outbound_ready_app_id ?? null,
    readyVersion: agent?.sarvam_outbound_ready_version ?? null,
    ...(agent?.sarvam_outbound_app_id && agent.sarvam_outbound_app_version
      ? {
          toolAuthConfirmed: (
            await (
              await import("@/lib/tool-auth-checkpoint.server")
            ).toolAuthStatus(supabaseAdmin, {
              organizationId: orgId,
              appId: agent.sarvam_outbound_app_id,
              version: agent.sarvam_outbound_app_version,
              role: "outbound",
            })
          ).confirmed,
        }
      : {}),
    masterAgentAppIds: [masterAgentAppId(), outboundMasterAgentAppId()],
    blockers: outboundConfig
      ? outboundConfig.blockers
      : ["The customer has not finished onboarding (no business profile or agent yet)."],
    voiceLanguageProblem: outboundConfig
      ? outboundConfig.voiceLanguageProblem
      : "Voice and languages are not set for this customer yet.",
    now: gateInput.now,
  };

  return {
    org,
    business,
    agent,
    numbers: numbersRes.data ?? [],
    connection: connRes.data
      ? {
          registered: Boolean(connRes.data.provider_connection_id),
          label: connRes.data.label,
          status: connRes.data.status,
        }
      : null,
    credential,
    outboundCredential,
    voiceLanguage,
    config,
    outboundConfig,
    templates,
    runs,
    jobEvents: jobEvents ?? [],
    audit: auditRes.data ?? [],
    webhookRecovery: await (
      await import("@/lib/sarvam-webhook-rotation.server")
    ).loadRecoveryMarker(supabaseAdmin, orgId),
    masterAgentConfigured: Boolean(gateInput.masterAgentAppId),
    gateInput: { ...gateInput, now: gateInput.now.toISOString(), masterAgentAppId: null },
    // Master ids are not sent to the browser; the server re-checks them on registration.
    outboundGateInput: {
      ...outboundGateInput,
      now: outboundGateInput.now.toISOString(),
      masterAgentAppIds: [],
    },
    _outboundGate: outboundGateInput,
    _gate: gateInput,
  };
}

export const getProvisioningDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { _gate, _outboundGate, ...detail } = await loadDetail(data.orgId);
    void _gate;
    void _outboundGate;
    return detail;
  });

/**
 * Step 6: records the customer's own Sarvam agent (copied from the
 * universal master agent) as theirs. Refused while onboarding is incomplete,
 * without a live integration credential, or for the master agent itself.
 */
export const registerCustomerSarvamAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { orgId: string; sarvamAppId: string; sarvamAppVersion: number; reason: string }) => {
      if (!input?.orgId) throw new Error("orgId is required");
      if (!input.sarvamAppId?.trim()) throw new Error("The Sarvam agent id is required");
      if (!Number.isInteger(input.sarvamAppVersion) || input.sarvamAppVersion < 1)
        throw new Error("The Sarvam agent version must be a positive whole number");
      if (!input.reason?.trim()) throw new Error("A reason is required");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const detail = await loadDetail(data.orgId);
    if (!detail.agent) throw new Error("This customer has no agent yet.");
    const gate = registrationGate(detail._gate, data.sarvamAppId);
    if (!gate.allowed) throw new Error(gate.reasons.join(" "));

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // A live customer is moved verify-first (mapping saved only after Sarvam
    // is confirmed on the new version); anyone else is mapped directly.
    const { findLiveNumber, remapLiveAgent, defaultLiveRemapDeps } =
      await import("@/lib/sarvam-live-remap.server");
    const live = await findLiveNumber(supabaseAdmin, data.orgId, detail.agent.id);
    const before = {
      sarvam_app_id: detail.agent.sarvam_app_id,
      sarvam_app_version: detail.agent.sarvam_app_version,
    };
    if (live) {
      const result = await remapLiveAgent(
        supabaseAdmin,
        {
          organizationId: data.orgId,
          agentConfigId: detail.agent.id,
          number: live,
          appId: data.sarvamAppId,
          appVersion: data.sarvamAppVersion,
        },
        await defaultLiveRemapDeps(),
      );
      if (result.outcome !== "verified") {
        await writeAudit(admin, {
          action: "SARVAM_APP_MAPPING_NOT_APPLIED",
          entityType: "agent_config",
          entityId: detail.agent.id,
          organizationId: data.orgId,
          newValue: {
            sarvam_app_id: data.sarvamAppId.trim(),
            sarvam_app_version: data.sarvamAppVersion,
            live_reverification: result.outcome,
          },
          reason: data.reason,
        });
        throw new Error(result.detail);
      }
    }
    const { applySarvamAgentMapping, masterAgentAppId } =
      await import("@/lib/sarvam-agent-registration.server");
    const mapped = live
      ? { organizationId: data.orgId, before }
      : await applySarvamAgentMapping(supabaseAdmin, {
          agentConfigId: detail.agent.id,
          organizationId: data.orgId,
          sarvamAppId: data.sarvamAppId,
          sarvamAppVersion: data.sarvamAppVersion,
          masterAgentAppId: masterAgentAppId(),
        });
    await writeAudit(admin, {
      action: "SARVAM_AGENT_REGISTERED",
      entityType: "agent_config",
      entityId: detail.agent.id,
      organizationId: data.orgId,
      oldValue: mapped.before,
      newValue: {
        sarvam_app_id: data.sarvamAppId.trim(),
        sarvam_app_version: data.sarvamAppVersion,
        agent_config_fingerprint: detail.config?.fingerprint ?? null,
      },
      reason: data.reason,
    });

    // Registering confirms this committed version carries the saved voice and
    // languages (the dialog says so); the gate above guarantees they are saved and valid.
    const { data: applied, error: applyError } = await supabaseAdmin
      .from("agent_voice_language_settings")
      .update({
        status: "applied",
        applied_sarvam_app_id: data.sarvamAppId.trim(),
        applied_sarvam_app_version: data.sarvamAppVersion,
        applied_at: new Date().toISOString(),
        applied_by: context.userId,
      })
      .eq("agent_config_id", detail.agent.id)
      .eq("organization_id", data.orgId)
      .select("id");
    if (applyError) throw applyError;
    if (!applied?.length) throw new Error("Voice & language settings were not found to apply.");
    await writeAudit(admin, {
      action: "VOICE_LANGUAGE_SETTINGS_APPLIED",
      entityType: "agent_config",
      entityId: detail.agent.id,
      organizationId: data.orgId,
      newValue: {
        applied_sarvam_app_id: data.sarvamAppId.trim(),
        applied_sarvam_app_version: data.sarvamAppVersion,
        via: "agent_registration",
      },
      reason: data.reason,
    });

    // A live customer was already moved and verified above.
    if (live) return { ok: true as const, deploymentSync: { items: [] }, reverify: null };
    // An existing deployment follows the new version (no-op for a new customer).
    const { syncAgentDeployments } = await import("@/lib/sarvam-inbound-deployment.server");
    const deploymentSync = await syncAgentDeployments(supabaseAdmin, detail.agent.id).catch(
      (err: Error) => ({ items: [], error: err.message }),
    );
    // A customer that already has a deployment is re-verified now: until the
    // new agent/version is verified, the admission gate serves no business data.
    let reverify: { state: string | null; note: string | null } | null = null;
    // The same goes for a customer whose activation job is waiting for this agent:
    // registering it continues the job now (the scheduled sweep is the backstop).
    const { data: openJob, error: openJobError } = await supabaseAdmin
      .from("provisioning_runs")
      .select("id")
      .eq("organization_id", data.orgId)
      .in("status", ["pending", "running", "waiting"])
      .limit(1);
    if (openJobError) throw openJobError;
    if (
      detail.numbers.some((n) => n.provider === "sarvam" && n.provider_deployment_id) ||
      (openJob ?? []).length
    ) {
      const { runProvisioning } = await import("@/lib/provisioning-runs.server");
      const run = await runProvisioning(supabaseAdmin, {
        organizationId: data.orgId,
        trigger: "admin_retry",
        createdBy: admin.userId,
        force: true,
      });
      reverify = { state: run.result?.state ?? null, note: run.result?.note ?? null };
    }
    return { ok: true as const, deploymentSync, reverify };
  });

/**
 * Step 12: records the customer's own OUTBOUND agent (created by an operator
 * in Sarvam from the outbound template). Refused while onboarding is
 * incomplete, without a live outbound credential, for a master template, for
 * the customer's inbound agent, or for any agent another customer uses
 * (applySarvamOutboundAgentMapping; the database enforces the same rules).
 * Registering never switches outbound calling on. Safe to repeat.
 */
export const registerCustomerSarvamOutboundAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { orgId: string; sarvamAppId: string; sarvamAppVersion: number; reason: string }) => {
      if (!input?.orgId) throw new Error("orgId is required");
      if (!input.sarvamAppId?.trim()) throw new Error("The Sarvam agent id is required");
      if (!Number.isInteger(input.sarvamAppVersion) || input.sarvamAppVersion < 1)
        throw new Error("The Sarvam agent version must be a positive whole number");
      if (!input.reason?.trim()) throw new Error("A reason is required");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const detail = await loadDetail(data.orgId);
    if (!detail.agent) throw new Error("This customer has no agent yet.");
    const gate = outboundRegistrationGate(detail._outboundGate, data.sarvamAppId);
    if (!gate.allowed) throw new Error(gate.reasons.join(" "));

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { applySarvamOutboundAgentMapping } =
      await import("@/lib/sarvam-agent-registration.server");
    const result = await applySarvamOutboundAgentMapping(supabaseAdmin, {
      agentConfigId: detail.agent.id,
      organizationId: data.orgId,
      sarvamAppId: data.sarvamAppId,
      sarvamAppVersion: data.sarvamAppVersion,
      masterAgentAppIds: detail._outboundGate.masterAgentAppIds,
      registeredBy: context.userId,
      now: new Date(),
    });
    await writeAudit(admin, {
      action: "SARVAM_OUTBOUND_AGENT_REGISTERED",
      entityType: "agent_config",
      entityId: detail.agent.id,
      organizationId: data.orgId,
      oldValue: result.before,
      newValue: {
        sarvam_outbound_app_id: data.sarvamAppId.trim(),
        sarvam_outbound_app_version: data.sarvamAppVersion,
        outbound_config_fingerprint: detail.outboundConfig?.fingerprint ?? null,
        outbound_confirmation_cleared: result.outboundConfirmationCleared,
      },
      reason: data.reason,
    });
    // Resume the provisioning run (steps 11-12 are read-only for a live customer).
    const { runProvisioning } = await import("@/lib/provisioning-runs.server");
    const run = await runProvisioning(supabaseAdmin, {
      organizationId: data.orgId,
      trigger: "admin_retry",
      createdBy: admin.userId,
    });
    return {
      ok: true as const,
      outboundConfirmationCleared: result.outboundConfirmationCleared,
      run: { state: run.result?.state ?? null, note: run.result?.note ?? null },
    };
  });

/**
 * Step 2 (manual): an admin confirms the customer's pre-assigned number
 * already exists in Sarvam on the customer's connection. Sarvam documents
 * no API to list or import numbers; ClickAI never rents, buys or claims one.
 */
export const confirmSarvamNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string; reason: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const detail = await loadDetail(data.orgId);
    const number = detail.numbers.find((n) => n.provider === "sarvam");
    if (!number) throw new Error("This customer has no Sarvam number assigned.");
    // Confirmation marks a number ClickAI provisions itself; a number that
    // already has a deployment (for example a legacy live one) is never
    // re-labelled as ClickAI-provisioned.
    if (number.provider_deployment_id)
      throw new Error(
        "This number already has a Sarvam deployment; it does not need confirmation. Use Re-verify live deployment for a live customer.",
      );
    if (!detail.connection?.registered)
      throw new Error("Register this customer's Sarvam connection first.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const confirmedAt = new Date().toISOString();
    const { data: updated, error } = await supabaseAdmin
      .from("phone_numbers")
      .update({ sarvam_number_confirmed_at: confirmedAt, sarvam_number_confirmed_by: admin.userId })
      .eq("id", number.id)
      .eq("organization_id", data.orgId)
      .neq("status", "released")
      .is("provider_deployment_id", null)
      .select("id");
    if (error) throw error;
    if (!updated?.length) throw new Error("The number changed; reload and try again.");
    await writeAudit(admin, {
      action: "SARVAM_NUMBER_CONFIRMED",
      entityType: "phone_number",
      entityId: number.id,
      organizationId: data.orgId,
      newValue: { e164: number.e164, confirmed_at: confirmedAt },
      reason: data.reason,
    });
    return { ok: true as const };
  });

/**
 * Clears an admission block (set when a call reached the customer's agent
 * through a deployment ClickAI never verified) after an admin reviewed it in
 * Sarvam. The gate still requires a verified, ACTIVE number afterwards.
 */
export const clearAdmissionBlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string; reason: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: cleared, error } = await supabaseAdmin
      .from("phone_numbers")
      .update({ admission_blocked_at: null, admission_blocked_reason: null })
      .eq("organization_id", data.orgId)
      .eq("provider", "sarvam")
      .not("admission_blocked_at", "is", null)
      .select("id, e164");
    if (error) throw error;
    if (!cleared?.length) throw new Error("Nothing is blocked for this customer.");
    await writeAudit(admin, {
      action: "INBOUND_ADMISSION_BLOCK_CLEARED",
      entityType: "phone_number",
      entityId: cleared[0]!.id,
      organizationId: data.orgId,
      newValue: { numbers: cleared.map((n) => n.e164) },
      reason: data.reason,
    });
    return { ok: true as const };
  });

/**
 * Records (or clears) the customer's current Sarvam agent version as
 * confirmed for outbound calls: the same one agent answers inbound and, in
 * this version, also declares call_direction and the campaign variables and
 * carries the outbound section. Mark it only after a supervised outbound test
 * and an inbound regression check. ClickAI changes nothing in Sarvam here.
 * A later remap to another version blocks outbound again automatically.
 */
export const setSarvamOutboundReady = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { orgId: string; ready: boolean; reason: string; maxCallMinutes?: number }) => {
      if (!input?.orgId) throw new Error("orgId is required");
      if (typeof input.ready !== "boolean") throw new Error("ready must be true or false");
      if (input.maxCallMinutes !== undefined && typeof input.maxCallMinutes !== "number")
        throw new Error("maxCallMinutes must be a number");
      if (!input.reason?.trim()) throw new Error("A reason is required");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { setOutboundReady } = await import("@/lib/sarvam-outbound-mode.server");
    const result = await setOutboundReady(supabaseAdmin, {
      organizationId: data.orgId,
      ready: data.ready,
      maxCallSeconds:
        typeof data.maxCallMinutes === "number" ? Math.round(data.maxCallMinutes * 60) : undefined,
      actor: { userId: admin.userId, email: admin.email },
    });
    if (!result.ok) throw new Error(result.reason);
    await writeAudit(admin, {
      action: data.ready ? "SARVAM_OUTBOUND_READY_SET" : "SARVAM_OUTBOUND_READY_CLEARED",
      entityType: "agent_config",
      entityId: null,
      organizationId: data.orgId,
      newValue: {
        ready: result.ready,
        app_id: result.appId,
        app_version: result.appVersion,
        max_call_seconds: result.maxCallSeconds,
      },
      reason: data.reason,
    });
    return result;
  });

/**
 * Releases a Sarvam agent id that was reported (or confirmed) for this customer by mistake, so
 * the job can accept the correct one. Refused for a registered agent. Changes ClickAI records
 * only: nothing is read from or written to Sarvam, and no number or deployment is touched.
 */
export const releaseSarvamAgentId = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string; sarvamAppId: string; reason: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!input.sarvamAppId?.trim()) throw new Error("The Sarvam agent id is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { releaseAgentId } = await import("@/lib/agent-recovery.server");
    return releaseAgentId(supabaseAdmin, {
      organizationId: data.orgId,
      appId: data.sarvamAppId,
      actor: { userId: admin.userId, email: admin.email },
      reason: data.reason,
    });
  });

/**
 * An admin's own check, in Sarvam, that every tool of the registered outbound agent version
 * carries the outbound credential and this customer's agent_ref. Needs no provisioning job.
 * It never enables calling: "Confirm the outbound agent for outbound calls" stays separate.
 */
export const confirmOutboundToolAuth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      orgId: string;
      sarvamAppId: string;
      sarvamAppVersion: number;
      agentRef: string;
      everyToolChecked: boolean;
      reason: string;
    }) => {
      if (!input?.orgId) throw new Error("orgId is required");
      if (!input.sarvamAppId?.trim()) throw new Error("The Sarvam agent id is required");
      if (!Number.isInteger(input.sarvamAppVersion) || input.sarvamAppVersion < 1)
        throw new Error("The Sarvam agent version must be a positive whole number");
      if (typeof input.agentRef !== "string") throw new Error("agentRef is required");
      if (input.everyToolChecked !== true)
        throw new Error("Confirm that you checked every tool on the committed version");
      if (!input.reason?.trim()) throw new Error("A reason is required");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { confirmOutboundToolCredentials } = await import("@/lib/agent-recovery.server");
    const { masterAgentAppId, outboundMasterAgentAppId } =
      await import("@/lib/sarvam-agent-registration.server");
    const { runProvisioning } = await import("@/lib/provisioning-runs.server");
    return confirmOutboundToolCredentials(supabaseAdmin, {
      organizationId: data.orgId,
      appId: data.sarvamAppId,
      version: data.sarvamAppVersion,
      agentRef: data.agentRef,
      masterAgentAppIds: [masterAgentAppId(), outboundMasterAgentAppId()],
      actor: { userId: admin.userId, email: admin.email },
      reason: data.reason,
      resume: () =>
        runProvisioning(supabaseAdmin, {
          organizationId: data.orgId,
          trigger: "admin_retry",
          createdBy: admin.userId,
          force: true,
        }),
    });
  });

/**
 * Re-verifies a customer whose number is already live, against Sarvam's own
 * view of the deployment (read only, apart from undoing a recorded pause). Saves the verified
 * mapping on success, so a working live customer keeps (or regains) business
 * data without new onboarding or voice settings. Never activates a number.
 */
export const reverifyLiveDeployment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string; reason: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: agent, error } = await supabaseAdmin
      .from("agent_configs")
      .select("id, sarvam_app_id, sarvam_app_version")
      .eq("organization_id", data.orgId)
      .maybeSingle();
    if (error) throw error;
    if (!agent?.sarvam_app_id || !agent.sarvam_app_version)
      throw new Error("This customer's agent is not mapped to Sarvam.");
    const { findLiveNumber, remapLiveAgent, defaultLiveRemapDeps } =
      await import("@/lib/sarvam-live-remap.server");
    const live = await findLiveNumber(supabaseAdmin, data.orgId, agent.id);
    if (!live)
      throw new Error(
        "This customer has no live number (ACTIVE, inbound on, with a deployment). New customers are verified by provisioning instead.",
      );
    const result = await remapLiveAgent(
      supabaseAdmin,
      {
        organizationId: data.orgId,
        agentConfigId: agent.id,
        number: live,
        appId: agent.sarvam_app_id,
        appVersion: agent.sarvam_app_version,
      },
      await defaultLiveRemapDeps(),
    );
    await writeAudit(admin, {
      action:
        result.outcome === "verified"
          ? "LIVE_DEPLOYMENT_REVERIFIED"
          : "LIVE_DEPLOYMENT_REVERIFY_FAILED",
      entityType: "phone_number",
      entityId: live.id,
      organizationId: data.orgId,
      newValue: { deployment_id: live.deploymentId, outcome: result.outcome },
      reason: data.reason,
    });
    return { outcome: result.outcome, detail: result.detail };
  });

async function sarvamRotationDeps() {
  const [telephony, sarvam] = await Promise.all([
    import("@/lib/telephony.server"),
    import("@/lib/telephony/sarvam-provider.server"),
  ]);
  const adapter = () => {
    const a = telephony.getTelephonyAdapter("sarvam");
    if (!a || !(a instanceof sarvam.SarvamTelephonyAdapter))
      throw new Error("Sarvam is not connected.");
    return a;
  };
  return {
    getDeployment: (id: string) => adapter().getDeployment(id),
    setDeploymentStatus: (id: string, action: "pause" | "resume") =>
      adapter().setDeploymentStatus(id, action),
    updateWebhook: (id: string, webhook: { url: string; metadata: Record<string, string> }) =>
      adapter().updateInboundDeployment(id, { webhookConfig: webhook }),
    webhookUrl: () => telephony.sarvamOutboundWebhookUrl(),
  };
}

/**
 * Rotation of SARVAM_WEBHOOK_SECRET: replaces the webhook URL (and so its
 * verify_token) on this customer's existing Sarvam deployment with one built
 * from the CURRENT secret. An active deployment is paused for a few seconds
 * for the edit (Sarvam edits only paused deployments), so the caller must
 * confirm the pause explicitly. Every attempt is audited (actor,
 * organization, deployment, reason, stage, outcome), never with the URL,
 * the token or provider error text. See docs/sarvam-webhook-token-rotation.md.
 */
export const updateSarvamWebhookToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string; reason: string; confirmPause: boolean }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return { ...input, confirmPause: input.confirmPause === true };
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { rotateDeploymentWebhook, ROTATION_AUDIT_ACTIONS } =
      await import("@/lib/sarvam-webhook-rotation.server");
    try {
      const result = await rotateDeploymentWebhook(
        supabaseAdmin,
        { organizationId: data.orgId, confirmPause: data.confirmPause },
        await sarvamRotationDeps(),
      );
      // Statuses only: never the URL, the token or provider error text.
      await writeAudit(admin, {
        action: ROTATION_AUDIT_ACTIONS[result.outcome],
        entityType: "sarvam_deployment",
        entityId: result.deploymentId,
        organizationId: data.orgId,
        newValue: {
          stage: result.stage,
          outcome: result.outcome,
          deployment_id: result.deploymentId,
          confirm_pause: data.confirmPause,
          status_before: result.statusBefore,
          status_after: result.statusAfter,
          token_status_before: result.tokenStatusBefore,
          token_status_after: result.tokenStatusAfter,
          app_id_before: result.appIdBefore,
          app_version_before: result.appVersionBefore,
          paused_by_us: result.pausedByUs,
          recovery: result.recovery,
        },
        reason: data.reason,
      });
      return { outcome: result.outcome, detail: result.detail };
    } catch (err) {
      await writeAudit(admin, {
        action: ROTATION_AUDIT_ACTIONS.error,
        entityType: "sarvam_deployment",
        entityId: null,
        organizationId: data.orgId,
        newValue: { stage: "error", outcome: "error", confirm_pause: data.confirmPause },
        reason: data.reason,
      });
      throw err;
    }
  });

/**
 * Recovery after a webhook-token update left the deployment paused: resumes
 * that one deployment back to active (its recorded original state), only if
 * Sarvam still shows the same agent, version and number, then clears the
 * durable recovery marker on the number row. Audited.
 */
export const resumeSarvamDeploymentAfterTokenUpdate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string; reason: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "numbers.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { resumeAfterFailedRotation, RESUME_AUDIT_ACTIONS } =
      await import("@/lib/sarvam-webhook-rotation.server");
    try {
      const result = await resumeAfterFailedRotation(
        supabaseAdmin,
        { organizationId: data.orgId },
        await sarvamRotationDeps(),
      );
      await writeAudit(admin, {
        action: RESUME_AUDIT_ACTIONS[result.outcome],
        entityType: "sarvam_deployment",
        entityId: result.deploymentId,
        organizationId: data.orgId,
        newValue: {
          stage: result.stage,
          outcome: result.outcome,
          deployment_id: result.deploymentId,
          status_before: result.statusBefore,
          status_after: result.statusAfter,
          marker_cleared: result.markerCleared,
        },
        reason: data.reason,
      });
      return { outcome: result.outcome, detail: result.detail };
    } catch (err) {
      await writeAudit(admin, {
        action: RESUME_AUDIT_ACTIONS.error,
        entityType: "sarvam_deployment",
        entityId: null,
        organizationId: data.orgId,
        newValue: { stage: "error", outcome: "error" },
        reason: data.reason,
      });
      throw err;
    }
  });
