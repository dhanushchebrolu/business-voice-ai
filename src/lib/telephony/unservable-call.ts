import type { HangupOutcome, TelephonyProviderAdapter } from "./adapter.ts";

const HANGUP_RETRY_DELAYS_MS = [500, 1500];

/**
 * The provider's hang-up, retried when the failure is transient: the
 * provider could not be reached, or answered 5xx. A 4xx (credentials, a
 * malformed request) is not retried — it would fail the same way. With
 * <Stream keepCallAlive="true"> closing the media socket is not known to
 * end a Vobiz call, so this API is the one way the runtime ends it; one
 * dropped request must not leave the caller connected and billed.
 * At most three attempts. Rejects with the last error.
 */
export async function hangupWithRetry(
  adapter: Required<Pick<TelephonyProviderAdapter, "hangupCall">>,
  providerCallId: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<HangupOutcome> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await adapter.hangupCall(providerCallId);
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      const transient = typeof status !== "number" || status >= 500;
      const delay = HANGUP_RETRY_DELAYS_MS[attempt];
      if (!transient || delay === undefined) throw err;
      await sleep(delay);
    }
  }
}

/**
 * Ends a call this runtime can never serve (no business, or an agent whose
 * configuration is incomplete). For a provider that is already streaming
 * the call to us (Vobiz: vobiz-answer returned <Stream>), returning
 * `handled: false` alone left the caller connected to silence — billed —
 * until they gave up. Only these deterministic failures end the call here:
 * every other handoff for the same call would fail the same way, so no
 * concurrent attempt can be serving it. Providers without a hang-up API
 * (Exotel) are unchanged. Best effort: never throws.
 */
export async function endUnservableCall(
  adapter: Pick<TelephonyProviderAdapter, "hangupCall"> | null,
  providerCallId: string,
  callId: string,
  reason: "no_business" | "agent_config_incomplete",
): Promise<boolean> {
  if (!adapter?.hangupCall) return false;
  try {
    const outcome = await hangupWithRetry(
      { hangupCall: adapter.hangupCall.bind(adapter) },
      providerCallId,
    );
    console.info("telephony:unservable_call_hung_up", { callId, reason, outcome });
    return true;
  } catch (err) {
    console.error("telephony:unservable_call_not_hung_up", {
      callId,
      reason,
      message: (err as Error).message,
    });
    return false;
  }
}
