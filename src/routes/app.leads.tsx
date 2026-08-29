import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, leadsQuery } from "@/lib/workspace";
import { supabase } from "@/integrations/supabase/client";
import { getBusinessType } from "@/lib/business-types";
import { PageHeader, EmptyState, LoadingState, SectionCard, StatusPill } from "@/components/app/primitives";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const STATUSES = ["new", "contacted", "qualified", "won", "lost"];

export const Route = createFileRoute("/app/leads")({
  head: () => ({
    meta: [
      { title: "Leads — Vaani" },
      { name: "description", content: "Contacts your AI receptionist captured from inbound calls." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LeadsPage,
});

function LeadsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const { data: leads, isLoading } = useQuery(leadsQuery(ws?.organization?.id));
  const type = getBusinessType(ws?.business?.business_type);

  async function updateStatus(id: string, status: string) {
    const { error } = await supabase.from("leads").update({ status }).eq("id", id);
    if (error) {
      toast.error("Could not update this contact.");
      return;
    }
    await qc.invalidateQueries({ queryKey: ["leads"] });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={type.customerLabel}
        description="Contacts captured by the receptionist during calls. Update status as your team follows up."
      />

      {isLoading ? (
        <LoadingState label="Loading contacts" />
      ) : leads?.length ? (
        <SectionCard title={`${leads.length} contacts`}>
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Contact</th>
                  <th className="px-3 py-2 font-medium">Asked about</th>
                  <th className="px-3 py-2 font-medium">Score</th>
                  <th className="px-3 py-2 font-medium">Captured</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id} className="border-b border-border/60">
                    <td className="px-5 py-2.5 font-medium">{lead.name ?? "Unnamed"}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{lead.phone ?? lead.email ?? "—"}</td>
                    <td className="max-w-[240px] truncate px-3 py-2.5 text-muted-foreground">{lead.asked_about ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      <StatusPill tone={lead.score === "hot" ? "accent" : lead.score === "warm" ? "ready" : "idle"} dot={false}>
                        {lead.score}
                      </StatusPill>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground tabular">
                      {new Date(lead.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-2.5">
                      <Select value={lead.status} onValueChange={(v) => updateStatus(lead.id, v)}>
                        <SelectTrigger className="h-8 w-[130px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {STATUSES.map((s) => (
                            <SelectItem key={s} value={s} className="text-xs capitalize">
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : (
        <EmptyState
          icon={Users}
          title="No contacts captured yet"
          description="When a caller shares their name, number or what they need, the receptionist records it here automatically."
        />
      )}
    </div>
  );
}
