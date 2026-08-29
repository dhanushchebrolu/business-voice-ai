import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Hash } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, numbersQuery } from "@/lib/workspace";
import { listTelephonyProviders } from "@/lib/telephony.functions";
import { PageHeader, SectionCard, EmptyState, StatusPill, LoadingState } from "@/components/app/primitives";

export const Route = createFileRoute("/app/numbers")({
  head: () => ({
    meta: [
      { title: "Phone numbers — Vaani" },
      { name: "description", content: "Connect a telephony provider and route inbound calls to your AI receptionist." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: NumbersPage,
});

function NumbersPage() {
  const { user } = useAuth();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const { data: numbers, isLoading } = useQuery(numbersQuery(ws?.organization?.id));
  const listProviders = useServerFn(listTelephonyProviders);
  const { data: providers } = useQuery({ queryKey: ["telephony-providers"], queryFn: () => listProviders({}) });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Phone numbers"
        description="Your receptionist answers calls on numbers routed through a connected telephony provider."
      />

      {isLoading ? (
        <LoadingState label="Loading numbers" />
      ) : numbers?.length ? (
        <SectionCard title="Your numbers">
          <ul className="divide-y divide-border">
            {numbers.map((n) => (
              <li key={n.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-mono text-sm">{n.e164}</p>
                  <p className="text-xs text-muted-foreground">
                    {n.provider} · {n.country} · {n.inbound_enabled ? "inbound" : "no inbound"}
                  </p>
                </div>
                <StatusPill tone={n.status === "active" ? "live" : "idle"}>{n.status}</StatusPill>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : (
        <EmptyState
          icon={Hash}
          title="No number connected yet"
          description="No telephony provider is connected to this platform yet, so live numbers can't be purchased or routed. Your receptionist configuration is still fully testable in the meantime."
        />
      )}

      <SectionCard title="Telephony providers" description="Connection status reported by the platform — nothing is simulated.">
        <ul className="divide-y divide-border">
          {(providers?.providers ?? []).map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
              <div>
                <p className="text-sm font-medium">{p.label}</p>
                {!p.configured ? (
                  <p className="text-xs text-muted-foreground">Requires: {p.missing.join(", ")}</p>
                ) : null}
              </div>
              <StatusPill tone={p.configured ? "live" : "idle"}>{p.configured ? "Connected" : "Not connected"}</StatusPill>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
