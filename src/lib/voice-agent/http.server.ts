/**
 * HTTP layer of klyro's internal voice-agent API: body limits, request
 * signing (internal-auth.ts), replay protection, schema validation, and
 * the handlers that call sessions.server.ts. Route files under
 * src/routes/api/internal/voice-agent/ and the LiveKit webhook route are
 * thin wrappers around these functions so they can be tested directly.
 */
import { z } from "zod";
import { MAX_BODY_BYTES, verifySignedRequest, type KeyId } from "./internal-auth.ts";
import { SIP_ATTR, participantSeconds, verifyLiveKitWebhook } from "./livekit-webhook.ts";
import {
  completeSipCallFromLiveKit,
  endSipSession,
  prepareOutboundSipCall,
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
  nowSeconds?: () => number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function readLimited(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).length > MAX_BODY_BYTES ? null : text;
}

/** Signature + replay check. Returns the raw body, or a response to send back. */
async function authenticate(
  request: Request,
  deps: HttpDeps,
): Promise<{ body: string } | { response: Response }> {
  const body = await readLimited(request);
  if (body === null) return { response: json(413, { error: "body_too_large" }) };
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
  });
  if (!result.ok) {
    console.warn("voice_agent:auth_rejected", { reason: result.reason, path: url.pathname });
    const status =
      result.reason === "not_configured" ? 503 : result.reason === "body_too_large" ? 413 : 401;
    return { response: json(status, { error: "unauthorized" }) };
  }
  return { body };
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
const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/);

const StartSchema = z.object({
  sipCallId: id,
  roomName: id,
  calledNumber: z.string().max(32),
  callerNumber: z.string().max(32).nullable(),
  direction: z.enum(["inbound", "outbound"]),
  outboundCallLogId: z.string().uuid().optional(),
});
const ToolSchema = z.object({
  callId: z.string().uuid(),
  tool: z.string().min(1).max(64),
  input: z.record(z.unknown()),
});
const EndSchema = z.object({
  callId: z.string().uuid(),
  reason: z.string().max(200),
  summary: z.string().max(2000).optional(),
  language: z.string().max(16).optional(),
  outcome: z.string().max(64).optional(),
});
const OutboundSchema = z.object({
  organizationId: z.string().uuid(),
  phoneNumberId: z.string().uuid(),
  toNumber: e164,
});

export async function handleSessionStart(request: Request, deps: HttpDeps): Promise<Response> {
  const a = await authenticate(request, deps);
  if ("response" in a) return a.response;
  const p = parse(StartSchema, a.body);
  if (!p.ok) return p.response;
  const r = await startSipSession(deps.session, {
    ...p.data,
    outboundCallLogId: p.data.outboundCallLogId,
  });
  return json(200, r);
}

export async function handleTool(request: Request, deps: HttpDeps): Promise<Response> {
  const a = await authenticate(request, deps);
  if ("response" in a) return a.response;
  const p = parse(ToolSchema, a.body);
  if (!p.ok) return p.response;
  const r = await runSessionTool(deps.session, p.data.callId, p.data.tool, p.data.input);
  if (!r.ok) return json(r.reason === "unknown_call" ? 404 : 403, { error: r.reason });
  return json(200, r);
}

export async function handleSessionEnd(request: Request, deps: HttpDeps): Promise<Response> {
  const a = await authenticate(request, deps);
  if ("response" in a) return a.response;
  const p = parse(EndSchema, a.body);
  if (!p.ok) return p.response;
  return json(200, await endSipSession(deps.session, p.data));
}

/**
 * Outbound authorisation is OFF unless VOICE_AGENT_OUTBOUND_ENABLED=true.
 * This endpoint trusts the agent's signing key to name any organisation's
 * number (still entitlement-gated and billed); outbound calls should be
 * started from klyro's own authenticated UI before this is enabled.
 */
export async function handleOutboundPrepare(request: Request, deps: HttpDeps): Promise<Response> {
  if (deps.env("VOICE_AGENT_OUTBOUND_ENABLED") !== "true") return json(404, { error: "not_found" });
  const a = await authenticate(request, deps);
  if ("response" in a) return a.response;
  const p = parse(OutboundSchema, a.body);
  if (!p.ok) return p.response;
  const r = await prepareOutboundSipCall(deps.session, p.data);
  return json(r.ok ? 200 : 403, r);
}

/**
 * LiveKit server webhook. Only signed events are processed, each once
 * (webhook_events on provider "livekit"). A SIP participant leaving ends
 * and bills the call; everything else is acknowledged and ignored.
 */
export async function handleLiveKitWebhook(request: Request, deps: HttpDeps): Promise<Response> {
  const body = await readLimited(request);
  if (body === null) return json(413, { error: "body_too_large" });
  const v = await verifyLiveKitWebhook({
    apiKey: deps.env("LIVEKIT_API_KEY"),
    apiSecret: deps.env("LIVEKIT_API_SECRET"),
    authorization: request.headers.get("authorization"),
    body,
    ...(deps.nowSeconds ? { nowSeconds: deps.nowSeconds() } : {}),
  });
  if (!v.ok) {
    console.warn("livekit_webhook:rejected", { reason: v.reason });
    return json(v.reason === "not_configured" ? 503 : 401, { error: "unauthorized" });
  }
  const ev = v.event;
  const eventId = ev.id ?? `${ev.event}:${ev.room?.sid ?? ""}:${ev.participant?.sid ?? ""}`;
  if (!(await deps.claimOnce("livekit", eventId, { event: ev.event })))
    return json(200, { ok: true, duplicate: true });
  const attrs = ev.participant?.attributes ?? {};
  const sipCallId = attrs[SIP_ATTR.callId];
  if (ev.event === "participant_left" && sipCallId) {
    try {
      const r = await completeSipCallFromLiveKit(deps.session, {
        sipCallId,
        seconds: participantSeconds(ev),
      });
      return json(200, { ok: true, handled: r.handled });
    } catch (err) {
      // Release the claim so LiveKit's retry completes and bills the call
      // (billing is idempotent per call, so a retry can never double-charge).
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
  const session = await defaultSessionDeps();
  return {
    session,
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
