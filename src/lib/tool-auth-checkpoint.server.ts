import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

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
 */

type Admin = SupabaseClient<Database>;

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
}

async function events(admin: Admin, organizationId: string, names: string[], runId?: string) {
  let query = admin
    .from("provisioning_run_events")
    .select("event, detail, created_at")
    .eq("organization_id", organizationId)
    .in("event", names);
  if (runId) query = query.eq("run_id", runId);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    event: r.event,
    detail: (r.detail ?? {}) as EventDetail,
    createdAt: r.created_at,
  }));
}

export async function toolAuthStatus(
  admin: Admin,
  input: { organizationId: string; appId: string; version: number },
): Promise<ToolAuthStatus> {
  const rows = await events(admin, input.organizationId, [
    "agent_tools_created",
    "tool_auth_confirmed",
  ]);
  return {
    required: rows.some((r) => r.event === "agent_tools_created" && r.detail.appId === input.appId),
    confirmed: rows.some(
      (r) =>
        r.event === "tool_auth_confirmed" &&
        r.detail.appId === input.appId &&
        r.detail.version === input.version,
    ),
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
): Promise<{ appId: string } | null> {
  const run = runId ?? (await activeRunId(admin, organizationId));
  if (!run) return null;
  const [latest] = await events(admin, organizationId, ["agent_tools_created"], run);
  return typeof latest?.detail.appId === "string" ? { appId: latest.detail.appId } : null;
}

/** The latest "tools created" report for display: agent, master reference, tools, when. */
export async function toolsCreatedReport(admin: Admin, organizationId: string, runId: string) {
  const [latest] = await events(admin, organizationId, ["agent_tools_created"], runId);
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
