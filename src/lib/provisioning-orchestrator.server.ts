import type { ProvisioningState } from "./provisioning-state.ts";

/**
 * The result shape every provisioning attempt reports (provisioning-pipeline.server.ts,
 * stored by provisioning-runs.server.ts).
 *
 * The older payment-time orchestrator that lived here claimed a number, created its
 * deployment and marked it active without any verification. Nothing called it and it was
 * removed: numbers are activated only by the pipeline, after verification.
 */

export interface ProvisionOrganizationResult {
  organizationId: string;
  phoneNumberId: string | null;
  numberClaimedNow: boolean;
  deploymentCreatedNow: boolean;
  note: string;
  /** The seven-state machine-readable status (Task list item 7) — see provisioning-state.ts. */
  state: ProvisioningState;
  /** The Sarvam deployment the number is on, when one is on file or was created now. */
  deploymentId?: string | null;
}
