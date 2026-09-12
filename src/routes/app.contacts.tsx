import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Contact, Search, Upload, PhoneOff } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, contactsQuery, type ContactRow } from "@/lib/workspace";
import { supabase } from "@/integrations/supabase/client";
import { csvToTable, validateContactRows } from "@/lib/contacts-import";
import {
  PageHeader,
  EmptyState,
  LoadingState,
  SectionCard,
  StatusPill,
} from "@/components/app/primitives";
import { ServiceLocked } from "@/components/app/ServiceLocked";
import { featureLocksQuery } from "@/lib/access";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/app/contacts")({
  head: () => ({
    meta: [
      { title: "Contacts — Vaani" },
      { name: "description", content: "Your customer list — upload once, call in any campaign." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ContactsPage,
});

function ContactsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const orgId = ws?.organization?.id;
  const { data: contacts, isLoading } = useQuery(contactsQuery(orgId));
  const { data: locks } = useQuery(featureLocksQuery(orgId));
  const phoneLocked = locks?.["phone"] === true;
  const lifecycle = ws?.organization?.lifecycle_status ?? "not_provisioned";

  const [q, setQ] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return contacts ?? [];
    return (contacts ?? []).filter((c) =>
      [c.name, c.phone, c.email].some((v) => v?.toLowerCase().includes(term)),
    );
  }, [contacts, q]);

  async function toggleOptOut(contact: ContactRow) {
    const { error } = await supabase
      .from("contacts")
      .update({
        opted_out: !contact.opted_out,
        opted_out_at: !contact.opted_out ? new Date().toISOString() : null,
        opted_out_reason: !contact.opted_out ? "Manually marked do-not-call" : null,
      })
      .eq("id", contact.id);
    if (error) {
      toast.error("Could not update this contact.");
      return;
    }
    await qc.invalidateQueries({ queryKey: ["contacts", orgId] });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contacts"
        description="Your customer list, independent of any one campaign. Upload once — call from any campaign."
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search contacts"
                className="h-9 w-48 pl-8"
              />
            </div>
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              <Upload className="mr-1.5 size-3.5" /> Upload CSV
            </Button>
          </div>
        }
      />

      {phoneLocked ? <ServiceLocked feature="phone" lifecycle={lifecycle} compact /> : null}

      {isLoading ? (
        <LoadingState label="Loading contacts" />
      ) : filtered.length ? (
        <SectionCard title={`${filtered.length} contacts`}>
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Phone</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Added</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-b border-border/60">
                    <td className="px-5 py-2.5 font-medium">{c.name ?? "Unnamed"}</td>
                    <td className="px-3 py-2.5 tabular text-muted-foreground">{c.phone}</td>
                    <td className="px-3 py-2.5 text-xs capitalize text-muted-foreground">
                      {c.source.replace("_", " ")}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground tabular">
                      {new Date(c.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-5 py-2.5">
                      <button onClick={() => toggleOptOut(c)} className="inline-flex">
                        <StatusPill tone={c.opted_out ? "error" : "live"} dot={false}>
                          {c.opted_out ? (
                            <span className="inline-flex items-center gap-1">
                              <PhoneOff className="size-3" /> Do not call
                            </span>
                          ) : (
                            "Callable"
                          )}
                        </StatusPill>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : (
        <EmptyState
          icon={Contact}
          title={q ? "No matching contacts" : "No contacts yet"}
          description={
            q
              ? "Try a different name or phone number."
              : "Upload a CSV to get started — you'll be able to use these contacts in any campaign."
          }
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file || !orgId) return;
          const text = await file.text();
          const table = csvToTable(text);
          const phoneColumn = table.headers.find((h) => /phone/i.test(h)) ?? table.headers[0] ?? "";
          const summary = validateContactRows(table, phoneColumn);

          let created = 0;
          let updated = 0;
          for (const row of summary.valid) {
            const { data: existing } = await supabase
              .from("contacts")
              .select("id")
              .eq("organization_id", orgId)
              .eq("phone", row.phone!)
              .maybeSingle();
            if (existing) {
              await supabase
                .from("contacts")
                .update({ custom_fields: row.fields as never })
                .eq("id", existing.id);
              updated++;
            } else {
              const { error } = await supabase.from("contacts").insert({
                organization_id: orgId,
                name: row.fields["name"] ?? row.fields["Name"] ?? null,
                phone: row.phone!,
                custom_fields: row.fields as never,
                source: "csv_import",
              });
              if (!error) created++;
            }
          }
          toast.success(
            `Imported ${created + updated} contacts (${created} new, ${updated} updated). ${summary.invalid.length} invalid, ${summary.duplicates.length} duplicate rows skipped.`,
          );
          await qc.invalidateQueries({ queryKey: ["contacts", orgId] });
        }}
      />

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload contacts</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Upload a CSV file. We'll auto-detect a phone number column, normalize numbers to E.164,
            and skip duplicates and invalid rows — nothing is silently discarded, you'll see exactly
            what was imported.
          </p>
          <DialogFooter>
            <Button
              onClick={() => {
                setUploadOpen(false);
                fileInputRef.current?.click();
              }}
            >
              Choose CSV file
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
