import type { AudioMediaBridge } from "./audio-bridge";

/**
 * Correlates Vobiz's *inbound* media WebSocket connection (Vobiz connects to
 * us, per the `<Stream>` Voice XML element — see vobiz-provider.ts's module
 * doc) with the webhook/answer-route's call to
 * `adapter.openMediaBridge(providerCallId)`. Same short-lived, in-memory,
 * per-process rendezvous as exotel-media-registry.server.ts, kept as its
 * own module (rather than shared) so the two providers' duplicate-
 * connection guards and arrival queues can never cross-contaminate — see
 * that file's own doc for the full rationale, which applies identically
 * here.
 */

interface PendingWaiter {
  resolve: (bridge: AudioMediaBridge) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const waiters = new Map<string, PendingWaiter>();
const arrived = new Map<string, AudioMediaBridge>();
const active = new Set<string>();

const ARRIVAL_TTL_MS = 30_000;

/** Called by `VobizTelephonyAdapter.openMediaBridge` while waiting for Vobiz's connection. */
export function awaitVobizMediaBridge(
  providerCallId: string,
  timeoutMs: number,
): Promise<AudioMediaBridge | null> {
  const already = arrived.get(providerCallId);
  if (already) {
    arrived.delete(providerCallId);
    return Promise.resolve(already);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      waiters.delete(providerCallId);
      resolve(null);
    }, timeoutMs);
    waiters.set(providerCallId, { resolve: (bridge) => resolve(bridge), timeout });
  });
}

/** Reserves this providerCallId for one media bridge. Returns false if one is already active. */
export function claimVobizMediaSession(providerCallId: string): boolean {
  if (active.has(providerCallId)) return false;
  active.add(providerCallId);
  return true;
}

/** Called by the media WS route once a connection has been fully authorized and claimed. */
export function registerVobizMediaBridge(providerCallId: string, bridge: AudioMediaBridge): void {
  const waiter = waiters.get(providerCallId);
  if (waiter) {
    clearTimeout(waiter.timeout);
    waiters.delete(providerCallId);
    waiter.resolve(bridge);
    return;
  }
  arrived.set(providerCallId, bridge);
  setTimeout(() => arrived.delete(providerCallId), ARRIVAL_TTL_MS);
}

/** Releases the duplicate-connection guard once a bridge closes, or if authorization failed before one was ever registered. */
export function releaseVobizMediaSession(providerCallId: string): void {
  active.delete(providerCallId);
  arrived.delete(providerCallId);
  const waiter = waiters.get(providerCallId);
  if (waiter) {
    clearTimeout(waiter.timeout);
    waiters.delete(providerCallId);
  }
}
