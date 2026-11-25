import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AgentSnapshot } from "./agent-instructions.ts";
import { buildUniversalAgentConfig } from "./universal-agent-config.ts";
import { customerAgentName, registerProvisionedAgent } from "./sarvam-agent-provisioner.server.ts";
import { sanitizeDiagnostic } from "./voice-provisioning-job.ts";

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
export const WORK_ORDER_STATES = ["waiting_for_integration_credential", "waiting_for_agent"];

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
  /** Continues the customer's provisioning job after an agent is registered. */
  resume: (organizationId: string, actor: string) => Promise<unknown>;
  now?: () => Date;
}

export async function defaultWorkOrderDeps(): Promise<WorkOrderDeps> {
  const [{ loadSnapshot }, { masterAgentAppId }, { runProvisioning }] = await Promise.all([
    import("./agent-service.server.ts"),
    import("./sarvam-agent-registration.server.ts"),
    import("./provisioning-runs.server.ts"),
  ]);
  return {
    loadSnapshot,
    baseUrl: process.env["TELEPHONY_WEBHOOK_BASE_URL"]?.replace(/\/+$/, "") || null,
    masterAgentAppId: masterAgentAppId(),
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

export async function listWorkOrders(admin: Admin) {
  const { data, error } = await admin
    .from("provisioning_runs")
    .select("id, organization_id, current_step, phone_number_id, created_at")
    .eq("status", "waiting")
    .in("current_step", WORK_ORDER_STATES)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw error;
  const out = [];
  for (const r of data ?? []) {
    const agent = await agentOf(admin, r.organization_id);
    if (!agent?.business_id) continue;
    out.push({
      workOrderId: r.id,
      agentName: customerAgentName(r.organization_id, agent.id),
      stage:
        r.current_step === "waiting_for_integration_credential"
          ? "needs_credential"
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
  return {
    workOrderId: run.id,
    agentName,
    businessType: snapshot.business.business_type,
    templateAgentAppId: deps.masterAgentAppId,
    fingerprint: config.fingerprint,
    credentialIssued: Boolean(cred),
    agent: {
      systemPrompt: tools.systemPrompt,
      inputVariables: tools.inputVariables,
      httpTools: tools.tools,
      enabledCapabilities: config.capabilities.filter((c) => c.enabled).map((c) => c.id),
      voiceLanguage: config.voiceLanguage,
    },
    instructions: [
      `1. List existing agents; if one named "${agentName}" exists, reuse it (never create a second).`,
      "2. Otherwise clone the template agent (templateAgentAppId) under that exact name with configure_agent.",
      "3. If credentialIssued is false, call issue_agent_credential ONCE and use the token as the Bearer secret of every HTTP tool (masked/secret field; never echo it).",
      "4. Apply agent.systemPrompt, inputVariables, httpTools, the voice and languages in agent.voiceLanguage. Read sarvam://schemas/agent-config for the exact field names; resend whole lists.",
      "5. Commit the draft (immutable version).",
      `6. Call submit_agent_result with workOrderId, the Sarvam agent id, the committed version number and fingerprint "${config.fingerprint}".`,
      "Do not create deployments or attach numbers: ClickAI does that after step 6.",
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
export async function submitAgentResult(
  admin: Admin,
  input: { workOrderId: string; appId: string; version: number; fingerprint: string },
  auth: Extract<BridgeAuth, { ok: true }>,
  deps: WorkOrderDeps,
) {
  if (!Number.isInteger(input.version) || input.version < 1)
    throw new BridgeError("invalid", "version must be a positive whole number.");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$/.test(input.appId ?? ""))
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
