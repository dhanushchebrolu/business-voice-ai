/**
 * Shared CallSid -> call_logs correlation and authorization for Exotel's
 * media WebSocket, used by BOTH the local-dev fallback
 * (exotel-media-route.server.ts) and the production Durable Object
 * (call-session-durable-object.server.ts).
 *
 * This module exists because those two files previously carried their own,
 * independently-maintained COPIES of this exact lookup/retry/authorization
 * logic — and a real production bug came from that duplication: a fix for
 * a status-check race (widening which call_logs.status values are accepted
 * before a call is considered "already ended") landed in
 * exotel-media-route.server.ts but was never applied to
 * call-session-durable-object.server.ts, the file Cloudflare's CALL_SESSION
 * Durable Object binding actually runs in production. One shared function
 * makes that class of drift impossible going forward.
 *
 * Live-log finding (the reason this module exists): a real Exotel test call
 * produced `exotel_media_route:*`-prefixed log lines in production, not
 * `call_session_do:*` — meaning the deployed Worker's `env.CALL_SESSION`
 * binding was not active for that request, and traffic fell back to the
 * ambient (non-Durable-Object) path. That is a deploy/binding-provisioning
 * question, not something this module can detect or fix — but it does mean
 * both code paths must behave identically, which is exactly what sharing
 * this function guarantees.
 */

import { verifyMediaSessionToken } from "./media-session-token.ts";
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
 * Looks up the call_logs row for `callSid`, retries briefly to absorb the
 * inherent race between Exotel's WebSocket connect and its independent
 * call-status webhook (the thing that actually writes the row), and — once
 * found — re-runs the exact same entitlement gate (checkTelephonyAccess)
 * every other telephony code path uses. Never accepts a call this cannot
 * positively verify: every rejection path returns `{ ok: false, reason }`
 * and the caller is responsible for closing the socket, never proceeding.
 */
export async function authorizeExotelMediaSession(
  callSid: string,
  optionalToken: string | undefined,
): Promise<AuthorizedMediaSession | RejectedMediaSession> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  async function lookupCall() {
    const { data } = await supabaseAdmin
      .from("call_logs")
      .select("id, organization_id, phone_number_id, status")
      .eq("provider", "exotel")
      .eq("provider_call_id", callSid)
      .maybeSingle();
    return data;
  }

  // Widened from the original 5 attempts / 1s total: Exotel's status
  // webhook (the thing that actually writes this row) can plausibly take
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
    console.error("exotel_media_session:call_log_lookup", {
      callSid: maskedSid,
      attempts: attemptsMade,
      found: false,
      supabase_host: supabaseHost,
    });
    return { ok: false, reason: `No known call for CallSid ${maskedSid}` };
  }

  console.info("exotel_media_session:call_log_lookup", {
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

  // Optional second factor — only enforced when present, so its absence
  // (an Exotel account not configured to pass it) never weakens the
  // mandatory CallSid+DB check above, but its presence must be internally
  // consistent if it *is* there — a token for a different call is rejected
  // outright, not silently ignored.
  if (optionalToken) {
    const result = verifyMediaSessionToken(optionalToken);
    if (
      !result.ok ||
      result.payload.callId !== call.id ||
      result.payload.organizationId !== call.organization_id
    ) {
      return {
        ok: false,
        reason: `Media session token present but invalid or mismatched for call ${call.id}`,
      };
    }
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
    console.error("exotel_media_session:rejected_by_gate", {
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
