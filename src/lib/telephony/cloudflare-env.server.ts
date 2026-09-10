/**
 * Minimal, dependency-free Cloudflare Workers/Durable Object type surface
 * and accessor.
 *
 * This project does not depend on `@cloudflare/workers-types` (see the
 * existing runtime-feature-detection style in exotel-media-route.server.ts,
 * which checks for `globalThis.WebSocketPair` rather than typing against a
 * types package) — this file follows the same convention: just enough
 * structural typing to describe the Durable Object binding this module
 * needs, nothing more.
 *
 * `getCloudflareEnv()` reads `globalThis.__env__`, which Nitro's
 * cloudflare-module preset itself sets on every incoming request
 * (`node_modules/nitro/dist/presets/cloudflare/runtime/_module-handler.mjs`:
 * `globalThis.__env__ = env`) specifically so that code nested deep inside
 * the request-handling stack — far below the raw `fetch(request, env, ctx)`
 * signature — can still reach the platform's bindings. This is not a
 * workaround; it is Nitro's own documented mechanism for this exact
 * problem, and this project's `src/server.ts` (itself wrapped by that same
 * Nitro handler) receives the identical `env` object as its own `fetch`
 * parameter, so both access paths agree.
 *
 * Env bindings are deployment-wide and identical for every request to the
 * same Worker, so reading this global from anywhere during request handling
 * is safe — it is never request-specific, unlike request/response state.
 */

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface CloudflareEnv {
  /** Binding name configured in wrangler.json for CallSessionDurableObject. */
  CALL_SESSION?: DurableObjectNamespace;
}

/**
 * Returns the live Cloudflare env bindings for the current deployment, or
 * `null` when running somewhere that doesn't provide them (local `vite dev`,
 * the Node test runner, or a Cloudflare deployment that hasn't been
 * configured with the CALL_SESSION Durable Object binding yet). Every
 * caller in this codebase must treat `null` as "fall back to the
 * pre-existing in-process behavior" — never as an error — so that local
 * development and tests keep working exactly as before this change.
 */
export function getCloudflareEnv(): CloudflareEnv | null {
  const env = (globalThis as { __env__?: unknown }).__env__;
  return env && typeof env === "object" ? (env as CloudflareEnv) : null;
}

/** The one Durable Object instance every Exotel media call is coordinated through. */
export function getCallSessionStub(): DurableObjectStub | null {
  const env = getCloudflareEnv();
  const namespace = env?.CALL_SESSION;
  if (!namespace) return null;
  return namespace.get(namespace.idFromName(CALL_SESSION_COORDINATOR_NAME));
}

/**
 * Exotel's Voicebot Applet WSS URL is configured once, statically, in the
 * Exotel dashboard's call-flow (see exotel-media-route.server.ts) — it is
 * NOT dynamically generated per call, so the inbound WebSocket upgrade
 * request carries no per-call identity the Worker could use to address a
 * per-call Durable Object *before* accepting the connection. The call's
 * CallSid is only known once the socket's first ("start") message arrives.
 *
 * Given that hard constraint, this uses ONE fixed-name Durable Object
 * instance as the durable coordinator for every in-flight Exotel media
 * call, rather than one instance per call_id. All per-call isolation is
 * still deterministic and keyed by call_id/providerCallId *within* that one
 * instance (see call-session-durable-object.server.ts) — the instance
 * itself is shared by necessity, not by choice; a genuinely per-call
 * Durable Object would require Exotel to embed the CallSid in the
 * WebSocket URL itself, which this codebase does not control.
 */
export const CALL_SESSION_COORDINATOR_NAME = "exotel-call-session-coordinator";
