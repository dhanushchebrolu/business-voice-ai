/**
 * How the speech clients reach Sarvam. Clients only ever see a `Transport`:
 *  - live: global fetch / WebSocket (both honour HTTPS_PROXY with
 *    NODE_USE_ENV_PROXY=1, verified in this environment), wrapped in the
 *    same auth guard as the LLM adapter (src/agent/sarvam-llm.ts, imported,
 *    not modified): exactly the credential headers the auth mode allows,
 *    and only https/wss://api.sarvam.ai;
 *  - offline: the in-process fake (fake-sarvam.ts), with the process-wide
 *    network kill switch (network.ts) installed as well.
 */
import {
  sarvamAuthGuard,
  sarvamAuthProblems,
  type SarvamAuth,
} from "../../src/agent/sarvam-llm.ts";

/** The subset of the WHATWG WebSocket the clients use (Node's global WebSocket and the fake both fit). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", fn: () => void): void;
  addEventListener(type: "message", fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", fn: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", fn: (ev: unknown) => void): void;
}

export interface Transport {
  readonly name: "live" | "fake";
  fetch: typeof fetch;
  openSocket(url: string, headers: Record<string, string>): SocketLike;
}

export const SARVAM_API = "https://api.sarvam.ai";
export const SARVAM_WS = "wss://api.sarvam.ai";

/** The credential headers a request carries: the key once in api-key mode; none in proxy-injected mode. */
export function authHeaders(auth: SarvamAuth): Record<string, string> {
  return auth.mode === "api-key" ? { "api-subscription-key": auth.apiKey } : {};
}

export class AuthGuardError extends Error {
  override name = "AuthGuardError";
}

/** Same checks as the HTTP guard, for a WebSocket URL (wss -> https for the host check). */
export function socketAuthProblems(
  auth: SarvamAuth,
  url: string,
  headers: Record<string, string>,
): string[] {
  const u = new URL(url);
  const problems: string[] = [];
  if (u.protocol !== "wss:") problems.push("WebSocket must be wss://");
  const asHttps = new URL(url.replace(/^wss:/, "https:"));
  problems.push(...sarvamAuthProblems(auth, asHttps, new Headers(headers)));
  if (u.hostname !== "api.sarvam.ai") problems.push("WebSocket host must be api.sarvam.ai");
  return [...new Set(problems)];
}

export function liveTransport(auth: SarvamAuth): Transport {
  const realFetch = globalThis.fetch;
  const RealWebSocket = globalThis.WebSocket;
  const guarded = sarvamAuthGuard(auth, realFetch);
  return {
    name: "live",
    fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (typeof input !== "string" && !(input instanceof URL))
        throw new AuthGuardError("speech harness passes URLs, not Request objects");
      const url = new URL(typeof input === "string" ? input : input.href);
      if (url.protocol !== "https:" || url.hostname !== "api.sarvam.ai")
        throw new AuthGuardError("speech harness only calls https://api.sarvam.ai");
      // Never follow a redirect: a 3xx to another host would re-send the request
      // (and, for 307/308, its body) to a destination that is not api.sarvam.ai.
      return guarded(url.href, { ...init, redirect: "error" });
    }) as typeof fetch,
    openSocket(url, headers) {
      const problems = socketAuthProblems(auth, url, headers);
      if (problems.length) throw new AuthGuardError(`socket not opened: ${problems.join("; ")}`);
      // Node's WebSocket accepts { headers } (undici); it is not in the DOM typings.
      const Ctor = RealWebSocket as unknown as new (
        u: string,
        o: { headers: Record<string, string> },
      ) => SocketLike;
      return new Ctor(url, { headers });
    },
  };
}

/** Removes a secret from any string that leaves the process (logs, results, reports). */
export function redactor(secrets: string[]): (s: string) => string {
  const live = secrets.filter((x) => x && x.length >= 6);
  return (s: string) => live.reduce((acc, k) => acc.split(k).join("[REDACTED]"), s);
}
