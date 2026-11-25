import { createFileRoute, Link } from "@tanstack/react-router";
import {
  configEditBlockedReason,
  describeImportResult,
  describeUploadRow,
  IMPORT_TOO_LARGE_MESSAGE,
  MAX_IMPORT_ROWS,
} from "@/lib/campaign-wizard";
import { newCampaignCreateKey } from "@/lib/campaign-create-key";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Pencil, Upload, Users2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  campaignQuery,
  campaignContactsQuery,
  campaignUploadsQuery,
  type CampaignRow,
} from "@/lib/workspace";
import { csvToTable, validateContactRows } from "@/lib/contacts-import";
import {
  CampaignSetupPill,
  CampaignStatusPill,
  formatDateTime,
} from "@/components/app/CampaignStatus";
import { importCampaignContactsCsv } from "@/lib/campaign-contacts.functions";
import { pauseCampaign, cancelCampaign } from "@/lib/campaigns.functions";
import {
  PageHeader,
  SectionCard,
  StatusPill,
  EmptyState,
  LoadingState,
  ErrorState,
} from "@/components/app/primitives";
import { describeQueryError } from "@/lib/query-error";
import { CampaignContextPanel, CampaignInsights } from "@/components/app/CampaignContextPanel";
import { CampaignAnalytics } from "@/components/app/CampaignAnalytics";
import {
  CampaignLaunchButton,
  CampaignLaunchChecklist,
} from "@/components/app/CampaignLaunchControl";
import { campaignReadinessKey } from "@/lib/campaign-wizard";
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
  head: () => ({ meta: [{ title: "Campaign — ClickAI" }, { name: "robots", content: "noindex" }] }),
  component: CampaignDetailPage,
});

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
  excluded: "error",
  outcome_unknown: "idle",
};

function CampaignDetailPage() {
  const { campaignId } = Route.useParams();
  const qc = useQueryClient();
  const {
    data: campaign,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery(campaignQuery(campaignId));
  const {
    data: contacts,
    isError: contactsIsError,
    error: contactsError,
    refetch: refetchContacts,
  } = useQuery(campaignContactsQuery(campaignId));

  const [uploadOpen, setUploadOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [csvText, setCsvText] = useState("");
  const [phoneColumn, setPhoneColumn] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [importKey, setImportKey] = useState(() => newCampaignCreateKey());
  const [actionPending, setActionPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    for (const c of contacts ?? []) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    return byStatus;
  }, [contacts]);
  const total = contacts?.length ?? 0;
  // The same validation the server re-runs on import, shown before anything is written.
  const uploadPreview = useMemo(
    () => (csvText && phoneColumn ? validateContactRows(csvToTable(csvText), phoneColumn) : null),
    [csvText, phoneColumn],
  );
  // Same cap the server enforces (one import = one transaction under an 8 s timeout).
  const tooLarge = (uploadPreview?.totalRows ?? 0) > MAX_IMPORT_ROWS;

  async function invalidate() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["campaign", campaignId] }),
      qc.invalidateQueries({ queryKey: ["campaign-contacts", campaignId] }),
      qc.invalidateQueries({ queryKey: ["campaign-eligibility", campaignId] }),
      qc.invalidateQueries({ queryKey: ["campaign-stats", campaignId] }),
      qc.invalidateQueries({ queryKey: ["campaign-uploads", campaignId] }),
      qc.invalidateQueries({ queryKey: ["campaigns"] }),
      qc.invalidateQueries({ queryKey: campaignReadinessKey(campaignId) }),
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
    // One import attempt per chosen file: retries (double click, timeout, lost response)
    // send the same key and get the first result back instead of a second import.
    setImportKey(newCampaignCreateKey());
    setUploadOpen(true);
  }

  async function doImport() {
    if (!file || !phoneColumn || importing) return;
    setImporting(true);
    try {
      const result = await importCampaignContactsCsv({
        data: {
          campaignId,
          filename: file.name,
          csvText,
          phoneColumn,
          mapping,
          idempotencyKey: importKey,
        },
      });
      toast.success(describeImportResult(result));
      setUploadOpen(false);
      await invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setImporting(false);
    }
  }

  // These start/stop a real outbound-calling campaign — never idempotent,
  // so they must never auto-retry and must never be fireable twice
  // concurrently from a double click while the first call is in flight.
  async function runAction(action: () => Promise<unknown>, successMessage: string) {
    if (actionPending) return;
    setActionPending(true);
    try {
      await action();
      toast.success(successMessage);
      await invalidate();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setActionPending(false);
    }
  }
  const doPause = () =>
    runAction(() => pauseCampaign({ data: { campaignId } }), "Campaign paused.");
  const doCancel = () => {
    if (
      !confirm(
        "Cancel this campaign? Contacts not yet called will not be dialed. Calls already in progress are not hung up; they finish normally.",
      )
    )
      return;
    void runAction(() => cancelCampaign({ data: { campaignId } }), "Campaign cancelled.");
  };

  if (isLoading) return <LoadingState label="Loading campaign" />;
  if (isError) {
    return (
      <ErrorState
        message={describeQueryError(error, "Could not load this campaign.")}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!campaign) return <EmptyState icon={Users2} title="Campaign not found" description="" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={campaign.name}
        description={campaign.objective ?? "No objective set."}
        actions={
          // Wraps onto further rows on narrow screens instead of running off the page.
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <CampaignStatusPill status={campaign.status} />
            {campaign.status === "draft" ? (
              <CampaignSetupPill reviewedAt={campaign.context_reviewed_at} />
            ) : null}
            {configEditBlockedReason(campaign.status) ? null : (
              <Link to="/app/campaigns/$campaignId/edit" params={{ campaignId }}>
                <Button size="sm" variant="secondary">
                  <Pencil className="mr-1.5 size-3.5" /> Edit configuration
                </Button>
              </Link>
            )}
            {["draft", "scheduled", "paused"].includes(campaign.status) ? (
              // Enabled only when every server-side launch check passes
              // (campaign-launch-readiness.server.ts); launchCampaign re-runs them.
              <CampaignLaunchButton
                campaignId={campaignId}
                status={campaign.status}
                onLaunched={invalidate}
              />
            ) : null}
            {campaign.status === "running" ? (
              <Button size="sm" variant="secondary" onClick={doPause} disabled={actionPending}>
                Pause
              </Button>
            ) : null}
            {!["completed", "cancelled"].includes(campaign.status) ? (
              <Button size="sm" variant="ghost" onClick={doCancel} disabled={actionPending}>
                Cancel
              </Button>
            ) : null}
          </div>
        }
      />

      {["draft", "scheduled", "paused"].includes(campaign.status) ? (
        <CampaignLaunchChecklist campaignId={campaignId} />
      ) : null}

      <CampaignConfiguration campaign={campaign} />

      <CampaignContextPanel campaign={campaign} onSaved={invalidate} />

      <CampaignInsights campaignId={campaignId} status={campaign.status} onChanged={invalidate} />

      <CampaignAnalytics campaignId={campaignId} />

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
        {contactsIsError ? (
          <ErrorState
            message={describeQueryError(contactsError, "Could not load enrolled contacts.")}
            onRetry={() => void refetchContacts()}
          />
        ) : total ? (
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

      <div className="grid gap-6 lg:grid-cols-2">
        <ImportHistory campaignId={campaignId} />
        <CampaignActivity campaign={campaign} />
      </div>

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
          {uploadPreview ? (
            <p className="text-sm" aria-live="polite">
              {uploadPreview.totalRows} rows: {uploadPreview.valid.length} valid,{" "}
              {uploadPreview.invalid.length} invalid (not added), {uploadPreview.duplicates.length}{" "}
              duplicate (added once). Opted-out contacts are skipped.
            </p>
          ) : null}
          {tooLarge ? (
            <p className="text-sm text-destructive" role="alert">
              {IMPORT_TOO_LARGE_MESSAGE}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={doImport}
              disabled={importing || !phoneColumn || !uploadPreview?.valid.length || tooLarge}
            >
              {importing ? "Importing…" : "Import contacts"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** What this campaign is set to do, read from the saved row only. */
function CampaignConfiguration({ campaign }: { campaign: CampaignRow }) {
  const { data: names } = useQuery({
    queryKey: [
      "campaign-config-names",
      campaign.id,
      campaign.agent_config_id,
      campaign.phone_number_id,
    ],
    queryFn: async () => {
      const [agent, number] = await Promise.all([
        campaign.agent_config_id
          ? supabase
              .from("agent_configs")
              .select("agent_name")
              .eq("id", campaign.agent_config_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        campaign.phone_number_id
          ? supabase
              .from("phone_numbers")
              .select("e164")
              .eq("id", campaign.phone_number_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      return {
        agent: (agent.data as { agent_name: string | null } | null)?.agent_name ?? null,
        number: (number.data as { e164: string } | null)?.e164 ?? null,
      };
    },
  });
  const s = (campaign.schedule ?? {}) as {
    startDate?: string;
    endDate?: string;
    windowStart?: string;
    windowEnd?: string;
    days?: number[];
    timezone?: string;
  };
  const days =
    s.days?.length && s.days.length < 7
      ? [...s.days]
          .sort()
          .map((d) => DAY_NAMES[d])
          .join(", ")
      : "Every day";
  const rows: [string, string][] = [
    ["Agent", campaign.agent_config_id ? (names?.agent ?? "Your AI receptionist") : "Not chosen"],
    ["Caller number", campaign.phone_number_id ? (names?.number ?? "…") : "Not chosen"],
    ["Starts", s.startDate ?? "When launched"],
    ["Ends", s.endDate ?? "No end date"],
    ["Calling days", days],
    [
      "Calling hours",
      s.windowStart && s.windowEnd
        ? `${s.windowStart}–${s.windowEnd} (${s.timezone ?? "Asia/Kolkata"})`
        : "09:00–21:00 India time",
    ],
    ["Attempts per contact", String(campaign.max_attempts)],
    [
      "Retries",
      campaign.max_attempts > 1 && campaign.retry_statuses?.length
        ? `After ${campaign.retry_after_minutes} min, when ${campaign.retry_statuses.join(", ").replace(/_/g, " ")}`
        : "No retries",
    ],
    [
      "Budget",
      campaign.budget_limit
        ? `₹${(campaign.budget_limit / 100).toLocaleString("en-IN")}`
        : "No limit",
    ],
  ];
  const blocked = configEditBlockedReason(campaign.status);
  return (
    <SectionCard
      title="Configuration"
      {...(campaign.description ? { description: campaign.description } : {})}
      actions={
        blocked ? (
          <span className="text-xs text-muted-foreground">{blocked}</span>
        ) : (
          <Link
            to="/app/campaigns/$campaignId/edit"
            params={{ campaignId: campaign.id }}
            className="text-sm font-medium text-info hover:underline"
          >
            Edit
          </Link>
        )
      }
    >
      {!campaign.phone_number_id && !blocked ? (
        <p className="mb-3 text-xs text-warning">
          No caller number yet. Edit the configuration to choose one; it is needed before calls can
          start.
        </p>
      ) : null}
      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-border/50 py-1">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-right">{v}</dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}

function ImportHistory({ campaignId }: { campaignId: string }) {
  const { data: uploads, isError, refetch } = useQuery(campaignUploadsQuery(campaignId));
  return (
    <SectionCard title="Contact imports">
      {isError ? (
        <ErrorState message="Could not load import history." onRetry={() => void refetch()} />
      ) : uploads?.length ? (
        <ul className="divide-y divide-border text-sm">
          {uploads.map((u) => (
            <li key={u.id} className="py-2">
              <p className="font-medium">{u.filename ?? "Import"}</p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(u.created_at)} · {describeUploadRow(u)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No contacts imported yet.</p>
      )}
    </SectionCard>
  );
}

/** Only events the campaign row actually records. */
function CampaignActivity({ campaign }: { campaign: CampaignRow }) {
  const events = (
    [
      ["Created", campaign.created_at],
      ["Call instructions confirmed", campaign.context_reviewed_at],
      ["Launched", campaign.launched_at],
      ["Paused", campaign.paused_at],
      ["Completed", campaign.completed_at],
      ["Cancelled", campaign.cancelled_at],
    ] as [string, string | null][]
  )
    .filter(([, at]) => Boolean(at))
    .sort((a, b) => (a[1]! < b[1]! ? -1 : 1));
  return (
    <SectionCard title="Activity">
      <ol className="space-y-2 text-sm">
        {events.map(([label, at]) => (
          <li key={label} className="flex justify-between gap-3">
            <span>{label}</span>
            <span className="text-xs text-muted-foreground tabular">{formatDateTime(at)}</span>
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}
