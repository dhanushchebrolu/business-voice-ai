import type { LifecycleStatus } from "@/lib/lifecycle";

/**
 * The single, shared rule for "can this customer reach their dashboard" —
 * used by both the public navbar (whether to show the Dashboard button) and
 * the /app route itself (whether to render the real workspace or the
 * setup/suspended screen). Having one function instead of two independently
 * hand-rolled checks is the fix for the bug this module exists for: the
 * navbar and the route used to disagree about what "has dashboard access"
 * means, and neither of them honored an explicit admin override correctly.
 *
 * Precedence (highest wins), mirroring feature_locked()'s own precedence in
 * supabase/migrations/20260902080000_phase_b_entitlements_and_payment_control.sql
 * and 20260907090000_enforce_lifecycle_gate_before_feature_defaults.sql:
 *
 *   1. Customer-level lock (suspended/cancelled/archived) -> always locked.
 *   2. Explicit admin lock for the 'dashboard' feature
 *      (organization_feature_locks.locked = true) -> locked.
 *   3. Explicit admin UNLOCK for 'dashboard'
 *      (organization_feature_locks.locked = false) -> NOT locked, even
 *      during the normal pre-payment setup window. This is what Phase B's
 *      "Feature access" admin panel promises ("Unlocked features are free
 *      for this customer, overriding the platform default") and what the
 *      feature_locked() RPC itself does for every other feature — but for
 *      'dashboard' specifically, feature_locked() cannot distinguish this
 *      explicit-unlock case from its own default (both return `false`, see
 *      those migrations' comments on why 'dashboard' is excluded from the
 *      lifecycle gate), so this function reads the raw
 *      organization_feature_locks row instead of the RPC's collapsed
 *      boolean for this one decision.
 *   4. Otherwise: the existing setup-payment gate — not_provisioned or
 *      setup_payment_pending blocks the real dashboard (shows the
 *      setup/payment screen instead) unless organizations.payment_override
 *      is set (the existing, audited per-customer demo/override mechanism —
 *      see setPaymentOverride in admin-clients.functions.ts). Every other
 *      lifecycle state (setup_paid, provisioning, ready, active) is
 *      unlocked.
 *
 * No fake payment, invoice, subscription, or lifecycle_status write is ever
 * involved in any of this — every input here is already-existing data, read
 * as-is.
 */
export interface DashboardAccessInput {
  /** null/undefined when the caller has no organization at all (no workspace has been provisioned for them). */
  lifecycleStatus: LifecycleStatus | null | undefined;
  /** organizations.payment_override for this org. */
  paymentOverride: boolean | null | undefined;
  /**
   * The raw `locked` value of the organization's organization_feature_locks
   * row for feature = 'dashboard'. `true` = explicit lock, `false` =
   * explicit unlock/override, `null`/`undefined` = no row (no override set).
   */
  dashboardOverride: boolean | null | undefined;
}

export function isDashboardLocked({
  lifecycleStatus,
  paymentOverride,
  dashboardOverride,
}: DashboardAccessInput): boolean {
  // No organization at all — nothing to show, regardless of any override
  // (an override row is itself scoped to an organization_id, so this state
  // never has a meaningful dashboardOverride value in practice either).
  if (lifecycleStatus == null) return true;

  const customerLocked =
    lifecycleStatus === "suspended" ||
    lifecycleStatus === "cancelled" ||
    lifecycleStatus === "archived";
  if (customerLocked) return true;

  if (dashboardOverride === true) return true;
  if (dashboardOverride === false) return false;

  const setupPending =
    lifecycleStatus === "not_provisioned" || lifecycleStatus === "setup_payment_pending";
  return setupPending && !paymentOverride;
}
