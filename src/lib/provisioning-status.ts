/**
 * Pure client-facing provisioning-status logic, mirrored from
 * agent-status.ts's own pattern (structural input type, zero `@/`-aliased
 * imports, directly unit-testable). This is the customer-safe translation
 * of everything the automatic provisioning orchestrator
 * (provisioning-orchestrator.server.ts) does behind the scenes into one of
 * six plain-English labels — never a raw Sarvam identifier, error string,
 * or internal field name. The six labels this function returns are exactly
 * the ones specified for the client dashboard: "Setting up your phone
 * agent", "Waiting for phone number", "Activating inbound calling",
 * "Inbound calling active", "Active", "Setup needs admin attention".
 *
 * Meant to be shown only while account_status is "setup_in_progress"
 * (lifecycle_status setup_paid/provisioning/ready — see the
 * account_status DB trigger, 20260902080000) or once it reaches "active";
 * for "payment_required"/"suspended"/"cancelled" the existing
 * ACCOUNT_STATUS_LABEL (workspace.ts) already covers it and should be
 * shown instead.
 */

export interface ProvisioningStatusInput {
  /** organizations.lifecycle_status */
  lifecycleStatus: string;
  /** Does this org have any non-released phone_numbers row at all? */
  hasNumber: boolean;
  /** Is the org's (primary) number's status === "active"? */
  numberActive: boolean;
  /**
   * Does the org's number have a Klyro telephony connection linked
   * (phone_numbers.connection_id set)? A connection row only ever exists
   * with a real Sarvam provider_connection_id already set (both are
   * written together by registerTelephonyConnection), so this is a safe,
   * customer-facing proxy for "an admin has completed the Sarvam
   * connection setup" — the raw connection id itself is never exposed.
   */
  connectionLinked: boolean;
  /** agent_configs.sarvam_app_id && sarvam_app_version both set. */
  agentSarvamMapped: boolean;
  inboundEnabled: boolean;
  outboundEnabled: boolean;
}

export interface ProvisioningStatus {
  label: string;
  tone: "live" | "ready" | "idle" | "error";
}

export function provisioningStatusLabel(input: ProvisioningStatusInput): ProvisioningStatus {
  const {
    lifecycleStatus,
    hasNumber,
    numberActive,
    connectionLinked,
    agentSarvamMapped,
    inboundEnabled,
    outboundEnabled,
  } = input;

  if (numberActive && inboundEnabled && outboundEnabled) {
    return { label: "Active", tone: "live" };
  }
  if (numberActive && inboundEnabled && !outboundEnabled) {
    // Outbound stays off until an admin enables it; never call that "ready".
    return { label: "Inbound calling active", tone: "live" };
  }

  if (hasNumber) {
    // Both connection registration and Sarvam app mapping are one-time,
    // manual Sarvam-dashboard steps an admin must complete — automatic
    // provisioning cannot do either itself (see the audit this work
    // started from). Stuck here for either reason is a real "needs a
    // human" state, not a transient "still working on it" one.
    if (!connectionLinked || !agentSarvamMapped) {
      return { label: "Setup needs admin attention", tone: "error" };
    }
    // Everything needed is in place — deployment creation and activation
    // happen automatically from here (either the next payment/retry
    // event, or already in flight).
    return { label: "Activating inbound calling", tone: "ready" };
  }

  // No number yet. Distinguish the very first moment after payment
  // (lifecycle_status is still exactly "setup_paid" — automatic
  // provisioning hasn't run or just started) from having already run and
  // found the pool empty (lifecycle_status has since advanced to
  // "provisioning"/"ready" but still no number — see
  // provisioning-orchestrator.server.ts, which only advances past
  // setup_paid once it has actually run).
  if (lifecycleStatus === "setup_paid") {
    return { label: "Setting up your phone agent", tone: "ready" };
  }
  return { label: "Waiting for phone number", tone: "ready" };
}

export interface CustomerSetupInput {
  /** The customer's agent row exists (onboarding saved the business and agent). */
  agentExists: boolean;
  /** agent_configs.sarvam_app_id && sarvam_app_version. */
  inboundAgentReady: boolean;
  /** agent_configs.sarvam_outbound_app_id && sarvam_outbound_app_version. */
  outboundAgentReady: boolean;
  hasNumber: boolean;
  numberActive: boolean;
  inboundEnabled: boolean;
  /** provisioningStatusLabel said "Setup needs admin attention". */
  needsAttention: boolean;
}

export type CustomerSetupStepStatus = "done" | "in_progress" | "attention" | "pending";

export interface CustomerSetupStep {
  label: string;
  status: CustomerSetupStepStatus;
}

/**
 * The customer's setup progress in plain words (dual-agent provisioning). No
 * Sarvam id, error text or internal field ever appears: only which step is
 * done, which one is under way, and whether the ClickAI team is needed. The
 * first unfinished step is "in_progress" (or "attention"); later ones are
 * "pending". Outbound calling itself is switched on separately by ClickAI.
 */
export function customerSetupSteps(i: CustomerSetupInput): CustomerSetupStep[] {
  const steps: [string, boolean][] = [
    ["Business information received", i.agentExists],
    ["Creating your inbound AI agent", i.inboundAgentReady],
    ["Creating your outbound AI agent", i.outboundAgentReady],
    ["Assigning your phone number", i.hasNumber],
    ["Connecting your phone line", i.numberActive && i.inboundEnabled],
  ];
  const allDone = steps.every(([, done]) => done);
  steps.push(["Ready", allDone]);
  let current = false;
  return steps.map(([label, done]) => {
    if (done) return { label, status: "done" as const };
    if (current) return { label, status: "pending" as const };
    current = true;
    return { label, status: i.needsAttention ? ("attention" as const) : ("in_progress" as const) };
  });
}
