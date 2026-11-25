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
 * Hand-registered agents (the admin screen; every live customer today) have no
 * agent_tools_created event and are never gated. A new version needs a new confirmation.
 */

type Admin = SupabaseClient<Database>;

export interface ToolAuthStatus {
  /** The agent was built through the operator bridge, which requires tool authentication. */
  required: boolean;
  confirmed: boolean;
}

interface EventDetail {
  appId?: unknown;
  version?: unknown;
}

async function events(admin: Admin, organizationId: string, names: string[]) {
  const { data, error } = await admin
    .from("provisioning_run_events")
    .select("event, detail, created_at")
    .eq("organization_id", organizationId)
    .in("event", names)
    .order("created_at", { ascending: false })
    .limit(200);
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

/** The agent an operator reported with its tools created, while no version is registered yet. */
export async function reportedAgent(
  admin: Admin,
  organizationId: string,
): Promise<{ appId: string } | null> {
  const [latest] = await events(admin, organizationId, ["agent_tools_created"]);
  return typeof latest?.detail.appId === "string" ? { appId: latest.detail.appId } : null;
}
