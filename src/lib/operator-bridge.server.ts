import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AgentSnapshot } from "./agent-instructions.ts";
import { MASTER_AGENT_TOOLS, buildUniversalAgentConfig } from "./universal-agent-config.ts";
import { customerAgentName, registerProvisionedAgent } from "./sarvam-agent-provisioner.server.ts";
import { maskPhone, sanitizeDiagnostic } from "./voice-provisioning-job.ts";
import {
  CLICKAI_TOOL_NAMES,
  clickAiToolDefinitions,
  sarvamSafePrompt,
} from "./sarvam-agent-tools-spec.ts";
import { reportedAgent, toolsCreatedReport } from "./tool-auth-checkpoint.server.ts";
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
 * Bridge tokens are short-lived (<= 12 h), revocable, hash-only, platform-admin
 * issued, and grant nothing but these four operations.
 */

type Admin = SupabaseClient<Database>;

export const BRIDGE_TOKEN_PREFIX = "cbr_";
export const BRIDGE_MAX_HOURS = 12;
/** Job states in which an operator has agent work to do. */
export const WORK_ORDER_STATES = [
  "waiting_for_integration_credential",
  "waiting_for_agent",
  "waiting_for_tool_authentication",
];

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function issueBridgeToken(
  admin: Admin,
  input: { createdBy: string; hours?: number; now?: Date },
): Promise<{ token: string; prefix: string; expiresAt: string }> {
  const hours = Math.min(Math.max(input.hours ?? 8, 1), BRIDGE_MAX_HOURS);
  const now = input.now ?? new Date();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const body = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const token = `${BRIDGE_TOKEN_PREFIX}${body}`;
  const expiresAt = new Date(now.getTime() + hours * 3_600_000).toISOString();
  const { error } = await admin.from("operator_bridge_tokens").insert({
    token_hash: await sha256Hex(token),
    token_prefix: token.slice(0, BRIDGE_TOKEN_PREFIX.length + 4),
    created_by: input.createdBy,
    expires_at: expiresAt,
    created_at: now.toISOString(),
  });
  if (error) throw error;
  return { token, prefix: token.slice(0, BRIDGE_TOKEN_PREFIX.length + 4), expiresAt };
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
  | { ok: true; tokenId: string; createdBy: string; prefix: string }
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
    .select("id, created_by, token_prefix, expires_at, revoked_at")
    .eq("token_hash", await sha256Hex(m[1]!))
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, reason: "invalid" };
  if (data.revoked_at) return { ok: false, reason: "revoked" };
  if (new Date(data.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  await admin
    .from("operator_bridge_tokens")
    .update({ last_used_at: now.toISOString() })
    .eq("id", data.id);
  return { ok: true, tokenId: data.id, createdBy: data.created_by, prefix: data.token_prefix };
}

export interface WorkOrderDeps {
  loadSnapshot: (admin: Admin, businessId: string) => Promise<AgentSnapshot>;
  /** Public base URL Sarvam's HTTP tools call (TELEPHONY_WEBHOOK_BASE_URL). */
  baseUrl: string | null;
  masterAgentAppId: string | null;
  /** The COMMITTED master version customers are cloned from. */
  masterAgentVersion: number;
  /** Continues the customer's provisioning job after an agent is registered. */
  resume: (organizationId: string, actor: string) => Promise<unknown>;
  now?: () => Date;
}

export async function defaultWorkOrderDeps(): Promise<WorkOrderDeps> {
  const [{ loadSnapshot }, { masterAgentAppId, masterAgentVersion }, { runProvisioning }] =
    await Promise.all([
      import("./agent-service.server.ts"),
      import("./sarvam-agent-registration.server.ts"),
      import("./provisioning-runs.server.ts"),
    ]);
  return {
    loadSnapshot,
    baseUrl: process.env["TELEPHONY_WEBHOOK_BASE_URL"]?.replace(/\/+$/, "") || null,
    masterAgentAppId: masterAgentAppId(),
    masterAgentVersion: masterAgentVersion(),
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
}

async function openRun(admin: Admin, runId: string): Promise<OpenRun | null> {
  const { data, error } = await admin
    .from("provisioning_runs")
    .select("id, organization_id, current_step, phone_number_id, status")
    .eq("id", runId)
    .eq("status", "waiting")
    .maybeSingle();
  if (error) throw error;
  return data && WORK_ORDER_STATES.includes(data.current_step ?? "") ? data : null;
}

async function agentOf(admin: Admin, organizationId: string) {
  const { data, error } = await admin
    .from("agent_configs")
    .select("id, organization_id, business_id, sarvam_app_id, sarvam_app_version")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listWorkOrders(admin: Admin, now: Date = new Date()) {
  const { data, error } = await admin
    .from("provisioning_runs")
    .select(
      "id, organization_id, current_step, phone_number_id, created_at, failure_code, sarvam_agent_id",
    )
    .eq("status", "waiting")
    .in("current_step", WORK_ORDER_STATES)
    .order("created_at", { ascending: true })
    .limit(50);
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
    const agentName = customerAgentName(r.organization_id, agent.id);
    // The checkpoint view only exists once the operator reported the agent and its six tools.
    const report =
      r.current_step === "waiting_for_tool_authentication"
        ? await toolsCreatedReport(admin, r.organization_id)
        : null;
    const checkpoint = report
      ? buildToolAuthCheckpoint({
          jobId: r.id,
          customerId: r.organization_id,
          customer: org?.name ?? "(unknown)",
          agentId: report.appId,
          credentialName: `clickai-${agentName}`,
          master: report.master,
          waitingSince: report.reportedAt ?? r.created_at,
          now,
          toolsReported: report.tools,
        })
      : null;
    out.push({
      checkpoint,
      workOrderId: r.id,
      customerId: r.organization_id,
      customer: org?.name ?? "(unknown)",
      /** Set when an operator reported it cannot continue (for example Sarvam sign-in required). */
      blocked: r.failure_code === "WAITING_FOR_OPERATOR",
      agentName,
      /** The agent the operator reported (tools created), once credentials are pending. */
      agentId: r.current_step === "waiting_for_tool_authentication" ? r.sarvam_agent_id : null,
      stage:
        r.current_step === "waiting_for_integration_credential"
          ? "needs_credential"
          : r.current_step === "waiting_for_tool_authentication"
            ? "needs_tool_authentication"
            : "needs_agent",
      queuedAt: r.created_at,
    });
  }
  return out;
}

export async function getWorkOrder(admin: Admin, runId: string, deps: WorkOrderDeps) {
  const run = await openRun(admin, runId);
  if (!run) throw new BridgeError("not_found", "No open work order with that id.");
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

  const toolSpecs = clickAiToolDefinitions(deps.baseUrl).map((d) => ({
    name: d.name,
    toolType: d.toolType,
    lifecycle: d.lifecycle,
    description: d.description,
    // All six are created on every customer agent (clones carry no tools); the ones this
    // customer's capabilities do not use are then switched off.
    enabled: d.enabledBy === "always" || config.tools.enable.includes(d.name),
    connectorConfig: d.connectorConfig,
  }));
  const masterReady = Boolean(deps.masterAgentAppId);
  const stage =
    run.current_step === "waiting_for_tool_authentication"
      ? "needs_tool_authentication"
      : "needs_agent";
  const reported =
    run.current_step === "waiting_for_tool_authentication"
      ? await reportedAgent(admin, run.organization_id)
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
      "3. If credentialIssued is false, call issue_agent_credential ONCE. Keep the token out of chat; it goes into the Sarvam console's masked credential field (or a Sarvam secret named credentialSecretName). Never write it into a tool.",
      "4. Recreate all six tools (clones carry none): for each entry of tools, configure_app_tool with its toolType and connectorConfig exactly (create it, or update the existing tool of that name by tool_id). Do not add an auth key. Then agents set_tools: enable exactly the tools with enabled true, disable the others.",
      "5. Read the draft back (agents get, include tools) and confirm all six exist with the same URLs, system_variable bindings (interaction_id, user_identifier), timeouts and reply templates.",
      "6. Call report_tools_created. ClickAI then shows the job as waiting for tool authentication, with this agent id.",
      "7. A person selects the ClickAI credential on each of the six tools in the Sarvam console (this MCP cannot). Do this BEFORE committing: a committed version is frozen with the credentials its tools have.",
      "8. Read the draft back and confirm every tool now has bearer auth, then commit once, then read the COMMITTED version back (agents get with app_version) and confirm all six tools still show bearer auth.",
      `9. Call submit_agent_result with workOrderId, agentId, the committed version, fingerprint "${config.fingerprint}" and toolAuth (name and authType for all six, from the committed version's read-back).`,
      "Do not create deployments or attach numbers: ClickAI does that after step 9.",
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

/** Issues the customer agent's integration credential ONCE; never rotates an existing one. */
export async function issueCredentialForRun(
  admin: Admin,
  runId: string,
  auth: Extract<BridgeAuth, { ok: true }>,
) {
  const run = await openRun(admin, runId);
  if (!run) throw new BridgeError("not_found", "No open work order with that id.");
  const agent = await agentOf(admin, run.organization_id);
  if (!agent) throw new BridgeError("not_ready", "The customer has no agent record yet.");
  const { data: active, error } = await admin
    .from("sarvam_agent_integrations")
    .select("id")
    .eq("agent_config_id", agent.id)
    .eq("role", "inbound")
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  if (active)
    throw new BridgeError(
      "conflict",
      "A credential was already issued for this customer and cannot be shown again. Rotate it in the ClickAI admin screen if the agent's tools lost it.",
    );
  const { issueIntegrationCredential } = await import("./sarvam-integration-credential.server.ts");
  const issued = await issueIntegrationCredential(admin, {
    organizationId: run.organization_id,
    agentConfigId: agent.id,
    role: "inbound",
    expiresInDays: 365,
    createdBy: auth.createdBy,
  });
  await bridgeAudit(admin, auth, run, "credential_issued", { prefix: issued.prefix });
  return { token: issued.token, expiresAt: issued.expiresAt };
}

/**
 * The operator reports the agent it built. Idempotent: the same id and version
 * again is a no-op; a different agent for an already-registered customer is refused.
 */
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/;
const SIX = new Set<string>(CLICKAI_TOOL_NAMES);

function requireSixToolNames(names: unknown, what: string): string[] {
  const list = Array.isArray(names) ? names.map((n) => String(n)) : [];
  if (list.length !== SIX.size || !list.every((n) => SIX.has(n)) || new Set(list).size !== SIX.size)
    throw new BridgeError(
      "invalid",
      `${what} must list exactly the six ClickAI tools: ${CLICKAI_TOOL_NAMES.join(", ")}.`,
    );
  return list;
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
    clonedFrom: { agentId: string; version: number };
    tools: unknown;
  },
  auth: Extract<BridgeAuth, { ok: true }>,
  deps: WorkOrderDeps,
) {
  if (!APP_ID_PATTERN.test(input.appId ?? ""))
    throw new BridgeError("invalid", "That does not look like a Sarvam agent id.");
  const run = await openRun(admin, input.workOrderId);
  if (!run) throw new BridgeError("not_found", "No open work order with that id.");
  const agent = await agentOf(admin, run.organization_id);
  if (!agent?.business_id)
    throw new BridgeError("not_ready", "The customer has no agent record yet.");
  if (input.appId === deps.masterAgentAppId)
    throw new BridgeError("conflict", "That is the master template, not a customer agent.");
  if (
    !deps.masterAgentAppId ||
    input.clonedFrom?.agentId !== deps.masterAgentAppId ||
    input.clonedFrom?.version !== deps.masterAgentVersion
  )
    throw new BridgeError(
      "conflict",
      `The agent must be cloned from the committed master ${deps.masterAgentAppId} version ${deps.masterAgentVersion}.`,
    );
  const tools = requireSixToolNames(input.tools, "tools");
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
  if (agent.sarvam_app_id && agent.sarvam_app_id !== input.appId)
    throw new BridgeError(
      "conflict",
      "This customer already has a different agent registered. Replace it in the ClickAI admin screen.",
    );
  const previous = await reportedAgent(admin, run.organization_id);
  if (previous && previous.appId !== input.appId)
    throw new BridgeError(
      "conflict",
      `A different agent (${previous.appId}) was already reported for this customer. Reuse it instead of creating another.`,
    );
  if (previous) return { status: "already_reported" as const, agentId: previous.appId };
  await bridgeAudit(admin, auth, run, "agent_tools_created", {
    appId: input.appId,
    clonedFrom: input.clonedFrom,
    tools,
  });
  const { error } = await admin
    .from("provisioning_runs")
    .update({ sarvam_agent_id: input.appId })
    .eq("id", run.id)
    .eq("organization_id", run.organization_id);
  if (error) throw error;
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
 * The operator reports the COMMITTED agent version. It is registered only when the tools were
 * reported first (so the checkpoint cannot be skipped) and the committed version's read-back
 * shows credentials on all six tools. Idempotent: the same id and version again is a no-op.
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
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new BridgeError("invalid", "version must be a positive whole number.");
  if (!APP_ID_PATTERN.test(input.appId ?? ""))
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
    if (agent?.sarvam_app_id === input.appId && agent.sarvam_app_version === input.version)
      return { status: "already_registered" as const };
    throw new BridgeError("not_found", "No open work order with that id.");
  }
  const agent = await agentOf(admin, run.organization_id);
  if (!agent?.business_id)
    throw new BridgeError("not_ready", "The customer has no agent record yet.");
  if (agent.sarvam_app_id && agent.sarvam_app_id !== input.appId)
    throw new BridgeError(
      "conflict",
      "This customer already has a different agent registered. Replace it in the ClickAI admin screen.",
    );
  // The tools must have been reported for THIS agent first: the checkpoint cannot be skipped.
  const reported = await reportedAgent(admin, run.organization_id);
  if (reported?.appId !== input.appId)
    throw new BridgeError(
      "conflict",
      "Report the agent's six tools first (report_tools_created) for this agent, then select the credentials in the Sarvam console, commit, and submit.",
    );
  // Evidence from the committed version's read-back: a credential on every one of the six tools.
  const evidence = Array.isArray(input.toolAuth)
    ? (input.toolAuth as { name?: unknown; authType?: unknown }[])
    : [];
  requireSixToolNames(
    evidence.map((e) => e?.name),
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
  // The reported fingerprint must match what ClickAI generates NOW, so an agent built from an
  // out-of-date work order (settings changed since) is rejected, not registered.
  const current = await getWorkOrder(admin, run.id, deps);
  if (input.fingerprint !== current.fingerprint)
    throw new BridgeError(
      "conflict",
      "The agent was built from an outdated work order (the customer's settings changed). Fetch the work order again and update the agent.",
    );
  try {
    await registerProvisionedAgent(admin, {
      organizationId: run.organization_id,
      agentConfigId: agent.id,
      appId: input.appId,
      version: input.version,
      masterAgentAppId: deps.masterAgentAppId,
    });
  } catch (e) {
    throw new BridgeError("conflict", sanitizeDiagnostic((e as Error).message));
  }
  await bridgeAudit(admin, auth, run, "tool_auth_confirmed", {
    appId: input.appId,
    version: input.version,
    tools: evidence.map((e) => ({ name: String(e.name), authType: String(e.authType) })),
  });
  await bridgeAudit(admin, auth, run, "agent_submitted", {
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
  const run = await openRun(admin, input.workOrderId);
  if (!run) throw new BridgeError("not_found", "No open work order with that id.");
  const reason = input.reason === "sarvam_auth_required" ? "sarvam_auth_required" : "other";
  const message =
    reason === "sarvam_auth_required"
      ? "Sarvam sign-in is required: sign in to the Sarvam Voice Agents MCP in your client (24 h session), then process this work order again."
      : sanitizeDiagnostic(input.message ?? "The operator could not continue.", 300);
  const { error } = await admin
    .from("provisioning_runs")
    .update({
      failure_code: "WAITING_FOR_OPERATOR",
      retryable: null,
      diagnostics: { blocker: reason, note: message } as never,
    })
    .eq("id", run.id)
    .eq("organization_id", run.organization_id)
    .eq("status", "waiting");
  if (error) throw error;
  await bridgeAudit(admin, auth, run, "operator_blocked", { reason });
  return { status: "recorded" as const, message };
}
