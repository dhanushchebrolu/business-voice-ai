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

/**
 * `numberProvider` is the telephony carrier of whichever phone number is
 * actually assigned to this agent (`phone_numbers.provider`), or `null`/
 * `undefined` when none is assigned yet. The Sarvam-app-mapping requirement
 * below only applies on the Sarvam-*managed* telephony path (Sarvam Voice
 * Agents runs the whole call itself, against an app configured by hand in
 * Sarvam's own dashboard — see agent-sarvam-sync.server.ts's module doc). On
 * the Klyro-owned Exotel runtime (voice-runtime.server.ts + Sarvam's raw
 * STT/LLM/TTS APIs), Sarvam is an AI backend, not the telephony provider —
 * this agent can be fully ready with no sarvam_app_id at all. Callers that
 * don't pass `numberProvider` (or pass a number not yet assigned to any
 * provider) get the stricter, Sarvam-managed-path behavior by default —
 * never the reverse — so nothing can silently start claiming "Ready" for a
 * Sarvam-managed number just because a caller forgot to pass this.
 */
export function agentStatusLabel(
  agent: AgentStatusInput | null,
  hasNumber: boolean,
  numberProvider?: string | null,
): AgentStatus {
  if (!agent || agent.active_version === 0) return { label: "Not configured", tone: "idle" };
  // The agent has been valid at least once (active_version > 0 — that flag
  // never regresses, see saveAgentConfiguration), but its CURRENT saved
  // configuration has since become invalid (a required field was cleared).
  // A real call right now would use this same current config — never call
  // this "Ready" or "Live" while that's true.
  if (agent.status === "not_configured") return { label: "Incomplete", tone: "idle" };
  if (agent.status === "error") return { label: "Error", tone: "error" };
  if (agent.status === "paused") return { label: "Paused", tone: "idle" };

  const requiresSarvamMapping = numberProvider === "sarvam" || !numberProvider;
  if (requiresSarvamMapping && (!agent.sarvam_app_id || !agent.sarvam_app_version)) {
    return { label: "Provider setup required", tone: "error" };
  }

  if (agent.status === "live") {
    return hasNumber
      ? { label: "Live", tone: "live" }
      : { label: "Ready — no number", tone: "ready" };
  }
  return hasNumber
    ? { label: "Ready", tone: "ready" }
    : { label: "Ready — no number", tone: "ready" };
}
