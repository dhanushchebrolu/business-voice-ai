/**
 * Outbound AI calls over LiveKit SIP. The only way to start one is an
 * authenticated user acting on a phone number of an organization where they
 * are owner or admin (outbound.functions.ts wraps this with
 * requireSupabaseAuth). The agent's signing key cannot start calls, and the
 * VOICE_AGENT_OUTBOUND_ENABLED flag is only a kill switch on top of that
 * authorization, never a substitute for it.
 *
 * Lifecycle (every transition is a conditional database update):
 *   request (idempotency key) -> row "initiated" (id derived from the key,
 *   so a repeated request finds the same row) -> LiveKit dispatch ->
 *   agent claim (initiated -> ringing, one job only, within the claim TTL,
 *   returns the destination and caller ID from the row) -> dial ->
 *   session start (ringing -> answered, once) -> signed LiveKit end event ->
 *   completed + billed once.
 *
 * Dispatch outcomes are kept apart:
 *   dispatched -> "dispatched";
 *   rejected (definite 4xx) -> row failed, nothing can dial;
 *   unknown (timeout / network / 5xx) -> row stays "initiated" ("pending"
 *   to the caller), never failed: a job may still claim it. Retrying the
 *   same request re-dispatches safely, because only one job can ever win
 *   the claim; the sweep closes it only after the claim TTL.
 */
import { classifyDispatchError } from "./livekit-api.ts";
import type { RateLimitDecision } from "./rate-limits.ts";
import {
  OUTBOUND_CLAIM_TTL_SECONDS,
  outboundRoomName,
  prepareOutboundSipCall,
  recordDispatchOutcome,
  type SessionDeps,
} from "./sessions.server.ts";

export const OUTBOUND_MANAGER_ROLES: readonly string[] = ["owner", "admin"];
const E164 = /^\+[1-9]\d{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OutboundDeps {
  session: SessionDeps;
  env: (name: string) => string | undefined;
  /** The user's role in exactly this organization, or null when not a member. */
  memberRole: (userId: string, organizationId: string) => Promise<string | null>;
  canAfford: (organizationId: string) => Promise<boolean>;
  rateLimit: (scope: "outbound_org" | "outbound_user", key: string) => Promise<RateLimitDecision>;
  /** Throws on failure; classifyDispatchError decides rejected vs unknown. */
  dispatch: (p: { room: string; agentName: string; metadata: string }) => Promise<void>;
}

export type OutboundFailure =
  | "disabled"
  | "not_configured"
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "unsupported_number"
  | "destination_not_allowed"
  | "rate_limited"
  | "limit_reached"
  | "insufficient_balance"
  | "not_available"
  | "not_entitled"
  | "conflict"
  | "dispatch_rejected"
  | "internal_error";

export type OutboundResult =
  | {
      ok: true;
      callId: string;
      room: string;
      /** "dispatched", "pending" (dispatch outcome unknown), or the row's status on a replay. */
      status: string;
      replayed: boolean;
    }
  | { ok: false; code: OutboundFailure; message: string };

const fail = (code: OutboundFailure, message: string): OutboundResult => ({
  ok: false,
  code,
  message,
});

const NOT_FOUND = "That phone number was not found in your workspace.";

/* ------------------------------------------------------------------ */
/* Idempotency: the call row id is derived from the request key        */
/* ------------------------------------------------------------------ */

/**
 * Deterministic call id for (organization, user, idempotency key): a
 * repeated or concurrent request maps to the SAME call_logs primary key, so
 * the database itself refuses a second row (23505). UUID version 8 layout
 * over SHA-256; no migration needed.
 */
export async function outboundCallId(
  organizationId: string,
  userId: string,
  idempotencyKey: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `clickai-outbound:${organizationId}:${userId}:${idempotencyKey.toLowerCase()}`,
      ),
    ),
  );
  const b = digest.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x80; // version 8
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ------------------------------------------------------------------ */
/* Toll-fraud controls                                                 */
/* ------------------------------------------------------------------ */

const prefixes = (raw: string | undefined, fallback: string[]): string[] => {
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^\+\d{1,6}$/.test(x));
};

/**
 * Destination policy. Allowed country prefixes default to India only
 * (VOICE_AGENT_OUTBOUND_ALLOWED_PREFIXES, comma separated). Indian numbers
 * must be a 10-digit subscriber number starting 2-9: this excludes
 * toll-free/shared-cost/premium service codes (1800, 1860, 1900 ...) and
 * short codes. VOICE_AGENT_OUTBOUND_BLOCKED_PREFIXES adds explicit blocks.
 * Calling the organization's own caller ID is refused.
 */
export function checkDestination(
  toE164: string,
  fromE164: string,
  env: (name: string) => string | undefined,
): { ok: true } | { ok: false; message: string } {
  const allowed = prefixes(env("VOICE_AGENT_OUTBOUND_ALLOWED_PREFIXES"), ["+91"]);
  const blocked = prefixes(env("VOICE_AGENT_OUTBOUND_BLOCKED_PREFIXES"), []);
  const no = (message: string) => ({ ok: false as const, message });
  if (!E164.test(toE164)) return no("A valid E.164 destination is required.");
  if (toE164 === fromE164) return no("A number cannot call itself.");
  if (!allowed.some((p) => toE164.startsWith(p)))
    return no("Calls to this country are not enabled for AI outbound calling.");
  if (blocked.some((p) => toE164.startsWith(p))) return no("This destination is blocked.");
  if (toE164.startsWith("+91") && !/^\+91[2-9]\d{9}$/.test(toE164))
    return no("Only regular Indian mobile and landline numbers can be called.");
  return { ok: true };
}

const intEnv = (env: OutboundDeps["env"], name: string, dflt: number) => {
  const n = Number(env(name));
  return Number.isInteger(n) && n > 0 ? n : dflt;
};

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

async function dispatchOnce(
  deps: OutboundDeps,
  callId: string,
): Promise<"dispatched" | "rejected" | "unknown"> {
  const room = outboundRoomName(callId);
  const attempt = async () => {
    try {
      await deps.dispatch({
        room,
        agentName: deps.env("VOICE_AGENT_NAME") || "clickai-receptionist",
        // Only the row id. The agent obtains the destination and caller ID
        // from klyro's claim endpoint, never from dispatch metadata.
        metadata: JSON.stringify({ outboundCallLogId: callId }),
      });
      return "dispatched" as const;
    } catch (err) {
      return classifyDispatchError(err);
    }
  };
  let outcome = await attempt();
  // One immediate retry of an unknown outcome. Safe: a duplicate dispatch
  // creates a second job, and only one job can ever win the claim.
  if (outcome === "unknown") outcome = await attempt();
  await recordDispatchOutcome(deps.session, callId, outcome);
  console.info("voice_agent:outbound_dispatch", { callId, outcome });
  return outcome;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function startOutboundAgentCall(
  deps: OutboundDeps,
  input: { userId: string; phoneNumberId: string; toE164: string; idempotencyKey: string },
): Promise<OutboundResult> {
  if (deps.env("VOICE_AGENT_OUTBOUND_ENABLED") !== "true")
    return fail("disabled", "AI outbound calling is not enabled on this deployment.");
  if (!deps.env("LIVEKIT_URL") || !deps.env("LIVEKIT_API_KEY") || !deps.env("LIVEKIT_API_SECRET"))
    return fail("not_configured", "AI outbound calling is not configured on this deployment.");
  if (
    !UUID.test(input.phoneNumberId) ||
    !E164.test(input.toE164) ||
    !UUID.test(input.idempotencyKey)
  )
    return fail(
      "invalid_request",
      "A phone number, a valid E.164 destination and a request id are required.",
    );

  const { data: number } = await deps.session.db
    .from("phone_numbers")
    .select("id, organization_id, provider, status, e164")
    .eq("id", input.phoneNumberId)
    .maybeSingle();
  if (!number?.organization_id) return fail("not_found", NOT_FOUND);
  const orgId = number.organization_id;

  // Same answer for "no such number" and "another tenant's number".
  const role = await deps.memberRole(input.userId, orgId);
  if (!role) return fail("not_found", NOT_FOUND);
  if (!OUTBOUND_MANAGER_ROLES.includes(role))
    return fail("forbidden", "Only workspace owners and admins can place AI outbound calls.");
  if (number.provider !== "vobiz")
    return fail("unsupported_number", "AI outbound calls need a Vobiz number connected over SIP.");

  const callId = await outboundCallId(orgId, input.userId, input.idempotencyKey);
  const room = outboundRoomName(callId);

  // Replay of an earlier request with the same key: never a second call.
  const { data: prior } = await deps.session.db
    .from("call_logs")
    .select(
      "id, organization_id, phone_number_id, destination_number, status, started_at, provider_metadata",
    )
    .eq("id", callId)
    .maybeSingle();
  if (prior) {
    if (
      prior.organization_id !== orgId ||
      prior.phone_number_id !== number.id ||
      prior.destination_number !== input.toE164
    )
      return fail("conflict", "This request id was already used for a different call.");
    const dispatchState = (prior.provider_metadata as { dispatch?: string } | null)?.dispatch;
    const young =
      deps.session.now().getTime() - Date.parse(prior.started_at) <
      (OUTBOUND_CLAIM_TTL_SECONDS - 30) * 1000;
    if (prior.status === "initiated" && dispatchState === "unknown" && young) {
      // The first dispatch's outcome is unknown: re-dispatch (safe, see above).
      const limited = await deps.rateLimit("outbound_user", input.userId);
      if (!limited.allowed)
        return fail(
          "rate_limited",
          `Too many requests. Try again in ${limited.retryAfterSeconds}s.`,
        );
      const outcome = await dispatchOnce(deps, callId);
      if (outcome === "rejected")
        return fail("dispatch_rejected", "The call could not be started.");
      return {
        ok: true,
        callId,
        room,
        status: outcome === "dispatched" ? "dispatched" : "pending",
        replayed: true,
      };
    }
    // Past the claim window an unclaimed row can never be dialled: say so
    // instead of "initiated" (the sweep closes it as not_dialed later).
    const expired =
      prior.status === "initiated" &&
      deps.session.now().getTime() - Date.parse(prior.started_at) >=
        OUTBOUND_CLAIM_TTL_SECONDS * 1000;
    return { ok: true, callId, room, status: expired ? "expired" : prior.status, replayed: true };
  }

  const dest = checkDestination(input.toE164, number.e164, deps.env);
  if (!dest.ok) return fail("destination_not_allowed", dest.message);

  for (const [scope, key] of [
    ["outbound_org", orgId],
    ["outbound_user", input.userId],
  ] as const) {
    const d = await deps.rateLimit(scope, key);
    if (!d.allowed)
      return fail("rate_limited", `Too many outbound calls. Try again in ${d.retryAfterSeconds}s.`);
  }

  if (!(await deps.canAfford(orgId)))
    return fail("insufficient_balance", "Insufficient wallet balance to place this call.");

  // Caps are enforced atomically with the row insert (one database call
  // under a per-organization lock): concurrent requests cannot exceed them.
  const prep = await prepareOutboundSipCall(deps.session, {
    organizationId: orgId,
    phoneNumberId: number.id,
    toNumber: input.toE164,
    callId,
    requestedBy: input.userId,
    maxActive: intEnv(deps.env, "VOICE_AGENT_OUTBOUND_MAX_CONCURRENT", 3),
    maxDaily: intEnv(deps.env, "VOICE_AGENT_OUTBOUND_DAILY_LIMIT", 100),
  });
  if (!prep.ok) {
    switch (prep.code) {
      case "invalid_destination":
        return fail("invalid_request", "A valid E.164 destination is required.");
      case "not_available":
        return fail("not_available", "This phone number is not active for calling.");
      case "not_entitled":
        return fail("not_entitled", prep.reason);
      case "conflict":
        return fail("conflict", "This request id was already used for a different call.");
      case "limit_active":
        return fail("limit_reached", "Too many AI outbound calls are already in progress.");
      case "limit_daily":
        return fail("limit_reached", "The daily AI outbound call limit has been reached.");
      default:
        return fail("internal_error", "The call could not be recorded. Please try again.");
    }
  }
  // Lost a concurrent race for the same key: the winner dispatches.
  if (!prep.created) return { ok: true, callId, room, status: prep.status, replayed: true };

  const outcome = await dispatchOnce(deps, callId);
  if (outcome === "rejected") return fail("dispatch_rejected", "The call could not be started.");
  return {
    ok: true,
    callId,
    room,
    status: outcome === "dispatched" ? "dispatched" : "pending",
    replayed: false,
  };
}
