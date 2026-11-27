import type { ProvisioningState } from "./provisioning-state.ts";

/**
 * What a customer sees about their number activation: a plain-language
 * status, never internal ids, notes or provider detail.
 */

export type CustomerActivationStatus =
  "live" | "in_progress" | "needs_setup" | "preparing" | "problem";

/** Plain-language status for the customer; never internal ids, notes or provider detail. */
export function customerActivationStatus(state: ProvisioningState | string | null): {
  status: CustomerActivationStatus;
  message: string;
} {
  if (state === "active") return { status: "live", message: "Your number is live." };
  if (state === "waiting_for_onboarding")
    return {
      status: "needs_setup",
      message: "Finish setting up your business (hours, services and details) first.",
    };
  if (state === "failed" || state === "verification_failed" || state === "manual_action_required")
    return {
      status: "problem",
      message: "Activation could not finish yet. Please contact the ClickAI team for help.",
    };
  return {
    status: "preparing",
    message: "The ClickAI team is preparing your number.",
  };
}
