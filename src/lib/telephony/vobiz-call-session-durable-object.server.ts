import type { AudioMediaBridge } from "./audio-bridge.ts";
import { VobizMediaBridge, type VobizSocketLike } from "./vobiz-media-bridge.server.ts";
import { authorizeMediaSession, maskCallSid } from "./media-session-authorization.server.ts";
import { VOBIZ_MEDIA_STREAM_PATH as MEDIA_STREAM_PATH } from "./vobiz-media-stream-path.ts";
import {
  startRuntimeSession,
  terminateRuntimeSession,
  getActiveSession,
  injectPaymentEvent,
  type StartRuntimeSessionInput,
} from "../voice-runtime.server.ts";

/**
 * Cloudflare Durable Object that makes Vobiz media-session correlation
 * durable across Worker isolates — the Vobiz counterpart of
 * call-session-durable-object.server.ts, built for the identical reason
 * (production audit finding E1, see that file's module doc): the answer
 * webhook (which calls routeToAgentRuntime -> this DO's /internal/start-runtime)
 * and the inbound media WebSocket upgrade (Vobiz's `<Stream>` element
 * connecting to us as a WS client) are two independent Worker requests with
 * no guarantee of landing on the same isolate. A plain Worker's in-process
 * Maps/Sets (vobiz-media-registry.server.ts) cannot bridge that gap; a
 * Durable Object can.
 *
 * This is a DEDICATED class, not a generalization of
 * CallSessionDurableObject, so that file and its binding/migration/tests
 * stay byte-for-byte unchanged — Exotel's production path carries zero risk
 * from this change. The two classes share no code at the class level; they
 * do share the already provider-neutral modules both depend on
 * (authorizeMediaSession, voice-runtime.server.ts's startRuntimeSession/
 * terminateRuntimeSession/getActiveSession/injectPaymentEvent) — reusing
 * those is what keeps this from being a second, independently-drifting copy
 * of the actual business logic; only the DO-instance bookkeeping
 * (claim/registerBridge/release/awaitBridge) and the Vobiz-specific
 * WebSocket protocol parsing are duplicated, and that duplication is
 * intentionally scoped to transport plumbing, never to authorization or
 * billing logic.
 *
 * Like Exotel's Voicebot Applet, Vobiz's `<Stream>` WSS URL carries no
 * reliable per-call identity at the transport layer the Worker could use to
 * address a per-call Durable Object before accepting the connection — the
 * callId is only known once the socket's first ("start") message arrives,
 * and a live WebSocket cannot be handed off between Durable Object
 * instances. This uses the same mitigation as Exotel: ONE fixed-name
 * coordinator instance (VOBIZ_CALL_SESSION_COORDINATOR_NAME, see
 * cloudflare-env.server.ts) for every in-flight Vobiz media call, with
 * per-call isolation fully contained within that one instance's
 * waiters/arrived/active maps, keyed by callId.
 *
 * No secrets are ever stored in Durable Object state. This class holds no
 * persistent storage at all (no `state.storage` calls) — every field below
 * is transient, call-scoped, in-memory instance state.
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

interface AcceptableSocket extends VobizSocketLike {
  accept(): void;
}
interface CloudflareWebSocketPair {
  0: AcceptableSocket;
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

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

export interface VobizStartRuntimeRpcInput {
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

export interface VobizAgentRuntimeRpcResult {
  handled: boolean;
  note: string;
}

export class VobizCallSessionDurableObject {
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
      if (url.pathname === "/internal/payment-event" && request.method === "POST") {
        return await this.handlePaymentEvent(request);
      }
      if (url.pathname === "/internal/status" && request.method === "GET") {
        return this.handleStatus(url);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("vobiz_call_session_do:unhandled_error", (err as Error).message);
      return new Response("Internal error", { status: 500 });
    }
  }

  /* ------------------------------------------------------------------ */
  /* WebSocket accept + Vobiz "start" event validation                    */
  /* (same shape/field names as vobiz-media-route.server.ts's               */
  /* handleFirstMessage, logic unchanged — only where it runs, and where   */
  /* claim/register state lives, has changed)                              */
  /* ------------------------------------------------------------------ */

  private async handleMediaUpgrade(request: Request, url: URL): Promise<Response> {
    if (url.pathname !== MEDIA_STREAM_PATH) return new Response("Not found", { status: 404 });

    const WebSocketPairCtor = getWebSocketPairCtor();
    if (!WebSocketPairCtor) {
      console.error("vobiz_call_session_do:websocketpair_unavailable");
      return new Response("WebSocket media transport is not available in this runtime.", {
        status: 501,
      });
    }

    const pair = new WebSocketPairCtor();
    const [server, client] = [pair[0], pair[1]];
    server.accept();
    console.info("vobiz_call_session_do:handshake_accepted", {
      doId: this.state.id.toString(),
      path: MEDIA_STREAM_PATH,
    });

    let settled = false;
    // Same buffering fix as Exotel's DO: authorization is several awaited
    // round trips deep, and Vobiz can start streaming "media" frames
    // immediately after "start" — without buffering, any frame arriving
    // during that window would be silently dropped.
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
          console.error(
            "vobiz_call_session_do:media_validation_crashed",
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
  ): Promise<VobizMediaBridge | null> {
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
    // Vobiz's "start" event carries its fields flat on the message itself
    // (not nested, unlike Exotel's) — same extraction as
    // vobiz-media-route.server.ts, the authoritative parsing for this
    // protocol in this codebase.
    const callId = firstDefinedString(msg, ["callId", "call_id", "CallId", "CallUUID"]);
    const streamId = firstDefinedString(msg, ["streamId", "stream_id", "StreamId"]);

    const reject = (reason: string): null => {
      console.error("vobiz_call_session_do:media_rejected", { reason });
      try {
        server.close(1008, "unauthorized");
      } catch {
        /* best-effort */
      }
      return null;
    };

    if (!callId) return reject("Missing callId on start event");

    // The actual callId -> call_logs correlation, status and entitlement
    // checks all live in the shared module also used by
    // vobiz-media-route.server.ts (the local-dev fallback path) — see that
    // module's doc for why sharing this matters. No optional token is read
    // here (unlike Exotel's equivalent path): Klyro never mints a
    // media-session token for Vobiz (mintMediaSessionToken is only ever
    // called from exotel.media-token.ts; buildVobizStreamXml embeds nothing
    // but the bare wss:// URL), so a top-level "token"/"session_token" field
    // in Vobiz's own "start" message can only ever be Vobiz's own,
    // unrelated data — reading it as Klyro's HMAC-signed token was
    // deterministically rejecting otherwise fully legitimate, correctly
    // call_logs-authorized calls (production incident). The callId lookup
    // and entitlement gate below remain the mandatory, unweakened baseline.
    const auth = await authorizeMediaSession("vobiz", callId, undefined);
    if (!auth.ok) return reject(auth.reason);

    if (!this.claim(callId))
      return reject(`A media session for callId ${maskCallSid(callId)} is already active`);

    const bridge = new VobizMediaBridge(server, streamId ?? callId, callId, (id) =>
      this.release(id),
    );
    this.registerBridge(callId, bridge);
    console.info("vobiz_call_session_do:media_accepted", {
      doId: this.state.id.toString(),
      callId: auth.callId,
      providerCallId: maskCallSid(callId),
      organizationId: auth.organizationId,
    });
    return bridge;
  }

  /* ------------------------------------------------------------------ */
  /* Instance-scoped rendezvous — same logic as                          */
  /* call-session-durable-object.server.ts's equivalents, kept in a       */
  /* separate class/instance so Vobiz and Exotel never share state.       */
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
    // briefly rather than dropping it, exactly like Exotel's DO.
    this.arrived.set(providerCallId, bridge);
    setTimeout(() => this.arrived.delete(providerCallId), ARRIVAL_TTL_MS);
  }

  private release(providerCallId: string): void {
    this.active.delete(providerCallId);
    this.arrived.delete(providerCallId);
    const waiter = this.waiters.get(providerCallId);
    if (waiter) {
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
  /* route and telephony-runtime.ts) via the VOBIZ_CALL_SESSION binding.  */
  /* ------------------------------------------------------------------ */

  private async handleStartRuntime(request: Request): Promise<Response> {
    const body = (await request.json()) as VobizStartRuntimeRpcInput;
    const requestedTimeoutMs = body.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
    console.info("vobiz_call_session_do:start_runtime_received", {
      doId: this.state.id.toString(),
      callId: body.callId,
      requestedTimeoutMs,
    });

    // Idempotent: a duplicate "answered"/"in_progress" webhook event (or a
    // retried delivery) for a call whose runtime is already running must
    // not start a second one.
    const existing = getActiveSession(body.callId);
    if (existing) {
      console.info("vobiz_call_session_do:start_runtime_already_active", {
        callId: body.callId,
        state: existing.state,
      });
      return jsonResponse({
        handled: existing.state !== "failed",
        note: `Voice runtime already running (runtime session ${existing.runtimeSessionId}).`,
      } satisfies VobizAgentRuntimeRpcResult);
    }

    const bridgeWaitStarted = Date.now();
    const bridge = await this.awaitBridge(body.providerCallId, requestedTimeoutMs);
    const waitedMs = Date.now() - bridgeWaitStarted;
    if (!bridge) {
      console.error("vobiz_call_session_do:start_runtime_no_bridge", {
        callId: body.callId,
        requestedTimeoutMs,
        waitedMs,
      });
      return jsonResponse({
        handled: false,
        note: "The provider does not expose a live audio channel yet — the runtime cannot start without one.",
      } satisfies VobizAgentRuntimeRpcResult);
    }
    console.info("vobiz_call_session_do:start_runtime_bridge_found", {
      callId: body.callId,
      waitedMs,
    });

    console.info("vobiz_call_session_do:starting_voice_runtime", { callId: body.callId });
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

    console.info("vobiz_call_session_do:start_runtime_completed", {
      callId: body.callId,
      state: handle.state,
    });
    return jsonResponse({
      handled: handle.state !== "failed",
      note:
        handle.state === "failed"
          ? "The voice runtime failed to start — see server logs for the specific STT/TTS connection error."
          : `Voice runtime started (runtime session ${handle.runtimeSessionId}).`,
    } satisfies VobizAgentRuntimeRpcResult);
  }

  private async handleTerminateRuntime(request: Request): Promise<Response> {
    const body = (await request.json()) as { callId: string; reason: string };
    // terminateRuntimeSession is itself idempotent (a second call for an
    // already-ending/ended/nonexistent session is a documented no-op).
    await terminateRuntimeSession(body.callId, body.reason);
    return jsonResponse({ ok: true });
  }

  /**
   * The "Durable Object RPC" leg of the payment event architecture for
   * Vobiz calls — same contract as CallSessionDurableObject's
   * handlePaymentEvent. {handled:false} means no active session exists for
   * this callId (already ended, or never started) — the documented,
   * expected ended-call fallback, not an error.
   */
  private async handlePaymentEvent(request: Request): Promise<Response> {
    const body = (await request.json()) as { callId: string; message: string };
    const result = await injectPaymentEvent(body.callId, body.message);
    console.info("vobiz_call_session_do:payment_event", {
      doId: this.state.id.toString(),
      callId: body.callId,
      handled: result.handled,
    });
    return jsonResponse(result);
  }

  private handleStatus(url: URL): Response {
    const callId = url.searchParams.get("callId");
    if (!callId) return new Response("Missing callId", { status: 400 });
    const session = getActiveSession(callId);
    return jsonResponse({ active: session !== null, state: session?.state ?? null });
  }
}
