import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";
import { getAdminCallDetail } from "@/lib/sarvam-admin.functions";
import { formatMoney } from "@/lib/pricing";
import { describeQueryError } from "@/lib/query-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/app/primitives";

const NOT_SENT = "Not sent by provider";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all text-sm">{children}</dd>
    </div>
  );
}

const when = (v: string | null) => (v ? new Date(v).toLocaleString() : "—");

/** Read-only monitoring view of one call, straight from what Klyro stored. */
export function CallDetailDialog({
  callId,
  onOpenChange,
}: {
  callId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const fetchDetail = useServerFn(getAdminCallDetail);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["admin-call-detail", callId],
    queryFn: () => fetchDetail({ data: { callId: callId! } }),
    enabled: callId !== null,
  });

  return (
    <Dialog open={callId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Call details</DialogTitle>
          <DialogDescription className="font-mono text-xs">{callId}</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{describeQueryError(error)}</p>
        ) : data ? (
          <div className="space-y-5">
            <div className="flex items-center gap-2">
              <StatusPill
                tone={
                  data.status === "completed"
                    ? "live"
                    : ["failed", "busy", "no_answer", "outcome_unknown"].includes(data.status)
                      ? "error"
                      : "idle"
                }
              >
                {data.status === "outcome_unknown" ? "Unconfirmed" : data.status}
              </StatusPill>
              <span className="text-xs text-muted-foreground">
                {data.provider} · {data.direction}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto h-7 text-xs"
                disabled={isFetching}
                onClick={() => void refetch()}
              >
                {isFetching ? "Refreshing…" : "Refresh"}
              </Button>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Row label="Customer">
                {data.customer.name ?? "Unknown"}{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  {data.customer.clientId}
                </span>
              </Row>
              <Row label="Provider call ID (attempt)">
                <span className="font-mono text-xs">
                  {data.providerCallId ?? "Not received yet"}
                </span>
              </Row>
              <Row label="From (assigned number)">
                <span className="font-mono">{data.fromNumber ?? data.phoneNumber ?? "—"}</span>
              </Row>
              <Row label="To">
                <span className="font-mono">{data.destinationNumber ?? "—"}</span>
              </Row>
              <Row label="Voice agent (number's current agent)">
                {data.agent
                  ? `${data.agent.name} · Sarvam app ${data.agent.sarvamAppId ?? "not mapped"} v${data.agent.sarvamAppVersion ?? "—"}`
                  : "—"}
              </Row>
              <Row label="Interaction ID">
                <span className="font-mono text-xs">{data.interactionId ?? "—"}</span>
              </Row>
              <Row label="Started">{when(data.startedAt)}</Row>
              <Row label="Answered">{when(data.answeredAt)}</Row>
              <Row label="Ended">{when(data.endedAt)}</Row>
              <Row label="Duration">{data.durationSeconds}s</Row>
              {data.outcome ? <Row label="Outcome">{data.outcome}</Row> : null}
              {data.failureReason ? (
                <Row label="Error">
                  <span className="text-destructive">{data.failureReason}</span>
                </Row>
              ) : null}
            </dl>

            <section className="space-y-2 border-t border-border pt-3">
              <p className="text-sm font-medium">Billing</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Row label="Provider cost">{formatMoney(data.providerCost, data.currency)}</Row>
                <Row label="Customer charge">{formatMoney(data.customerCharge, data.currency)}</Row>
                <Row label="Finalization">
                  {data.finalizationState ?? "Not final yet"}
                  {data.finalizationAttempts ? ` · ${data.finalizationAttempts} attempt(s)` : ""}
                </Row>
                <Row label="Billing applied">{when(data.billingAppliedAt)}</Row>
                <Row label="Wallet debits for this call">
                  {data.walletDebits.length === 0
                    ? "None"
                    : data.walletDebits
                        .map((d) => `${formatMoney(d.amount, d.currency)} (${when(d.created_at)})`)
                        .join(", ")}
                </Row>
                <Row label="Resolved by">
                  {data.resolutionSource ?? "—"}
                  {data.resolutionConflict ? " · provider reported a different outcome" : ""}
                </Row>
              </dl>
              {data.finalizationError ? (
                <p className="text-xs text-destructive">
                  Finalization error: {data.finalizationError}
                </p>
              ) : null}
            </section>

            <section className="space-y-2 border-t border-border pt-3">
              <p className="text-sm font-medium">Webhooks</p>
              {data.webhookEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No provider webhook received for this call yet.
                </p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {data.webhookEvents.map((e) => (
                    <li key={`${e.event_id}-${e.created_at}`}>
                      {when(e.created_at)} · {e.event_type ?? "event"} ·{" "}
                      {e.error ? (
                        <span className="text-destructive">failed: {e.error}</span>
                      ) : e.processed_at ? (
                        "processed"
                      ) : (
                        "not processed"
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2 border-t border-border pt-3">
              <p className="text-sm font-medium">Recording</p>
              {data.recordingUrl ? (
                <a
                  href={data.recordingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline"
                >
                  Open recording
                </a>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {data.provider === "sarvam"
                    ? `${NOT_SENT} — Sarvam's call webhook has no recording URL.`
                    : "No recording stored."}
                </p>
              )}
            </section>

            <section className="space-y-2 border-t border-border pt-3">
              <p className="text-sm font-medium">Transcript</p>
              {data.summary ? <p className="text-sm">{data.summary}</p> : null}
              {data.transcript ? (
                <ol className="space-y-1.5 text-sm">
                  {data.transcript.map((t, i) => (
                    <li key={i}>
                      <span className="text-xs font-medium uppercase text-muted-foreground">
                        {t.role}
                      </span>{" "}
                      {t.text}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No transcript stored{data.endedAt ? "" : " — the call has not ended yet"}.
                </p>
              )}
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
