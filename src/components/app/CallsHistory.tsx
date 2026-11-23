import { useMemo, useState } from "react";
import { PhoneCall, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import type { CustomerCallRow } from "@/lib/workspace";
import { EmptyState, LoadingState, StatusPill, SectionCard } from "@/components/app/primitives";
import { languageLabel } from "@/lib/voices";
import { formatMoney } from "@/lib/pricing";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CallContextSnapshot } from "@/components/app/CallContextSnapshot";
import {
  callCounterpart,
  callOutcomeLabel,
  callStatusLabel,
  callStatusTone,
} from "@/lib/call-history";

type TranscriptTurn = { role?: string; speaker?: string; text?: string; content?: string };

/**
 * The customer's call history: the table (inbound and outbound, by the other
 * party), and a sheet with one call's detail and transcript. Presentational:
 * the Calls page passes the rows it read through the customer's own client.
 */
export function CallsHistory({
  calls,
  isLoading,
  query,
}: {
  calls: CustomerCallRow[] | undefined;
  isLoading: boolean;
  query: string;
}) {
  const [selected, setSelected] = useState<CustomerCallRow | null>(null);
  const q = query;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return calls ?? [];
    return (calls ?? []).filter((c) =>
      [callCounterpart(c), c.caller_name, c.summary, c.outcome].some((v) =>
        v?.toLowerCase().includes(term),
      ),
    );
  }, [calls, q]);

  const turns = ((selected?.transcript as TranscriptTurn[] | null) ?? []).filter(Boolean);

  return (
    <>
      {isLoading ? (
        <LoadingState label="Loading calls" />
      ) : filtered.length ? (
        <SectionCard
          title={`${filtered.length} calls`}
          description="Select a call to read the transcript."
        >
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Contact</th>
                  <th className="px-3 py-2 font-medium">Started</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Language</th>
                  <th className="px-3 py-2 font-medium">Outcome</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((call) => (
                  <tr
                    key={call.id}
                    onClick={() => setSelected(call)}
                    className="cursor-pointer border-b border-border/60 transition-colors hover:bg-accent/40"
                  >
                    <td className="px-5 py-2.5">
                      <p className="flex items-center gap-1.5 font-medium">
                        {call.direction === "outbound" ? (
                          <PhoneOutgoing
                            className="size-3.5 text-muted-foreground"
                            aria-label="Outbound"
                          />
                        ) : (
                          <PhoneIncoming
                            className="size-3.5 text-muted-foreground"
                            aria-label="Inbound"
                          />
                        )}
                        {callCounterpart(call)}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {call.summary ?? "No summary"}
                      </p>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground tabular">
                      {new Date(call.started_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 tabular text-xs">
                      {call.billing_hold ? "—" : formatDuration(call.duration_seconds)}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {call.language ? languageLabel(call.language) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-xs">{callOutcomeLabel(call.outcome)}</td>
                    <td className="px-5 py-2.5">
                      <StatusPill tone={callStatusTone(call.status)} dot={false}>
                        {callStatusLabel(call.status)}
                      </StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : (
        <EmptyState
          icon={PhoneCall}
          title={q ? "No matching calls" : "No calls yet"}
          description={
            q
              ? "Try a different caller number or keyword."
              : "Calls appear here as soon as a connected phone number routes to your published receptionist."
          }
        />
      )}

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{selected ? callCounterpart(selected) : "Call detail"}</SheetTitle>
          </SheetHeader>
          {selected ? (
            <div className="space-y-5 px-4 pb-8">
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <Meta label="Started" value={new Date(selected.started_at).toLocaleString()} />
                <Meta
                  label="Duration"
                  value={
                    selected.billing_hold
                      ? "Being verified"
                      : formatDuration(selected.duration_seconds)
                  }
                />
                <Meta label="Direction" value={selected.direction} />
                <Meta label="Status" value={callStatusLabel(selected.status)} />
                <Meta
                  label="Language"
                  value={selected.language ? languageLabel(selected.language) : "—"}
                />
                <Meta label="Outcome" value={callOutcomeLabel(selected.outcome)} />
                <Meta
                  label="Agent version"
                  value={selected.agent_version ? `v${selected.agent_version}` : "—"}
                />
                {selected.billing_hold ? (
                  // F3: connected, duration not yet verified; never shown (or billed) as ₹0.
                  <Meta label="Charge" value="Pending: call length being verified" />
                ) : selected.customer_charge != null ? (
                  <Meta
                    label="Charge"
                    value={formatMoney(selected.customer_charge, selected.currency ?? "INR")}
                  />
                ) : null}
              </dl>

              {selected.status === "outcome_unknown" ? (
                <p className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm">
                  We couldn't confirm whether this call went through. Our team checks it with the
                  phone provider; you are only charged if it connected.
                </p>
              ) : null}

              {selected.summary ? (
                <div className="rounded-md border border-border bg-surface/50 p-3 text-sm">
                  <p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                    Summary
                  </p>
                  {selected.summary}
                </div>
              ) : null}

              {selected.direction === "outbound" ? (
                <CallContextSnapshot callId={selected.id} scope="member" />
              ) : null}

              {selected.recording_url ? (
                <audio controls src={selected.recording_url} className="w-full">
                  <track kind="captions" />
                </audio>
              ) : null}

              <div>
                <p className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Transcript
                </p>
                {turns.length ? (
                  <div className="space-y-2">
                    {turns.map((turn, i) => (
                      <div key={i} className="rounded-md border border-border px-3 py-2 text-sm">
                        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                          {turn.role ?? turn.speaker ?? "speaker"}
                        </p>
                        <p className="mt-0.5">{turn.text ?? turn.content}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No transcript was stored for this call.
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}

/** "—" when no duration was recorded (not connected, or not confirmed yet), never a fake 0m 00s. */
function formatDuration(seconds: number | null) {
  if (seconds === null || seconds === undefined) return "—";
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
