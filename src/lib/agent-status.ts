/**
 * Pure agent-status logic, pulled out of workspace.ts so it can be unit
 * tested directly (workspace.ts itself imports the browser Supabase client
 * via the `@/` alias, which this project's plain `node --test` runner
 * cannot resolve — same reason dashboard-access.ts exists as its own file).
 *
 * Deliberately takes a minimal structural type rather than importing the
 * full generated `AgentConfig` row type, so this file has zero `@/`-aliased
 * imports and stays runnable in isolation.
 */

export interface AgentStatusInput {
  active_version: number;
  status: string;
  sarvam_app_id: string | null;
  sarvam_app_version: number | null;
}

export interface AgentStatus {
  label: string;
  tone: "live" | "ready" | "idle" | "error";
}

export function agentStatusLabel(agent: AgentStatusInput | null, hasNumber: boolean): AgentStatus {
  if (!agent || agent.active_version === 0) return { label: "Not configured", tone: "idle" };
  if (agent.status === "error") return { label: "Error", tone: "error" };
  if (agent.status === "paused") return { label: "Paused", tone: "idle" };
  // A published Klyro agent (active_version > 0) is NOT the same as a
  // working Sarvam agent — Sarvam agent creation has no verified API (see
  // the Sarvam API verification audit) and is still a manual admin step in
  // Sarvam's own dashboard, recorded here only once an admin maps it via
  // sarvam_app_id/sarvam_app_version. Never report "Live" or "Ready" while
  // that mapping is missing — outbound/inbound calls would fail the moment
  // anything tried to actually reach Sarvam, and a customer seeing "Live"
  // would have no reason to suspect that.
  if (!agent.sarvam_app_id || !agent.sarvam_app_version) {
    return { label: "Provider setup required", tone: "error" };
  }
  if (hasNumber && agent.status === "live") return { label: "Live", tone: "live" };
  return { label: "Ready — no number", tone: "ready" };
}
