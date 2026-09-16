import type { NormalizedCallStatus } from "./adapter.ts";

/**
 * Which `call_logs.status` values a call may carry for its media session to
 * be allowed to attach — shared by exotel-media-route.server.ts (local-dev
 * fallback) and call-session-durable-object.server.ts (production Durable
 * Object path) so the two never drift apart.
 *
 * "initiated" is included alongside "answered"/"in_progress" because of a
 * real production race: Exotel's Voicebot Applet opens its media WebSocket
 * immediately once the call-flow reaches that step, which happens before
 * Exotel's own status-callback webhook has necessarily delivered an
 * "answered"/"in-progress" event — so the call_logs row this socket's
 * "start" event gets matched against is frequently still in the "initiated"
 * state the webhook's very first event (or its unrecognized-status
 * fallback — see exotel-provider.ts's STATUS_MAP) wrote it as. Rejecting
 * that legitimate, in-flight call outright (as the previous "answered" /
 * "in_progress"-only allowlist did) meant every real inbound call lost its
 * media session to this race.
 *
 * This does not weaken authorization: eligibility here only ever narrows
 * which calls get this far. It is checked *after* the CallSid has already
 * been matched to a genuine call_logs row (never an unknown CallSid), and
 * every other check in the caller — tenant ownership via that row's
 * organization_id, the entitlement gate (checkTelephonyAccess), the
 * optional signed token — is unaffected and still runs unconditionally.
 * "initiated" only ever reaches this row when the entitlement gate already
 * passed at insert time (a rejected call is inserted with status "failed",
 * which stays excluded here); a terminal status (completed, failed, busy,
 * no_answer, cancelled) is deliberately never included, so a call that has
 * already ended — or was refused — cannot reopen a media session.
 */
export const MEDIA_SESSION_ELIGIBLE_STATUSES: ReadonlySet<NormalizedCallStatus> = new Set([
  "initiated",
  "answered",
  "in_progress",
]);

/**
 * Takes `string`, not `NormalizedCallStatus`: the call_logs row this is
 * checked against comes back from Supabase typed as a plain `string` (the
 * DB column has no generated enum type), so this must fail closed on any
 * value outside the known statuses rather than require a cast at the call
 * site.
 */
export function isEligibleForMediaSession(status: string): boolean {
  return (MEDIA_SESSION_ELIGIBLE_STATUSES as ReadonlySet<string>).has(status);
}
