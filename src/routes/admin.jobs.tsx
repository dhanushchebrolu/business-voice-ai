import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { ListChecks } from "lucide-react";
import { getJobQueueOverview, requeueDeadJob } from "@/lib/jobs-admin.functions";
import {
  PageHeader,
  LoadingState,
  ErrorState,
  EmptyState,
  SectionCard,
  StatusPill,
} from "@/components/app/primitives";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/admin/jobs")({
  component: AdminJobs,
});

const ALERT_SECONDS = 600;

function age(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function AdminJobs() {
  const fetchOverview = useServerFn(getJobQueueOverview);
  const requeue = useServerFn(requeueDeadJob);
  const [requeueId, setRequeueId] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-jobs"],
    queryFn: () => fetchOverview(),
    refetchInterval: 30_000,
  });

  const dead = data?.dead.length ?? 0;
  const oldest = Math.max(0, ...(data?.stats ?? []).map((s) => s.oldestDueSeconds ?? 0));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Background jobs"
        description="The durable queue the scheduler drains every minute: call reconciliation, call finalization and housekeeping. Campaign dispatch and payment expiry are not scheduled."
      />
      {isLoading ? (
        <LoadingState label="Loading the job queue" />
      ) : error ? (
        <ErrorState
          message={error instanceof Error ? error.message : "Could not load jobs"}
          onRetry={() => void refetch()}
        />
      ) : !data ? null : (
        <>
          <div className="flex flex-wrap gap-2 text-sm">
            <StatusPill tone={data.schedulerEnabled ? "live" : "error"}>
              Scheduler {data.schedulerEnabled ? "on" : "off (JOBS_SCHEDULER_ENABLED=false)"}
            </StatusPill>
            <StatusPill tone={dead > 0 ? "error" : "live"}>{dead} dead-lettered</StatusPill>
            <StatusPill tone={oldest > ALERT_SECONDS ? "error" : "live"}>
              Oldest due job: {age(oldest)}
            </StatusPill>
          </div>

          <SectionCard title="Queue by kind" description="Jobs per kind and state.">
            {data.stats.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title="No jobs yet"
                description="The first scheduled tick will create them."
              />
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1">Kind</th>
                    <th>State</th>
                    <th className="text-right">Jobs</th>
                    <th className="text-right">Oldest due</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stats.map((s) => (
                    <tr key={`${s.kind}:${s.status}`} className="border-t border-border">
                      <td className="py-1 font-mono text-xs">{s.kind}</td>
                      <td>{s.status}</td>
                      <td className="text-right">{s.jobs}</td>
                      <td className="text-right">{age(s.oldestDueSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>

          <SectionCard
            title="Dead letters"
            description="Jobs that failed every attempt. Requeue once the cause is fixed; nothing here retries on its own."
          >
            {data.dead.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing dead-lettered.</p>
            ) : (
              <ul className="divide-y divide-border">
                {data.dead.map((j) => (
                  <li key={j.id} className="flex flex-wrap items-start gap-2 py-2 text-sm">
                    <span className="font-mono text-xs">{j.kind}</span>
                    <span className="text-xs text-muted-foreground">
                      {j.attempts}/{j.max_attempts} attempts ·{" "}
                      {j.dead_at ? new Date(j.dead_at).toLocaleString() : ""}
                    </span>
                    <span className="w-full text-xs text-destructive">{j.last_error}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => setRequeueId(j.id)}
                    >
                      Requeue
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title="Recent activity" description="The 25 most recently updated jobs.">
            <ul className="divide-y divide-border text-xs">
              {data.recent.map((j) => (
                <li key={j.id} className="flex flex-wrap gap-2 py-1.5">
                  <span className="font-mono">{j.kind}</span>
                  <StatusPill
                    tone={
                      j.status === "dead" ? "error" : j.status === "succeeded" ? "live" : "idle"
                    }
                  >
                    {j.status}
                  </StatusPill>
                  <span className="text-muted-foreground">attempt {j.attempts}</span>
                  {j.last_error ? <span className="text-destructive">{j.last_error}</span> : null}
                </li>
              ))}
            </ul>
          </SectionCard>
        </>
      )}

      <ReasonDialog
        open={requeueId !== null}
        onOpenChange={(open) => {
          if (!open) setRequeueId(null);
        }}
        title="Requeue dead-lettered job"
        description="The job runs again on the next scheduled tick, with its attempts reset."
        confirmLabel="Requeue"
        onConfirm={async (reason) => {
          if (!requeueId) return;
          await requeue({ data: { jobId: requeueId, reason } });
          toast.success("Job requeued");
          void refetch();
        }}
      />
    </div>
  );
}
