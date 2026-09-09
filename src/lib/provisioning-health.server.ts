import { checkFeatureAccess } from "./feature-gate.server.ts";

/**
 * The single authoritative "is this customer actually ready to be ACTIVE"
 * check. Reused by handoverClient (admin-clients.functions.ts) as a hard
 * gate, and exposed read-only via getProvisioningReadiness so the admin UI
 * can show the customer's real status before anyone clicks "Hand over" —
 * one check, two callers, no parallel readiness logic.
 *
 * Every check re-derives its answer from the database/existing resolvers on
 * each call (feature_locked() via checkFeatureAccess, not a cached value),
 * matching the rest of this codebase's "server is authoritative, nothing
 * cached" convention.
 *
 * "fail" checks block ACTIVE (overall: "blocked"). "warning" checks do not
 * block — they cover infrastructure that is real but not yet fully wired
 * into an automated health signal (Sarvam deployment mapping, webhook
 * delivery health), so an admin can still hand over a customer using a
 * different provider or a still-manual step without a false block, while
 * still seeing the gap. Never claim a check passed without actually running
 * the query behind it.
 */

export type ProvisioningCheckStatus = "pass" | "warning" | "fail";

export interface ProvisioningCheck {
  key: string;
  label: string;
  status: ProvisioningCheckStatus;
  detail: string;
}

export interface ProvisioningReadiness {
  overall: "healthy" | "warning" | "blocked";
  checks: ProvisioningCheck[];
}

/** Pure precedence rule, exported so it's independently unit-testable without a database. */
export function computeOverallReadiness(
  checks: ProvisioningCheck[],
): ProvisioningReadiness["overall"] {
  if (checks.some((c) => c.status === "fail")) return "blocked";
  if (checks.some((c) => c.status === "warning")) return "warning";
  return "healthy";
}

export async function checkProvisioningReadiness(orgId: string): Promise<ProvisioningReadiness> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("lifecycle_status, setup_paid_at, payment_override")
    .eq("id", orgId)
    .maybeSingle();

  if (!org) {
    return {
      overall: "blocked",
      checks: [
        {
          key: "workspace",
          label: "Workspace",
          status: "fail",
          detail: "Customer workspace not found.",
        },
      ],
    };
  }

  const checks: ProvisioningCheck[] = [
    { key: "workspace", label: "Workspace", status: "pass", detail: "Workspace exists." },
  ];

  const isLocked =
    org.lifecycle_status === "suspended" ||
    org.lifecycle_status === "cancelled" ||
    org.lifecycle_status === "archived";
  checks.push({
    key: "lock",
    label: "Not locked",
    status: isLocked ? "fail" : "pass",
    detail: isLocked
      ? `Customer lifecycle is "${org.lifecycle_status}" — cannot activate.`
      : "Customer is not locked, cancelled, or archived.",
  });

  const setupSatisfied = Boolean(org.setup_paid_at) || org.payment_override === true;
  checks.push({
    key: "payment",
    label: "Setup payment",
    status: setupSatisfied ? "pass" : "fail",
    detail: setupSatisfied
      ? org.payment_override
        ? "Admin payment override is set for this customer."
        : "Setup payment has been verified."
      : "Setup payment has not been verified and no admin payment override is set.",
  });

  const { count: memberCount } = await supabaseAdmin
    .from("organization_members")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  const hasMember = Boolean(memberCount && memberCount > 0);
  checks.push({
    key: "membership",
    label: "Membership",
    status: hasMember ? "pass" : "fail",
    detail: hasMember
      ? "At least one user has joined this workspace."
      : "No one has accepted an invitation to this workspace yet.",
  });

  const [phoneGate, dashboardGate] = await Promise.all([
    checkFeatureAccess(orgId, "phone"),
    checkFeatureAccess(orgId, "dashboard"),
  ]);
  const entitled = phoneGate.allowed && dashboardGate.allowed;
  checks.push({
    key: "entitlement",
    label: "Service entitlement",
    status: entitled ? "pass" : "fail",
    detail: entitled
      ? "Dashboard and phone service are unlocked for this customer."
      : [phoneGate.reason, dashboardGate.reason].filter(Boolean).join(" "),
  });

  const { data: numbers } = await supabaseAdmin
    .from("phone_numbers")
    .select("status, provider, provider_deployment_id")
    .eq("organization_id", orgId);
  const activeNumbers = (numbers ?? []).filter((n) => n.status === "active");
  checks.push({
    key: "phone",
    label: "Phone number",
    status: activeNumbers.length > 0 ? "pass" : "fail",
    detail:
      activeNumbers.length > 0
        ? `${activeNumbers.length} active phone number${activeNumbers.length === 1 ? "" : "s"}.`
        : "No active phone number is assigned to this customer.",
  });

  // Reuses the same "agent configured" signal workspace.ts's
  // agentStatusLabel() already uses for the customer-facing status pill
  // (active_version > 0 means at least one version has been published) —
  // not a new heuristic.
  const { data: agent } = await supabaseAdmin
    .from("agent_configs")
    .select("active_version")
    .eq("organization_id", orgId)
    .maybeSingle();
  const agentConfigured = Boolean(agent && agent.active_version && agent.active_version > 0);
  checks.push({
    key: "agent",
    label: "Agent configured",
    status: agentConfigured ? "pass" : "fail",
    detail: agentConfigured
      ? "An agent version has been published for this customer."
      : "No agent version has been published for this customer yet.",
  });

  // Warning, not a hard block: Sarvam deployment mapping is a newer,
  // provider-specific piece (see sarvam-admin.functions.ts), and Exotel
  // customers legitimately have no provider_deployment_id at all. Blocking
  // handover on this would regress every non-Sarvam customer.
  const sarvamNumbersMissingDeployment = activeNumbers.filter(
    (n) => n.provider === "sarvam" && !n.provider_deployment_id,
  );
  checks.push({
    key: "deployment",
    label: "Sarvam deployment",
    status: sarvamNumbersMissingDeployment.length > 0 ? "warning" : "pass",
    detail:
      sarvamNumbersMissingDeployment.length > 0
        ? "One or more active Sarvam numbers have no recorded deployment — inbound routing may not be configured."
        : "No active Sarvam number is missing a deployment mapping.",
  });

  // "Webhook" health has no real per-organization delivery signal yet
  // (webhook_events has no organization_id column — see the Phase 2
  // architecture review). The honest proxy available today is the
  // registered provider connection's own status/last_error
  // (telephony_connections), which is real data, not invented. Warning
  // only — never claimed HEALTHY without actually checking it, and never a
  // hard block since it isn't a structural provisioning gap.
  const providers = [...new Set((numbers ?? []).map((n) => n.provider))];
  let connectionCheck: ProvisioningCheck;
  if (providers.length === 0) {
    connectionCheck = {
      key: "connection",
      label: "Webhook / connection",
      status: "warning",
      detail: "No phone number is assigned yet, so no provider connection to check.",
    };
  } else {
    const { data: connections } = await supabaseAdmin
      .from("telephony_connections")
      .select("provider, status, last_error")
      .eq("organization_id", orgId)
      .in("provider", providers);
    const unhealthy = (connections ?? []).filter((c) => c.status !== "connected" || c.last_error);
    const missing = providers.filter((p) => !(connections ?? []).some((c) => c.provider === p));
    const problems = [
      ...unhealthy.map((c) => `${c.provider}: ${c.last_error ?? `status is "${c.status}"`}`),
      ...missing.map((p) => `${p}: no connection record`),
    ];
    connectionCheck = {
      key: "connection",
      label: "Webhook / connection",
      status: problems.length > 0 ? "warning" : "pass",
      detail:
        problems.length > 0
          ? `Provider connection issue(s): ${problems.join("; ")}.`
          : "Every provider this customer uses has a connected telephony_connections record.",
    };
  }
  checks.push(connectionCheck);

  // Wallet/billing health: real signals from wallet_transactions, never
  // fabricated. Two distinct concerns, both warning-only (operational
  // health, not a structural provisioning gap): "billing" flags a balance
  // that has gone negative (something charged more than it should have);
  // "wallet" flags running low, using the same admin-configured thresholds
  // admin.settings.tsx already exposes (billing.low_balance_threshold /
  // billing.critical_balance_threshold) rather than a new constant.
  const { data: walletRows } = await supabaseAdmin
    .from("wallet_transactions")
    .select("amount")
    .eq("organization_id", orgId);
  const walletBalance = (walletRows ?? []).reduce((s, t) => s + t.amount, 0);

  checks.push({
    key: "billing",
    label: "Billing",
    status: walletBalance < 0 ? "warning" : "pass",
    detail:
      walletBalance < 0
        ? `Wallet balance is negative (₹${(walletBalance / 100).toFixed(2)}) — review recent charges.`
        : "Wallet balance is not negative.",
  });

  const { data: thresholdSettings } = await supabaseAdmin
    .from("platform_settings")
    .select("key, value")
    .in("key", ["billing.low_balance_threshold", "billing.critical_balance_threshold"]);
  const thresholdMap = new Map(
    (thresholdSettings ?? []).map((s) => [s.key, (s.value as { amount?: number } | null)?.amount]),
  );
  const criticalThreshold = thresholdMap.get("billing.critical_balance_threshold");
  const lowThreshold = thresholdMap.get("billing.low_balance_threshold");
  let walletCheck: ProvisioningCheck;
  if (typeof criticalThreshold === "number" && walletBalance <= criticalThreshold) {
    walletCheck = {
      key: "wallet",
      label: "Wallet balance",
      status: "warning",
      detail: `Wallet balance (₹${(walletBalance / 100).toFixed(2)}) is at or below the critical threshold.`,
    };
  } else if (typeof lowThreshold === "number" && walletBalance <= lowThreshold) {
    walletCheck = {
      key: "wallet",
      label: "Wallet balance",
      status: "warning",
      detail: `Wallet balance (₹${(walletBalance / 100).toFixed(2)}) is at or below the low-balance threshold.`,
    };
  } else {
    walletCheck = {
      key: "wallet",
      label: "Wallet balance",
      status: "pass",
      detail:
        typeof lowThreshold === "number"
          ? `Wallet balance (₹${(walletBalance / 100).toFixed(2)}) is above the low-balance threshold.`
          : "No low-balance threshold is configured; balance is not negative.",
    };
  }
  checks.push(walletCheck);

  return { overall: computeOverallReadiness(checks), checks };
}
