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

  return { overall: computeOverallReadiness(checks), checks };
}
