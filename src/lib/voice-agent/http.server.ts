/**
 * HTTP layer of klyro's internal voice-agent API: body limits, request
 * signing (internal-auth.ts), replay protection, schema validation, and
 * rate limits (rate-limits.ts), and the handlers that call
 * sessions.server.ts. Route files under src/routes/api/internal/voice-agent/
 * and the LiveKit webhook route are thin wrappers around these functions so
 * they can be tested directly.
 *
 * Outbound calls are NOT started here: the agent's signing key cannot
 * authorise a dial. They start only from an authenticated user's
 * organization-scoped server function (outbound.functions.ts). The agent can
 * only CLAIM a row an owner/admin already created (handleOutboundClaim),
 * which is where it learns the destination and caller ID.
 */
import { z } from "zod";
import { MAX_BODY_BYTES, verifySignedRequest, type KeyId } from "./internal-auth.ts";
import { SIP_ATTR, participantSeconds, verifyLiveKitWebhook } from "./livekit-webhook.ts";
import {
  COUNTED_INTERNAL_FAILURES,
  COUNTED_WEBHOOK_FAILURES,
  clientIp,
  tooManyRequests,
  type SharedScope,
  type VoiceAgentLimiter,
} from "./rate-limits.ts";
import {
  MAX_TRANSCRIPT_TEXT,
  MAX_TRANSCRIPT_TURNS,
  claimOutboundCall,
  completeSipCallFromLiveKit,
  endSipSession,
  runSessionTool,
  startSipSession,
  type SessionDeps,
} from "./sessions.server.ts";

export interface HttpDeps {
  session: SessionDeps;
  env: (name: string) => string | undefined;
  /** Atomically records a nonce / webhook id; false when already seen. */
  claimOnce: (provider: string, id: string, payload: Record<string, unknown>) => Promise<boolean>;
  /** Undoes a claim when processing failed, so the sender's retry is processed. */
  releaseClaim: (provider: string, id: string) => Promise<void>;
  limiter: VoiceAgentLimiter;
  nowSeconds?: () => number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function readLimited(request: Request, maxBytes = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).length > maxBytes ? null : text;
}

/**
 * session-end alone carries the call transcript (G3), so it may be larger
 * than the other internal requests; the agent keeps its report within this
 * (services/voice-agent src/agent/call.ts TRANSCRIPT_BUDGET_BYTES).
 */
export const SESSION_END_MAX_BODY_BYTES = 256 * 1024;

/**
 * Response for a request that failed verification. The signature was
 * checked first, so only invalid requests ever reach the failure budget:
 * a counted failure is recorded unless the source is already over budget,
 * and an over-budget source gets 429 instead of the normal rejection.
 */
function rejectAuth(
  deps: HttpDeps,
  scope: "internal" | "webhook",
  ip: string,
  reason: string,
  normal: Response,
): Response {
  const counted = (scope === "internal" ? COUNTED_INTERNAL_FAILURES : COUNTED_WEBHOOK_FAILURES).has(
    reason,
  );
  const budget = deps.limiter.authFailureBudget(scope, ip);
  if (!budget.allowed) {
    console.warn(
      scope === "internal" ? "voice_agent:rate_limited" : "livekit_webhook:rate_limited",
      {
        scope: `${scope}_auth_failures`,
      },
    );
    return tooManyRequests(budget);
  }
  if (counted) deps.limiter.recordAuthFailure(scope, ip);
  return normal;
}

/** Signature + replay check. Returns the raw body, or a response to send back. */
async function authenticate(
  request: Request,
  deps: HttpDeps,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<{ body: string } | { response: Response }> {
  const ip = clientIp(request);
  const body = await readLimited(request, maxBytes);
  if (body === null)
    return {
      response: rejectAuth(
        deps,
        "internal",
        ip,
        "body_too_large",
        json(413, { error: "body_too_large" }),
      ),
    };
  const url = new URL(request.url);
  const result = await verifySignedRequest({
    secrets: {
      current: deps.env("VOICE_AGENT_HMAC_SECRET"),
      previous: deps.env("VOICE_AGENT_HMAC_SECRET_PREVIOUS"),
    },
    method: request.method,
    path: url.pathname + url.search,
    body,
    header: (n) => request.headers.get(n),
    ...(deps.nowSeconds ? { nowSeconds: deps.nowSeconds() } : {}),
    claimNonce: (keyId: KeyId, nonce: string, ts: number) =>
      deps.claimOnce("voice_agent_request", `${keyId}:${nonce}`, { ts }),
    maxBodyBytes: maxBytes,
  });
  if (!result.ok) {
    console.warn("voice_agent:auth_rejected", { reason: result.reason, path: url.pathname });
    const status =
      result.reason === "not_configured" ? 503 : result.reason === "body_too_large" ? 413 : 401;
    return {
      response: rejectAuth(
        deps,
        "internal",
        ip,
        result.reason,
        json(status, { error: "unauthorized" }),
      ),
    };
  }
  return { body };
}

/** Shared (cross-isolate) limit after authentication; null when allowed. */
async function sharedLimit(
  deps: HttpDeps,
  scope: SharedScope,
  key: string,
): Promise<Response | null> {
  const d = await deps.limiter.shared(scope, key);
  if (d.allowed) return null;
  console.warn("voice_agent:rate_limited", { scope });
  return tooManyRequests(d);
}

function parse<T>(
  schema: z.ZodType<T>,
  body: string,
): { ok: true; data: T } | { ok: false; response: Response } {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, response: json(400, { error: "invalid_json" }) };
  }
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, response: json(400, { error: "invalid_request" }) };
  return { ok: true, data: r.data };
}

const id = z.string().min(1).max(128);

const StartSchema = z.object({
  sipCallId: id,
  roomName: id,
  calledNumber: z.string().max(32),
  callerNumber: z.string().max(32).nullable(),
  direction: z.enum(["inbound", "outbound"]),
  outboundCallLogId: z.string().uuid().optional(),
  /** The agent's own MAX_CALL_SECONDS (Phase 2.11+ agents). */
  maxCallSeconds: z.number().int().min(60).max(7200).optional(),
});
const ToolSchema = z.object({
  callId: z.string().uuid(),
  tool: z.string().min(1).max(64),
  input: z.record(z.unknown()),
});
const ClaimSchema = z.object({
  callId: z.string().uuid(),
  roomName: id,
  jobId: id,
});
const EndSchema = z.object({
  callId: z.string().uuid(),
  jobId: id.optional(),
  reason: z.string().max(200),
  summary: z.string().max(2000).optional(),
  language: z.string().max(16).optional(),
  outcome: z.string().max(64).optional(),
  /** F1: the reporting agent's room and SIP call id; must match the call. */
  roomName: id.optional(),
  sipCallId: id.optional(),
  /**
   * G3: the conversation as the caller heard it, in the dashboard's
   * call_logs.transcript shape (the Worker runtime's ConversationTurn).
   * Caller and agent speech only: never system instructions or tool data.
   */
  transcript: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().min(1).max(MAX_TRANSCRIPT_TEXT),
        at: z.string().datetime(),
      }),
    )
    .max(MAX_TRANSCRIPT_TURNS)
    .optional(),
  /** The reporting LiveKit job: one transcript segment per job. */
  segment: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  /** A transcript checkpoint during the call (nothing else changes). */
  checkpoint: z.boolean().optional(),
});

export async function handleSessionStart(request: Request, deps: HttpDeps): Promise<Response> {
  const a = await authenticate(request, deps);
  if ("response" in a) return a.response;
  const p = parse(StartSchema, a.body);
  if (!p.ok) return p.response;
  const limited = await sharedLimit(deps, "session_start", p.data.calledNumber);
  if (limited) return limited;
  const { maxCallSeconds, ...start } = p.data;
  const r = await startSipSession(deps.session, {
    ...start,
    outboundCallLogId: p.data.outboundCallLogId,
    agentMaxCallSeconds: maxCallSeconds,
  });
  return json(200, r);
}

export async function handleTool(request: Request, deps: HttpDeps): Promise<Response> {
  const a = await authenticate(request, deps);
  if ("response" in a) return a.response;
  const p = parse(ToolSchema, a.body);
  if (!p.ok) return p.response;
  const limited = await sharedLimit(deps, "tool", p.data.callId);
  if (limited) return limited;
  const r = await runSessionTool(deps.session, p.data.callId, p.data.tool, p.data.input);
  if (!r.ok) return json(r.reason === "unknown_call" ? 404 : 403, { error: r.reason });
  return json(200, r);
}

export async function handleSessionEnd(request: Request, deps: HttpDeps): Promise<Response> {
  const a = await authenticate(request, deps, SESSION_END_MAX_BODY_BYTES);
  if ("response" in a) return a.response;
  const p = parse(EndSchema, a.body);
  if (!p.ok) return p.response;
  const limited = await sharedLimit(deps, "session_end", p.data.callId);
  if (limited) return limited;
  const r = await endSipSession(deps.session, p.data);
  // A report whose room / SIP call id does not match the call is refused
  // (409) and changes nothing (F1).
  return json(r.reason === "binding_mismatch" ? 409 : 200, r);
}

/**
 * The agent's claim on an outbound call row, made BEFORE it dials. Returns
 * the destination and caller ID from the row (never from dispatch
 * metadata). One job only; the same job may retry (idempotent).
 */
export async function handleOutboundClaim(request: Request, deps: HttpDeps): Promise<Response> {
  const a = await authenticate(request, deps);
  if ("response" in a) return a.response;
  const p = parse(ClaimSchema, a.body);
  if (!p.ok) return p.response;
  const limited = await sharedLimit(deps, "outbound_claim", p.data.callId);
  if (limited) return limited;
  const r = await claimOutboundCall(deps.session, p.data);
  if (!r.ok) {
    console.warn("voice_agent:outbound_claim_refused", { reason: r.reason });
    return json(r.reason === "not_found" ? 404 : 409, { error: r.reason });
  }
  return json(200, r);
}

/**
 * LiveKit server webhook. Only signed events are processed, each once
 * (webhook_events on provider "livekit"). A SIP participant leaving ends
 * and bills the call; everything else is acknowledged and ignored.
 */
export async function handleLiveKitWebhook(request: Request, deps: HttpDeps): Promise<Response> {
  // The signature is verified FIRST: a correctly signed LiveKit event is
  // never rate-limited, whatever its source IP has done (LiveKit's egress
  // may be shared with other LiveKit customers). Only unverifiable requests
  // count against, and are limited by, their source's failure budget.
  const ip = clientIp(request);
  const body = await readLimited(request);
  if (body === null)
    return rejectAuth(
      deps,
      "webhook",
      ip,
      "body_too_large",
      json(413, { error: "body_too_large" }),
    );
  const v = await verifyLiveKitWebhook({
    apiKey: deps.env("LIVEKIT_API_KEY"),
    apiSecret: deps.env("LIVEKIT_API_SECRET"),
    authorization: request.headers.get("authorization"),
    body,
    ...(deps.nowSeconds ? { nowSeconds: deps.nowSeconds() } : {}),
  });
  if (!v.ok) {
    console.warn("livekit_webhook:rejected", { reason: v.reason });
    return rejectAuth(
      deps,
      "webhook",
      ip,
      v.reason,
      json(v.reason === "not_configured" ? 503 : 401, { error: "unauthorized" }),
    );
  }
  const ev = v.event;
  const eventId = ev.id ?? `${ev.event}:${ev.room?.sid ?? ""}:${ev.participant?.sid ?? ""}`;
  if (!(await deps.claimOnce("livekit", eventId, { event: ev.event })))
    return json(200, { ok: true, duplicate: true });
  const attrs = ev.participant?.attributes ?? {};
  const sipCallId = attrs[SIP_ATTR.callId];
  if (ev.event === "participant_left" && sipCallId) {
    try {
      const endedAt = Number(ev.createdAt);
      const r = await completeSipCallFromLiveKit(deps.session, {
        sipCallId,
        seconds: participantSeconds(ev),
        ...(Number.isFinite(endedAt) ? { endedAtSeconds: endedAt } : {}),
      });
      return json(200, { ok: true, handled: r.handled });
    } catch (err) {
      // Release the claim so LiveKit's retry completes and bills the call.
      // Billing happens once: the completion is a conditional transition and
      // a row left "billing: pending" is billed with its stored duration,
      // by this retry or by the reconcile sweep (sessions.server.ts).
      console.error("livekit_webhook:processing_failed", (err as Error).message);
      await deps.releaseClaim("livekit", eventId).catch(() => undefined);
      return json(500, { error: "processing_failed" });
    }
  }
  return json(200, { ok: true, handled: false });
}

/** Production HttpDeps (lazy, server-only). */
export async function defaultHttpDeps(): Promise<HttpDeps> {
  const { defaultSessionDeps } = await import("./sessions.server.ts");
  const { defaultVoiceAgentLimiter } = await import("./rate-limits.ts");
  const [session, limiter] = await Promise.all([defaultSessionDeps(), defaultVoiceAgentLimiter()]);
  return {
    session,
    limiter,
    env: (n) => process.env[n],
    claimOnce: async (provider, eventId, payload) => {
      const { error } = await session.db.from("webhook_events").insert({
        provider,
        event_id: eventId,
        event_type: provider === "livekit" ? String(payload["event"] ?? "") : "request",
        payload: payload as never,
        processed_at: new Date().toISOString(),
      });
      if (!error) return true;
      if ((error as { code?: string }).code === "23505") return false;
      throw error;
    },
    releaseClaim: async (provider, eventId) => {
      await session.db
        .from("webhook_events")
        .delete()
        .eq("provider", provider)
        .eq("event_id", eventId);
    },
  };
}
