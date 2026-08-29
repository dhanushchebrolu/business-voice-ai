import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { PhoneCall, Search } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, callsQuery, type CallRow } from "@/lib/workspace";
import { PageHeader, EmptyState, LoadingState, StatusPill, SectionCard } from "@/components/app/primitives";
import { languageLabel } from "@/lib/voices";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export const Route = createFileRoute("/app/calls")({
  head: () => ({
    meta: [
      { title: "Calls — Vaani" },
      { name: "description", content: "Review every answered call, transcript and outcome." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: CallsPage,
});

type TranscriptTurn = { role?: string; speaker?: string; text?: string; content?: string };

function CallsPage() {
  const { user } = useAuth();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const { data: calls, isLoading } = useQuery(callsQuery(ws?.organization?.id));
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<CallRow | null>(null);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return calls ?? [];
    return (calls ?? []).filter((c) =>
      [c.caller_number, c.caller_name, c.summary, c.outcome].some((v) => v?.toLowerCase().includes(term)),
    );
  }, [calls, q]);

  const turns = ((selected?.transcript as TranscriptTurn[] | null) ?? []).filter(Boolean);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calls"
        description="Every call your receptionist handled, with duration, language, outcome and full transcript."
        actions={
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search calls" className="h-9 w-56 pl-8" />
          </div>
        }
      />

      {isLoading ? (
        <LoadingState label="Loading calls" />
      ) : filtered.length ? (
        <SectionCard title={`${filtered.length} calls`} description="Select a call to read the transcript.">
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Caller</th>
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
                      <p className="font-medium">{call.caller_number ?? "Unknown"}</p>
                      <p className="truncate text-xs text-muted-foreground">{call.summary ?? "No summary"}</p>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground tabular">
                      {new Date(call.started_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 tabular text-xs">{formatDuration(call.duration_seconds)}</td>
                    <td className="px-3 py-2.5 text-xs">{call.language ? languageLabel(call.language) : "—"}</td>
                    <td className="px-3 py-2.5 text-xs">{call.outcome ?? "—"}</td>
                    <td className="px-5 py-2.5">
                      <StatusPill tone={call.status === "completed" ? "live" : call.status === "failed" ? "error" : "idle"} dot={false}>
                        {call.status}
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
            <SheetTitle>{selected?.caller_number ?? "Call detail"}</SheetTitle>
          </SheetHeader>
          {selected ? (
            <div className="space-y-5 px-4 pb-8">
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <Meta label="Started" value={new Date(selected.started_at).toLocaleString()} />
                <Meta label="Duration" value={formatDuration(selected.duration_seconds)} />
                <Meta label="Direction" value={selected.direction} />
                <Meta label="Language" value={selected.language ? languageLabel(selected.language) : "—"} />
                <Meta label="Outcome" value={selected.outcome ?? "—"} />
                <Meta label="Agent version" value={selected.agent_version ? `v${selected.agent_version}` : "—"} />
              </dl>

              {selected.summary ? (
                <div className="rounded-md border border-border bg-surface/50 p-3 text-sm">
                  <p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">Summary</p>
                  {selected.summary}
                </div>
              ) : null}

              {selected.recording_url ? (
                <audio controls src={selected.recording_url} className="w-full">
                  <track kind="captions" />
                </audio>
              ) : null}

              <div>
                <p className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">Transcript</p>
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
                  <p className="text-sm text-muted-foreground">No transcript was stored for this call.</p>
                )}
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
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

function formatDuration(seconds: number | null) {
  const s = seconds ?? 0;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
