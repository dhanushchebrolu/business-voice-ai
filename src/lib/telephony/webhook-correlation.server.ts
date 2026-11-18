import type { NormalizedCallEvent } from "./adapter.ts";

/**
 * Pure helpers used by the telephony webhook route (routes/api/public/
 * webhooks/telephony.ts) for building `call_logs.provider_metadata` and for
 * validating an outbound event's `clientReference` before it is ever used to
 * look up a Klyro-owned row. Kept in a separate, non-route module because
 * this repo's Node-native test runner cannot import a `createFileRoute`-based
 * file directly (established convention — see e.g.
 * service-lock-message.test.ts, constant-time-equals.server.test.ts).
 */

/**
 * The only provider_metadata keys a telephony webhook may store, and the
 * readers that need them:
 *   - interaction_id: call recordings (call-recording.functions.ts) and the
 *     admin call view (sarvam-admin-calls.server.ts);
 *   - recording_url: the provider's recording link, when it sends one;
 *   - app_id: the Sarvam agent that handled the call;
 *   - late_provider_report: kept by telephony-event-processing when a
 *     provider's final report arrives after an operator resolved the call.
 * Never the raw payload: it carries every agent variable, the transcript,
 * both phone numbers and (outbound) ClickAI's webhook URL with its token.
 * The transcript, numbers and allowlisted variables have their own columns.
 */
export const PROVIDER_METADATA_KEYS = [
  "interaction_id",
  "recording_url",
  "app_id",
  "late_provider_report",
] as const;

/** Keys only an unsanitized (raw-payload) row has; used to find older rows to clean. */
export const RAW_PROVIDER_METADATA_MARKERS = [
  "_agent_variables",
  "final_agent_variables",
  "interaction_transcript",
  "user_phone_number",
  "webhook_config",
] as const;

/** provider_metadata reduced to PROVIDER_METADATA_KEYS (strings, and the late report object). */
export function sanitizeProviderMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const source = metadata as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["interaction_id", "recording_url", "app_id"] as const) {
    const value = source[key];
    if (typeof value === "string" && value) out[key] = value.slice(0, 2048);
  }
  const late = source["late_provider_report"];
  if (late && typeof late === "object" && !Array.isArray(late)) out["late_provider_report"] = late;
  return out;
}

/**
 * provider_metadata for a call from one normalized webhook event: only the
 * identifiers ClickAI's readers use (PROVIDER_METADATA_KEYS), never the raw
 * payload or agent variables.
 */
export function buildProviderMetadata(event: NormalizedCallEvent): Record<string, unknown> {
  const raw = (event.raw ?? {}) as Record<string, unknown>;
  return sanitizeProviderMetadata({
    interaction_id: raw["interaction_id"],
    recording_url: event.recordingUrl ?? raw["recording_url"],
    app_id: raw["app_id"],
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A `clientReference` is only ever safe to use as a lookup key when it has
 * the exact shape Klyro itself generates for one — the pre-created
 * `call_logs` row's own UUID `id` (see telephony-outbound.functions.ts /
 * the Sarvam outbound design in the migration report). Anything else —
 * malformed input, or a value an unverified/forged webhook happens to
 * supply — must never reach a database lookup that could be tricked into
 * matching an unintended row; rejecting the format here, before any query
 * runs, is the guard for that.
 */
export function isPlausibleClientReference(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Defense-in-depth cross-check once a Klyro-owned call_logs row is resolved:
 * an organization_id echoed back in the webhook's metadata (which Klyro
 * itself sent) must agree with the row's own organization. Absent metadata
 * passes — the row, never the payload, decides the organization.
 */
export function metadataOrganizationMatches(
  event: Pick<NormalizedCallEvent, "metadataOrganizationId">,
  rowOrganizationId: string,
): boolean {
  return !event.metadataOrganizationId || event.metadataOrganizationId === rowOrganizationId;
}

export type ClientReferenceMatch =
  | { ok: true; backfillProviderCallId: boolean }
  | { ok: false; reason: "organization_mismatch" | "provider_call_id_mismatch" };

/**
 * Decides whether an outbound event matched only through its clientReference
 * (metadata.call_id) may be applied to that row. Rejected: a disagreeing
 * metadata organization, or a row already bound to a different provider call
 * id (for Sarvam, a different attempt_id) — every attempt has its own row, so
 * that is never legitimate. A row with no provider_call_id yet is backfilled.
 */
export function checkClientReferenceMatch(
  row: { organization_id: string; provider_call_id: string | null },
  event: Pick<NormalizedCallEvent, "metadataOrganizationId" | "providerCallId">,
): ClientReferenceMatch {
  if (!metadataOrganizationMatches(event, row.organization_id)) {
    return { ok: false, reason: "organization_mismatch" };
  }
  if (row.provider_call_id && row.provider_call_id !== event.providerCallId) {
    return { ok: false, reason: "provider_call_id_mismatch" };
  }
  return { ok: true, backfillProviderCallId: !row.provider_call_id };
}
