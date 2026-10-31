import type { TelephonyProviderAdapter } from "./adapter.ts";

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
    const outcome = await adapter.hangupCall(providerCallId);
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
