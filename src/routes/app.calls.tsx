import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Search } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, callsQuery } from "@/lib/workspace";
import { PageHeader } from "@/components/app/primitives";
import { ServiceLocked } from "@/components/app/ServiceLocked";
import { featureLocksQuery } from "@/lib/access";
import { Input } from "@/components/ui/input";
import { PlaceCallButton } from "@/components/app/PlaceCallDialog";
import { CallsHistory } from "@/components/app/CallsHistory";
import { isCallOpen } from "@/lib/call-history";

export const Route = createFileRoute("/app/calls")({
  head: () => ({
    meta: [
      { title: "Calls — ClickAI" },
      { name: "description", content: "Review every answered call, transcript and outcome." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: CallsPage,
});

function CallsPage() {
  const { user } = useAuth();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const { data: calls, isLoading } = useQuery({
    ...callsQuery(ws?.organization?.id),
    // Keep a call that is still going up to date until it ends.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((c) => isCallOpen(c.status)) ? 10_000 : false,
  });
  const { data: locks } = useQuery(featureLocksQuery(ws?.organization?.id));
  const phoneLocked = locks?.["phone"] === true;
  const lifecycle = ws?.organization?.lifecycle_status ?? "not_provisioned";
  const [q, setQ] = useState("");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calls"
        description="Every call your receptionist handled or placed, with duration, language, outcome and full transcript."
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            {ws?.organization?.id && !phoneLocked ? (
              <PlaceCallButton organizationId={ws.organization.id} />
            ) : null}
            <div className="relative min-w-0 flex-1 sm:flex-none">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search calls"
                className="h-9 w-full pl-8 sm:w-56"
              />
            </div>
          </div>
        }
      />

      {phoneLocked ? <ServiceLocked feature="phone" lifecycle={lifecycle} compact /> : null}

      <CallsHistory calls={calls} isLoading={isLoading} query={q} />
    </div>
  );
}
