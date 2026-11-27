/**
 * Shared call-id -> call_logs correlation and authorization for a provider's media
 * WebSocket (Vobiz), used by BOTH the local-development route
 * (vobiz-media-route.server.ts) and the production Durable Object
 * (vobiz-call-session-durable-object.server.ts).
 *
 * One shared function because two independently maintained copies of this
 * lookup/retry/authorization logic once drifted apart: a fix for a
 * status-check race reached one path and not the one running in production.
 */

import {
  checkTelephonyAccess,
  maskPhoneNumber,
  TERMINAL_CALL_STATUSES,
} from "../telephony-guard.server.ts";

export interface AuthorizedMediaSession {
  ok: true;
  callId: string;
  organizationId: string;
  phoneNumberId: string;
}

export interface RejectedMediaSession {
  ok: false;
  reason: string;
}

/**
 * Masks an opaque provider call identifier for logging — keeps only the
 * last 6 characters, e.g. "3d8c2c67e38509437f5f61f597e91a9" ->
 * "**************************e91a9". A CallSid isn't a secret the way an
 * API key is, but it is still an external identifier that shouldn't be
 * dumped in full into logs — masking it here lets the webhook's and the
 * media route's logs be visually diffed against each other without ever
 * printing the complete value in either place.
 */
export function maskCallSid(sid: string): string {
  if (sid.length <= 6) return "*".repeat(sid.length);
  return "*".repeat(sid.length - 6) + sid.slice(-6);
}

/**
 * Looks up the call_logs row for `callSid` under the given `provider`,
 * retries briefly to absorb the inherent race between a provider's
 * WebSocket connect and its independent call-status webhook (the thing
 * that actually writes the row), and — once found — re-runs the exact same
 * entitlement gate (checkTelephonyAccess) every other telephony code path
 * uses. Never accepts a call this cannot positively verify: every
 * rejection path returns `{ ok: false, reason }` and the caller is
 * responsible for closing the socket, never proceeding.
 *
 * `provider` scopes the lookup, so a provider call id never matches
 * another provider's call.
 */
export async function authorizeMediaSession(
  provider: string,
  callSid: string,
): Promise<AuthorizedMediaSession | RejectedMediaSession> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const logPrefix = `${provider}_media_session`;

  async function lookupCall() {
    const { data } = await supabaseAdmin
      .from("call_logs")
      .select("id, organization_id, phone_number_id, status")
      .eq("provider", provider)
      .eq("provider_call_id", callSid)
      .maybeSingle();
    return data;
  }

  // Widened from the original 5 attempts / 1s total: the status webhook
  // (the thing that actually writes this row) can plausibly take
  // longer than 1s to arrive under real network conditions, and rejecting
  // here means the caller hears nothing — a false rejection is much more
  // costly than a slightly longer wait for a call that was never going to
  // arrive at all.
  const CALL_LOOKUP_ATTEMPTS = 10;
  const CALL_LOOKUP_DELAY_MS = 300;
  let call = await lookupCall();
  let attemptsMade = 1;
  for (let attempt = 1; !call && attempt < CALL_LOOKUP_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, CALL_LOOKUP_DELAY_MS));
    call = await lookupCall();
    attemptsMade++;
  }

  const maskedSid = maskCallSid(callSid);
  if (!call) {
    // Diagnostic: distinguishes "the webhook genuinely never wrote this
    // row" from "this Worker is pointed at a different Supabase project
    // than whatever wrote it" — same technique telephony.ts's
    // webhook_unknown_number log already uses for the same ambiguity on
    // the webhook side.
    let supabaseHost: string | null = null;
    try {
      const rawUrl = process.env["SUPABASE_URL"];
      supabaseHost = rawUrl ? new URL(rawUrl).hostname : null;
    } catch {
      supabaseHost = "unparseable";
    }
    console.error(`${logPrefix}:call_log_lookup`, {
      callSid: maskedSid,
      attempts: attemptsMade,
      found: false,
      supabase_host: supabaseHost,
    });
    return { ok: false, reason: `No known call for CallSid ${maskedSid}` };
  }

  console.info(`${logPrefix}:call_log_lookup`, {
    callSid: maskedSid,
    attempts: attemptsMade,
    found: true,
    organizationId: call.organization_id,
  });

  // Only a call that has already reached a TERMINAL status is rejected —
  // attaching live media to an already-ended call would be a real bug. A
  // call still "initiated"/"ringing"/etc. is accepted here; the real
  // authorization (org/number/entitlement) is independently re-verified via
  // checkTelephonyAccess below regardless of which non-terminal status this
  // row is at.
  if (TERMINAL_CALL_STATUSES.includes(call.status as (typeof TERMINAL_CALL_STATUSES)[number])) {
    return { ok: false, reason: `Call ${call.id} has already ended (status: ${call.status})` };
  }
  if (!call.phone_number_id) {
    return { ok: false, reason: `Call ${call.id} has no associated phone number` };
  }

  const { data: phoneNumber } = await supabaseAdmin
    .from("phone_numbers")
    .select("*")
    .eq("id", call.phone_number_id)
    .maybeSingle();
  if (!phoneNumber) {
    return { ok: false, reason: `Phone number not found for call ${call.id}` };
  }

  // Reuse Phase D's entitlement gate exactly — never a parallel check.
  const gate = await checkTelephonyAccess(call.organization_id, phoneNumber.id, "inbound");
  if (!gate.allowed) {
    console.error(`${logPrefix}:rejected_by_gate`, {
      callSid: maskedSid,
      organizationId: call.organization_id,
      calledNumber: maskPhoneNumber(phoneNumber.e164),
      reason: gate.reason,
    });
    return {
      ok: false,
      reason: gate.reason ?? `Call ${call.id} is not authorized for the voice runtime`,
    };
  }

  return {
    ok: true,
    callId: call.id,
    organizationId: call.organization_id,
    phoneNumberId: phoneNumber.id,
  };
}
