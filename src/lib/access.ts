import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PLATFORM_FEATURES, type FeatureLockMap } from "@/lib/features";

/**
 * Resolves which features are locked for an organization.
 *
 * The resolution happens in the database (`feature_locked`), which honours the
 * global payment-enforcement switch, the per-customer override and the
 * platform default — so the browser only ever *reflects* the decision. Server
 * functions re-check the same rule before doing anything privileged.
 */
export const featureLocksQuery = (orgId: string | undefined) =>
  queryOptions({
    queryKey: ["feature-locks", orgId],
    enabled: Boolean(orgId),
    staleTime: 30_000,
    queryFn: async (): Promise<FeatureLockMap> => {
      const entries = await Promise.all(
        PLATFORM_FEATURES.map(async (feature) => {
          const { data, error } = await supabase.rpc("feature_locked", {
            _org: orgId!,
            _feature: feature.key,
          });
          if (error) throw error;
          return [feature.key, data !== false] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  });

/**
 * The raw admin override row for the 'dashboard' feature, distinct from
 * `featureLocksQuery`'s collapsed feature_locked() boolean.
 *
 * feature_locked() cannot distinguish "admin explicitly unlocked dashboard"
 * from "no override at all" for this one feature — both return `false` (see
 * 20260907090000_enforce_lifecycle_gate_before_feature_defaults.sql's
 * comment on why 'dashboard' skips the lifecycle gate). isDashboardLocked
 * (src/lib/dashboard-access.ts) needs that distinction to correctly bypass
 * the setup-payment screen only when there is a real, explicit unlock —
 * never as an accidental side effect of the platform default. Reads the
 * same organization_feature_locks table the admin "Feature access" panel
 * already writes to (RLS: "members read own locks" already permits this —
 * no policy change needed).
 */
export const dashboardOverrideQuery = (orgId: string | undefined) =>
  queryOptions({
    queryKey: ["dashboard-override", orgId],
    enabled: Boolean(orgId),
    staleTime: 30_000,
    queryFn: async (): Promise<boolean | null> => {
      const { data, error } = await supabase
        .from("organization_feature_locks")
        .select("locked")
        .eq("organization_id", orgId!)
        .eq("feature", "dashboard")
        .maybeSingle();
      if (error) throw error;
      return data?.locked ?? null;
    },
  });

export const paymentEnforcementQuery = () =>
  queryOptions({
    queryKey: ["payment-enforcement"],
    staleTime: 30_000,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from("platform_settings")
        .select("value")
        .eq("key", "billing.payment_required")
        .maybeSingle();
      if (error) throw error;
      return Boolean((data?.value as { enabled?: boolean } | null)?.enabled ?? true);
    },
  });
