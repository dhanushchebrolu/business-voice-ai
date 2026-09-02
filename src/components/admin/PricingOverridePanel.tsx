import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listPricingRules, listPricingOverrides, setPricingOverride } from "@/lib/admin-finance.functions";
import { SectionCard } from "@/components/app/primitives";
import { formatMoney } from "@/lib/pricing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReasonDialog } from "@/components/admin/ReasonDialog";

const toPaise = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));

/** Per-customer price/cost override. Provider cost never leaves the admin plane. */
export function PricingOverridePanel({ orgId }: { orgId: string }) {
  const fetchRules = useServerFn(listPricingRules);
  const fetchOverrides = useServerFn(listPricingOverrides);
  const save = useServerFn(setPricingOverride);

  const rules = useQuery({ queryKey: ["pricing-rules"], queryFn: () => fetchRules() });
  const overrides = useQuery({ queryKey: ["pricing-overrides", orgId], queryFn: () => fetchOverrides({ data: { orgId } }) });

  const [target, setTarget] = useState<{ key: string; label: string } | null>(null);
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");

  const overrideMap = new Map((overrides.data ?? []).map((o) => [o.key, o]));

  return (
    <SectionCard
      title="Customer pricing"
      description="Overrides apply to this customer only. Blank fields fall back to the platform rule. Customers never see provider cost or margin."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="py-2 font-medium">Item</th>
              <th className="py-2 font-medium">Customer price</th>
              <th className="py-2 font-medium">Provider cost</th>
              <th className="py-2 font-medium">Margin</th>
              <th className="py-2 font-medium">Source</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {(rules.data ?? []).map((rule) => {
              const ov = overrideMap.get(rule.key);
              const customer = ov?.customer_amount ?? rule.customer_amount;
              const provider = ov?.provider_cost ?? rule.provider_cost;
              const margin = customer - provider;
              return (
                <tr key={rule.key} className="border-b border-border/60">
                  <td className="py-2.5">
                    {rule.label}
                    <span className="ml-1 text-xs text-muted-foreground">/{rule.unit}</span>
                  </td>
                  <td className="py-2.5 tabular">{formatMoney(customer)}</td>
                  <td className="py-2.5 tabular text-muted-foreground">{formatMoney(provider)}</td>
                  <td className={`py-2.5 tabular ${margin < 0 ? "text-destructive" : "text-success"}`}>
                    {formatMoney(margin)}
                    {customer > 0 ? ` · ${((margin / customer) * 100).toFixed(1)}%` : ""}
                  </td>
                  <td className="py-2.5 text-xs text-muted-foreground">{ov ? "Customer override" : "Platform rule"}</td>
                  <td className="py-2.5 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setTarget({ key: rule.key, label: rule.label });
                        setPrice(ov?.customer_amount != null ? String(ov.customer_amount / 100) : "");
                        setCost(ov?.provider_cost != null ? String(ov.provider_cost / 100) : "");
                      }}
                    >
                      Override
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ReasonDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={`Override “${target?.label}” for this customer`}
        description="Leave both fields empty to remove the override and follow the platform rule again. Amounts in rupees."
        confirmLabel="Save override"
        extra={
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="Customer price ₹" value={price} onChange={(e) => setPrice(e.target.value)} />
            <Input placeholder="Provider cost ₹" value={cost} onChange={(e) => setCost(e.target.value)} />
          </div>
        }
        onConfirm={async (reason) => {
          await save({
            data: { orgId, key: target!.key, customerAmount: toPaise(price), providerCost: toPaise(cost), reason },
          });
          toast.success("Pricing updated");
          setTarget(null);
          await overrides.refetch();
        }}
      />
    </SectionCard>
  );
}
