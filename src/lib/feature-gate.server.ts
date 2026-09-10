import type { FeatureKey } from "./features.ts";
import { FEATURE_LABEL } from "./features.ts";

/**
 * Canonical server-side feature/entitlement gate.
 *
 * There is exactly one authorization resolver for "can this organization
 * use this feature right now": the `feature_locked(_org, _feature)`
 * Postgres function (see supabase/migrations/20260902080000_phase_b_
 * entitlements_and_payment_control.sql and 20260907090000_enforce_
 * lifecycle_gate_before_feature_defaults.sql for its precedence — customer
 * lock, explicit admin lock, active entitlement, admin unlock, payment
 * override / global enforcement, then the lifecycle gate before the
 * platform default). This module does not reimplement that precedence in
 * TypeScript — it only calls the RPC and interprets the boolean, exactly
 * like telephony-guard.server.ts's checkTelephonyAccess already did before
 * this file existed (that function now delegates its own "phone" check
 * here too, so there is a single place in the codebase that calls this
 * RPC).
 *
 * `orgId` must always come from a trusted, server-derived source (an RLS-
 * scoped row lookup keyed by the caller's own user_id, or an equivalent
 * membership check) — never from a client-supplied organizationId field,
 * or a customer could name another tenant's organization to probe or
 * bypass its gate. Every caller of this module is responsible for that;
 * this module only answers "is FEATURE locked for ORG", nothing about who
 * is asking.
 */

export interface FeatureGateResult {
  allowed: boolean;
  reason: string | null;
}

export interface FeatureRpcResult {
  data: boolean | null;
  error: { message: string } | null;
}

/**
 * The RPC call itself, isolated behind an injectable dependency purely so
 * checkFeatureAccess/assertFeatureUnlocked's branching (locked / unlocked /
 * RPC error) can be genuinely unit-tested without a live Supabase project —
 * this sandbox cannot reach one. The default implementation, used by every
 * real caller, is the exact same call telephony-guard.server.ts's
 * checkTelephonyAccess made directly before this file existed. This is the
 * same dependency-injection shape already established by
 * public-assistant.functions.ts's runPublicChat/runPublicVoiceTurn — not a
 * new pattern.
 */
async function callFeatureLockedRpc(orgId: string, feature: FeatureKey): Promise<FeatureRpcResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin.rpc("feature_locked", { _org: orgId, _feature: feature });
}

export async function checkFeatureAccess(
  orgId: string,
  feature: FeatureKey,
  rpc: (orgId: string, feature: FeatureKey) => Promise<FeatureRpcResult> = callFeatureLockedRpc,
): Promise<FeatureGateResult> {
  const { data: locked, error } = await rpc(orgId, feature);
  if (error) {
    return {
      allowed: false,
      reason: `Could not evaluate ${FEATURE_LABEL[feature] ?? feature} entitlement.`,
    };
  }
  if (locked) {
    return {
      allowed: false,
      reason: `${FEATURE_LABEL[feature] ?? feature} is not available for this workspace yet.`,
    };
  }
  return { allowed: true, reason: null };
}

/**
 * Throws a safe, generic Error (never leaking billing/provider/internal
 * detail — just which feature and that it's unavailable) when `feature` is
 * locked for `orgId`. Matches this codebase's existing convention for
 * authorization failures (assertPlatformAdmin, checkTelephonyAccess's
 * callers) — a plain thrown Error, not a typed result, since a locked
 * feature is an authorization failure, not a validation outcome the caller
 * is expected to branch on.
 */
export async function assertFeatureUnlocked(
  orgId: string,
  feature: FeatureKey,
  rpc?: (orgId: string, feature: FeatureKey) => Promise<FeatureRpcResult>,
): Promise<void> {
  const gate = await checkFeatureAccess(orgId, feature, rpc);
  if (!gate.allowed) {
    throw new Error(gate.reason ?? `${FEATURE_LABEL[feature] ?? feature} is not available.`);
  }
}
