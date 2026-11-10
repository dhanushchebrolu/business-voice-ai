import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { PhoneCall } from "lucide-react";
import { toast } from "sonner";
import { listAllCalls, type AdminCallRow } from "@/lib/telephony-admin.functions";
import {
  describeResolutionResult,
  isResolvableSarvamCall,
  needsFinalizationRetry,
} from "@/lib/sarvam-call-review";
import {
  resolveUnknownSarvamCall,
  retrySarvamCallFinalization,
} from "@/lib/sarvam-admin.functions";
import { ReasonDialog } from "@/components/admin/ReasonDialog";
import { CallDetailDialog } from "@/components/admin/CallDetailDialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PageHeader,
  SectionCard,
  StatCard,
  LoadingState,
  ErrorState,
  EmptyState,
  StatusPill,
} from "@/components/app/primitives";
import { formatMoney } from "@/lib/pricing";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export const Route = createFileRoute("/admin/calls")({
  component: AdminCalls,
});

const STATUS_TONE: Record<string, "live" | "ready" | "idle" | "error"> = {
  completed: "live",
  in_progress: "ready",
  answered: "ready",
  ringing: "idle",
  initiated: "idle",
  failed: "error",
  busy: "error",
  no_answer: "error",
  cancelled: "idle",
  outcome_unknown: "error",
};

const STATUS_LABEL: Record<string, string> = { outcome_unknown: "Unconfirmed" };

type Resolution = "not_placed" | "completed" | "no_answer" | "busy" | "failed";

function AdminCalls() {
  const fetchCalls = useServerFn(listAllCalls);
  const resolveCall = useServerFn(resolveUnknownSarvamCall);
  const retryFinalization = useServerFn(retrySarvamCallFinalization);
  const [finalizing, setFinalizing] = useState<AdminCallRow | null>(null);
  const [detailCallId, setDetailCallId] = useState<string | null>(null);
  const [orgId, setOrgId] = useState("");
  const [needsReview, setNeedsReview] = useState(false);
  const [resolving, setResolving] = useState<AdminCallRow | null>(null);
  const [resolution, setResolution] = useState<Resolution>("not_placed");
  const [duration, setDuration] = useState("");
  const [attemptId, setAttemptId] = useState("");
  const [checkedInSarvam, setCheckedInSarvam] = useState(false);
  // Sarvam accepted an `initiated` call, so it may still be ringing or in progress.
  const mayBeActive = resolving?.status === "initiated";

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-calls", orgId, needsReview],
    queryFn: () =>
      fetchCalls({
        data: {
          ...(orgId.trim() ? { orgId: orgId.trim() } : {}),
          ...(needsReview ? { needsReview: true } : {}),
        },
      }),
  });

  if (isLoading) return <LoadingState label="Loading calls" />;
  if (error)
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Could not load calls"}
        onRetry={() => void refetch()}
      />
    );

  const rows = data ?? [];
  const revenue = rows.reduce((s, r) => s + r.customerCharge, 0);
  const cost = rows.reduce((s, r) => s + r.providerCost, 0);
  const profit = rows.reduce((s, r) => s + r.grossProfit, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calls"
        description="Every call across every customer, with the real financials. Provider cost and margin are admin-only — customers never see this view."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={needsReview ? "default" : "outline"}
              aria-pressed={needsReview}
              onClick={() => setNeedsReview((v) => !v)}
            >
              Needs review
            </Button>
            <Input
              placeholder="Filter by organization ID"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              className="h-9 w-64"
            />
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Revenue" value={formatMoney(revenue, "INR")} />
        <StatCard label="Provider cost" value={formatMoney(cost, "INR")} />
        <StatCard
          label="Gross profit"
          value={formatMoney(profit, "INR")}
          tone={profit >= 0 ? "accent" : "default"}
        />
      </div>

      <SectionCard title={`${rows.length} calls`}>
        {rows.length === 0 ? (
          <EmptyState
            icon={PhoneCall}
            title="No calls yet"
            description="Calls will appear here as numbers go live."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-4">Customer</th>
                  <th className="py-2 pr-4">Direction</th>
                  <th className="py-2 pr-4">From / To</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Duration</th>
                  <th className="py-2 pr-4">Charge</th>
                  <th className="py-2 pr-4">Cost</th>
                  <th className="py-2 pr-4">Profit</th>
                  <th className="py-2 pr-4">Started</th>
                  <th className="py-2 pr-4">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="py-2.5 pr-4">
                      <p className="font-medium">{c.customerName}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{c.clientId}</p>
                    </td>
                    <td className="py-2.5 pr-4 text-xs capitalize">{c.direction}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs">
                      {c.callerNumber ?? "—"} → {c.destinationNumber ?? "—"}
                    </td>
                    <td className="py-2.5 pr-4">
                      <StatusPill tone={STATUS_TONE[c.status] ?? "idle"}>
                        {STATUS_LABEL[c.status] ?? c.status}
                      </StatusPill>
                      {isResolvableSarvamCall(c) && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-2 h-7 text-xs"
                          onClick={() => {
                            setCheckedInSarvam(false);
                            setResolving(c);
                          }}
                        >
                          Resolve
                        </Button>
                      )}
                      {needsFinalizationRetry(c) && (
                        <>
                          <span className="ml-2 text-xs text-destructive">
                            {c.finalizationState === "failed"
                              ? "Billing/campaign update failed"
                              : "Billing/campaign update pending"}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="ml-2 h-7 text-xs"
                            onClick={() => setFinalizing(c)}
                          >
                            Retry
                          </Button>
                          {c.finalizationError && (
                            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                              Error: {c.finalizationError}
                            </p>
                          )}
                        </>
                      )}
                      {c.resolutionConflict && (
                        <span className="ml-2 text-xs text-destructive">
                          Sarvam reported a different outcome
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 tabular text-xs">
                      {Math.floor(c.durationSeconds / 60)}m{" "}
                      {String(c.durationSeconds % 60).padStart(2, "0")}s
                    </td>
                    <td className="py-2.5 pr-4 tabular">
                      {formatMoney(c.customerCharge, c.currency)}
                    </td>
                    <td className="py-2.5 pr-4 tabular">
                      {formatMoney(c.providerCost, c.currency)}
                    </td>
                    <td className="py-2.5 pr-4 tabular">
                      {formatMoney(c.grossProfit, c.currency)}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(c.startedAt).toLocaleString()}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() => setDetailCallId(c.id)}
                      >
                        Details
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <CallDetailDialog
        callId={detailCallId}
        onOpenChange={(open) => {
          if (!open) setDetailCallId(null);
        }}
      />

      <ReasonDialog
        open={resolving !== null}
        onOpenChange={(open) => {
          if (!open) setResolving(null);
        }}
        title="Resolve call outcome"
        description={
          !mayBeActive
            ? "Sarvam didn't confirm whether this call was placed. Check Sarvam's dashboard, then record what actually happened. A connected call is billed for the duration you enter."
            : resolving?.hasProviderCallId
              ? "Sarvam accepted this call, but its result never reached Klyro. Look it up in Sarvam's dashboard and record what actually happened. A connected call is billed for the duration you enter."
              : "Klyro never received Sarvam's answer to this call's start request (for example, the server stopped mid-request), so Sarvam may or may not have placed it. Check Sarvam's dashboard for a call to this number at this time, then record what happened."
        }
        confirmLabel="Resolve call"
        extra={
          <div className="space-y-3">
            {mayBeActive && (
              <Alert variant="destructive">
                <AlertTitle>This call may still be in progress</AlertTitle>
                <AlertDescription>
                  It could still be ringing or connected, or its start request may still be running.
                  Only resolve it once Sarvam shows the call has ended (or shows no such call) — a
                  late result from Sarvam is ignored after you resolve it.
                </AlertDescription>
              </Alert>
            )}
            <Select value={resolution} onValueChange={(v) => setResolution(v as Resolution)}>
              <SelectTrigger aria-label="What happened">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="not_placed">Not placed</SelectItem>
                <SelectItem value="completed">Placed and connected</SelectItem>
                <SelectItem value="no_answer">Placed, no answer</SelectItem>
                <SelectItem value="busy">Placed, busy</SelectItem>
                <SelectItem value="failed">Placed, failed</SelectItem>
              </SelectContent>
            </Select>
            {resolution !== "completed" && (
              <p className="text-xs text-muted-foreground">
                {resolution === "not_placed" ? "“Not placed”" : "This outcome"} counts as a failed
                attempt: a campaign may call this contact again (after its retry delay), and a
                one-off call to this number is allowed again.
              </p>
            )}
            {resolution === "completed" && (
              <Input
                type="number"
                min={0}
                aria-label="Duration in seconds"
                placeholder="Duration in seconds (from Sarvam)"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            )}
            {resolution !== "not_placed" && !resolving?.hasProviderCallId && (
              <Input
                aria-label="Sarvam attempt ID"
                placeholder="Sarvam attempt ID (optional)"
                value={attemptId}
                onChange={(e) => setAttemptId(e.target.value)}
              />
            )}
            {mayBeActive && (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={checkedInSarvam}
                  onCheckedChange={(v) => setCheckedInSarvam(Boolean(v))}
                  className="mt-0.5"
                />
                <span>I checked this call in Sarvam&apos;s dashboard and it has ended.</span>
              </label>
            )}
          </div>
        }
        onConfirm={async (reason) => {
          if (!resolving) return;
          if (mayBeActive && !checkedInSarvam)
            throw new Error("Confirm you checked this call in Sarvam before resolving it.");
          const result = await resolveCall({
            data: {
              callId: resolving.id,
              ...(mayBeActive ? { confirmedCheckedInSarvam: true } : {}),
              resolution: resolution === "not_placed" ? "not_placed" : "placed",
              ...(resolution === "not_placed" ? {} : { outcome: resolution }),
              ...(resolution === "completed" && duration.trim()
                ? { durationSeconds: Number(duration) }
                : {}),
              ...(resolution !== "not_placed" && attemptId.trim()
                ? { attemptId: attemptId.trim() }
                : {}),
              reason,
            },
          });
          // A plain success only when billing and the campaign update finished too.
          const message = describeResolutionResult(result);
          if (message.tone === "success")
            toast.success(message.title, { description: message.description });
          else toast.warning(message.title, { description: message.description });
          setResolution("not_placed");
          setDuration("");
          setAttemptId("");
          setCheckedInSarvam(false);
          await refetch();
        }}
      />

      <ReasonDialog
        open={finalizing !== null}
        onOpenChange={(open) => {
          if (!open) setFinalizing(null);
        }}
        title="Retry billing and campaign update"
        description="This call's outcome is recorded, but its charge and/or campaign update didn't finish. Retrying is safe: each step runs at most once, so nothing is charged or applied twice."
        confirmLabel="Retry"
        extra={
          finalizing?.finalizationError ? (
            <p className="text-xs text-muted-foreground">
              Last error: {finalizing.finalizationError}
            </p>
          ) : null
        }
        onConfirm={async (reason) => {
          if (!finalizing) return;
          const result = await retryFinalization({ data: { callId: finalizing.id, reason } });
          if (result.state === "done") toast.success("Billing and campaign update finished");
          else toast.error("It failed again — see the error on the call");
          await refetch();
        }}
      />
    </div>
  );
}
