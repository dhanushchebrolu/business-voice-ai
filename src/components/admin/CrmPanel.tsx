import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listCrm, addCrmNote, updateClientProfile } from "@/lib/admin-clients.functions";
import { CRM_STAGES } from "@/lib/lifecycle";
import { SectionCard, EmptyState, StatusPill } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** CRM notes, follow-ups and the customer timeline built from real events. */
export function CrmPanel({
  orgId,
  stage,
  followUpAt,
  onChanged,
}: {
  orgId: string;
  stage: string;
  followUpAt: string | null;
  onChanged: () => Promise<void> | void;
}) {
  const fetchCrm = useServerFn(listCrm);
  const addNote = useServerFn(addCrmNote);
  const updateClient = useServerFn(updateClientProfile);

  const [body, setBody] = useState("");
  const [followUp, setFollowUp] = useState(followUpAt ? followUpAt.slice(0, 10) : "");
  const [busy, setBusy] = useState(false);

  const { data, refetch } = useQuery({
    queryKey: ["admin-crm", orgId],
    queryFn: () => fetchCrm({ data: { orgId } }),
  });

  return (
    <div className="space-y-6">
      <SectionCard title="Pipeline" description="Where this client sits in your sales pipeline.">
        <div className="flex flex-wrap gap-2">
          {CRM_STAGES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={stage === s ? "default" : "outline"}
              disabled={stage === s}
              onClick={async () => {
                await updateClient({ data: { orgId, patch: { crm_stage: s } } });
                toast.success("Pipeline stage updated");
                await onChanged();
              }}
              className="capitalize"
            >
              {s}
            </Button>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Notes & follow-up" description="Internal only — customers never see these.">
        <div className="space-y-3">
          <Textarea rows={3} placeholder="Add a note…" value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Follow-up date</Label>
              <Input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
            </div>
            <Button
              size="sm"
              disabled={busy || !body.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await addNote({
                    data: { orgId, body, followUpAt: followUp ? new Date(followUp).toISOString() : null },
                  });
                  setBody("");
                  toast.success("Note saved");
                  await refetch();
                  await onChanged();
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Could not save note");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save note
            </Button>
          </div>
        </div>

        <div className="mt-5">
          {data?.notes.length ? (
            <ul className="divide-y divide-border">
              {data.notes.map((n) => (
                <li key={n.id} className="py-2.5 text-sm">
                  <p>{n.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {n.admin_email ?? "admin"} · {new Date(n.created_at).toLocaleString()}
                    {n.follow_up_at ? ` · follow up ${new Date(n.follow_up_at).toLocaleDateString()}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No notes yet" description="Log calls, emails and commitments here." />
          )}
        </div>
      </SectionCard>

      <SectionCard title="Timeline" description="Recorded automatically as the client moves through their lifecycle.">
        {data?.events.length ? (
          <ul className="space-y-3">
            {data.events.map((e) => (
              <li key={e.id} className="flex gap-3 text-sm">
                <StatusPill tone="idle">{e.kind}</StatusPill>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{e.title}</p>
                  {e.detail ? <p className="text-xs text-muted-foreground">{e.detail}</p> : null}
                </div>
                <span className="whitespace-nowrap text-xs text-muted-foreground tabular">
                  {new Date(e.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No activity yet" description="Lifecycle changes, payments and access events appear here." />
        )}
      </SectionCard>
    </div>
  );
}
