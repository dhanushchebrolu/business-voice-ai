import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient, queryOptions } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { PhoneCall, Check, Hourglass } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, numbersQuery } from "@/lib/workspace";
import { pricingQuery, formatMoney } from "@/lib/pricing";
import { useCheckout } from "@/hooks/useCheckout";
import { PageHeader, SectionCard, StatusPill, LoadingState } from "@/components/app/primitives";
import { ServiceLocked } from "@/components/app/ServiceLocked";
import { featureLocksQuery } from "@/lib/access";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { requestPhoneNumber } from "@/lib/telephony-customer.functions";

/** Has this org already asked for a number? RLS-scoped (org members read own customer_events) — the same source of truth requestPhoneNumber itself checks, so a page refresh never loses the "request submitted" state. */
const numberRequestQuery = (orgId: string | undefined) =>
  queryOptions({
    queryKey: ["phone-number-request", orgId],
    enabled: Boolean(orgId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customer_events")
        .select("id, created_at")
        .eq("organization_id", orgId!)
        .eq("kind", "phone_number_requested")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

export const Route = createFileRoute("/app/numbers")({
  head: () => ({
    meta: [
      { title: "Phone & AI Voice Service — Vaani" },
      {
        name: "description",
        content: "Your business phone number and the AI voice service that answers it.",
      },
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
  const { data: locks } = useQuery(featureLocksQuery(ws?.organization?.id));
  const orgId = ws?.organization?.id;
  const { data: existingRequest, refetch: refetchRequest } = useQuery(numberRequestQuery(orgId));
  const requestNumber = useServerFn(requestPhoneNumber);
  const queryClient = useQueryClient();
  const [requesting, setRequesting] = useState(false);
  const [providerSetupRequired, setProviderSetupRequired] = useState(false);

  const onRequestNumber = async () => {
    setRequesting(true);
    try {
      const result = await requestNumber();
      if (!result.providerReady) setProviderSetupRequired(true);
      toast.success(
        result.alreadyRequested
          ? "Your request is already with our team."
          : "Request submitted — our team will provision your number shortly.",
      );
      await refetchRequest();
      await queryClient.invalidateQueries({ queryKey: ["numbers", orgId] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not submit your request.");
    } finally {
      setRequesting(false);
    }
  };

  const fee = pricing?.["pricing.phone_service_fee"];
  const active = numbers?.find((n) => n.status === "active");
  // Mirrors the same feature_locked("phone") check checkTelephonyAccess
  // enforces server-side (telephony-guard.server.ts) before any real
  // call — this only decides what this page shows, never what's allowed.
  const phoneLocked = locks?.["phone"] === true;
  const lifecycle = ws?.organization?.lifecycle_status ?? "not_provisioned";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Phone & AI Voice Service"
        description="One monthly service that gives your business a phone number answered by your AI receptionist."
        actions={
          <StatusPill tone={active ? "live" : "idle"}>
            {active ? "Active" : "Setup required"}
          </StatusPill>
        }
      />

      {isLoading ? (
        <LoadingState label="Loading your service" />
      ) : phoneLocked ? (
        <ServiceLocked feature="phone" lifecycle={lifecycle} />
      ) : (
        <SectionCard
          title={
            fee
              ? `Phone & AI Voice Service — ${formatMoney(fee.amount, fee.currency)}/month`
              : "Phone & AI Voice Service"
          }
          description="Billed monthly to your workspace. Cancel any time from billing."
          actions={
            active ? null : (
              <Button
                size="sm"
                disabled={pending !== null}
                onClick={() => pay("phone_service_fee")}
              >
                {pending === "phone_service_fee" ? "Opening…" : "Activate service"}
              </Button>
            )
          }
        >
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="rounded-lg border border-border p-4">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Your number
              </p>
              {active ? (
                <>
                  <p className="mt-1.5 font-mono text-xl">{active.e164}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <StatusPill tone="live">{active.status}</StatusPill>
                    <StatusPill tone="idle">{active.provider}</StatusPill>
                    <StatusPill tone={active.inbound_enabled ? "live" : "idle"}>
                      Inbound {active.inbound_enabled ? "on" : "off"}
                    </StatusPill>
                    <StatusPill tone={active.outbound_enabled ? "live" : "idle"}>
                      Outbound {active.outbound_enabled ? "on" : "off"}
                    </StatusPill>
                  </div>
                  <dl className="mt-3 space-y-1 text-xs text-muted-foreground">
                    <div className="flex justify-between gap-2">
                      <dt>Agent</dt>
                      <dd>{active.agent_config_id ? "Assigned" : "Not assigned"}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>Deployment</dt>
                      <dd>{active.provider_deployment_id ? "Connected" : "Not connected"}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>Created</dt>
                      <dd>{new Date(active.created_at).toLocaleDateString()}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <>
                  <p className="mt-1.5 text-xl font-medium text-muted-foreground">
                    Not assigned yet
                  </p>
                  {existingRequest ? (
                    <div className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                      <Hourglass className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        Request submitted{" "}
                        {new Date(existingRequest.created_at).toLocaleDateString()} — our team will
                        provision your number and it will appear here automatically. Nothing is
                        simulated: this stays empty until a real number is live.
                      </span>
                    </div>
                  ) : (
                    <>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Request a number and our team will connect it to your AI receptionist.
                        Nothing is simulated here — this stays empty until a real number is live on
                        your workspace.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-3"
                        disabled={requesting}
                        onClick={onRequestNumber}
                      >
                        {requesting ? "Submitting…" : "Get / Attach Sarvam Number"}
                      </Button>
                    </>
                  )}
                  {providerSetupRequired ? (
                    <p className="mt-2 text-xs text-warning">
                      Provider setup required — our team needs to finish connecting Sarvam for your
                      workspace before this can be fulfilled.
                    </p>
                  ) : null}
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
