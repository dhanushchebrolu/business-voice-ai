import type { AudioMediaBridge } from "./audio-bridge";

/**
 * Correlates Exotel's *inbound* media WebSocket connection (Exotel connects
 * to us — see the Phase D.1 report §6/§20) with the call-status webhook's
 * call to `adapter.openMediaBridge(providerCallId)` (Phase E calls that
 * expecting something *returned to it*, not something it dials out for).
 * These are two independent events on two independent channels that can
 * arrive in either order — the webhook's "answered" event and Exotel's own
 * WS connection attempt are not synchronized with each other — so this is
 * a short-lived, in-memory rendezvous point, keyed by `providerCallId`
 * (Exotel's CallSid), not a queue or a persistence layer.
 *
 * Ephemeral and per-process, exactly like `voice-runtime.server.ts`'s
 * `activeSessions` map — acceptable for the same reason: a single call's
 * media bridge only ever needs to be visible within the one process
 * instance that is actually holding that WebSocket open.
 */

interface PendingWaiter {
  resolve: (bridge: AudioMediaBridge) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const waiters = new Map<string, PendingWaiter>();
const arrived = new Map<string, AudioMediaBridge>();
/** providerCallIds with a bridge currently claimed (registered and not yet closed) — the actual duplicate-connection guard (spec §18). */
const active = new Set<string>();

const ARRIVAL_TTL_MS = 30_000;

/** Called by `ExotelTelephonyAdapter.openMediaBridge` while waiting for Exotel's connection. */
export function awaitMediaBridge(
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

/**
 * Reserves this providerCallId for one media bridge. Returns false if one
 * is already active — the caller (the WS route) must reject the second
 * connection (close it) rather than ever handing it to the runtime.
 */
export function claimMediaSession(providerCallId: string): boolean {
  if (active.has(providerCallId)) return false;
  active.add(providerCallId);
  return true;
}

/** Called by the media WS route once a connection has been fully authorized and claimed. */
export function registerMediaBridge(providerCallId: string, bridge: AudioMediaBridge): void {
  const waiter = waiters.get(providerCallId);
  if (waiter) {
    clearTimeout(waiter.timeout);
    waiters.delete(providerCallId);
    waiter.resolve(bridge);
    return;
  }
  // The WS connection beat the webhook's openMediaBridge call — hold it
  // briefly rather than dropping it (per §21: the two channels must not
  // race each other incorrectly).
  arrived.set(providerCallId, bridge);
  setTimeout(() => arrived.delete(providerCallId), ARRIVAL_TTL_MS);
}

/** Releases the duplicate-connection guard once a bridge closes, or if authorization failed before one was ever registered. */
export function releaseMediaSession(providerCallId: string): void {
  active.delete(providerCallId);
  arrived.delete(providerCallId);
  const waiter = waiters.get(providerCallId);
  if (waiter) {
    clearTimeout(waiter.timeout);
    waiters.delete(providerCallId);
  }
}
