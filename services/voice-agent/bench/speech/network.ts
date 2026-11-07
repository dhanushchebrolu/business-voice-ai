/**
 * Process-level network kill switch for the speech harness.
 *
 * `disableNetwork()` replaces every outbound primitive this process can use
 * with one that throws NetworkDisabledError before any socket is opened:
 * global fetch and WebSocket (undici), node:net / node:tls connections,
 * node:http / node:https / node:http2 requests and DNS lookups. Offline runs
 * (dry run, simulation) and the harness's tests install it, so a bug that
 * tried to reach Sarvam would fail loudly instead of spending money.
 *
 * `allowLoopback` lets tests talk to their own 127.0.0.1 fake servers; every
 * other host stays blocked. Native addons and child processes are outside
 * its reach (the harness uses neither).
 */
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

export class NetworkDisabledError extends Error {
  override name = "NetworkDisabledError";
  readonly api: string;
  readonly target: string;
  constructor(api: string, target: string) {
    super(`network disabled: ${api} to ${target} was blocked before connecting`);
    this.api = api;
    this.target = target;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Best-effort host of whatever a connect/request call was given (never throws). */
function hostOf(args: unknown[]): string {
  const a = args[0];
  try {
    if (typeof a === "string") {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) return new URL(a).hostname;
      if (a.startsWith("/") || a.startsWith("\\\\")) return "local-ipc"; // net.connect(path)
      return a; // dns.lookup(hostname)
    }
    if (typeof a === "number") return typeof args[1] === "string" ? args[1] : "localhost";
    if (a instanceof URL) return a.hostname;
    if (a && typeof a === "object") {
      const o = a as { host?: string; hostname?: string; path?: string; url?: string };
      if (o.url) return new URL(o.url).hostname;
      if (o.path && !o.host && !o.hostname && !String(o.path).startsWith("/")) return "local-ipc";
      return o.hostname ?? o.host ?? "localhost";
    }
  } catch {
    /* unparseable: treat as non-loopback */
  }
  return "unknown";
}

type Patch = { obj: Record<string, unknown>; key: string; original: unknown };

export interface NetworkGuard {
  /** Every attempt that was blocked (api and host; never URLs with query strings or headers). */
  readonly blocked: Array<{ api: string; target: string }>;
  restore(): void;
}

let active: NetworkGuard | null = null;

export function networkDisabled(): boolean {
  return active !== null;
}

export function disableNetwork(opts: { allowLoopback?: boolean } = {}): NetworkGuard {
  if (active) throw new Error("network guard already installed");
  const patches: Patch[] = [];
  const blocked: NetworkGuard["blocked"] = [];
  const allow = (target: string) =>
    !!opts.allowLoopback && (LOOPBACK.has(target) || target === "local-ipc");

  const wrap = (obj: object, key: string, api: string) => {
    const o = obj as Record<string, unknown>;
    const original = o[key];
    if (typeof original !== "function") return;
    patches.push({ obj: o, key, original });
    o[key] = function (this: unknown, ...args: unknown[]) {
      const target = hostOf(args);
      if (allow(target)) return (original as (...a: unknown[]) => unknown).apply(this, args);
      blocked.push({ api, target });
      throw new NetworkDisabledError(api, target);
    };
  };

  for (const k of ["connect", "createConnection"]) wrap(net, k, `net.${k}`);
  wrap(tls, "connect", "tls.connect");
  for (const k of ["request", "get"]) {
    wrap(http, k, `http.${k}`);
    wrap(https, k, `https.${k}`);
  }
  wrap(http2, "connect", "http2.connect");
  for (const k of ["lookup", "resolve", "resolve4", "resolve6"]) wrap(dns, k, `dns.${k}`);
  for (const k of ["lookup", "resolve", "resolve4", "resolve6"])
    wrap(dns.promises, k, `dns.promises.${k}`);

  // Global fetch / WebSocket (undici) do not go through node:net's exports.
  const g = globalThis as unknown as Record<string, unknown>;
  const realFetch = g.fetch as typeof fetch;
  patches.push({ obj: g, key: "fetch", original: realFetch });
  g.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = hostOf([typeof input === "string" || input instanceof URL ? input : input.url]);
    if (allow(target)) return realFetch(input, init);
    blocked.push({ api: "fetch", target });
    throw new NetworkDisabledError("fetch", target);
  }) as typeof fetch;
  const RealWebSocket = g.WebSocket as typeof WebSocket | undefined;
  if (RealWebSocket) {
    patches.push({ obj: g, key: "WebSocket", original: RealWebSocket });
    g.WebSocket = new Proxy(RealWebSocket, {
      construct(Target, args: unknown[]) {
        const target = hostOf([String(args[0])]);
        if (allow(target)) return Reflect.construct(Target, args);
        blocked.push({ api: "WebSocket", target });
        throw new NetworkDisabledError("WebSocket", target);
      },
    });
  }

  // Named ESM imports of built-ins (`import { connect } from "node:net"`) see the patches too.
  syncBuiltinESMExports();
  const guard: NetworkGuard = {
    blocked,
    restore() {
      for (const p of patches.reverse()) p.obj[p.key] = p.original;
      patches.length = 0;
      syncBuiltinESMExports();
      active = null;
    },
  };
  active = guard;
  return guard;
}
