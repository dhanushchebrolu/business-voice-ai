import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { listPlatformSettings, updatePlatformSetting } from "@/lib/admin.functions";
import { PageHeader, SectionCard, LoadingState, ErrorState, StatusPill } from "@/components/app/primitives";
import { PLATFORM_FEATURES } from "@/lib/features";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReasonDialog } from "@/components/admin/ReasonDialog";

export const Route = createFileRoute("/admin/settings")({
  component: AdminSettings,
});

const NUMERIC_SETTINGS: { key: string; label: string; field: string; hint: string; rupees?: boolean }[] = [
  { key: "billing.grace_period_days", label: "Grace period", field: "days", hint: "Days after an overdue payment before services are suspended." },
  { key: "billing.low_balance_threshold", label: "Low balance warning", field: "amount", hint: "Wallet balance that triggers a warning.", rupees: true },
  { key: "billing.critical_balance_threshold", label: "Critical balance", field: "amount", hint: "Wallet balance that triggers a critical alert.", rupees: true },
];

function AdminSettings() {
  const fetchSettings = useServerFn(listPlatformSettings);
  const saveSetting = useServerFn(updatePlatformSetting);
  const queryClient = useQueryClient();
  const [featureTarget, setFeatureTarget] = useState<{ key: string; label: string; locked: boolean } | null>(null);
  const [numericTarget, setNumericTarget] = useState<(typeof NUMERIC_SETTINGS)[number] | null>(null);
  const [numericValue, setNumericValue] = useState("");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: () => fetchSettings(),
  });

  if (isLoading) return <LoadingState label="Loading platform settings" />;
  if (error) return <ErrorState message={error instanceof Error ? error.message : "Could not load settings"} onRetry={() => void refetch()} />;

  const map = new Map((data ?? []).map((s) => [s.key, s.value as Record<string, unknown>]));
  const enforcement = Boolean((map.get("billing.payment_required") as { enabled?: boolean } | undefined)?.enabled ?? true);
  const defaults = (map.get("features.defaults") ?? {}) as Record<string, boolean>;
  const autoSuspend = Boolean((map.get("billing.auto_suspend_enabled") as { enabled?: boolean } | undefined)?.enabled ?? true);

  return (
    <div className="space-y-6">
      <PageHeader title="Platform settings" description="Runtime configuration. Every value here is enforced server-side without a deployment." />

      <SectionCard
        title="Payment enforcement"
        description="Master switch for the whole platform."
        actions={<StatusPill tone={enforcement ? "live" : "idle"}>{enforcement ? "Enabled" : "Disabled"}</StatusPill>}
      >
        <p className="text-sm text-muted-foreground">
          Toggle this from the Overview page — it requires a confirmation and is recorded in the audit log.
        </p>
      </SectionCard>

      <SectionCard
        title="Default feature locks"
        description="Applied to every customer that has no individual override. Locked means the customer must pay to use it."
      >
        <ul className="divide-y divide-border">
          {PLATFORM_FEATURES.map((feature) => {
            const locked = defaults[feature.key] ?? true;
            return (
              <li key={feature.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">{feature.label}</p>
                  <p className="text-xs text-muted-foreground">{feature.description}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={locked ? "error" : "live"}>{locked ? "Locked" : "Unlocked"}</StatusPill>
                  <Button size="sm" variant="outline" onClick={() => setFeatureTarget({ key: feature.key, label: feature.label, locked: !locked })}>
                    {locked ? "Unlock for all" : "Lock for all"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <SectionCard title="Billing rules" description="Thresholds and timers used by suspension and notification logic.">
        <ul className="divide-y divide-border">
          {NUMERIC_SETTINGS.map((setting) => {
            const raw = (map.get(setting.key) ?? {}) as Record<string, number>;
            const value = raw[setting.field];
            return (
              <li key={setting.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">{setting.label}</p>
                  <p className="text-xs text-muted-foreground">{setting.hint}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular text-sm">
                    {value === undefined ? "Not set" : setting.rupees ? `₹${(value / 100).toLocaleString("en-IN")}` : value}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setNumericTarget(setting);
                      setNumericValue(value === undefined ? "" : String(setting.rupees ? value / 100 : value));
                    }}
                  >
                    Edit
                  </Button>
                </div>
              </li>
            );
          })}
          <li className="flex items-center justify-between gap-3 py-3">
            <div>
              <p className="text-sm font-medium">Automatic suspension</p>
              <p className="text-xs text-muted-foreground">Suspend services automatically once the grace period is exceeded.</p>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill tone={autoSuspend ? "live" : "idle"}>{autoSuspend ? "On" : "Off"}</StatusPill>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setFeatureTarget({ key: "billing.auto_suspend_enabled", label: "Automatic suspension", locked: !autoSuspend })}
              >
                {autoSuspend ? "Turn off" : "Turn on"}
              </Button>
            </div>
          </li>
        </ul>
      </SectionCard>

      <ReasonDialog
        open={featureTarget !== null}
        onOpenChange={(open) => !open && setFeatureTarget(null)}
        title={`Update ${featureTarget?.label ?? ""}`}
        description="This changes the default for every customer without an individual override, effective immediately."
        onConfirm={async (reason) => {
          const target = featureTarget!;
          if (target.key === "billing.auto_suspend_enabled") {
            await saveSetting({ data: { key: target.key, value: { enabled: target.locked }, reason } });
          } else {
            await saveSetting({
              data: { key: "features.defaults", value: { ...defaults, [target.key]: target.locked }, reason },
            });
          }
          toast.success("Setting updated");
          setFeatureTarget(null);
          await queryClient.invalidateQueries();
        }}
      />

      <ReasonDialog
        open={numericTarget !== null}
        onOpenChange={(open) => !open && setNumericTarget(null)}
        title={`Update ${numericTarget?.label ?? ""}`}
        description="Applied immediately to server-side billing enforcement."
        confirmLabel="Save"
        extra={<Input placeholder="Value" value={numericValue} onChange={(e) => setNumericValue(e.target.value)} />}
        onConfirm={async (reason) => {
          const parsed = Number(numericValue);
          if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Enter a valid number");
          const target = numericTarget!;
          const value = target.rupees
            ? { amount: Math.round(parsed * 100), currency: "INR" }
            : { [target.field]: Math.round(parsed) };
          await saveSetting({ data: { key: target.key, value, reason } });
          toast.success("Setting updated");
          setNumericTarget(null);
          await queryClient.invalidateQueries();
        }}
      />
    </div>
  );
}
