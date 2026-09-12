import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Upload, Users2 } from "lucide-react";
import { campaignQuery, campaignContactsQuery } from "@/lib/workspace";
import { csvToTable } from "@/lib/contacts-import";
import { importCampaignContactsCsv } from "@/lib/campaign-contacts.functions";
import {
  launchCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
} from "@/lib/campaigns.functions";
import {
  PageHeader,
  SectionCard,
  StatusPill,
  EmptyState,
  LoadingState,
} from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/app/campaigns/$campaignId")({
  head: () => ({ meta: [{ title: "Campaign — Vaani" }, { name: "robots", content: "noindex" }] }),
  component: CampaignDetailPage,
});

const STATUS_TONE: Record<string, "live" | "ready" | "idle" | "error"> = {
  draft: "idle",
  scheduled: "ready",
  queued: "ready",
  running: "live",
  paused: "idle",
  completed: "ready",
  failed: "error",
  cancelled: "error",
};

const CONTACT_STATUS_TONE: Record<string, "live" | "ready" | "idle" | "error"> = {
  pending: "idle",
  queued: "ready",
  calling: "ready",
  connected: "live",
  completed: "live",
  no_answer: "idle",
  busy: "idle",
  retry_scheduled: "ready",
  failed: "error",
  opted_out: "error",
  wrong_number: "error",
  cancelled: "error",
};

function CampaignDetailPage() {
  const { campaignId } = Route.useParams();
  const qc = useQueryClient();
  const { data: campaign, isLoading } = useQuery(campaignQuery(campaignId));
  const { data: contacts } = useQuery(campaignContactsQuery(campaignId));

  const [uploadOpen, setUploadOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [csvText, setCsvText] = useState("");
  const [phoneColumn, setPhoneColumn] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    for (const c of contacts ?? []) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    return byStatus;
  }, [contacts]);
  const total = contacts?.length ?? 0;

  async function invalidate() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["campaign", campaignId] }),
      qc.invalidateQueries({ queryKey: ["campaign-contacts", campaignId] }),
    ]);
  }

  async function handleFile(f: File) {
    const text = await f.text();
    const table = csvToTable(text);
    setFile(f);
    setCsvText(text);
    setHeaders(table.headers);
    const guess = table.headers.find((h) => /phone/i.test(h)) ?? table.headers[0] ?? "";
    setPhoneColumn(guess);
    setMapping({});
    setUploadOpen(true);
  }

  async function doImport() {
    if (!file || !phoneColumn) return;
    setImporting(true);
    try {
      const result = await importCampaignContactsCsv({
        data: { campaignId, filename: file.name, csvText, phoneColumn, mapping },
      });
      toast.success(
        `Imported ${result.enrolled} contacts. ${result.optedOut} opted out (skipped), ${result.alreadyInCampaign} already in this campaign, ${result.invalid} invalid, ${result.duplicatesInFile} duplicate rows.`,
      );
      setUploadOpen(false);
      await invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setImporting(false);
    }
  }

  async function doLaunch() {
    try {
      await launchCampaign({ data: { campaignId } });
      toast.success("Campaign launched — calls will begin within the scheduled window.");
      await invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  async function doPause() {
    try {
      await pauseCampaign({ data: { campaignId } });
      toast.success("Campaign paused.");
      await invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  async function doResume() {
    try {
      await resumeCampaign({ data: { campaignId } });
      toast.success("Campaign resumed.");
      await invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  async function doCancel() {
    if (!confirm("Cancel this campaign? Contacts not yet called will not be dialed.")) return;
    try {
      await cancelCampaign({ data: { campaignId } });
      toast.success("Campaign cancelled.");
      await invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (isLoading) return <LoadingState label="Loading campaign" />;
  if (!campaign) return <EmptyState icon={Users2} title="Campaign not found" description="" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={campaign.name}
        description={campaign.objective ?? "No objective set."}
        actions={
          <div className="flex items-center gap-2">
            <StatusPill tone={STATUS_TONE[campaign.status] ?? "idle"} dot={false}>
              {campaign.status}
            </StatusPill>
            {["draft", "scheduled", "paused"].includes(campaign.status) ? (
              <Button size="sm" onClick={doLaunch}>
                {campaign.status === "paused" ? "Resume" : "Launch campaign"}
              </Button>
            ) : null}
            {campaign.status === "running" ? (
              <Button size="sm" variant="secondary" onClick={doPause}>
                Pause
              </Button>
            ) : null}
            {!["completed", "cancelled"].includes(campaign.status) ? (
              <Button size="sm" variant="ghost" onClick={doCancel}>
                Cancel
              </Button>
            ) : null}
          </div>
        }
      />

      <SectionCard title="Progress" description={`${total} contacts enrolled`}>
        <div className="flex flex-wrap gap-2">
          {Object.entries(stats).map(([status, count]) => (
            <StatusPill key={status} tone={CONTACT_STATUS_TONE[status] ?? "idle"} dot={false}>
              {status.replace("_", " ")}: {count}
            </StatusPill>
          ))}
          {total === 0 ? (
            <p className="text-sm text-muted-foreground">No contacts enrolled yet.</p>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="Contacts"
        actions={
          <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()}>
            <Upload className="mr-1.5 size-3.5" /> Upload CSV
          </Button>
        }
      >
        {total ? (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Contact</th>
                  <th className="px-3 py-2 font-medium">Attempts</th>
                  <th className="px-3 py-2 font-medium">Outcome</th>
                  <th className="px-5 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {contacts!.map((cc) => (
                  <tr key={cc.id} className="border-b border-border/60">
                    <td className="px-5 py-2.5">
                      <p className="font-medium">{cc.contacts?.name ?? "Unnamed"}</p>
                      <p className="text-xs text-muted-foreground">{cc.contacts?.phone}</p>
                    </td>
                    <td className="px-3 py-2.5 tabular text-xs">{cc.attempts}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {cc.outcome ?? "—"}
                    </td>
                    <td className="px-5 py-2.5">
                      <StatusPill tone={CONTACT_STATUS_TONE[cc.status] ?? "idle"} dot={false}>
                        {cc.status.replace("_", " ")}
                      </StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={Users2}
            title="No contacts yet"
            description="Upload a CSV of phone numbers to enroll them in this campaign."
          />
        )}
      </SectionCard>

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) handleFile(f);
        }}
      />

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Map your columns</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Which column is the phone number?</Label>
              <Select value={phoneColumn} onValueChange={setPhoneColumn}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {headers.map((h) => (
                    <SelectItem key={h} value={h}>
                      {h}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Map other columns to variables the AI can use on the call</Label>
              {headers
                .filter((h) => h !== phoneColumn)
                .map((h) => (
                  <div key={h} className="flex items-center gap-2">
                    <span className="w-32 truncate text-xs text-muted-foreground">{h}</span>
                    <Input
                      placeholder="e.g. customer_name"
                      value={mapping[h] ?? ""}
                      onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))}
                    />
                  </div>
                ))}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={doImport} disabled={importing || !phoneColumn}>
              {importing ? "Importing…" : "Import contacts"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
