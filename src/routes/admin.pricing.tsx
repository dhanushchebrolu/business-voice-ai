import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { listPlatformSettings, updatePlatformSetting } from "@/lib/admin.functions";
import { PageHeader, SectionCard, LoadingState, ErrorState } from "@/components/app/primitives";
import { formatMoney } from "@/lib/pricing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ReasonDialog } from "@/components/admin/ReasonDialog";

export const Route = createFileRoute("/admin/pricing")({
  component: AdminPricing,
});

interface PriceValue {
  amount: number;
  currency: string;
  label: string;
}

/** Prices the platform can charge. Adding a new key here creates it on first save. */
const KNOWN_PRICES: { key: string; label: string }[] = [
  { key: "pricing.setup_fee", label: "One-time setup fee" },
  { key: "pricing.monthly_plan", label: "Monthly platform fee" },
  { key: "pricing.phone_service_fee", label: "Phone & AI Voice Service (monthly)" },
  { key: "pricing.voice_minute", label: "Voice per minute" },
  { key: "pricing.inbound_call", label: "Inbound call per minute" },
  { key: "pricing.outbound_call", label: "Outbound call per minute" },
  { key: "pricing.whatsapp_message", label: "WhatsApp message" },
  { key: "pricing.chatbot_monthly", label: "Website chatbot (monthly)" },
  { key: "pricing.additional_number", label: "Additional phone number (monthly)" },
  { key: "pricing.additional_agent", label: "Additional AI agent (monthly)" },
];

function AdminPricing() {
  const fetchSettings = useServerFn(listPlatformSettings);
  const saveSetting = useServerFn(updatePlatformSetting);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ key: string; label: string } | null>(null);
  const [amount, setAmount] = useState("");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-settings"],
    queryFn: () => fetchSettings(),
  });

  if (isLoading) return <LoadingState label="Loading pricing" />;
  if (error) return <ErrorState message={error instanceof Error ? error.message : "Could not load pricing"} onRetry={() => void refetch()} />;

  const map = new Map((data ?? []).map((s) => [s.key, s.value as unknown as PriceValue]));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Pricing"
        description="Every charge in the product reads these values at runtime. Changing a price never needs a deployment."
      />

      <SectionCard title="Price list" description="Amounts are stored in paise and shown in rupees. Currency: INR.">
        <ul className="divide-y divide-border">
          {KNOWN_PRICES.map((price) => {
            const value = map.get(price.key);
            return (
              <li key={price.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">{value?.label ?? price.label}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{price.key}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular text-sm font-medium">
                    {value ? formatMoney(value.amount, value.currency) : "Not set"}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditing(price);
                      setAmount(value ? String(value.amount / 100) : "");
                    }}
                  >
                    Edit
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <ReasonDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={`Update ${editing?.label ?? ""}`}
        description="The new price applies immediately to every new charge across the platform. Historic payments are untouched."
        confirmLabel="Save price"
        extra={<Input placeholder="Amount in ₹" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        onConfirm={async (reason) => {
          const rupees = Number(amount);
          if (!Number.isFinite(rupees) || rupees < 0) throw new Error("Enter a valid amount");
          const existing = map.get(editing!.key);
          await saveSetting({
            data: {
              key: editing!.key,
              value: { amount: Math.round(rupees * 100), currency: existing?.currency ?? "INR", label: existing?.label ?? editing!.label },
              reason,
            },
          });
          toast.success("Price updated");
          setEditing(null);
          await queryClient.invalidateQueries();
        }}
      />
    </div>
  );
}
