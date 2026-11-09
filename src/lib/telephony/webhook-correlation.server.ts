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
 * Merges a normalized event's structured extras (agent variables, and any
 * deployment/campaign/attempt identifiers) into the raw payload under
 * underscore-prefixed keys, so nothing is lost and nothing collides with a
 * real field of the same name in a provider's own raw payload. Every field
 * folded in here is already documented as service-role-only, never exposed
 * to a customer (see the Phase D migration's column-level grant on
 * call_logs, and adapter.ts's doc comments on these NormalizedCallEvent
 * fields).
 */
export function buildProviderMetadata(event: NormalizedCallEvent): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...event.raw };
  if (event.agentVariables) metadata["_agent_variables"] = event.agentVariables;
  if (event.providerDeploymentId) metadata["_deployment_id"] = event.providerDeploymentId;
  if (event.providerCampaignId) metadata["_campaign_id"] = event.providerCampaignId;
  if (event.providerAttemptId) metadata["_attempt_id"] = event.providerAttemptId;
  return metadata;
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
