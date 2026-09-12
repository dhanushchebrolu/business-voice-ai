/**
 * The seven machine-readable provisioning states (Task list item 7),
 * distinct from provisioning-status.ts's six customer-facing plain-English
 * labels: this is the admin/operational vocabulary, used by the
 * orchestrator's own result and the admin provisioning view, not shown to
 * customers. Same "pure function, structural input, zero @/-aliased
 * imports, directly testable" pattern as agent-status.ts/
 * provisioning-status.ts.
 */

export type ProvisioningState =
  | "waiting_for_credentials"
  | "waiting_for_agent"
  | "waiting_for_connection"
  | "waiting_for_number"
  | "provisioning"
  | "active"
  | "failed";

export interface ComputeProvisioningStateInput {
  /** Platform-wide: do SARVAM_INBOUND_VOICE_API_KEY/SARVAM_OUTBOUND_VOICE_API_KEY/SARVAM_ORG_ID/SARVAM_WORKSPACE_ID all resolve? (validateSarvamEnv().allPresent) */
  sarvamCredentialsConfigured: boolean;
  /** An explicit signal from the orchestrator's own structured result (e.g. its deployment-creation attempt threw) — never derived by string-matching a note. */
  lastAttemptFailed: boolean;
  hasNumber: boolean;
  numberActive: boolean;
  connectionLinked: boolean;
  agentSarvamMapped: boolean;
  inboundEnabled: boolean;
}

/**
 * Priority order, most authoritative first: platform-wide credential
 * absence blocks everything and is reported regardless of any
 * per-organization progress; a genuinely active, working number always
 * reports "active" even if some earlier attempt's failure note is still on
 * file (a stale failure is not the current truth once the number is
 * demonstrably live); an explicit failure signal is reported next; then
 * the three concrete "waiting on this one thing" states in the order
 * automatic provisioning actually resolves them (number, then connection,
 * then agent mapping); "provisioning" is the catch-all for "everything
 * needed is in place, activation is in flight."
 */
export function computeProvisioningState(input: ComputeProvisioningStateInput): ProvisioningState {
  if (!input.sarvamCredentialsConfigured) return "waiting_for_credentials";
  if (input.numberActive && input.inboundEnabled) return "active";
  if (input.lastAttemptFailed) return "failed";
  if (!input.hasNumber) return "waiting_for_number";
  if (!input.connectionLinked) return "waiting_for_connection";
  if (!input.agentSarvamMapped) return "waiting_for_agent";
  return "provisioning";
}
