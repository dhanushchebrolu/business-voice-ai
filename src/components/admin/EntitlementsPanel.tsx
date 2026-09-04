import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ShieldPlus, ShieldMinus } from "lucide-react";
import { grantEntitlement, revokeEntitlement } from "@/lib/admin-clients.functions";
import { PLATFORM_FEATURES } from "@/lib/features";
import { SectionCard, StatusPill, EmptyState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { ReasonDialog } from "@/components/admin/ReasonDialog";

export interface EntitlementRow {
  feature: string;
  source: "admin" | "subscription" | "trial" | "system";
  active: boolean;
  reason: string | null;
  granted_by_email: string | null;
  granted_at: string;
  revoked_at: string | null;
}

/**
 * The central entitlement system: which sources currently grant a customer
 * access to each feature. Multiple active sources can coexist for the same
 * feature (e.g. an admin grant AND a subscription) — revoking one never
 * touches the other. This is a read of `organization_entitlements`, not a
 * second lock mechanism; `organization_feature_locks` (below, in
 * ClientAccessPanel-adjacent UI) still wins over any entitlement here.
 */
export function EntitlementsPanel({
  orgId,
  entitlements,
  onChanged,
}: {
  orgId: string;
  entitlements: EntitlementRow[];
  onChanged: () => Promise<void> | void;
}) {
  const grant = useServerFn(grantEntitlement);
  const revoke = useServerFn(revokeEntitlement);

  const [grantTarget, setGrantTarget] = useState<{
    feature: string;
    label: string;
    source: "admin" | "subscription";
  } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{
    feature: string;
    label: string;
    source: "admin" | "subscription";
  } | null>(null);

  const activeByFeature = new Map<string, EntitlementRow[]>();
  for (const row of entitlements) {
    if (!row.active) continue;
    const list = activeByFeature.get(row.feature) ?? [];
    list.push(row);
    activeByFeature.set(row.feature, list);
  }

  return (
    <SectionCard
      title="Entitlements"
      description="Which sources currently grant access to each service. No payment, invoice or subscription is fabricated by a grant here — the grant itself is the record."
    >
      <ul className="divide-y divide-border">
        {PLATFORM_FEATURES.filter((f) => f.key !== "dashboard").map((feature) => {
          const active = activeByFeature.get(feature.key) ?? [];
          const hasAdmin = active.some((r) => r.source === "admin");
          const hasSub = active.some((r) => r.source === "subscription");
          return (
            <li
              key={feature.key}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="text-sm font-medium">{feature.label}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {active.length === 0 ? (
                    <span className="text-xs text-muted-foreground">No active entitlement</span>
                  ) : (
                    active.map((r) => (
                      <StatusPill key={r.source} tone="live">
                        {r.source}
                      </StatusPill>
                    ))
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={hasAdmin}
                  onClick={() =>
                    setGrantTarget({ feature: feature.key, label: feature.label, source: "admin" })
                  }
                >
                  <ShieldPlus className="mr-1.5 size-3.5" /> Grant (admin)
                </Button>
                {hasAdmin ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setRevokeTarget({
                        feature: feature.key,
                        label: feature.label,
                        source: "admin",
                      })
                    }
                  >
                    <ShieldMinus className="mr-1.5 size-3.5" /> Revoke admin grant
                  </Button>
                ) : null}
                {hasSub ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setRevokeTarget({
                        feature: feature.key,
                        label: feature.label,
                        source: "subscription",
                      })
                    }
                  >
                    <ShieldMinus className="mr-1.5 size-3.5" /> Revoke subscription
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {entitlements.length === 0 ? (
        <EmptyState
          title="No entitlement history"
          description="Grants and revocations for this customer will appear here."
        />
      ) : null}

      <ReasonDialog
        open={grantTarget !== null}
        onOpenChange={(open) => !open && setGrantTarget(null)}
        title={`Grant ${grantTarget?.label ?? ""} (${grantTarget?.source ?? ""})?`}
        description="No payment, invoice or subscription record is created. This grant alone is the record of why access exists."
        onConfirm={async (reason) => {
          await grant({
            data: { orgId, feature: grantTarget!.feature, source: grantTarget!.source, reason },
          });
          toast.success("Entitlement granted");
          setGrantTarget(null);
          await onChanged();
        }}
      />

      <ReasonDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title={`Revoke ${revokeTarget?.label ?? ""} (${revokeTarget?.source ?? ""})?`}
        description="Only this source is revoked. Any other source still granting this feature (e.g. an active subscription) is untouched."
        onConfirm={async (reason) => {
          await revoke({
            data: { orgId, feature: revokeTarget!.feature, source: revokeTarget!.source, reason },
          });
          toast.success("Entitlement revoked");
          setRevokeTarget(null);
          await onChanged();
        }}
      />
    </SectionCard>
  );
}
