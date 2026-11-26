import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";
import {
  getAdminCallDetail,
  reviewSarvamStartFailure,
  verifySarvamCallDuration,
} from "@/lib/sarvam-admin.functions";
import { getCallRecording } from "@/lib/call-recording.functions";
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
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusPill } from "@/components/app/primitives";
import { CallContextSnapshot } from "@/components/app/CallContextSnapshot";

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
  const fetchRecording = useServerFn(getCallRecording);
  const [recording, setRecording] = useState<{
    callId: string;
    src?: string;
    note?: string;
  } | null>(null);
  const [loadingRecording, setLoadingRecording] = useState(false);
  const recordingForThisCall = recording?.callId === callId ? recording : null;
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
                  ? `${data.agent.name} · ${data.agent.role} agent · Sarvam app ${data.agent.sarvamAppId ?? "not mapped"} v${data.agent.sarvamAppVersion ?? "—"}`
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

            {data.direction === "outbound" && callId ? (
              <div className="border-t border-border pt-3">
                <CallContextSnapshot callId={callId} scope="admin" />
              </div>
            ) : null}

            <section className="space-y-2 border-t border-border pt-3">
              <p className="text-sm font-medium">Billing</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Row label="Provider cost">{formatMoney(data.providerCost, data.currency)}</Row>
                <Row label="Customer charge">
                  {data.billingHold
                    ? "Pending (billing on hold)"
                    : formatMoney(data.customerCharge, data.currency)}
                </Row>
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
              {data.lateProviderReport ? (
                <p className="text-xs text-muted-foreground">
                  Late provider report ({when(data.lateProviderReport.receivedAt ?? null)}):{" "}
                  {data.lateProviderReport.status ?? "unknown"}
                  {data.lateProviderReport.durationSeconds != null
                    ? ` · ${data.lateProviderReport.durationSeconds}s`
                    : ""}
                  . Kept for review; not applied and not billed.
                </p>
              ) : null}
              {data.billingHold && callId ? (
                <VerifyDuration callId={callId} onDone={() => void refetch()} />
              ) : null}
              {data.campaignContact ? (
                <p className="text-xs text-muted-foreground">
                  Campaign contact: {data.campaignContact.status.replace(/_/g, " ")} ·{" "}
                  {data.campaignContact.attempts} attempt(s)
                  {data.campaignContact.onThisCall ? "" : " · now on a later call"}
                </p>
              ) : null}
              {data.operatorReview ? (
                <p className="text-xs text-muted-foreground">
                  Operator review ({when(data.operatorReview.reviewedAt ?? null)}):{" "}
                  {data.operatorReview.decision?.replace(/_/g, " ")}
                  {data.operatorReview.allowRetry ? " · contact released for retry" : ""} —{" "}
                  {data.operatorReview.reason}
                </p>
              ) : null}
              {data.resolutionSource === "start_failure" && data.resolutionConflict && callId ? (
                <ReviewStartFailure
                  callId={callId}
                  isCampaign={data.campaignContact !== null}
                  onDone={() => void refetch()}
                />
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
              ) : data.provider === "sarvam" && callId ? (
                recordingForThisCall?.src ? (
                  <audio controls src={recordingForThisCall.src} className="w-full" />
                ) : (
                  <div className="space-y-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={loadingRecording}
                      onClick={async () => {
                        setLoadingRecording(true);
                        try {
                          const r = await fetchRecording({ data: { callId } });
                          setRecording(
                            r.available
                              ? { callId, src: `data:${r.contentType};base64,${r.base64}` }
                              : { callId, note: r.reason },
                          );
                        } catch (err) {
                          setRecording({ callId, note: describeQueryError(err) });
                        } finally {
                          setLoadingRecording(false);
                        }
                      }}
                    >
                      {loadingRecording ? "Loading…" : "Load recording from Sarvam"}
                    </Button>
                    {recordingForThisCall?.note ? (
                      <p className="text-xs text-muted-foreground">{recordingForThisCall.note}</p>
                    ) : null}
                  </div>
                )
              ) : (
                <p className="text-xs text-muted-foreground">No recording stored.</p>
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

/**
 * F3: the call connected but its duration is unknown, so it is not billed.
 * The operator enters the duration they verified in Sarvam; billing then runs
 * once, capped at what was reserved when the call was admitted.
 */
function VerifyDuration({ callId, onDone }: { callId: string; onDone: () => void }) {
  const verify = useServerFn(verifySarvamCallDuration);
  const [seconds, setSeconds] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const value = Number(seconds);
  const valid = Number.isInteger(value) && value >= 1 && reason.trim().length > 0;
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-xs">
        Billing on hold: this call connected but Sarvam reported no usable duration. Nothing is
        charged until a verified duration is recorded.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          className="h-8 w-40"
          inputMode="numeric"
          placeholder="Duration (seconds)"
          aria-label="Verified duration in seconds"
          value={seconds}
          onChange={(e) => setSeconds(e.target.value.trim())}
        />
        <Input
          className="h-8 min-w-48 flex-1"
          placeholder="Where you verified it"
          aria-label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button
          size="sm"
          className="h-8"
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true);
            setMessage(null);
            try {
              const r = await verify({
                data: { callId, durationSeconds: value, reason: reason.trim() },
              });
              setMessage(`Duration recorded; billing ${r.finalization}.`);
              onDone();
            } catch (err) {
              setMessage((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Record verified duration"}
        </Button>
      </div>
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}

const REVIEW_CHOICES = [
  { decision: "call_confirmed", label: "The call happened" },
  { decision: "no_call_confirmed", label: "No call happened" },
  { decision: "unresolved", label: "Still unclear" },
] as const;

/**
 * F2: Sarvam rejected the start, then reported a result for it anyway. The
 * operator decides; nothing is charged either way, and a campaign contact is
 * only released for another call when the operator ticks that explicitly.
 */
function ReviewStartFailure({
  callId,
  isCampaign,
  onDone,
}: {
  callId: string;
  isCampaign: boolean;
  onDone: () => void;
}) {
  const review = useServerFn(reviewSarvamStartFailure);
  const [decision, setDecision] = useState<(typeof REVIEW_CHOICES)[number]["decision"] | null>(
    null,
  );
  const [allowRetry, setAllowRetry] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-xs">
        Sarvam rejected this call&apos;s start request, then reported a result for it. What
        happened? Nothing is charged, and no call is placed, whatever you choose.
      </p>
      <div className="flex flex-wrap gap-2">
        {REVIEW_CHOICES.map((c) => (
          <Button
            key={c.decision}
            size="sm"
            variant={decision === c.decision ? "default" : "outline"}
            className="h-8"
            aria-pressed={decision === c.decision}
            onClick={() => setDecision(c.decision)}
          >
            {c.label}
          </Button>
        ))}
      </div>
      {isCampaign && decision === "no_call_confirmed" ? (
        <label className="flex items-center gap-2 text-xs">
          <Checkbox checked={allowRetry} onCheckedChange={(v) => setAllowRetry(v === true)} />
          Let the campaign call this contact again (its retry rules apply)
        </label>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Input
          className="h-8 min-w-48 flex-1"
          placeholder="Reason (what you checked)"
          aria-label="Review reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button
          size="sm"
          className="h-8"
          disabled={!decision || !reason.trim() || busy}
          onClick={async () => {
            if (!decision) return;
            setBusy(true);
            setMessage(null);
            try {
              const r = await review({
                data: { callId, decision, allowRetry, reason: reason.trim() },
              });
              setMessage(
                r.duplicate
                  ? "Already reviewed; that decision stands."
                  : decision === "unresolved"
                    ? "Noted. The call stays in Needs review."
                    : `Recorded${r.contactStatus ? ` · contact ${r.contactStatus.replace(/_/g, " ")}` : ""}.`,
              );
              onDone();
            } catch (err) {
              setMessage((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save review"}
        </Button>
      </div>
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}
