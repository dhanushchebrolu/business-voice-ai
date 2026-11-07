import { PACE_MIN, PACE_MAX } from "./voices.ts";

/**
 * agent_configs.speaking_pace is NUMERIC(3,2) NOT NULL DEFAULT 1.0, but the form must not trust the
 * wire value: a numeric can arrive as a string, and anything outside the range the save endpoint
 * accepts (agent.functions.ts: 0.5-2) would make every later save fail validation.
 */
export function normalizeSpeakingPace(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  return Math.min(PACE_MAX, Math.max(PACE_MIN, n));
}
