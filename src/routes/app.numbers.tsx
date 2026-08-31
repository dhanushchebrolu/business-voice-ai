import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PhoneCall, Check } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, numbersQuery } from "@/lib/workspace";
import { pricingQuery, formatMoney } from "@/lib/pricing";
import { useCheckout } from "@/hooks/useCheckout";
import { PageHeader, SectionCard, StatusPill, LoadingState } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/app/numbers")({
  head: () => ({
    meta: [
      { title: "Phone & AI Voice Service — Vaani" },
      { name: "description", content: "Your business phone number and the AI voice service that answers it." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: NumbersPage,
});

const INCLUDED = [
  "A dedicated business phone number",
  "Unlimited inbound answering by your AI receptionist",
  "Call recordings, transcripts and summaries",
  "Call transfer to your team when needed",
];

function NumbersPage() {
  const { user } = useAuth();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const { data: numbers, isLoading } = useQuery(numbersQuery(ws?.organization?.id));
  const { data: pricing } = useQuery(pricingQuery());
  const { pay, pending } = useCheckout({ email: user?.email });

  const fee = pricing?.["pricing.phone_service_fee"];
  const active = numbers?.find((n) => n.status === "active");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Phone & AI Voice Service"
        description="One monthly service that gives your business a phone number answered by your AI receptionist."
        actions={<StatusPill tone={active ? "live" : "idle"}>{active ? "Active" : "Setup required"}</StatusPill>}
      />

      {isLoading ? (
        <LoadingState label="Loading your service" />
      ) : (
        <SectionCard
          title={fee ? `Phone & AI Voice Service — ${formatMoney(fee.amount, fee.currency)}/month` : "Phone & AI Voice Service"}
          description="Billed monthly to your workspace. Cancel any time from billing."
          actions={
            active ? null : (
              <Button size="sm" disabled={pending !== null} onClick={() => pay("phone_service_fee")}>
                {pending === "phone_service_fee" ? "Opening…" : "Activate service"}
              </Button>
            )
          }
        >
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="rounded-lg border border-border p-4">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Your number</p>
              {active ? (
                <>
                  <p className="mt-1.5 font-mono text-xl">{active.e164}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {active.inbound_enabled ? "Receiving inbound calls" : "Inbound disabled"}
                    {active.outbound_enabled ? " · outbound enabled" : ""}
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-1.5 text-xl font-medium text-muted-foreground">Not assigned yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Your number is provisioned and connected by our team once the service is active. Nothing is simulated here —
                    this stays empty until a real number is live on your workspace.
                  </p>
                </>
              )}
            </div>

            <ul className="space-y-2">
              {INCLUDED.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </SectionCard>
      )}

      {numbers && numbers.length > 1 ? (
        <SectionCard title="All numbers on your workspace">
          <ul className="divide-y divide-border">
            {numbers.map((n) => (
              <li key={n.id} className="flex items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-2.5">
                  <PhoneCall className="size-4 text-muted-foreground" />
                  <span className="font-mono text-sm">{n.e164}</span>
                </div>
                <StatusPill tone={n.status === "active" ? "live" : "idle"}>{n.status}</StatusPill>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
