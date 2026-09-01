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
          const { data, error } = await supabase.rpc("feature_locked", { _org: orgId!, _feature: feature.key });
          if (error) throw error;
          return [feature.key, data !== false] as const;
        }),
      );
      return Object.fromEntries(entries);
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
