import type { LifecycleStatus } from "./lifecycle";

/**
 * Pure customer-facing copy selection for a locked feature/service (H2).
 * Kept in its own `.ts` file, separate from ServiceLocked.tsx's JSX, so it
 * is directly unit-testable (this repo's test runner — Node's built-in
 * `node --test` — does not transform JSX).
 *
 * This module decides *wording only*. It never decides whether a feature
 * is actually locked (that's featureLocksQuery / the feature_locked()
 * Postgres function) and never decides whether an action is allowed
 * (that's assertFeatureUnlocked / checkTelephonyAccess, server-side). See
 * ServiceLocked.tsx's module doc for the full authorization-boundary note.
 *
 * Deliberately does not assume every lock means "payment required" (audit
 * item 10): pre-payment states get payment/setup copy, post-payment-but-
 * still-provisioning states get "being set up" copy, and an active
 * organization with a lock anyway (admin lock, missing entitlement, or the
 * platform default) gets a generic, non-billing "contact support" message
 * — the exact wording the audit specified. No branch here ever mentions
 * provider cost, an internal error, or which specific mechanism produced
 * the lock; that distinction is intentionally invisible to the customer.
 */

export interface LockMessage {
  title: string;
  description: string;
  cta?: { label: string; to: string };
}

export function lockMessageFor(lifecycle: LifecycleStatus, featureLabel: string): LockMessage {
  switch (lifecycle) {
    case "not_provisioned":
    case "setup_payment_pending":
      return {
        title: `${featureLabel} isn't available yet`,
        description:
          "This unlocks once your account's one-time setup payment is confirmed. Nothing is activated before that.",
        cta: { label: "Go to account setup", to: "/account" },
      };
    case "setup_paid":
    case "provisioning":
    case "ready":
      return {
        title: `${featureLabel} is still being set up`,
        description:
          "Our team is finishing provisioning your workspace. This unlocks automatically — no action needed from you.",
      };
    case "suspended":
    case "cancelled":
    case "archived":
      return {
        title: `${featureLabel} is unavailable`,
        description: "Your workspace access is currently on hold. Contact support for details.",
      };
    case "active":
    default:
      // Active, but locked anyway — an admin-set lock, a missing
      // entitlement, or the platform default, never distinguished to the
      // customer. Exact wording from the audit spec.
      return {
        title: `${featureLabel} is currently unavailable`,
        description: "This service is currently unavailable. Please contact support.",
      };
  }
}
