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

import { verifyMediaSessionToken } from "./media-session-token.ts";
import { claimMediaSession, registerMediaBridge } from "./exotel-media-registry.server.ts";
import { ExotelMediaBridge, type ExotelSocketLike } from "./exotel-media-bridge.server.ts";
import { checkTelephonyAccess } from "../telephony-guard.server.ts";

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

  const onMessage = (ev: { data: unknown }) => {
    if (settled) return; // ignore anything after validation has already resolved either way
    void handleFirstMessage(ev.data);
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

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: call } = await supabaseAdmin
      .from("call_logs")
      .select("id, organization_id, phone_number_id, status")
      .eq("provider", "exotel")
      .eq("provider_call_id", callSid)
      .maybeSingle();
    if (!call) return reject(`No known call for CallSid ${callSid}`);
    if (call.status !== "answered" && call.status !== "in_progress") {
      return reject(`Call ${call.id} is not eligible for a media session (status: ${call.status})`);
    }
    if (!call.phone_number_id) return reject(`Call ${call.id} has no associated phone number`);

    // Optional second factor (spec §7/§24) — only enforced when present, so
    // its absence (an Exotel account not configured to pass it) never
    // weakens the mandatory CallSid+DB check above, but its presence must
    // be internally consistent if it *is* there — a token for a different
    // call is rejected outright, not silently ignored.
    if (optionalToken) {
      const result = verifyMediaSessionToken(optionalToken);
      if (
        !result.ok ||
        result.payload.callId !== call.id ||
        result.payload.organizationId !== call.organization_id
      ) {
        return reject(`Media session token present but invalid or mismatched for call ${call.id}`);
      }
    }

    const { data: phoneNumber } = await supabaseAdmin
      .from("phone_numbers")
      .select("*")
      .eq("id", call.phone_number_id)
      .maybeSingle();
    if (!phoneNumber) return reject(`Phone number not found for call ${call.id}`);

    // Reuse Phase D's entitlement gate exactly — never a parallel check.
    const gate = await checkTelephonyAccess(call.organization_id, phoneNumber.id, "inbound");
    if (!gate.allowed)
      return reject(gate.reason ?? `Call ${call.id} is not authorized for the voice runtime`);

    if (!claimMediaSession(callSid))
      return reject(`A media session for CallSid ${callSid} is already active`);

    const bridge = new ExotelMediaBridge(server, streamSid ?? callSid, callSid);
    registerMediaBridge(callSid, bridge);
    console.info("exotel_media_route:accepted", {
      callId: call.id,
      callSid,
      organizationId: call.organization_id,
    });
  }

  function reject(reason: string) {
    console.error("exotel_media_route:rejected", { reason });
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
