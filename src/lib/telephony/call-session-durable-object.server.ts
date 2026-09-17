import type { AudioMediaBridge } from "./audio-bridge.ts";
import { ExotelMediaBridge, type ExotelSocketLike } from "./exotel-media-bridge.server.ts";
import { verifyMediaSessionToken } from "./media-session-token.ts";
import { isEligibleForMediaSession } from "./media-session-eligibility.ts";
import { checkTelephonyAccess } from "../telephony-guard.server.ts";
import { EXOTEL_MEDIA_STREAM_PATH as MEDIA_STREAM_PATH } from "./exotel-media-stream-path.ts";
import {
  startRuntimeSession,
  terminateRuntimeSession,
  getActiveSession,
  type StartRuntimeSessionInput,
} from "../voice-runtime.server.ts";

/**
 * Cloudflare Durable Object that replaces the two unsafe, cross-request
 * in-memory rendezvous points found during the production audit (E1):
 *
 *   1. exotel-media-registry.server.ts's module-level waiters/arrived/active
 *      Maps, used to correlate Exotel's inbound media WebSocket connection
 *      with the call-status webhook's wait for that same call's audio
 *      bridge — two independent Worker requests with no guarantee of
 *      landing on the same isolate.
 *   2. voice-runtime.server.ts's module-level activeSessions Map, populated
 *      by whichever request happened to resolve the bridge above, and read
 *      by a *later*, separate webhook request when the call ends — again,
 *      no guarantee of the same isolate, so termination could silently
 *      no-op, leaking the open Sarvam STT/TTS sockets and losing the
 *      transcript.
 *
 * A Durable Object is Cloudflare's one primitive that actually guarantees
 * "the same logical instance handles every request routed to this ID,"
 * including a WebSocket held open for the life of a call — which is exactly
 * the guarantee this problem needs and a plain Worker cannot provide.
 *
 * IMPORTANT — why this is one shared coordinator instance, not one per
 * call_id: Exotel's Voicebot Applet WSS URL is configured once, statically,
 * in the Exotel dashboard's call-flow (see exotel-media-route.server.ts's
 * own long-standing comment on this) — it is not dynamically generated per
 * call, so the inbound WebSocket upgrade request carries no per-call
 * identity a Worker could use to address a per-call Durable Object *before*
 * accepting the connection. The CallSid is only known once the socket's
 * first ("start") message arrives, and a live WebSocket cannot be handed
 * off between Durable Object instances. Given that hard, external
 * constraint, this uses ONE fixed-name coordinator instance
 * (CALL_SESSION_COORDINATOR_NAME, see cloudflare-env.server.ts) for every
 * in-flight Exotel media call. All per-call state within that one instance
 * is still fully isolated and deterministic, keyed by call_id/providerCallId
 * (the waiters/arrived/active maps and voice-runtime.server.ts's own
 * activeSessions map, below) — only the Durable Object *instance* is
 * shared, never a given call's state with another call's.
 *
 * Everything below this instance boundary — the WebSocket
 * accept/validation logic, the audio bridge, the Sarvam voice runtime — is
 * reused UNCHANGED from the existing modules; this class only owns *where*
 * that code executes (durably, inside one Cloudflare-guaranteed-consistent
 * instance) instead of *what* it does.
 *
 * No secrets are ever stored in Durable Object state. This class holds no
 * persistent storage at all (no `state.storage` calls) — every field below
 * is transient, call-scoped, in-memory instance state, exactly as
 * short-lived as the call itself, matching the original design intent of
 * the code this replaces.
 */

const ARRIVAL_TTL_MS = 30_000;
const DEFAULT_BRIDGE_TIMEOUT_MS = 15_000;

interface PendingWaiter {
  resolve: (bridge: AudioMediaBridge | null) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Minimal Durable Object state shape this class actually uses — see cloudflare-env.server.ts for why this project doesn't depend on @cloudflare/workers-types. */
export interface DurableObjectState {
  id: { toString(): string };
}

interface AcceptableSocket extends ExotelSocketLike {
  accept(): void;
}
interface CloudflareWebSocketPair {
  0: AcceptableSocket;
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

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

export interface StartRuntimeRpcInput {
  callId: string;
  organizationId: string;
  businessId: string;
  agentConfigId: string | null;
  agentVersion: number | null;
  instructions: string;
  snapshotAgent: StartRuntimeSessionInput["snapshotAgent"];
  businessName: string;
  providerCallId: string;
  timeoutMs?: number;
}

export interface AgentRuntimeRpcResult {
  handled: boolean;
  note: string;
}

export class CallSessionDurableObject {
  private waiters = new Map<string, PendingWaiter>();
  private arrived = new Map<string, AudioMediaBridge>();
  private active = new Set<string>();
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    // Cloudflare passes this DO's own env bindings as the second
    // constructor argument; unused today but kept in the signature to
    // match the platform's expected shape.
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        return await this.handleMediaUpgrade(request, url);
      }
      if (url.pathname === "/internal/start-runtime" && request.method === "POST") {
        return await this.handleStartRuntime(request);
      }
      if (url.pathname === "/internal/terminate-runtime" && request.method === "POST") {
        return await this.handleTerminateRuntime(request);
      }
      if (url.pathname === "/internal/status" && request.method === "GET") {
        return this.handleStatus(url);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("call_session_do:unhandled_error", (err as Error).message);
      return new Response("Internal error", { status: 500 });
    }
  }

  /* ------------------------------------------------------------------ */
  /* WebSocket accept + Exotel "start" event validation                  */
  /* (moved from exotel-media-route.server.ts's handleExotelMediaUpgrade, */
  /* logic unchanged — only where it runs, and where claim/register state */
  /* lives, has changed)                                                  */
  /* ------------------------------------------------------------------ */

  private async handleMediaUpgrade(request: Request, url: URL): Promise<Response> {
    if (url.pathname !== MEDIA_STREAM_PATH) return new Response("Not found", { status: 404 });

    const WebSocketPairCtor = getWebSocketPairCtor();
    if (!WebSocketPairCtor) {
      console.error("call_session_do:websocketpair_unavailable");
      return new Response("WebSocket media transport is not available in this runtime.", {
        status: 501,
      });
    }

    const pair = new WebSocketPairCtor();
    const [server, client] = [pair[0], pair[1]];
    server.accept();
    // Diagnostic requirement 1 (WS upgrade/handshake success) — see
    // exotel-media-route.server.ts's identical log for the full rationale:
    // no CallSid is known yet at this point, so this only confirms the
    // transport-level upgrade itself succeeded, independent of whatever
    // happens with CallSid validation after it.
    console.info("call_session_do:handshake_accepted", {
      doId: this.state.id.toString(),
      path: MEDIA_STREAM_PATH,
    });

    let settled = false;
    // BUGFIX: handleFirstMessage's own validation (the call_logs lookup,
    // the phone_numbers lookup, checkTelephonyAccess) is several awaited
    // round trips deep. Exotel's Voicebot Applet starts streaming "media"
    // frames immediately after "start" — in the original version of this
    // method, any such frame arriving during that validation window was
    // silently dropped: `onMessage` had already set `settled = true`
    // synchronously (so it would no-op every later message), and the
    // ExotelMediaBridge that would actually handle "media" frames does not
    // exist yet — it is only constructed once validation finishes. That
    // meant the caller's first fraction of a second of speech could be lost
    // before the bridge ever saw it. Buffering here, and replaying into the
    // bridge once it exists (or discarding once validation fails and the
    // socket is closed), closes that window without changing anything about
    // the validation logic itself.
    let pending: unknown[] | null = null;
    const onMessage = (ev: { data: unknown }) => {
      if (pending) {
        pending.push(ev.data);
        return;
      }
      if (settled) return; // one validation attempt only, even if messages race
      void this.handleFirstMessage(server, ev.data, () => {
        settled = true;
        pending = [];
      })
        .then((bridge) => {
          const buffered = pending ?? [];
          pending = null;
          if (bridge) for (const raw of buffered) bridge.ingestRawMessage(raw);
        })
        .catch((err: unknown) => {
          // BUGFIX: handleFirstMessage's validation chain is not wrapped in
          // its own try/catch — an unexpected throw (a Supabase config or
          // network error, for example) previously became an unhandled
          // promise rejection here, since this call site had no .catch at
          // all. Node treats an unhandled rejection as fatal by default,
          // which would have taken down this Durable Object instance (and
          // every other in-flight call it was coordinating) over a single
          // bad request. Treat it the same as any other rejection: log,
          // discard whatever was buffered, and close the socket.
          console.error(
            "call_session_do:media_validation_crashed",
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
    server.addEventListener("message", onMessage);
    server.addEventListener("close", () => {
      settled = true;
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: unknown });
  }

  /**
   * Returns the bridge once it has been constructed and registered, or
   * `null` if this "start" event was rejected (or the message wasn't a
   * "start" event at all) — the caller (handleMediaUpgrade's `onMessage`)
   * uses this to know whether, and where, to replay any "media" frames that
   * arrived on the socket while this method was still awaiting its
   * validation chain.
   */
  private async handleFirstMessage(
    server: AcceptableSocket,
    data: unknown,
    markSettled: () => void,
  ): Promise<ExotelMediaBridge | null> {
    if (typeof data !== "string") return null;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }
    const eventName = String(msg["event"] ?? "").toLowerCase();
    if (eventName === "connected") return null; // handshake ack only — wait for start
    if (eventName !== "start") return null; // ignore anything else until we've seen start

    markSettled();
    const start = (msg["start"] as Record<string, unknown> | undefined) ?? msg;
    const callSid = firstDefinedString(start, ["call_sid", "CallSid", "callSid"]);
    const streamSid = firstDefinedString(start, ["stream_sid", "StreamSid", "streamSid"]);
    const customParams =
      (start["custom_parameters"] as Record<string, unknown> | undefined) ??
      (start["customParameters"] as Record<string, unknown> | undefined);
    const optionalToken = customParams
      ? firstDefinedString(customParams, ["token", "session_token"])
      : undefined;

    const reject = (reason: string): null => {
      console.error("call_session_do:media_rejected", { reason });
      try {
        server.close(1008, "unauthorized");
      } catch {
        /* best-effort */
      }
      return null;
    };

    if (!callSid) return reject("Missing CallSid on start event");
    const sid: string = callSid;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Exotel's WebSocket connect and its own call-status webhook POST (the
    // thing that actually writes this call_logs row) race independently —
    // nothing guarantees the webhook lands first. A short, bounded retry
    // absorbs that race instead of rejecting a legitimate call outright;
    // any "media" frames that arrive on the socket during this window are
    // already buffered by the caller (handleMediaUpgrade's `pending`
    // buffer), so nothing is lost while this waits. Kept in parity with
    // exotel-media-route.server.ts's identical fix.
    async function lookupCall() {
      const { data } = await supabaseAdmin
        .from("call_logs")
        .select("id, organization_id, phone_number_id, status")
        .eq("provider", "exotel")
        .eq("provider_call_id", sid)
        .maybeSingle();
      return data;
    }
    const CALL_LOOKUP_ATTEMPTS = 5;
    const CALL_LOOKUP_DELAY_MS = 200;
    let call = await lookupCall();
    let attemptsMade = 1;
    for (let attempt = 1; !call && attempt < CALL_LOOKUP_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, CALL_LOOKUP_DELAY_MS));
      call = await lookupCall();
      attemptsMade++;
    }
    // Safe: CallSid/attempt counts only — never a payload value, never a key.
    console.info("call_session_do:call_log_lookup", {
      callSid: sid,
      attempts: attemptsMade,
      found: Boolean(call),
    });
    if (!call) return reject(`No known call for CallSid ${callSid}`);
    if (!isEligibleForMediaSession(call.status)) {
      return reject(`Call ${call.id} is not eligible for a media session (status: ${call.status})`);
    }
    if (!call.phone_number_id) return reject(`Call ${call.id} has no associated phone number`);

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

    const gate = await checkTelephonyAccess(call.organization_id, phoneNumber.id, "inbound");
    if (!gate.allowed)
      return reject(gate.reason ?? `Call ${call.id} is not authorized for the voice runtime`);

    if (!this.claim(callSid))
      return reject(`A media session for CallSid ${callSid} is already active`);

    const bridge = new ExotelMediaBridge(server, streamSid ?? callSid, callSid, (id) =>
      this.release(id),
    );
    this.registerBridge(callSid, bridge);
    console.info("call_session_do:media_accepted", {
      doId: this.state.id.toString(),
      callId: call.id,
      callSid,
      organizationId: call.organization_id,
    });
    return bridge;
  }

  /* ------------------------------------------------------------------ */
  /* Instance-scoped equivalents of exotel-media-registry.server.ts's     */
  /* module-level functions — same logic, now durable per this DO's ID.   */
  /* ------------------------------------------------------------------ */

  private claim(providerCallId: string): boolean {
    if (this.active.has(providerCallId)) return false;
    this.active.add(providerCallId);
    return true;
  }

  private registerBridge(providerCallId: string, bridge: AudioMediaBridge): void {
    const waiter = this.waiters.get(providerCallId);
    if (waiter) {
      clearTimeout(waiter.timeout);
      this.waiters.delete(providerCallId);
      waiter.resolve(bridge);
      return;
    }
    // The WS connection beat the webhook's start-runtime call — hold it
    // briefly rather than dropping it, exactly like the original registry.
    this.arrived.set(providerCallId, bridge);
    setTimeout(() => this.arrived.delete(providerCallId), ARRIVAL_TTL_MS);
  }

  private release(providerCallId: string): void {
    this.active.delete(providerCallId);
    this.arrived.delete(providerCallId);
    const waiter = this.waiters.get(providerCallId);
    if (waiter) {
      // BUGFIX: previously this only cleared the timeout and deleted the
      // waiter entry, leaving its promise unresolved — a WS that closes
      // while /internal/start-runtime is concurrently awaiting this exact
      // providerCallId's bridge would hang for the full timeoutMs (up to
      // DEFAULT_BRIDGE_TIMEOUT_MS) before resolving null, instead of failing
      // fast the moment it's known no bridge is coming.
      clearTimeout(waiter.timeout);
      this.waiters.delete(providerCallId);
      waiter.resolve(null);
    }
  }

  private awaitBridge(providerCallId: string, timeoutMs: number): Promise<AudioMediaBridge | null> {
    const already = this.arrived.get(providerCallId);
    if (already) {
      this.arrived.delete(providerCallId);
      return Promise.resolve(already);
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(providerCallId);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(providerCallId, { resolve: (bridge) => resolve(bridge), timeout });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Internal RPC surface — called from the ambient Worker (the webhook   */
  /* route and telephony-runtime.ts) via the CALL_SESSION binding.        */
  /* ------------------------------------------------------------------ */

  private async handleStartRuntime(request: Request): Promise<Response> {
    const body = (await request.json()) as StartRuntimeRpcInput;
    const requestedTimeoutMs = body.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
    // Diagnostic requirement 3 (was the DO/runtime session even reached?):
    // this fires the instant the RPC body is parsed — before the bridge
    // wait, before startRuntimeSession — so it's present in the logs even
    // if everything after it fails or times out.
    console.info("call_session_do:start_runtime_received", {
      doId: this.state.id.toString(),
      callId: body.callId,
      requestedTimeoutMs,
    });

    // Idempotent: a duplicate "answered"/"in_progress" webhook event (or a
    // retried delivery) for a call whose runtime is already running must
    // not start a second one — startRuntimeSession is already idempotent
    // per call_id, but checking here too avoids an unnecessary bridge wait.
    const existing = getActiveSession(body.callId);
    if (existing) {
      console.info("call_session_do:start_runtime_already_active", {
        callId: body.callId,
        state: existing.state,
      });
      return jsonResponse({
        handled: existing.state !== "failed",
        note: `Voice runtime already running (runtime session ${existing.runtimeSessionId}).`,
      } satisfies AgentRuntimeRpcResult);
    }

    // Diagnostic requirement 5 (the exact reason a timeout resolves false):
    // waitedMs distinguishes "the bridge was never going to arrive" (waited
    // the full requestedTimeoutMs) from "arrived just barely too late" —
    // both currently produce the same {handled:false} result, but they
    // point at different next steps (the former: nothing ever validated on
    // the media-stream side for this CallSid at all; the latter: the
    // timeout window itself may be too short for real-world latency).
    const bridgeWaitStarted = Date.now();
    const bridge = await this.awaitBridge(body.providerCallId, requestedTimeoutMs);
    const waitedMs = Date.now() - bridgeWaitStarted;
    if (!bridge) {
      console.error("call_session_do:start_runtime_no_bridge", {
        callId: body.callId,
        requestedTimeoutMs,
        waitedMs,
      });
      return jsonResponse({
        handled: false,
        note: "The provider does not expose a live audio channel yet — the runtime cannot start without one.",
      } satisfies AgentRuntimeRpcResult);
    }
    console.info("call_session_do:start_runtime_bridge_found", {
      callId: body.callId,
      waitedMs,
    });

    // Diagnostic requirement 4 (were Sarvam STT/LLM/TTS connections even
    // attempted?): this log marks the exact point control passes into
    // voice-runtime.server.ts's startRuntimeSession, whose own
    // tts_connect_failed/stt_connect_failed/tts_connected/stt_connected/
    // greeting_failed logs (unchanged by this fix — already comprehensive)
    // cover everything from here on. If this log is present but none of
    // those follow it, startRuntimeSession itself hung or threw somewhere
    // this call site's own try/catch (routeToAgentRuntime, one layer up)
    // would still have caught.
    console.info("call_session_do:starting_voice_runtime", { callId: body.callId });
    const handle = await startRuntimeSession({
      callId: body.callId,
      organizationId: body.organizationId,
      businessId: body.businessId,
      agentConfigId: body.agentConfigId,
      agentVersion: body.agentVersion,
      instructions: body.instructions,
      snapshotAgent: body.snapshotAgent,
      businessName: body.businessName,
      bridge,
    });

    console.info("call_session_do:start_runtime_completed", {
      callId: body.callId,
      state: handle.state,
    });
    return jsonResponse({
      handled: handle.state !== "failed",
      note:
        handle.state === "failed"
          ? "The voice runtime failed to start — see server logs for the specific STT/TTS connection error."
          : `Voice runtime started (runtime session ${handle.runtimeSessionId}).`,
    } satisfies AgentRuntimeRpcResult);
  }

  private async handleTerminateRuntime(request: Request): Promise<Response> {
    const body = (await request.json()) as { callId: string; reason: string };
    // terminateRuntimeSession is itself idempotent (a second call for an
    // already-ending/ended/nonexistent session is a documented no-op).
    await terminateRuntimeSession(body.callId, body.reason);
    return jsonResponse({ ok: true });
  }

  private handleStatus(url: URL): Response {
    const callId = url.searchParams.get("callId");
    if (!callId) return new Response("Missing callId", { status: 400 });
    const session = getActiveSession(callId);
    return jsonResponse({ active: session !== null, state: session?.state ?? null });
  }
}
