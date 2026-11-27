import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AgentSnapshot } from "./agent-instructions.ts";
import {
  MASTER_AGENT_TOOLS,
  buildOutboundAgentConfig,
  buildUniversalAgentConfig,
} from "./universal-agent-config.ts";
import { customerAgentName, registerProvisionedAgent } from "./sarvam-agent-provisioner.server.ts";
import { CLOSED_LIFECYCLES, maskPhone, sanitizeDiagnostic } from "./voice-provisioning-job.ts";
import {
  CLICKAI_TOOL_NAMES,
  agentRef,
  clickAiToolDefinitions,
  sarvamSafePrompt,
  templateToolDefinitions,
} from "./sarvam-agent-tools-spec.ts";
import {
  claimedByAnotherCustomer,
  reportedAgent,
  toolsCreatedReport,
} from "./tool-auth-checkpoint.server.ts";
import { capabilitiesFor } from "./platform-admin.server.ts";
import { AGENT_ROLES, isAgentRole, registeredAgent, type AgentRole } from "./agent-roles.ts";
import { buildToolAuthCheckpoint } from "./tool-auth-checkpoint-view.ts";

/**
 * Operator bridge: the supported way to automate Sarvam agent authoring.
 *
 * Sarvam's only documented agent-authoring surface is its Voice Agents MCP
 * server, which needs an interactive Sarvam SSO login (OAuth 2.1, 24 h token,
 * no refresh token, no service credential). ClickAI therefore never holds a
 * Sarvam token. Instead a platform admin connects THEIR OWN MCP client (already
 * signed in to Sarvam by them) to this bridge as well. The client pulls a work
 * order (everything ClickAI generated for one customer), builds the agent in
 * Sarvam with Sarvam's own tools, and reports the agent id and version back.
 * ClickAI then registers it and the provisioning job continues by itself
 * (deployment, number routing, verification, activation: documented REST APIs).
 *
 * Bridge tokens are short-lived (default 1 h, <= 4 h), revocable, hash-only,
 * platform-admin issued and scoped to ONE customer, ONE job and ONE agent role.
 * Every request re-checks the issuer's rights and that the job is still open; the
 * token is used up by the one registration it can make.
 * The bridge never issues or returns a customer's integration credential, because
 * whatever it returns enters the operator's AI model context.
 */

type Admin = SupabaseClient<Database>;

export const BRIDGE_TOKEN_PREFIX = "cbr_";
export const BRIDGE_DEFAULT_HOURS = 1;
export const BRIDGE_MAX_HOURS = 4;
/** Job states in which an operator has agent work to do, per agent role. */
export const WORK_ORDER_STATES_BY_ROLE: Record<AgentRole, string[]> = {
  inbound: [
    "waiting_for_integration_credential",
    "waiting_for_agent",
    "waiting_for_tool_authentication",
  ],
  outbound: [
    "waiting_for_outbound_credential",
    "waiting_for_outbound_agent",
    "waiting_for_outbound_tool_authentication",
  ],
};
export const WORK_ORDER_STATES = AGENT_ROLES.flatMap((r) => WORK_ORDER_STATES_BY_ROLE[r]);
/** Which agent a job state is waiting on; null for states with no operator work. */
export const workOrderRole = (step: string | null | undefined): AgentRole | null =>
  AGENT_ROLES.find((r) => WORK_ORDER_STATES_BY_ROLE[r].includes(step ?? "")) ?? null;
const stageOf = (step: string | null) =>
  step?.endsWith("_credential")
    ? ("needs_credential" as const)
    : step?.endsWith("tool_authentication")
      ? ("needs_tool_authentication" as const)
      : ("needs_agent" as const);

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function customerClosed(admin: Admin, organizationId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("organizations")
    .select("lifecycle_status")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return !data || CLOSED_LIFECYCLES.includes(data.lifecycle_status);
}

/**
 * A token for ONE open work order: that customer, that job, and the one agent role the job is
 * waiting on. Issuing a new one revokes the job's previous token for that role.
 */
export async function issueBridgeToken(
  admin: Admin,
  input: { createdBy: string; runId: string; role?: AgentRole; hours?: number; now?: Date },
): Promise<{
  token: string;
  prefix: string;
  expiresAt: string;
  organizationId: string;
  runId: string;
  role: AgentRole;
}> {
  const run = await openRun(admin, input.runId);
  if (!run) throw new BridgeError("not_found", "No open work order with that id.");
  const role = input.role ?? run.role;
  if (role !== run.role)
    throw new BridgeError("invalid", `That work order is for the ${run.role} agent.`);
  if (await customerClosed(admin, run.organization_id))
    throw new BridgeError("conflict", "That customer is suspended or cancelled.");
  const hours = Math.min(Math.max(input.hours ?? BRIDGE_DEFAULT_HOURS, 1), BRIDGE_MAX_HOURS);
  const now = input.now ?? new Date();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const token = `${BRIDGE_TOKEN_PREFIX}${body}`;
  const prefix = token.slice(0, BRIDGE_TOKEN_PREFIX.length + 4);
  const expiresAt = new Date(now.getTime() + hours * 3_600_000).toISOString();
  const { error: replaceError } = await admin
    .from("operator_bridge_tokens")
    .update({ revoked_at: now.toISOString() })
    .eq("run_id", run.id)
    .eq("agent_role", role)
    .is("revoked_at", null);
  if (replaceError) throw replaceError;
  const { error } = await admin.from("operator_bridge_tokens").insert({
    token_hash: await sha256Hex(token),
    token_prefix: prefix,
    created_by: input.createdBy,
    expires_at: expiresAt,
    created_at: now.toISOString(),
    organization_id: run.organization_id,
    run_id: run.id,
    agent_role: role,
  });
  if (error) throw error;
  return { token, prefix, expiresAt, organizationId: run.organization_id, runId: run.id, role };
}

export async function revokeBridgeTokens(admin: Admin, now = new Date()): Promise<number> {
  const { data, error } = await admin
    .from("operator_bridge_tokens")
    .update({ revoked_at: now.toISOString() })
    .is("revoked_at", null)
    .gt("expires_at", now.toISOString())
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

export type BridgeAuth =
  | {
      ok: true;
      tokenId: string;
      createdBy: string;
      prefix: string;
      /** The only customer, job and agent role this token may touch. */
      organizationId: string;
      runId: string;
      role: AgentRole;
    }
  | { ok: false; reason: "missing" | "invalid" | "expired" | "revoked" };

export async function authenticateBridge(
  admin: Admin,
  header: string | null,
  now = new Date(),
): Promise<BridgeAuth> {
  const m = /^Bearer\s+(cbr_[A-Za-z0-9_-]{20,})$/.exec(header ?? "");
  if (!m) return { ok: false, reason: header ? "invalid" : "missing" };
  const { data, error } = await admin
    .from("operator_bridge_tokens")
    .select(
      "id, created_by, token_prefix, expires_at, revoked_at, organization_id, run_id, agent_role",
    )
    .eq("token_hash", await sha256Hex(m[1]!))
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, reason: "invalid" };
  if (data.revoked_at) return { ok: false, reason: "revoked" };
  if (new Date(data.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  // Revoked for good, so that restoring a right or reopening anything never revives it.
  const revoke = async (): Promise<BridgeAuth> => {
    const { error: revokeError } = await admin
      .from("operator_bridge_tokens")
      .update({ revoked_at: now.toISOString() })
      .eq("id", data.id);
    if (revokeError) console.error("operator_bridge:revoke_failed", revokeError.message);
    return { ok: false, reason: "revoked" };
  };
  const { organization_id: organizationId, run_id: runId, agent_role: role } = data;
  if (!organizationId || !runId || !isAgentRole(role)) return revoke();
  // A token is only as good as its issuer's rights NOW.
  const { data: issuer, error: issuerError } = await admin
    .from("platform_admins")
    .select("role, is_active")
    .eq("user_id", data.created_by)
    .maybeSingle();
  if (issuerError) throw issuerError;
  if (!issuer?.is_active || !capabilitiesFor(issuer.role).includes("agents.write")) return revoke();
  // The token ends with its job (finished, failed, gone) or when the job moves to the other role.
  const { data: run, error: runError } = await admin
    .from("provisioning_runs")
    .select("organization_id, status, current_step")
    .eq("id", runId)
    .maybeSingle();
  if (runError) throw runError;
  if (
    !run ||
    run.organization_id !== organizationId ||
    !["pending", "running", "waiting"].includes(run.status) ||
    (workOrderRole(run.current_step) ?? role) !== role
  )
    return revoke();
  // Cancelled or suspended customers: the job may not have noticed yet; the token ends now.
  if (await customerClosed(admin, organizationId)) return revoke();
  await admin
    .from("operator_bridge_tokens")
    .update({ last_used_at: now.toISOString() })
    .eq("id", data.id);
  return {
    ok: true,
    tokenId: data.id,
    createdBy: data.created_by,
    prefix: data.token_prefix,
    organizationId,
    runId,
    role,
  };
}

/** Everything outside the token's job is answered exactly like a job that does not exist. */
export function assertScope(auth: Extract<BridgeAuth, { ok: true }>, runId: string) {
  if (runId !== auth.runId) throw new BridgeError("not_found", "No open work order with that id.");
}

/** The token's own open job, still waiting on the token's own role. */
async function scopedRun(admin: Admin, auth: Extract<BridgeAuth, { ok: true }>, runId: string) {
  assertScope(auth, runId);
  const run = await openRun(admin, runId);
  if (!run || run.role !== auth.role)
    throw new BridgeError("not_found", "No open work order with that id.");
  return run;
}

/** Single use: one registration per token, decided by the database row. */
async function consumeToken(admin: Admin, tokenId: string, now: Date) {
  const { data, error } = await admin
    .from("operator_bridge_tokens")
    .update({ revoked_at: now.toISOString() })
    .eq("id", tokenId)
    .is("revoked_at", null)
    .select("id");
  if (error) throw error;
  if (!data?.length)
    throw new BridgeError("conflict", "This bridge token was already used. Create a new one.");
}

export interface WorkOrderDeps {
  loadSnapshot: (admin: Admin, businessId: string) => Promise<AgentSnapshot>;
  /** Public base URL Sarvam's HTTP tools call (TELEPHONY_WEBHOOK_BASE_URL). */
  baseUrl: string | null;
  masterAgentAppId: string | null;
  /** The outbound template agent, if one exists; never a customer's agent. */
  outboundMasterAgentAppId?: string | null;
  /** The COMMITTED master version customers are cloned from. */
  masterAgentVersion: number;
  /** Continues the customer's provisioning job after an agent is registered. */
  resume: (organizationId: string, actor: string) => Promise<unknown>;
  now?: () => Date;
}

export async function defaultWorkOrderDeps(): Promise<WorkOrderDeps> {
  const [{ loadSnapshot }, registration, { runProvisioning }] = await Promise.all([
    import("./agent-service.server.ts"),
    import("./sarvam-agent-registration.server.ts"),
    import("./provisioning-runs.server.ts"),
  ]);
  return {
    loadSnapshot,
    baseUrl: process.env["TELEPHONY_WEBHOOK_BASE_URL"]?.replace(/\/+$/, "") || null,
    masterAgentAppId: registration.masterAgentAppId(),
    outboundMasterAgentAppId: registration.outboundMasterAgentAppId(),
    masterAgentVersion: registration.masterAgentVersion(),
    resume: async (organizationId, actor) => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      return runProvisioning(supabaseAdmin, {
        organizationId,
        trigger: "admin_retry",
        createdBy: actor,
        force: true,
      });
    },
  };
}

interface OpenRun {
  id: string;
  organization_id: string;
  current_step: string | null;
  phone_number_id: string | null;
  role: AgentRole;
}

async function openRun(admin: Admin, runId: string): Promise<OpenRun | null> {
  const { data, error } = await admin
    .from("provisioning_runs")
    .select("id, organization_id, current_step, phone_number_id, status")
    .eq("id", runId)
    .eq("status", "waiting")
    .maybeSingle();
  if (error) throw error;
  const role = workOrderRole(data?.current_step);
  return data && role ? { ...data, role } : null;
}

async function agentOf(admin: Admin, organizationId: string) {
  const { data, error } = await admin
    .from("agent_configs")
    .select(
      "id, organization_id, business_id, sarvam_app_id, sarvam_app_version, sarvam_outbound_app_id, sarvam_outbound_app_version",
    )
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listWorkOrders(admin: Admin, now: Date = new Date(), onlyRunId?: string) {
  let query = admin
    .from("provisioning_runs")
    .select(
      "id, organization_id, current_step, phone_number_id, created_at, failure_code, sarvam_agent_id",
    )
    .eq("status", "waiting")
    .in("current_step", WORK_ORDER_STATES);
  if (onlyRunId) query = query.eq("id", onlyRunId);
  const { data, error } = await query.order("created_at", { ascending: true }).limit(50);
  if (error) throw error;
  const out = [];
  for (const r of data ?? []) {
    const agent = await agentOf(admin, r.organization_id);
    if (!agent?.business_id) continue;
    const { data: org } = await admin
      .from("organizations")
      .select("name")
      .eq("id", r.organization_id)
      .maybeSingle();
    const role = workOrderRole(r.current_step)!;
    const agentName = customerAgentName(r.organization_id, agent.id, role);
    const awaitingAuth = stageOf(r.current_step) === "needs_tool_authentication";
    // What the operator reported for this job and role, if anything yet.
    const report = awaitingAuth
      ? await toolsCreatedReport(admin, r.organization_id, r.id, role)
      : null;
    // An agent registered by hand has no "tools created" report: the checkpoint still applies,
    // so show it for the registered agent with no tool reported yet.
    const checkpointAgentId =
      report?.appId ??
      (role === "inbound" ? r.sarvam_agent_id : (registeredAgent(agent, role)?.appId ?? null));
    const checkpoint =
      awaitingAuth && checkpointAgentId
        ? buildToolAuthCheckpoint({
            role,
            jobId: r.id,
            customerId: r.organization_id,
            customer: org?.name ?? "(unknown)",
            agentId: checkpointAgentId,
            credentialName: `clickai-${agentName}`,
            agentRef: agentRef(role, agent.id),
            master: report?.master ?? null,
            waitingSince: report?.reportedAt ?? r.created_at,
            now,
            toolsReported: report?.tools ?? [],
          })
        : null;
    out.push({
      checkpoint,
      workOrderId: r.id,
      agentRole: role,
      customerId: r.organization_id,
      customer: org?.name ?? "(unknown)",
      /** Set when an operator reported it cannot continue (for example Sarvam sign-in required). */
      blocked: r.failure_code === "WAITING_FOR_OPERATOR",
      agentName,
      /** The agent the operator reported (tools created), once credentials are pending. */
      agentId: awaitingAuth ? checkpointAgentId : null,
      stage: stageOf(r.current_step),
      queuedAt: r.created_at,
    });
  }
  return out;
}

export async function getWorkOrder(admin: Admin, runId: string, deps: WorkOrderDeps) {
  const run = await openRun(admin, runId);
  if (!run || run.role !== "inbound")
    throw new BridgeError("not_found", "No open work order with that id.");
  const agent = await agentOf(admin, run.organization_id);
  if (!agent?.business_id)
    throw new BridgeError("not_ready", "The customer has no agent record yet.");
  if (!deps.baseUrl)
    throw new BridgeError("not_configured", "TELEPHONY_WEBHOOK_BASE_URL is not set.");
  const snapshot = await deps.loadSnapshot(admin, agent.business_id);
  const { data: voice, error: voiceError } = await admin
    .from("agent_voice_language_settings")
    .select(
      "organization_id, default_language, allowed_languages, auto_language_switch, sarvam_voice_internal_id, status, applied_sarvam_app_id, applied_sarvam_app_version",
    )
    .eq("agent_config_id", agent.id)
    .eq("organization_id", run.organization_id)
    .maybeSingle();
  if (voiceError) throw voiceError;
  const config = buildUniversalAgentConfig(snapshot, voice ?? null);
  if (config.blockers.length || config.voiceLanguageProblem)
    throw new BridgeError(
      "not_ready",
      [...config.blockers, config.voiceLanguageProblem].filter(Boolean).join(" "),
    );

  const { sarvamToolConfiguration } = await import("./sarvam-agent-api.server.ts");
  const { HEALTHCARE_BUSINESS_TYPES } = await import("./sarvam-agent-prompt.ts");
  const tools = sarvamToolConfiguration(deps.baseUrl, "inbound", {
    healthcare: HEALTHCARE_BUSINESS_TYPES.includes(snapshot.business.business_type),
    tools: config.tools.enable,
  });
  const { data: cred, error: credError } = await admin
    .from("sarvam_agent_integrations")
    .select("id")
    .eq("agent_config_id", agent.id)
    .eq("role", "inbound")
    .eq("status", "active")
    .maybeSingle();
  if (credError) throw credError;
  const agentName = customerAgentName(run.organization_id, agent.id);
  const [{ data: org }, { data: number }] = await Promise.all([
    admin.from("organizations").select("name").eq("id", run.organization_id).maybeSingle(),
    run.phone_number_id
      ? admin
          .from("phone_numbers")
          .select("e164, sarvam_number_confirmed_at")
          .eq("id", run.phone_number_id)
          .eq("organization_id", run.organization_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const active = (xs: { is_active: boolean }[]) => xs.filter((x) => x.is_active).length;
  const booking = config.capabilities.some(
    (c) => c.enabled && (c.id === "appointment_booking" || c.id === "restaurant_reservations"),
  );

  // Prompt: the clone already carries the master's prompt. Only a customer whose tool set or
  // category yields a DIFFERENT prompt gets a replacement text (Sarvam-compatible, no language bullets).
  const masterPrompt = sarvamSafePrompt(
    sarvamToolConfiguration(deps.baseUrl, "inbound", {
      healthcare: false,
      tools: [...MASTER_AGENT_TOOLS],
    }).systemPrompt,
  ).text;
  const customerPrompt = sarvamSafePrompt(tools.systemPrompt).text;
  const promptMatchesMaster = customerPrompt === masterPrompt;

  // Fixed on every tool: ClickAI refuses a call whose credential belongs to another agent.
  const ref = agentRef("inbound", agent.id);
  const toolSpecs = clickAiToolDefinitions(deps.baseUrl, ref).map((d) => ({
    name: d.name,
    toolType: d.toolType,
    lifecycle: d.lifecycle,
    description: d.description,
    // All six are created on every customer agent (clones carry no tools); the ones this
    // customer's capabilities do not use are then switched off.
    enabled: d.enabledBy === "always" || (config.tools.enable as string[]).includes(d.name),
    connectorConfig: d.connectorConfig,
  }));
  const masterReady = Boolean(deps.masterAgentAppId);
  const stage =
    run.current_step === "waiting_for_tool_authentication"
      ? "needs_tool_authentication"
      : "needs_agent";
  const reported =
    run.current_step === "waiting_for_tool_authentication"
      ? await reportedAgent(admin, run.organization_id, run.id)
      : null;
  const credentialSecretName = `clickai-${agentName}`;
  return {
    workOrderId: run.id,
    status: "WAITING_FOR_AGENT_CREATION" as const,
    stage,
    jobId: run.id,
    customerId: run.organization_id,
    customer: org?.name ?? "(unknown)",
    agentName,
    businessType: snapshot.business.business_type,
    // The one universal master agent, cloned at a COMMITTED version (never its draft);
    // "profile" says which tool set this customer gets (matching the generated tool list).
    master: {
      agentId: deps.masterAgentAppId,
      version: deps.masterAgentVersion,
      source: "committed_version" as const,
    },
    template: {
      kind: "universal_master" as const,
      profile: booking ? ("booking" as const) : ("enquiry" as const),
      masterAgentAppId: deps.masterAgentAppId,
    },
    templateAgentAppId: deps.masterAgentAppId,
    /** What the operator passes to configure_agent to create the customer's agent. */
    clone: {
      configureAgent: {
        name: agentName,
        clone_from: deps.masterAgentAppId,
        clone_version: deps.masterAgentVersion,
        config: config.voiceLanguage?.sarvamConfig ?? null,
      },
      prompt: promptMatchesMaster
        ? { action: "keep_cloned_prompt" as const }
        : { action: "replace_prompt" as const, text: customerPrompt },
    },
    tools: toolSpecs,
    /** Reported once the agent exists with its tools; the credentials are then chosen in the Sarvam console. */
    reportedAgentId: reported?.appId ?? null,
    credentialSecretName,
    /** Who this work order is for. The bridge token works for exactly this and nothing else. */
    scope: { customerId: run.organization_id, jobId: run.id, agentRole: "inbound" as const },
    agentRef: ref,
    assignedNumber: maskPhone(number?.e164),
    summary: {
      services: active(snapshot.services),
      faqs: active(snapshot.faqs),
      rules: active(snapshot.rules),
      openDays: snapshot.hours.filter((h) => !h.is_closed).length,
      tools: config.tools.enable,
    },
    checklist: [
      { item: "Onboarding data complete for every enabled capability", ok: true },
      { item: "Business category set", ok: Boolean(snapshot.business.business_type?.trim()) },
      { item: "Voice and languages valid", ok: true },
      {
        item: "Number assigned to this customer and confirmed in Sarvam",
        ok: Boolean(number?.sarvam_number_confirmed_at),
      },
      { item: "Master template configured in ClickAI", ok: masterReady },
      { item: "Agent integration credential issued", ok: Boolean(cred) },
    ],
    fingerprint: config.fingerprint,
    credentialIssued: Boolean(cred),
    agent: {
      inputVariables: tools.inputVariables,
      enabledCapabilities: config.capabilities.filter((c) => c.enabled).map((c) => c.id),
      voiceLanguage: config.voiceLanguage,
    },
    instructions: [
      "0. Check Sarvam sign-in by listing agents. If that fails with an authorization error, call report_blocker (reason sarvam_auth_required) and STOP; do not retry or use any other route.",
      `1. If an agent named "${agentName}" already exists, reuse it (never create a second one) and continue from the first missing step below.`,
      "2. Clone: configure_agent with clone.configureAgent exactly (clone_from the master, clone_version the COMMITTED master version, never a draft; the config overlay sets this customer's voice and languages). Apply clone.prompt only when its action is replace_prompt, with prompt_edits whose old_text is the whole current prompt.",
      "3. Never ask for, read, repeat or type a credential value, and do not call configure_secret. If credentialIssued is false, ask the person to generate it themselves in the ClickAI admin screen (Provisioning, this customer, integration credential) and to paste it straight into the Sarvam console as a secret named credentialSecretName. Wait until they say it is done.",
      "4. Recreate all six tools (clones carry none): for each entry of tools, configure_app_tool with its toolType and connectorConfig exactly, including the fixed body field agent_ref (create it, or update the existing tool of that name by tool_id). Do not add an auth key. Then agents set_tools: enable exactly the tools with enabled true, disable the others.",
      "5. Read the draft back (agents get, include tools) and confirm all six exist with the same URLs, the fixed agent_ref value, system_variable bindings (interaction_id, user_identifier), timeouts and reply templates.",
      "6. Call report_tools_created. ClickAI then shows the job as waiting for tool authentication, with this agent id.",
      "7. A person selects the ClickAI credential on each of the six tools in the Sarvam console (this MCP cannot). Do this BEFORE committing: a committed version is frozen with the credentials its tools have.",
      "8. Read the draft back and confirm every tool now has bearer auth, then commit once, then read the COMMITTED version back (agents get with app_version) and confirm all six tools still show bearer auth.",
      `9. Call submit_agent_result with workOrderId, agentId, the committed version, fingerprint "${config.fingerprint}" and toolAuth (name, authType and agentRef for all six, from the committed version's read-back).`,
      "Do not create deployments or attach numbers: ClickAI does that after step 9.",
    ],
  };
}

/** What the outbound agent is generated from: its own configuration, never the inbound one. */
async function outboundBuild(admin: Admin, runId: string, deps: WorkOrderDeps) {
  const run = await openRun(admin, runId);
  if (!run || run.role !== "outbound")
    throw new BridgeError("not_found", "No open work order with that id.");
  const agent = await agentOf(admin, run.organization_id);
  if (!agent?.business_id)
    throw new BridgeError("not_ready", "The customer has no agent record yet.");
  if (!deps.baseUrl)
    throw new BridgeError("not_configured", "TELEPHONY_WEBHOOK_BASE_URL is not set.");
  const snapshot = await deps.loadSnapshot(admin, agent.business_id);
  const { data: voice, error } = await admin
    .from("agent_voice_language_settings")
    .select(
      "organization_id, default_language, allowed_languages, auto_language_switch, sarvam_voice_internal_id",
    )
    .eq("agent_config_id", agent.id)
    .eq("organization_id", run.organization_id)
    .maybeSingle();
  if (error) throw error;
  const config = buildOutboundAgentConfig(snapshot, voice ?? null);
  if (config.blockers.length || config.voiceLanguageProblem)
    throw new BridgeError(
      "not_ready",
      [...config.blockers, config.voiceLanguageProblem].filter(Boolean).join(" "),
    );
  const { sarvamToolConfiguration } = await import("./sarvam-agent-api.server.ts");
  const { HEALTHCARE_BUSINESS_TYPES } = await import("./sarvam-agent-prompt.ts");
  const template = sarvamToolConfiguration(deps.baseUrl, "outbound", {
    healthcare: HEALTHCARE_BUSINESS_TYPES.includes(snapshot.business.business_type),
    tools: config.tools.enable,
  });
  const ref = agentRef("outbound", agent.id);
  const tools = templateToolDefinitions(template.tools, ref);
  return { run, agent, config, template, tools, ref };
}

/**
 * The outbound agent's work order. The agent is created new (never cloned from the inbound
 * agent or its master) with only the outbound tools the customer's capabilities allow.
 */
export async function getOutboundWorkOrder(admin: Admin, runId: string, deps: WorkOrderDeps) {
  const { run, agent, config, template, tools, ref } = await outboundBuild(admin, runId, deps);
  const agentName = customerAgentName(run.organization_id, agent.id, "outbound");
  const credentialSecretName = `clickai-${agentName}`;
  const [{ data: org }, { data: cred, error }] = await Promise.all([
    admin.from("organizations").select("name").eq("id", run.organization_id).maybeSingle(),
    admin
      .from("sarvam_agent_integrations")
      .select("id")
      .eq("agent_config_id", agent.id)
      .eq("role", "outbound")
      .eq("status", "active")
      .maybeSingle(),
  ]);
  if (error) throw error;
  const reported = await reportedAgent(admin, run.organization_id, run.id, "outbound");
  return {
    workOrderId: run.id,
    status: "WAITING_FOR_AGENT_CREATION" as const,
    stage: stageOf(run.current_step),
    jobId: run.id,
    customerId: run.organization_id,
    customer: org?.name ?? "(unknown)",
    scope: { customerId: run.organization_id, jobId: run.id, agentRole: "outbound" as const },
    agentName,
    agentRef: ref,
    create: {
      configureAgent: { name: agentName, config: config.voiceLanguage?.sarvamConfig ?? null },
      prompt: sarvamSafePrompt(template.systemPrompt).text,
    },
    tools,
    forbiddenTools: [...config.tools.forbidden],
    inputVariables: template.inputVariables,
    outputVariables: template.outputVariables,
    callHandling: config.callHandling,
    credentialSecretName,
    credentialIssued: Boolean(cred),
    reportedAgentId: reported?.appId ?? null,
    fingerprint: config.fingerprint,
    limitations: [
      "ClickAI cannot read the agent back from Sarvam: tools, settings and credentials are as the operator reports them.",
      "Confirming the tool credentials does not enable calling: an admin still confirms this version after a supervised call.",
    ],
    instructions: [
      "0. Check Sarvam sign-in by listing agents. If that fails with an authorization error, call report_blocker (reason sarvam_auth_required) and STOP.",
      `1. If an agent named "${agentName}" already exists, reuse it. Never use, copy or clone this customer's inbound agent or the inbound master.`,
      "2. Create it new: configure_agent with create.configureAgent, then prompt_append with create.prompt. Declare every inputVariables and outputVariables entry.",
      "3. Never ask for, read, repeat or type a credential value, and do not call configure_secret. If credentialIssued is false, ask the person to generate the OUTBOUND credential in the ClickAI admin screen (Provisioning, this customer) and paste it straight into the Sarvam console as a secret named credentialSecretName.",
      `4. Create exactly these ${tools.length} tools with their toolType and connectorConfig, including the fixed body field agent_ref, and enable only them. Do not add an auth key. The tools in forbiddenTools must not exist or be enabled.`,
      "5. Apply callHandling: maximum call length, voicemail detection and message, and NO call transfer. Read the draft back and confirm all of the above.",
      "6. Call report_tools_created with the agent ID and the tool names.",
      "7. A person selects the OUTBOUND credential on every tool in the Sarvam console, BEFORE committing.",
      "8. Read the draft back, commit once, then read the COMMITTED version back and confirm every tool still shows bearer auth.",
      `9. Call submit_agent_result with workOrderId, agentId, the committed version, fingerprint "${config.fingerprint}" and toolAuth (name, authType, agentRef for every tool).`,
      "Do not place calls or create campaigns.",
    ],
  };
}

export class BridgeError extends Error {
  code: "not_found" | "not_ready" | "not_configured" | "conflict" | "invalid";
  constructor(code: BridgeError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

async function bridgeAudit(
  admin: Admin,
  auth: Extract<BridgeAuth, { ok: true }>,
  run: { id: string; organization_id: string },
  event: string,
  detail: Record<string, unknown>,
) {
  const { error } = await admin.from("provisioning_run_events").insert({
    run_id: run.id,
    organization_id: run.organization_id,
    step: "creating_agent",
    event,
    detail: { via: "operator_bridge", token: auth.prefix, ...detail } as never,
  });
  if (error) console.error("operator_bridge:event_write_failed", event, error.message);
}

/**
 * The operator reports the agent it built. Idempotent: the same id and version
 * again is a no-op; a different agent for an already-registered customer is refused.
 */
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/;

/** A pasted token matches the agent-id shape: refuse it before it is stored or echoed. */
const isAgentId = (v: string) => APP_ID_PATTERN.test(v) && !/^(cai_sv_|cbr_)/i.test(v);

function requireToolNames(names: unknown, expected: readonly string[], what: string): string[] {
  const list = Array.isArray(names) ? names.map((n) => String(n)) : [];
  const want = new Set(expected);
  if (
    list.length !== want.size ||
    !list.every((n) => want.has(n)) ||
    new Set(list).size !== want.size
  )
    throw new BridgeError(
      "invalid",
      `${what} must list exactly these ${want.size} ClickAI tools: ${expected.join(", ")}.`,
    );
  return list;
}

/** The tools an agent of this role must have for this customer. */
async function expectedTools(
  admin: Admin,
  role: AgentRole,
  runId: string,
  deps: WorkOrderDeps,
): Promise<readonly string[]> {
  if (role === "inbound") return CLICKAI_TOOL_NAMES;
  return (await outboundBuild(admin, runId, deps)).tools.map((t) => t.name);
}

/**
 * The operator reports that the customer's agent exists (cloned from the committed master)
 * with all six tools, credentials still to be chosen in the Sarvam console. ClickAI records
 * it, shows the agent id, and parks the job at the tool-authentication checkpoint.
 * Idempotent for the same agent; a different agent for the same customer is refused.
 */
export async function reportToolsCreated(
  admin: Admin,
  input: {
    workOrderId: string;
    appId: string;
    /** Inbound only: the committed master it was cloned from. */
    clonedFrom?: { agentId: string; version: number } | undefined;
    tools: unknown;
  },
  auth: Extract<BridgeAuth, { ok: true }>,
  deps: WorkOrderDeps,
) {
  if (!isAgentId(input.appId ?? ""))
    throw new BridgeError("invalid", "That does not look like a Sarvam agent id.");
  const run = await scopedRun(admin, auth, input.workOrderId);
  const role = run.role;
  const agent = await agentOf(admin, run.organization_id);
  if (!agent?.business_id)
    throw new BridgeError("not_ready", "The customer has no agent record yet.");
  if (input.appId === deps.masterAgentAppId || input.appId === deps.outboundMasterAgentAppId)
    throw new BridgeError("conflict", "That is the master template, not a customer agent.");
  if (
    role === "inbound" &&
    (!deps.masterAgentAppId ||
      input.clonedFrom?.agentId !== deps.masterAgentAppId ||
      input.clonedFrom?.version !== deps.masterAgentVersion)
  )
    throw new BridgeError(
      "conflict",
      `The agent must be cloned from the committed master ${deps.masterAgentAppId} version ${deps.masterAgentVersion}.`,
    );
  if (
    role === "outbound" &&
    (input.appId === agent.sarvam_app_id ||
      (input.clonedFrom?.agentId &&
        [deps.masterAgentAppId, agent.sarvam_app_id].includes(input.clonedFrom.agentId)))
  )
    throw new BridgeError(
      "conflict",
      "The outbound agent must be its own agent: never the inbound agent, nor a copy of it or of the inbound master.",
    );
  const tools = requireToolNames(
    input.tools,
    await expectedTools(admin, role, run.id, deps),
    "tools",
  );
  // Another customer's agent can never be reported here.
  const { data: owner, error: ownerError } = await admin
    .from("agent_configs")
    .select("organization_id")
    .eq("sarvam_app_id", input.appId)
    .neq("organization_id", run.organization_id)
    .limit(1);
  if (ownerError) throw ownerError;
  if ((owner ?? []).length)
    throw new BridgeError("conflict", "That Sarvam agent already belongs to another customer.");
  // Nor one another customer's job has reported (either role), nor an agent of the other role.
  const otherRoleColumn = role === "inbound" ? "sarvam_outbound_app_id" : "sarvam_app_id";
  const [reportedByRun, otherRole, otherOwner] = await Promise.all([
    admin
      .from("provisioning_runs")
      .select("id")
      .eq("sarvam_agent_id", input.appId)
      .neq("organization_id", run.organization_id)
      .limit(1),
    admin.from("agent_configs").select("id").eq(otherRoleColumn, input.appId).limit(1),
    admin
      .from("agent_configs")
      .select("id")
      .eq("sarvam_outbound_app_id", input.appId)
      .neq("organization_id", run.organization_id)
      .limit(1),
  ]);
  for (const r of [reportedByRun, otherRole, otherOwner]) if (r.error) throw r.error;
  if (
    reportedByRun.data?.length ||
    (await claimedByAnotherCustomer(admin, input.appId, run.organization_id))
  )
    throw new BridgeError(
      "conflict",
      "That Sarvam agent already belongs to another customer. If it was reported there by mistake, a ClickAI admin can release it on that customer's provisioning page.",
    );
  if (otherRole.data?.length)
    throw new BridgeError(
      "conflict",
      `That Sarvam agent is registered as an ${role === "inbound" ? "outbound" : "inbound"} agent. The ${role} agent must be a different one.`,
    );
  if (otherOwner.data?.length)
    throw new BridgeError("conflict", "That Sarvam agent already belongs to another customer.");
  const registered = registeredAgent(agent, role);
  if (registered && registered.appId !== input.appId)
    throw new BridgeError(
      "conflict",
      "This customer already has a different agent registered. Replace it in the ClickAI admin screen.",
    );
  const previous = await reportedAgent(admin, run.organization_id, run.id, role);
  if (previous && previous.appId !== input.appId)
    throw new BridgeError(
      "conflict",
      `A different agent (${previous.appId}) was already reported for this customer. Reuse it instead of creating another. If that ID is wrong, a ClickAI admin releases it on the Provisioning page and creates a new token.`,
    );
  if (previous) return { status: "already_reported" as const, agentId: previous.appId };
  // Releasing an ID ends the token: a request already in flight writes nothing.
  const { data: stillLive, error: tokenError } = await admin
    .from("operator_bridge_tokens")
    .select("id")
    .eq("id", auth.tokenId)
    .is("revoked_at", null)
    .maybeSingle();
  if (tokenError) throw tokenError;
  if (!stillLive)
    throw new BridgeError("conflict", "This bridge token has ended. Create a new one.");
  await bridgeAudit(admin, auth, run, "agent_tools_created", {
    role,
    appId: input.appId,
    ...(input.clonedFrom ? { clonedFrom: input.clonedFrom } : {}),
    tools,
  });
  // The job's sarvam_agent_id column is the inbound agent's.
  if (role === "inbound") {
    const { error } = await admin
      .from("provisioning_runs")
      .update({ sarvam_agent_id: input.appId })
      .eq("id", run.id)
      .eq("organization_id", run.organization_id);
    if (error) throw error;
  }
  const resumed = await deps.resume(run.organization_id, auth.createdBy).then(
    () => true,
    (e) => {
      console.error("operator_bridge:resume_failed", (e as Error).message);
      return false;
    },
  );
  return { status: "recorded" as const, agentId: input.appId, jobResumed: resumed };
}

/**
 * The operator reports the COMMITTED agent version of the token's role. It is registered only
 * when the tools were reported first (so the checkpoint cannot be skipped) and the committed
 * version's read-back shows credentials on every tool. Idempotent for the same id and version.
 */
export async function submitAgentResult(
  admin: Admin,
  input: {
    workOrderId: string;
    appId: string;
    version: number;
    fingerprint: string;
    toolAuth: unknown;
  },
  auth: Extract<BridgeAuth, { ok: true }>,
  deps: WorkOrderDeps,
) {
  assertScope(auth, input.workOrderId);
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new BridgeError("invalid", "version must be a positive whole number.");
  if (!isAgentId(input.appId ?? ""))
    throw new BridgeError("invalid", "That does not look like a Sarvam agent id.");
  const run = await openRun(admin, input.workOrderId);
  if (!run) {
    // Already submitted and moved on? Report idempotently instead of failing the operator's batch.
    const { data: done } = await admin
      .from("provisioning_runs")
      .select("organization_id")
      .eq("id", input.workOrderId)
      .maybeSingle();
    const agent = done ? await agentOf(admin, done.organization_id) : null;
    const current = agent ? registeredAgent(agent, auth.role) : null;
    if (current?.appId === input.appId && current.version === input.version)
      return { status: "already_registered" as const };
    throw new BridgeError("not_found", "No open work order with that id.");
  }
  if (run.role !== auth.role)
    throw new BridgeError("not_found", "No open work order with that id.");
  const role = run.role;
  const agent = await agentOf(admin, run.organization_id);
  if (!agent?.business_id)
    throw new BridgeError("not_ready", "The customer has no agent record yet.");
  const registered = registeredAgent(agent, role);
  if (registered && registered.appId !== input.appId)
    throw new BridgeError(
      "conflict",
      "This customer already has a different agent registered. Replace it in the ClickAI admin screen.",
    );
  // A stale submission never replaces a newer registered version.
  if (registered && input.version < registered.version)
    throw new BridgeError(
      "conflict",
      `Version ${registered.version} of this agent is already registered; version ${input.version} is older. Submit the current committed version.`,
    );
  // The tools must have been reported for THIS agent first: the checkpoint cannot be skipped.
  const reported = await reportedAgent(admin, run.organization_id, run.id, role);
  if (reported?.appId !== input.appId)
    throw new BridgeError(
      "conflict",
      "Report the agent's tools first (report_tools_created) for this agent, then select the credentials in the Sarvam console, commit, and submit.",
    );
  // Evidence from the committed version's read-back: a credential on every one of its tools.
  const evidence = Array.isArray(input.toolAuth)
    ? (input.toolAuth as { name?: unknown; authType?: unknown; agentRef?: unknown }[])
    : [];
  requireToolNames(
    evidence.map((e) => e?.name),
    await expectedTools(admin, role, run.id, deps),
    "toolAuth",
  );
  const missing = evidence.filter(
    (e) => !["bearer", "api_key", "basic"].includes(String(e.authType)),
  );
  if (missing.length)
    throw new BridgeError(
      "conflict",
      `These tools have no credential on the committed version: ${missing.map((e) => String(e.name)).join(", ")}. Select it in the Sarvam console on the draft, commit again, and submit the new version.`,
    );
  // Every tool must carry this customer's reference, or a wrongly selected credential would
  // not be caught when the agent calls ClickAI.
  const expectedRef = agentRef(role, agent.id);
  const wrongRef = evidence.filter((e) => e.agentRef !== expectedRef);
  if (wrongRef.length)
    throw new BridgeError(
      "conflict",
      `These tools do not carry this customer's fixed agent_ref value (${expectedRef}): ${wrongRef.map((e) => String(e.name)).join(", ")}. Fix them on the draft, commit again, and submit the new version.`,
    );
  // The reported fingerprint must match what ClickAI generates NOW, so an agent built from an
  // out-of-date work order (settings changed since) is rejected, not registered.
  const current =
    role === "inbound"
      ? await getWorkOrder(admin, run.id, deps)
      : await getOutboundWorkOrder(admin, run.id, deps);
  if (input.fingerprint !== current.fingerprint)
    throw new BridgeError(
      "conflict",
      "The agent was built from an outdated work order (the customer's settings changed). Fetch the work order again and update the agent.",
    );
  await consumeToken(admin, auth.tokenId, deps.now?.() ?? new Date());
  try {
    await registerProvisionedAgent(admin, {
      role,
      organizationId: run.organization_id,
      agentConfigId: agent.id,
      appId: input.appId,
      version: input.version,
      masterAgentAppId: deps.masterAgentAppId,
      outboundMasterAgentAppId: deps.outboundMasterAgentAppId ?? null,
      registeredBy: auth.createdBy,
      now: deps.now?.() ?? new Date(),
    });
  } catch (e) {
    throw new BridgeError("conflict", sanitizeDiagnostic((e as Error).message));
  }
  await bridgeAudit(admin, auth, run, "tool_auth_confirmed", {
    role,
    appId: input.appId,
    version: input.version,
    tools: evidence.map((e) => ({ name: String(e.name), authType: String(e.authType) })),
  });
  await bridgeAudit(admin, auth, run, "agent_submitted", {
    role,
    appId: input.appId,
    version: input.version,
    fingerprint: input.fingerprint,
  });
  // Continue the job now; the scheduled sweep is the backstop if this fails.
  const resumed = await deps.resume(run.organization_id, auth.createdBy).then(
    () => true,
    (e) => {
      console.error("operator_bridge:resume_failed", (e as Error).message);
      return false;
    },
  );
  return { status: "registered" as const, jobResumed: resumed };
}

/**
 * The operator's client cannot continue (typically Sarvam sign-in expired). The
 * job stays parked, visibly "waiting for operator"; nothing retries and nothing
 * is created. The next get_agent_work_order / submit simply continues.
 */
export async function reportBlocker(
  admin: Admin,
  input: { workOrderId: string; reason: string; message?: string | undefined },
  auth: Extract<BridgeAuth, { ok: true }>,
) {
  const run = await scopedRun(admin, auth, input.workOrderId);
  const reason = input.reason === "sarvam_auth_required" ? "sarvam_auth_required" : "other";
  const message =
    reason === "sarvam_auth_required"
      ? "Sarvam sign-in is required: sign in to the Sarvam Voice Agents MCP in your client (24 h session), then process this work order again."
      : sanitizeDiagnostic(input.message ?? "The operator could not continue.", 300);
  const { data: before, error: readError } = await admin
    .from("provisioning_runs")
    .select("diagnostics")
    .eq("id", run.id)
    .maybeSingle();
  if (readError) throw readError;
  const { error } = await admin
    .from("provisioning_runs")
    .update({
      failure_code: "WAITING_FOR_OPERATOR",
      retryable: null,
      diagnostics: {
        ...((before?.diagnostics as Record<string, unknown> | null) ?? {}),
        blocker: reason,
        note: message,
      } as never,
    })
    .eq("id", run.id)
    .eq("organization_id", run.organization_id)
    .eq("status", "waiting");
  if (error) throw error;
  await bridgeAudit(admin, auth, run, "operator_blocked", { reason });
  return { status: "recorded" as const, message };
}
