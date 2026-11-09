/**
 * TEMPORARY diagnostic for Sarvam's on_start API Tool: answers "is the
 * `Agent phone number` variable the number the caller actually dialled?"
 * before the shared-template-agent design relies on it for tenant
 * resolution. Delete this file, its test and its route once that's settled.
 *
 * Sarvam doesn't document an on_start request schema — the API Tool sends
 * whatever Body we configure in its dashboard, with values picked from its
 * variable selector — so the body field names below are ours, not Sarvam's.
 */

export const CALL_START_FIELDS = [
  "agent_phone_number",
  "user_identifier",
  "app_id",
  "app_version",
  "interaction_id",
] as const;

type Field = (typeof CALL_START_FIELDS)[number];
export type CallStartDiagnostic = Record<Field, string> & { agent_phone_e164: boolean };

const PHONE_FIELDS = new Set<Field>(["agent_phone_number", "user_identifier"]);

/** Keeps country code + last 4 digits only, so the log can be matched against the dialled number without storing it. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 6) return `[unrecognized len=${value.length}]`;
  const plus = value.trim().startsWith("+") ? "+" : "";
  return `${plus}${digits.slice(0, 2)}${"*".repeat(digits.length - 6)}${digits.slice(-4)}`;
}

/** Non-phone values: allow ID-like characters only, cap length, so nothing odd lands in logs. */
function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, "?").slice(0, 64);
}

/** Returns null when the body isn't a JSON object; missing/empty fields are reported, never rejected, since seeing what arrives is the point. Every other body field is ignored. */
export function summarizeCallStart(body: unknown): CallStartDiagnostic | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const out = {} as Record<Field, string>;
  for (const field of CALL_START_FIELDS) {
    const raw = input[field];
    const value = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
    out[field] = !value ? "missing" : PHONE_FIELDS.has(field) ? maskPhone(value) : safeId(value);
  }
  const agentPhone =
    typeof input["agent_phone_number"] === "string" ? input["agent_phone_number"].trim() : "";
  // Format only, no data: tells us whether the value could later be looked up as E.164.
  return { ...out, agent_phone_e164: /^\+[1-9]\d{7,14}$/.test(agentPhone) };
}
