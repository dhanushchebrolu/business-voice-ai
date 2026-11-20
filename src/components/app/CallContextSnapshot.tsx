import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getAdminCallContextSnapshot,
  getCallContextSnapshot,
} from "@/lib/call-context-snapshot.functions";
import {
  SNAPSHOT_CONTEXT_FIELDS,
  snapshotFieldValue,
  type CallContextSnapshotView,
} from "@/lib/call-context-snapshot";
import { describeQueryError } from "@/lib/query-error";
import { ErrorState, LoadingState } from "@/components/app/primitives";

/**
 * Read-only: the campaign context one outbound call was admitted with, as
 * stored at admission (immutable). No actions. Rendered only for outbound
 * calls; `scope` picks the member or platform-admin server function, each of
 * which authorizes on the server.
 */
export function CallContextSnapshot({
  callId,
  scope,
}: {
  callId: string;
  scope: "member" | "admin";
}) {
  const fetchMember = useServerFn(getCallContextSnapshot);
  const fetchAdmin = useServerFn(getAdminCallContextSnapshot);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["call-context-snapshot", scope, callId],
    queryFn: (): Promise<CallContextSnapshotView> =>
      scope === "admin" ? fetchAdmin({ data: { callId } }) : fetchMember({ data: { callId } }),
    // A snapshot never changes; the campaign's current context rarely does.
    staleTime: 60_000,
  });

  return (
    <section className="space-y-2" aria-label="Campaign context used for this call">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
        Campaign context used for this call
      </p>
      {isLoading ? (
        <LoadingState label="Loading campaign context" />
      ) : isError ? (
        <ErrorState
          message={describeQueryError(error, "Could not load the campaign context for this call.")}
          onRetry={() => void refetch()}
        />
      ) : data ? (
        <SnapshotBody view={data} />
      ) : null}
    </section>
  );
}

function SnapshotBody({ view }: { view: CallContextSnapshotView }) {
  if (view.state === "not_campaign")
    return <p className="text-sm text-muted-foreground">Not a campaign call.</p>;
  if (view.state === "no_snapshot")
    return (
      <p className="text-sm text-muted-foreground">
        No context was recorded for this call
        {view.campaign?.name ? ` (campaign "${view.campaign.name}")` : ""}. Calls placed before
        context recording, or never started, have none.
      </p>
    );
  if (view.state === "unreadable")
    return (
      <p className="text-sm text-muted-foreground">
        The context recorded for this call could not be read.
      </p>
    );

  const { snapshot, campaign, currentDiffers } = view;
  return (
    <div className="space-y-3 rounded-md border border-border p-3 text-sm">
      <p className="text-xs text-muted-foreground">
        Recorded when the call started and cannot be changed
        {campaign?.name ? ` · campaign "${campaign.name}"` : ""}. Context version{" "}
        {snapshot.version ?? "—"}, reviewed{" "}
        {snapshot.reviewedAt ? new Date(snapshot.reviewedAt).toLocaleString() : "—"}.
      </p>
      {currentDiffers ? (
        <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs">
          The campaign's context has been edited since this call. What is shown here is what this
          call used, not the campaign's current context.
        </p>
      ) : null}

      <div className="space-y-2">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Sent to the voice agent
        </p>
        <SentValue label="campaign_objective" value={snapshot.sent.objective} />
        <SentValue label="campaign_instructions" value={snapshot.sent.instructions} />
      </div>

      {snapshot.context ? (
        <dl className="space-y-2">
          {SNAPSHOT_CONTEXT_FIELDS.map(([key, label]) => {
            const value = snapshotFieldValue(snapshot.context?.[key]);
            if (value === null) return null;
            return (
              <div key={key}>
                <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                <dd className="mt-0.5">
                  {Array.isArray(value) ? (
                    <ul className="list-disc space-y-0.5 pl-5">
                      {value.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="whitespace-pre-wrap">{value}</span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">No structured context was stored.</p>
      )}
    </div>
  );
}

function SentValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-xs text-muted-foreground">{label}</p>
      <pre className="mt-0.5 whitespace-pre-wrap break-words rounded bg-surface/50 p-2 font-sans text-sm">
        {value || "(empty)"}
      </pre>
    </div>
  );
}
