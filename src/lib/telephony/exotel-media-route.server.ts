/**
 * The inbound WebSocket endpoint Exotel's Voicebot Applet connects to.
 *
 * This is deliberately NOT a TanStack Start file route — TanStack Start's
 * `server.handlers` convention (used by every other route in this repo,
 * including the Phase D telephony webhook) has no WebSocket support at
 * all: `@tanstack/react-start`/`@tanstack/start-server-core` reference
 * "websocket" nowhere in their source (verified by grepping the installed
 * packages). WebSocket support in this stack exists one layer down, in
 * Nitro/h3/crossws — and this project's own `src/server.ts` is already the
 * raw Cloudflare Workers `fetch(request, env, ctx)` entry point Nitro
 * builds to (see `vite.config.ts`'s `tanstackStart.server.entry: "server"`
 * redirect), which is the one place with direct access to the platform's
 * native `WebSocketPair`. See PHASE_D1_EXOTEL_FINAL_REPORT.md §16 for the
 * full verification trail (including that Nitro ships a ready-made
 * `cloudflare-durable` preset for Durable-Object-backed WebSockets, not
 * used here because a plain Worker is sufficient — same report section).
 *
 * IMPORTANT correlation design note: Exotel's Voicebot Applet WSS URL is
 * configured once, statically, in the Exotel dashboard's call-flow — it is
 * NOT dynamically generated per call by anything Vaani does for inbound
 * calls (Vaani never initiates that connection; Exotel does). That means
 * the *upgrade request itself* carries no reliable per-call identity — the
 * only place Exotel's protocol is documented to actually carry the CallSid
 * is inside the first WebSocket message, the "start" event. So this route
 * accepts the upgrade unauthenticated at the transport level (standard for
 * this class of realtime-media protocol), then withholds any real
 * capability — no bridge is registered, no audio is forwarded, the
 * runtime never starts — until the "start" event's CallSid has been
 * cross-checked against `call_logs` (never trusted alone — spec §7/§9) and
 * the Phase D entitlement gate has passed. Anything that fails that check
 * closes the socket immediately.
 *
 * A short-lived, signed `media-session-token.ts` token is layered on top
 * *when available*: if the Exotel account's call-flow is built with a
 * Passthru step that mints one via the endpoint documented in
 * PHASE_D1_EXOTEL_FINAL_REPORT.md §20 and forwards it as one of the
 * Voicebot Applet's (max 3, ≤256-char) custom parameters, it is verified
 * as an *additional* factor. Its absence never weakens the CallSid+DB
 * check above, which is why it is optional here, not required.
 */

import { claimMediaSession, registerMediaBridge } from "./exotel-media-registry.server.ts";
import { ExotelMediaBridge, type ExotelSocketLike } from "./exotel-media-bridge.server.ts";
import { authorizeExotelMediaSession, maskCallSid } from "./media-session-authorization.server.ts";

const MEDIA_STREAM_PATH = "/api/public/media-stream/exotel";

interface CloudflareWebSocketPair {
  0: ExotelSocketLike & { accept(): void };
  1: ExotelSocketLike;
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

export async function handleExotelMediaUpgrade(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== MEDIA_STREAM_PATH) return null;
  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade request", { status: 400 });
  }

  // Runtime feature detection, not a compile-time assumption (spec §25):
  // this global exists in the Cloudflare Workers runtime, not in local
  // `vite dev` (plain Node) or in this project's test runner — both of
  // which must fail gracefully here, never crash, and never pretend to
  // have accepted a connection they didn't.
  const WebSocketPairCtor = getWebSocketPairCtor();
  if (!WebSocketPairCtor) {
    console.error("exotel_media_route:websocketpair_unavailable");
    return new Response("WebSocket media transport is not available in this runtime.", {
      status: 501,
    });
  }

  const pair = new WebSocketPairCtor();
  const [server, client] = [pair[0], pair[1]];
  server.accept();

  let settled = false;
  // BUGFIX: see call-session-durable-object.server.ts's identical fix for
  // the full rationale — handleFirstMessage's validation is several awaited
  // round trips deep, and Exotel starts streaming "media" frames immediately
  // after "start". Without buffering, any frame arriving during that
  // validation window was silently dropped: `settled` was already `true`
  // (so `onMessage` no-oped every later message) and the ExotelMediaBridge
  // that would actually handle "media" doesn't exist until validation
  // finishes. This is the local-dev fallback path (no CALL_SESSION binding
  // configured) — kept in parity with the Durable Object's production path.
  let pending: unknown[] | null = null;

  const onMessage = (ev: { data: unknown }) => {
    if (pending) {
      pending.push(ev.data);
      return;
    }
    if (settled) return; // ignore anything after validation has already resolved either way
    void handleFirstMessage(ev.data).catch((err: unknown) => {
      // BUGFIX: an uncaught throw inside handleFirstMessage's validation
      // chain (a Supabase config or network error, for example) previously
      // became an unhandled promise rejection here — fatal by default in
      // Node. Treat it the same as any other rejection: log, discard
      // whatever was buffered, and close the socket.
      console.error(
        "exotel_media_route:media_validation_crashed",
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
    if (eventName === "connected") return; // handshake ack only — wait for start
    if (eventName !== "start") return; // ignore anything else until we've seen start

    settled = true; // one validation attempt only, even if messages race
    pending = []; // start buffering any "media" frames that arrive while we validate
    const start = (msg["start"] as Record<string, unknown> | undefined) ?? msg;
    const callSid = firstDefinedString(start, ["call_sid", "CallSid", "callSid"]);
    const streamSid = firstDefinedString(start, ["stream_sid", "StreamSid", "streamSid"]);
    const customParams =
      (start["custom_parameters"] as Record<string, unknown> | undefined) ??
      (start["customParameters"] as Record<string, unknown> | undefined);
    const optionalToken = customParams
      ? firstDefinedString(customParams, ["token", "session_token"])
      : undefined;

    if (!callSid) return reject("Missing CallSid on start event");

    // The actual CallSid -> call_logs correlation, retry, status, token and
    // entitlement checks all live in one shared module also used by
    // call-session-durable-object.server.ts (the production path when the
    // CALL_SESSION binding is configured) — see that module's doc for why
    // sharing this matters.
    const auth = await authorizeExotelMediaSession(callSid, optionalToken);
    if (!auth.ok) return reject(auth.reason);

    if (!claimMediaSession(callSid))
      return reject(`A media session for CallSid ${maskCallSid(callSid)} is already active`);

    const bridge = new ExotelMediaBridge(server, streamSid ?? callSid, callSid);
    registerMediaBridge(callSid, bridge);
    // Replay anything that arrived while we were validating — see the
    // `pending` buffer's own comment above for why this is necessary.
    const buffered = pending ?? [];
    pending = null;
    for (const raw of buffered) bridge.ingestRawMessage(raw);
    console.info("exotel_media_route:accepted", {
      callId: auth.callId,
      callSid: maskCallSid(callSid),
      organizationId: auth.organizationId,
    });
  }

  function reject(reason: string) {
    console.error("exotel_media_route:rejected", { reason });
    pending = null; // discard anything buffered — the call is being refused
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
