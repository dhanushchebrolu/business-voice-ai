/**
 * The inbound WebSocket endpoint Vobiz's `<Stream>` Voice XML element
 * connects to — the Vobiz counterpart of exotel-media-route.server.ts.
 *
 * This is the local-dev / no-Durable-Object fallback path only (same scope
 * as Exotel's equivalent file). In production, Vobiz media is routed
 * through its own dedicated VobizCallSessionDurableObject instead (see
 * vobiz-call-session-durable-object.server.ts and src/server.ts) — a
 * separate class/binding from Exotel's CallSessionDurableObject, so the
 * two providers never share Durable Object instance state. src/server.ts
 * only falls back to this file's handleVobizMediaUpgrade when the
 * VOBIZ_CALL_SESSION binding isn't configured (local `vite dev`, where
 * there is no cross-isolate risk in the first place).
 *
 * Same correlation design as Exotel's: Vobiz's `<Stream>` URL carries no
 * reliable per-call identity in the upgrade request itself, so the upgrade
 * is accepted unauthenticated at the transport level, then withheld (no
 * bridge registered, no audio forwarded) until the "start" event's callId
 * has been cross-checked against call_logs and the entitlement gate has
 * passed — see authorizeMediaSession (media-session-authorization.server.ts).
 */

import { claimVobizMediaSession, registerVobizMediaBridge } from "./vobiz-media-registry.server.ts";
import { VobizMediaBridge, type VobizSocketLike } from "./vobiz-media-bridge.server.ts";
import { authorizeMediaSession, maskCallSid } from "./media-session-authorization.server.ts";
import { VOBIZ_MEDIA_STREAM_PATH as MEDIA_STREAM_PATH } from "./vobiz-media-stream-path.ts";

interface CloudflareWebSocketPair {
  0: VobizSocketLike & { accept(): void };
  1: VobizSocketLike;
}
interface CloudflareWebSocketPairConstructor {
  new (): CloudflareWebSocketPair;
}

function getWebSocketPairCtor(): CloudflareWebSocketPairConstructor | null {
  const ctor = (globalThis as Record<string, unknown>)["WebSocketPair"];
  return typeof ctor === "function"
    ? (ctor as unknown as CloudflareWebSocketPairConstructor)
    : null;
}

function firstDefinedString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

export async function handleVobizMediaUpgrade(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== MEDIA_STREAM_PATH) return null;
  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade request", { status: 400 });
  }

  const WebSocketPairCtor = getWebSocketPairCtor();
  if (!WebSocketPairCtor) {
    console.error("vobiz_media_route:websocketpair_unavailable");
    return new Response("WebSocket media transport is not available in this runtime.", {
      status: 501,
    });
  }

  const pair = new WebSocketPairCtor();
  const [server, client] = [pair[0], pair[1]];
  server.accept();
  console.info("vobiz_media_route:handshake_accepted", { path: MEDIA_STREAM_PATH });

  let settled = false;
  // Same buffering fix as Exotel's route: authorization is several awaited
  // round trips deep, and Vobiz can start streaming "media" frames
  // immediately after "start" — without buffering, any frame arriving
  // during that window is silently dropped.
  let pending: unknown[] | null = null;

  const onMessage = (ev: { data: unknown }) => {
    if (pending) {
      pending.push(ev.data);
      return;
    }
    if (settled) return;
    void handleFirstMessage(ev.data).catch((err: unknown) => {
      console.error(
        "vobiz_media_route:media_validation_crashed",
        err instanceof Error ? err.message : String(err),
      );
      pending = null;
      try {
        server.close(1011, "internal error");
      } catch {
        /* best-effort */
      }
    });
  };

  async function handleFirstMessage(data: unknown) {
    if (typeof data !== "string") return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const eventName = String(msg["event"] ?? "").toLowerCase();
    if (eventName === "connected") return;
    if (eventName !== "start") return;

    settled = true;
    pending = [];

    // Production incident: "Missing callId on start event" rejected every
    // real Vobiz call. Vobiz's own reference Pipecat integration
    // (VobizFrameSerializer — a documented subclass of Pipecat's
    // PlivoFrameSerializer; see vobiz-provider.ts's module doc for the
    // sourcing chain) nests the call/stream identifiers one level down,
    // inside a "start" sub-object (start.callId / start.streamId) — the
    // same shape Pipecat's own official Plivo integration parses
    // (`start_data = data.get("start"); start_data.get("callId")`). This
    // file previously only checked top-level keys, so a real start event's
    // callId was never found. Nested lookup is tried first now (the
    // confirmed real shape); the flat top-level keys are kept as a
    // defensive fallback only.
    const startData =
      typeof msg["start"] === "object" && msg["start"] !== null
        ? (msg["start"] as Record<string, unknown>)
        : null;
    // TEMPORARY DIAGNOSTIC (same incident) — field NAMES only, never
    // values: no audio, call id, auth token, or signature is logged here.
    console.info("vobiz_media_route:start_event_shape", {
      topLevelKeys: Object.keys(msg),
      nestedStartKeys: startData ? Object.keys(startData) : null,
    });
    const callId =
      (startData && firstDefinedString(startData, ["callId", "call_id", "CallId", "CallUUID"])) ??
      firstDefinedString(msg, ["callId", "call_id", "CallId", "CallUUID"]);
    const streamId =
      (startData && firstDefinedString(startData, ["streamId", "stream_id", "StreamId"])) ??
      firstDefinedString(msg, ["streamId", "stream_id", "StreamId"]);

    if (!callId) return reject("Missing callId on start event");

    // No optional token is ever read here, unlike Exotel's equivalent path:
    // Klyro never mints a media-session token for Vobiz (mintMediaSessionToken
    // is only ever called from exotel.media-token.ts, and buildVobizStreamXml
    // embeds nothing but the bare wss:// URL — no custom parameter Vobiz
    // could echo back). Production incident: Vobiz's own "start" message
    // apparently carries a top-level field this code previously mistook for
    // Klyro's own HMAC-signed token (same key names as Exotel's, inherited
    // from that flow without the corresponding mint-and-embed half); since
    // it was never minted by Klyro, verifyMediaSessionToken deterministically
    // rejected it, failing an otherwise fully legitimate, correctly
    // call_logs-authorized Vobiz call. The callId -> call_logs cross-check
    // and entitlement gate below remain the mandatory, unweakened baseline —
    // this only removes a check that could never legitimately pass for
    // Vobiz in the first place.
    const auth = await authorizeMediaSession("vobiz", callId, undefined);
    if (!auth.ok) return reject(auth.reason);

    if (!claimVobizMediaSession(callId))
      return reject(`A media session for callId ${maskCallSid(callId)} is already active`);

    const bridge = new VobizMediaBridge(server, streamId ?? callId, callId);
    registerVobizMediaBridge(callId, bridge);
    const buffered = pending ?? [];
    pending = null;
    for (const raw of buffered) bridge.ingestRawMessage(raw);
    console.info("vobiz_media_route:accepted", {
      callId: auth.callId,
      providerCallId: maskCallSid(callId),
      organizationId: auth.organizationId,
    });
  }

  function reject(reason: string) {
    console.error("vobiz_media_route:rejected", { reason });
    pending = null;
    try {
      server.close(1008, "unauthorized");
    } catch {
      /* best-effort */
    }
  }

  server.addEventListener("message", onMessage);
  server.addEventListener("close", () => {
    settled = true;
  });

  return new Response(null, { status: 101, webSocket: client } as ResponseInit & {
    webSocket: unknown;
  });
}
