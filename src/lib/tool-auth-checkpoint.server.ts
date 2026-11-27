import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AgentRole } from "./agent-roles.ts";

/**
 * The tool-authentication checkpoint. Sarvam's MCP refuses to set a tool's
 * credential, so after an operator clones the master and creates the customer's
 * six tools, a person selects the ClickAI credential on each tool in the Sarvam
 * console. That must happen on the DRAFT before the commit, because a committed
 * version is frozen with the tools (and credentials) it had.
 *
 * ClickAI cannot read the credentials itself, so the operator's reports, with
 * per-tool evidence read back from Sarvam, are kept in the append-only job event
 * trail (provisioning_run_events); no migration:
 *
 *   agent_tools_created  {appId, clonedFrom, tools}     the agent + six tools exist; auth pending
 *   tool_auth_confirmed  {appId, version, tools}        the COMMITTED version carries credentials
 *
 * The gate is MANDATORY for every number that is not live yet, however the agent was
 * registered (operator bridge or the admin screen): the pipeline needs a tool_auth_confirmed
 * event for the registered agent id AND version before it deploys or activates. A number that
 * is already live is only re-verified. A new version needs a new confirmation. The "tools
 * created" report belongs to one provisioning job, so an earlier job's report never blocks a
 * replacement agent.
 *
 * Recovery (agent-recovery.server.ts), kept in audit_logs because a customer may have no job:
 *   - an admin can RELEASE a wrongly reported agent id; the released records stop counting;
 *   - the outbound agent also accepts a confirmation of the exact agent id AND version made
 *     outside a job: by an admin, or kept from an earlier confirmation for calling. Those count
 *     only while the customer has a live outbound credential.
 */

type Admin = SupabaseClient<Database>;

export const AGENT_AUDIT = {
  released: "SARVAM_AGENT_ID_RELEASED",
  adminConfirmed: "SARVAM_OUTBOUND_TOOL_AUTH_CONFIRMED",
  preserved: "SARVAM_OUTBOUND_CONFIRMATION_PRESERVED",
  /** Written by the admin "Confirm for outbound calls" action. */
  readySet: "SARVAM_OUTBOUND_READY_SET",
} as const;

export const CONFIRMATION_ACTIONS: string[] = [
  AGENT_AUDIT.adminConfirmed,
  AGENT_AUDIT.preserved,
  AGENT_AUDIT.readySet,
];

const idsOf = (rows: { new_value: unknown }[] | null) =>
  new Set(
    (rows ?? []).flatMap((r) => {
      const ids = (r.new_value as { recordIds?: unknown } | null)?.recordIds;
      return Array.isArray(ids) ? ids.map(String) : [];
    }),
  );

/** Ids of this customer's reports and confirmations that an admin has released. */
export async function releasedRecordIds(
  admin: Admin,
  organizationId: string,
): Promise<Set<string>> {
  const { data, error } = await admin
    .from("audit_logs")
    .select("new_value")
    .eq("organization_id", organizationId)
    .eq("action", AGENT_AUDIT.released);
  if (error) throw error;
  return idsOf(data);
}

/** Another customer reported or confirmed this agent id, and no admin has released that. */
export async function claimedByAnotherCustomer(
  admin: Admin,
  appId: string,
  organizationId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("provisioning_run_events")
    .select("id")
    .in("event", ["agent_tools_created", "tool_auth_confirmed"])
    .eq("detail->>appId", appId)
    .neq("organization_id", organizationId);
  if (error) throw error;
  if (!data?.length) return false;
  const { data: releases, error: releaseError } = await admin
    .from("audit_logs")
    .select("new_value")
    .eq("action", AGENT_AUDIT.released)
    .eq("new_value->>appId", appId);
  if (releaseError) throw releaseError;
  const released = idsOf(releases);
  return data.some((r) => !released.has(r.id));
}

/** A confirmation of this exact outbound agent version that does not need a provisioning job. */
async function recordedOutboundConfirmation(
  admin: Admin,
  input: { organizationId: string; appId: string; version: number },
): Promise<boolean> {
  const { data: agent, error } = await admin
    .from("agent_configs")
    .select(
      "id, sarvam_app_id, sarvam_outbound_app_id, sarvam_outbound_app_version, sarvam_outbound_registered_at",
    )
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!agent || agent.sarvam_app_id === input.appId) return false;
  const { data: rows, error: rowsError } = await admin
    .from("audit_logs")
    .select("id, action, new_value, created_at")
    .eq("organization_id", input.organizationId)
    .in("action", CONFIRMATION_ACTIONS)
    .eq("new_value->>app_id", input.appId);
  if (rowsError) throw rowsError;
  if (!rows?.length) return false;
  const released = await releasedRecordIds(admin, input.organizationId);
  // An older "ready" entry may come from the one-agent model: it counts only when it was made
  // after the agent version it names was registered as the OUTBOUND agent.
  const since =
    agent.sarvam_outbound_app_id === input.appId &&
    agent.sarvam_outbound_app_version === input.version &&
    agent.sarvam_outbound_registered_at
      ? Date.parse(agent.sarvam_outbound_registered_at)
      : null;
  const matched = rows.some(
    (r) =>
      !released.has(r.id) &&
      (r.new_value as { app_version?: unknown } | null)?.app_version === input.version &&
      (r.action !== AGENT_AUDIT.readySet || (since !== null && Date.parse(r.created_at) >= since)),
  );
  if (!matched) return false;
  const { data: credential, error: credentialError } = await admin
    .from("sarvam_agent_integrations")
    .select("expires_at")
    .eq("agent_config_id", agent.id)
    .eq("role", "outbound")
    .eq("status", "active")
    .maybeSingle();
  if (credentialError) throw credentialError;
  return Boolean(
    credential && (!credential.expires_at || Date.parse(credential.expires_at) > Date.now()),
  );
}

export interface ToolAuthStatus {
  /** Informational: the operator bridge reported this agent's tools (the gate itself is mandatory). */
  required: boolean;
  confirmed: boolean;
}

interface EventDetail {
  appId?: unknown;
  version?: unknown;
  clonedFrom?: unknown;
  tools?: unknown;
  /** Absent on events written before the outbound agent had a checkpoint: inbound. */
  role?: unknown;
}

const ofRole = (role: AgentRole) => (r: { detail: EventDetail }) =>
  (r.detail.role ?? "inbound") === role;

async function events(admin: Admin, organizationId: string, names: string[], runId?: string) {
  let query = admin
    .from("provisioning_run_events")
    .select("id, event, detail, created_at")
    .eq("organization_id", organizationId)
    .in("event", names);
  if (runId) query = query.eq("run_id", runId);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  const released = data?.length ? await releasedRecordIds(admin, organizationId) : null;
  return (data ?? [])
    .filter((r) => !released?.has(r.id))
    .map((r) => ({
      event: r.event,
      detail: (r.detail ?? {}) as EventDetail,
      createdAt: r.created_at,
    }));
}

export async function toolAuthStatus(
  admin: Admin,
  input: { organizationId: string; appId: string; version: number; role?: AgentRole },
): Promise<ToolAuthStatus> {
  const role = input.role ?? "inbound";
  const rows = (
    await events(admin, input.organizationId, ["agent_tools_created", "tool_auth_confirmed"])
  ).filter(ofRole(role));
  const inTrail = rows.some(
    (r) =>
      r.event === "tool_auth_confirmed" &&
      r.detail.appId === input.appId &&
      r.detail.version === input.version,
  );
  return {
    required: rows.some((r) => r.event === "agent_tools_created" && r.detail.appId === input.appId),
    confirmed:
      inTrail || (role === "outbound" && (await recordedOutboundConfirmation(admin, input))),
  };
}

/** The customer's open provisioning job (the one an operator's report belongs to), if any. */
async function activeRunId(admin: Admin, organizationId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("provisioning_runs")
    .select("id")
    .eq("organization_id", organizationId)
    .in("status", ["pending", "running", "waiting"])
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * The agent an operator reported with its tools created FOR THIS JOB, while no version is
 * registered yet. Scoped to the job: a report from an earlier job (a replaced or abandoned
 * agent) never blocks reporting a different agent for a new one. Without a run id it uses
 * the customer's open job (none: nothing reported).
 */
export async function reportedAgent(
  admin: Admin,
  organizationId: string,
  runId?: string,
  role: AgentRole = "inbound",
): Promise<{ appId: string } | null> {
  const run = runId ?? (await activeRunId(admin, organizationId));
  if (!run) return null;
  const [latest] = (await events(admin, organizationId, ["agent_tools_created"], run)).filter(
    ofRole(role),
  );
  return typeof latest?.detail.appId === "string" ? { appId: latest.detail.appId } : null;
}

/** The latest "tools created" report for display: agent, master reference, tools, when. */
export async function toolsCreatedReport(
  admin: Admin,
  organizationId: string,
  runId: string,
  role: AgentRole = "inbound",
) {
  const [latest] = (await events(admin, organizationId, ["agent_tools_created"], runId)).filter(
    ofRole(role),
  );
  if (!latest || typeof latest.detail.appId !== "string") return null;
  const from = (latest.detail.clonedFrom ?? {}) as { agentId?: unknown; version?: unknown };
  return {
    appId: latest.detail.appId,
    reportedAt: latest.createdAt,
    master:
      typeof from.agentId === "string" && typeof from.version === "number"
        ? { agentId: from.agentId, version: from.version }
        : null,
    tools: Array.isArray(latest.detail.tools) ? latest.detail.tools.map(String) : [],
  };
}
