import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { OutboundConcurrencyCard } from "@/components/app/OutboundConcurrencyCard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, FileUp, Plus, Trash2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { workspaceQuery, numbersQuery } from "@/lib/workspace";
import { supabase } from "@/integrations/supabase/client";
import { describeQueryError } from "@/lib/query-error";
import { LANGUAGES } from "@/lib/voices";
import { importCampaignContactsCsv } from "@/lib/campaign-contacts.functions";
import { saveCampaignConfiguration } from "@/lib/campaigns.functions";
import {
  claimCampaignCreateKey,
  holdCampaignCreateKey,
  newCampaignCreateKey,
  releaseCampaignCreateKey,
} from "@/lib/campaign-create-key";
import { CONTEXT_LIMITS, platformCapabilities } from "@/lib/campaign-context";
import { MAX_RETRY_AFTER_MINUTES, MIN_RETRY_AFTER_MINUTES } from "@/lib/campaign-outcome";
import type { CampaignSchedule } from "@/lib/campaign-schedule";
import {
  DEFAULT_CONTROLS,
  PLATFORM_CALLING_HOURS,
  PLATFORM_PACING,
  WIZARD_STEPS,
  audienceImportMapping,
  audienceToCsv,
  budgetPaise,
  combineAudience,
  csvToTable,
  describeImportResult,
  callerNumberChoices,
  mappingProblems,
  openingLinePreview,
  previewAudience,
  reviewWarnings,
  toVariableName,
  validateAudience,
  validateControls,
  validateDetails,
  validateInstructions,
  validateSchedule,
  type ControlsStep,
  type CsvMapping,
  type DetailsStep,
  type InstructionsStep,
  type ManualContact,
  type ScheduleStep,
  type WizardState,
} from "@/lib/campaign-wizard";
import { PageHeader, SectionCard, StatusPill } from "@/components/app/primitives";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ParsedCsvTable } from "@/lib/contacts-import";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RETRY_OPTIONS = [
  { value: "no_answer", label: "No answer" },
  { value: "busy", label: "Busy" },
  { value: "failed", label: "Call failed" },
];
const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "UTC"];
const NONE = "__none__";
const AUDIENCE_STEP = 1;
const REVIEW_STEP = WIZARD_STEPS.length - 1;

const EMPTY_INSTRUCTIONS: InstructionsStep = {
  agentConfigId: "",
  language: "",
  audience: "",
  talkingPoints: "",
  questions: "",
  desiredOutcome: "",
  interestedHandling: "",
  uninterestedHandling: "",
  callbackHandling: "",
  closing: "",
  tone: "",
  extraInstructions: "",
};

/** What has already been written, so a retry after a partial failure never creates a second campaign. */
interface SaveProgress {
  campaignId: string | null;
  contactsImported: boolean;
  /** The wizard's one contact import: a retry sends the same key and gets the first result. */
  importKey: string;
  /** The campaign version this wizard last saw: an edit applies only to it. */
  updatedAt: string | null;
}

export interface CampaignWizardProps {
  /** create: all six steps. edit: an existing campaign's configuration (contacts are managed on its page). */
  mode: "create" | "edit";
  /** edit only */
  campaignId?: string;
  /** edit only: the saved configuration every field starts from */
  initial?: WizardState;
  /** edit only: the saved schedule, so unchanged dates already in the past stay valid */
  savedSchedule?: CampaignSchedule | null;
  /** edit only: the campaign's updated_at when it was loaded (optimistic concurrency) */
  loadedUpdatedAt?: string;
}

export function CampaignWizard({
  mode,
  campaignId,
  initial,
  savedSchedule,
  loadedUpdatedAt,
}: CampaignWizardProps) {
  const editing = mode === "edit";
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: ws } = useQuery(workspaceQuery(user?.id));
  const orgId = ws?.organization?.id;
  const { data: numbers } = useQuery(numbersQuery(orgId));
  const { data: agents } = useQuery({
    queryKey: ["campaign-agents", orgId],
    enabled: Boolean(orgId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("agent_configs")
        .select("id, agent_name")
        .eq("organization_id", orgId!)
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });
  // This workspace's own numbers (RLS + organization filter): those that may call out, and
  // the rest with why not (released numbers are not listed at all).
  const { eligible: eligibleNumbers, ineligible: ineligibleNumbers } = callerNumberChoices(
    numbers ?? [],
  );
  const businessName = ws?.business?.name ?? null;
  const visibleSteps = editing
    ? WIZARD_STEPS.map((_, i) => i).filter((i) => i !== AUDIENCE_STEP)
    : WIZARD_STEPS.map((_, i) => i);

  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [details, setDetails] = useState<DetailsStep>(
    initial?.details ?? { name: "", objective: "", description: "" },
  );
  const [phoneNumberId, setPhoneNumberId] = useState(initial?.phoneNumberId ?? "");
  const [manual, setManual] = useState<ManualContact[]>([]);
  const [manualDraft, setManualDraft] = useState<ManualContact>({ name: "", phone: "" });
  const [csv, setCsv] = useState<{ filename: string; table: ParsedCsvTable } | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [instructions, setInstructions] = useState<InstructionsStep>(
    initial?.instructions ?? { ...EMPTY_INSTRUCTIONS, agentConfigId: ws?.agent?.id ?? "" },
  );
  const [schedule, setSchedule] = useState<ScheduleStep>(
    initial?.schedule ?? {
      mode: "immediately",
      startDate: "",
      endDate: "",
      timezone: ws?.organization?.timezone || PLATFORM_CALLING_HOURS.timeZone,
      days: [1, 2, 3, 4, 5, 6],
      windowStart: "10:00",
      windowEnd: "18:00",
    },
  );
  const [controls, setControls] = useState<ControlsStep>(initial?.controls ?? DEFAULT_CONTROLS);
  const [saving, setSaving] = useState(false);
  const progress = useRef<SaveProgress>({
    campaignId: campaignId ?? null,
    contactsImported: false,
    importKey: newCampaignCreateKey(),
    updatedAt: loadedUpdatedAt ?? null,
  });
  // A save refused because the campaign changed elsewhere: the form stays as typed.
  const [conflict, setConflict] = useState(false);
  // Set right before leaving on purpose (after a save, or a confirmed cancel).
  const leaving = useRef(false);
  // One idempotency key per creation session (survives a refresh; released on leaving the
  // wizard). Edits never use one.
  const [createKey] = useState(() => (editing ? null : claimCampaignCreateKey()));
  useEffect(() => {
    if (!createKey) return undefined;
    holdCampaignCreateKey(createKey);
    return () => releaseCampaignCreateKey();
  }, [createKey]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A new campaign defaults to the workspace's own agent; an edit keeps what was saved.
  const agentConfigId = instructions.agentConfigId || (editing ? "" : (ws?.agent?.id ?? ""));
  const state: WizardState = {
    details,
    phoneNumberId,
    instructions: { ...instructions, agentConfigId },
    schedule,
    controls,
  };
  const audienceTable = useMemo(
    () => combineAudience(manual, csv?.table ?? null, mapping),
    [manual, csv, mapping],
  );
  const audience = useMemo(() => previewAudience(audienceTable), [audienceTable]);
  // Moving between steps never requires an agent; only "Save campaign" does.
  const instructionCheck = validateInstructions(details.objective.trim(), state.instructions, {
    requireAgent: false,
  });
  const scheduleCheck = validateSchedule(schedule, new Date(), {
    startDate: savedSchedule?.startDate,
    endDate: savedSchedule?.endDate,
  });
  const agentName = agents?.find((a) => a.id === agentConfigId)?.agent_name ?? "—";
  const callerNumber = eligibleNumbers.find((n) => n.id === phoneNumberId)?.e164 ?? null;

  const snapshot = (w: WizardState) => JSON.stringify(w);
  const startedFrom = useRef(snapshot(state));
  const dirty =
    !leaving.current &&
    (snapshot(state) !== startedFrom.current || manual.length > 0 || csv !== null);
  useBlocker({
    shouldBlockFn: () =>
      dirty &&
      !leaving.current &&
      !confirm(
        editing
          ? "Leave without saving? Your changes to this campaign will be lost."
          : "Leave without saving? This campaign has not been created yet.",
      ),
    enableBeforeUnload: () => dirty && !leaving.current,
  });

  function stepErrors(i: number): string[] {
    if (i === 0) return validateDetails(details);
    if (i === AUDIENCE_STEP)
      return editing
        ? []
        : [
            ...(mapping ? mappingProblems(mapping) : []),
            ...validateAudience(audienceTable, audience, reviewed),
          ];
    if (i === 2) return instructionCheck.errors;
    if (i === 3) return scheduleCheck.errors;
    if (i === 4) return validateControls(controls);
    return [];
  }

  const nextOf = (i: number) => visibleSteps[visibleSteps.indexOf(i) + 1];
  const prevOf = (i: number) => visibleSteps[visibleSteps.indexOf(i) - 1];

  function goTo(target: number) {
    // Forward only past steps that are valid; back is always allowed.
    for (const i of visibleSteps) {
      if (i < step || i >= target) continue;
      const problems = stepErrors(i);
      if (problems.length) {
        setStep(i);
        setErrors(problems);
        return;
      }
    }
    setErrors([]);
    setStep(target);
  }

  function addManual() {
    if (!manualDraft.phone.trim()) {
      setErrors(["Enter a phone number for the contact."]);
      return;
    }
    setManual((m) => [...m, manualDraft]);
    setManualDraft({ name: "", phone: "" });
    setReviewed(false);
    setErrors([]);
  }

  async function handleFile(f: File) {
    const table = csvToTable(await f.text());
    if (!table.headers.length) {
      toast.error("That file has no header row.");
      return;
    }
    const phoneColumn =
      table.headers.find((h) => /phone|mobile|number/i.test(h)) ?? table.headers[0]!;
    const nameColumn = table.headers.find((h) => h !== phoneColumn && /name/i.test(h)) ?? "";
    setCsv({ filename: f.name, table });
    setMapping({ phoneColumn, nameColumn, customFields: {} });
    setReviewed(false);
  }

  function setCustomField(column: string, keep: boolean) {
    setMapping((m) => {
      if (!m) return m;
      const customFields = { ...m.customFields };
      if (keep) customFields[column] = toVariableName(column) || "field";
      else delete customFields[column];
      return { ...m, customFields };
    });
    setReviewed(false);
  }

  /**
   * Draft: everything entered is saved; the call instructions are kept but
   * not confirmed, so the campaign cannot be launched. Save campaign: the
   * same, with an agent required and the instructions confirmed. Neither
   * places a call.
   */
  async function save(asDraft: boolean) {
    if (saving || !orgId) return;
    for (const i of visibleSteps) {
      if (i === REVIEW_STEP) continue;
      const problems = stepErrors(i);
      if (problems.length) {
        setStep(i);
        setErrors(problems);
        return;
      }
    }
    if (!asDraft && !agentConfigId) {
      setStep(2);
      setErrors(["Choose the AI agent for these calls, or save as a draft."]);
      return;
    }
    setSaving(true);
    try {
      const p = progress.current;
      // After a partial failure the campaign exists: save onto it, never create a second.
      // A create always carries this session's key: a retry after a lost response, a
      // refresh or a resubmission gets the same campaign back instead of a second one.
      const saved = await saveCampaignConfiguration({
        data: p.campaignId
          ? {
              campaignId: p.campaignId,
              wizard: state,
              confirm: !asDraft,
              // Applies only if nobody changed the campaign since this wizard saw it.
              ...(p.updatedAt ? { expectedUpdatedAt: p.updatedAt } : {}),
            }
          : {
              organizationId: orgId,
              wizard: state,
              confirm: !asDraft,
              ...(createKey ? { idempotencyKey: createKey } : {}),
            },
      });
      p.campaignId = saved.campaignId;
      p.updatedAt = saved.updatedAt;
      const id = saved.campaignId;
      if (!editing && !p.contactsImported && audienceTable.rows.length) {
        const result = await importCampaignContactsCsv({
          data: {
            campaignId: id,
            filename: csv?.filename ?? "added-in-wizard.csv",
            csvText: audienceToCsv(audienceTable),
            phoneColumn: "phone",
            mapping: audienceImportMapping(audienceTable),
            idempotencyKey: p.importKey,
          },
        });
        p.contactsImported = true;
        toast.success(describeImportResult(result));
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["campaigns", orgId] }),
        qc.invalidateQueries({ queryKey: ["campaign", id] }),
        qc.invalidateQueries({ queryKey: ["campaign-config-names", id] }),
      ]);
      toast.success(
        saved.outcome === "existing"
          ? "This campaign was already created; opening it. Nothing was duplicated."
          : asDraft
            ? "Saved as a draft. Confirm the call instructions before it can be launched."
            : editing
              ? "Changes saved. No calls are placed."
              : "Campaign saved. Nothing is called until launching is available and you launch it.",
      );
      leaving.current = true;
      navigate({ to: "/app/campaigns/$campaignId", params: { campaignId: id } });
    } catch (err) {
      if (/changed elsewhere/.test((err as { message?: string })?.message ?? "")) {
        // Never merged or retried automatically: the person reloads and reviews.
        setConflict(true);
        return;
      }
      toast.error(
        describeQueryError(
          err,
          !editing && progress.current.campaignId
            ? "The campaign was created but not everything was saved. Try again: nothing is duplicated."
            : "Could not save this campaign.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    if (
      dirty &&
      !confirm(
        editing
          ? "Discard your changes? The saved campaign is not changed."
          : "Discard this campaign? Nothing has been saved.",
      )
    )
      return;
    leaving.current = true;
    if (editing && campaignId)
      navigate({ to: "/app/campaigns/$campaignId", params: { campaignId } });
    else navigate({ to: "/app/campaigns" });
  }

  const set = <K extends keyof InstructionsStep>(key: K, value: InstructionsStep[K]) =>
    setInstructions((s) => ({ ...s, [key]: value }));
  const position = visibleSteps.indexOf(step);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Campaigns"
        title={editing ? `Edit ${initial?.details.name ?? "campaign"}` : "Create campaign"}
        description={
          editing
            ? "Change this campaign's configuration. Contacts are managed on the campaign page. Saving never places a call."
            : "Set up who to call, what the AI says and when. Saving never places a call."
        }
        actions={
          editing && campaignId ? (
            <Link
              to="/app/campaigns/$campaignId"
              params={{ campaignId }}
              className="text-sm text-muted-foreground hover:underline"
            >
              Back to campaign
            </Link>
          ) : (
            <Link to="/app/campaigns" className="text-sm text-muted-foreground hover:underline">
              Back to campaigns
            </Link>
          )
        }
      />

      <nav aria-label="Campaign setup steps" className="panel px-4 py-3">
        <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
          {visibleSteps.map((i, n) => {
            const label = WIZARD_STEPS[i]!;
            const done = n < position;
            const current = i === step;
            return (
              <li key={label} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => (n <= position ? (setErrors([]), setStep(i)) : goTo(i))}
                  aria-current={current ? "step" : undefined}
                  className={`flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                    current
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span
                    className={`flex size-5 items-center justify-center rounded-full border text-[10px] ${
                      done
                        ? "border-success/40 bg-success/10 text-success"
                        : current
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border"
                    }`}
                  >
                    {done ? <Check className="size-3" /> : n + 1}
                  </span>
                  <span className="hidden sm:inline">{label}</span>
                </button>
                {n < visibleSteps.length - 1 ? (
                  <span className="mx-1 hidden h-px w-4 bg-border sm:block" />
                ) : null}
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-xs text-muted-foreground sm:hidden">
          Step {position + 1} of {visibleSteps.length}: {WIZARD_STEPS[step]}
        </p>
      </nav>

      {conflict ? (
        <div
          role="alert"
          className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
        >
          <p className="font-medium">This campaign was changed elsewhere</p>
          <p className="mt-1 text-muted-foreground">
            Someone (or another tab) saved this campaign after you opened it, so your changes were
            not saved and nothing was overwritten. Reload to see the latest version, then make your
            changes again.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                leaving.current = true;
                window.location.reload();
              }}
            >
              Reload latest version
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConflict(false)}>
              Keep my edits on screen
            </Button>
          </div>
        </div>
      ) : null}

      {errors.length ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
        >
          <p className="font-medium text-destructive">Please fix before continuing:</p>
          <ul className="mt-1 list-disc pl-5 text-destructive">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {step === 0 ? (
        <SectionCard title="Campaign details" description="Only your team sees these.">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="c-name">Campaign name</Label>
              <Input
                id="c-name"
                value={details.name}
                maxLength={120}
                onChange={(e) => setDetails((d) => ({ ...d, name: e.target.value }))}
                placeholder="Six-month check-up reminders"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Business</Label>
              <p className="rounded-md border border-border bg-surface/50 px-3 py-2 text-sm">
                {businessName ?? "Set up your business profile first"}
              </p>
            </div>
          </div>
          <div className="mt-4 space-y-1.5">
            <Label htmlFor="c-objective">Purpose of the calls</Label>
            <Input
              id="c-objective"
              value={details.objective}
              maxLength={CONTEXT_LIMITS.objective}
              onChange={(e) => setDetails((d) => ({ ...d, objective: e.target.value }))}
              placeholder="Remind patients who are due a check-up and help them book one"
            />
            <p className="text-xs text-muted-foreground">
              The AI says this is why the business is calling. {details.objective.length}/
              {CONTEXT_LIMITS.objective}
            </p>
          </div>
          <div className="mt-4 space-y-1.5">
            <Label htmlFor="c-description">Description (optional)</Label>
            <Textarea
              id="c-description"
              value={details.description}
              rows={4}
              maxLength={4000}
              onChange={(e) => setDetails((d) => ({ ...d, description: e.target.value }))}
              placeholder="Internal notes: who this list is, where it came from, anything your team should know."
            />
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Campaign type: outbound voice calls by your AI receptionist (the only type available).
          </p>
        </SectionCard>
      ) : null}

      {step === 1 ? (
        <>
          <SectionCard
            title="Add contacts"
            description="Type them in, upload a CSV, or both. Nothing is saved until you finish."
          >
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <Input
                aria-label="Contact name"
                placeholder="Name (optional)"
                value={manualDraft.name}
                onChange={(e) => setManualDraft((d) => ({ ...d, name: e.target.value }))}
              />
              <Input
                aria-label="Contact phone number"
                placeholder="Phone, e.g. +91 98765 43210"
                value={manualDraft.phone}
                onChange={(e) => setManualDraft((d) => ({ ...d, phone: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addManual();
                }}
              />
              <Button type="button" variant="secondary" onClick={addManual}>
                <Plus className="mr-1.5 size-3.5" /> Add
              </Button>
            </div>
            {manual.length ? (
              <ul className="mt-3 divide-y divide-border rounded-md border border-border text-sm">
                {manual.map((m, i) => (
                  <li
                    key={`${m.phone}-${i}`}
                    className="flex items-center justify-between px-3 py-1.5"
                  >
                    <span>
                      {m.name || "Unnamed"} <span className="text-muted-foreground">{m.phone}</span>
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${m.phone}`}
                      onClick={() => {
                        setManual((list) => list.filter((_, j) => j !== i));
                        setReviewed(false);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Button
                type="button"
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp className="mr-1.5 size-3.5" /> {csv ? "Replace CSV" : "Upload CSV"}
              </Button>
              {csv ? (
                <>
                  <span className="text-sm text-muted-foreground">
                    {csv.filename}: {csv.table.rows.length} rows
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setCsv(null);
                      setMapping(null);
                      setReviewed(false);
                    }}
                  >
                    Remove file
                  </Button>
                </>
              ) : (
                <span className="text-xs text-muted-foreground">
                  A header row is required. Numbers without a country code are read as Indian.
                </span>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void handleFile(f);
                }}
              />
            </div>

            {csv && mapping ? (
              <div className="mt-4 space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>Phone number column</Label>
                    <Select
                      value={mapping.phoneColumn}
                      onValueChange={(v) => {
                        setMapping({ ...mapping, phoneColumn: v });
                        setReviewed(false);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {csv.table.headers.map((h) => (
                          <SelectItem key={h} value={h}>
                            {h}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Name column</Label>
                    <Select
                      value={mapping.nameColumn || NONE}
                      onValueChange={(v) => {
                        setMapping({ ...mapping, nameColumn: v === NONE ? "" : v });
                        setReviewed(false);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>No name column</SelectItem>
                        {csv.table.headers
                          .filter((h) => h !== mapping.phoneColumn)
                          .map((h) => (
                            <SelectItem key={h} value={h}>
                              {h}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {csv.table.headers.filter(
                  (h) => h !== mapping.phoneColumn && h !== mapping.nameColumn,
                ).length ? (
                  <div className="space-y-2">
                    <Label>Extra fields the AI can use (optional)</Label>
                    {csv.table.headers
                      .filter((h) => h !== mapping.phoneColumn && h !== mapping.nameColumn)
                      .map((h) => {
                        const kept = h in mapping.customFields;
                        return (
                          <div key={h} className="flex flex-wrap items-center gap-2">
                            <label className="flex w-40 items-center gap-2 text-sm">
                              <Checkbox
                                checked={kept}
                                onCheckedChange={(v) => setCustomField(h, v === true)}
                              />
                              <span className="truncate">{h}</span>
                            </label>
                            {kept ? (
                              <Input
                                aria-label={`Field name for ${h}`}
                                className="h-8 w-56"
                                value={mapping.customFields[h]}
                                onChange={(e) => {
                                  setMapping({
                                    ...mapping,
                                    customFields: { ...mapping.customFields, [h]: e.target.value },
                                  });
                                  setReviewed(false);
                                }}
                              />
                            ) : null}
                          </div>
                        );
                      })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </SectionCard>

          <SectionCard
            title="Import preview"
            description="Checked here and again by ClickAI when you save. Every row is accounted for."
          >
            {audienceTable.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No contacts added. You can also add them later on the campaign page.
              </p>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Count label="Rows" value={audience.totalRows} />
                  <Count label="Valid" value={audience.valid.length} tone="live" />
                  <Count label="Invalid" value={audience.invalid.length} tone="error" />
                  <Count label="Duplicates" value={audience.duplicates.length} tone="ready" />
                </div>
                {audience.notDiallable ? (
                  <p className="text-xs text-warning">
                    {audience.notDiallable} valid number(s) are outside India: they are saved but
                    ClickAI does not call them.
                  </p>
                ) : null}
                <div className="-mx-5 max-h-72 overflow-auto">
                  <table className="w-full min-w-[520px] text-sm">
                    <thead className="sticky top-0 bg-background">
                      <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                        <th className="px-5 py-2 font-medium">Row</th>
                        <th className="px-3 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 font-medium">Number</th>
                        <th className="px-5 py-2 font-medium">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audienceTable.rows.slice(0, 200).map((row, i) => {
                        const n = i + 1;
                        const invalid = audience.invalid.find((x) => x.rowIndex === n);
                        const duplicate = audience.duplicates.find((x) => x.rowIndex === n);
                        const valid = audience.valid.find((x) => x.rowIndex === n);
                        return (
                          <tr key={n} className="border-b border-border/60">
                            <td className="px-5 py-1.5 text-xs text-muted-foreground tabular">
                              {n}
                            </td>
                            <td className="px-3 py-1.5">{row["name"] || "—"}</td>
                            <td className="px-3 py-1.5 tabular">
                              {valid?.phone ?? row["phone"] ?? ""}
                            </td>
                            <td className="px-5 py-1.5">
                              {invalid ? (
                                <StatusPill tone="error" dot={false}>
                                  {invalid.reason}
                                </StatusPill>
                              ) : duplicate ? (
                                <StatusPill tone="ready" dot={false}>
                                  Duplicate of an earlier row
                                </StatusPill>
                              ) : (
                                <StatusPill tone="live" dot={false}>
                                  Will be added
                                </StatusPill>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {audienceTable.rows.length > 200 ? (
                  <p className="text-xs text-muted-foreground">
                    Showing the first 200 of {audienceTable.rows.length} rows; the counts above
                    cover all of them.
                  </p>
                ) : null}
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={reviewed}
                    onCheckedChange={(v) => setReviewed(v === true)}
                    className="mt-0.5"
                  />
                  <span>
                    I have reviewed this import. Invalid rows are not added; duplicates are added
                    once. Contacts who opted out are skipped when saved.
                  </span>
                </label>
              </div>
            )}
          </SectionCard>
        </>
      ) : null}

      {step === 2 ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <SectionCard
            title="AI agent & call instructions"
            description="These apply to this campaign only. Your agent's own setup is not changed."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>AI agent</Label>
                <Select value={agentConfigId} onValueChange={(v) => set("agentConfigId", v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {(agents ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.agent_name ?? "Your AI receptionist"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Language</Label>
                <Select
                  value={instructions.language || NONE}
                  onValueChange={(v) => set("language", v === NONE ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Same as the agent</SelectItem>
                    {LANGUAGES.map((l) => (
                      <SelectItem key={l.code} value={l.code}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="mt-4 space-y-1.5">
              <Label>Opening introduction</Label>
              <p className="rounded-md border border-border bg-surface/50 px-3 py-2 text-sm">
                {openingLinePreview(businessName)}
              </p>
              <p className="text-xs text-muted-foreground">
                Set by ClickAI on every call so the person always knows an AI assistant is calling
                for your business. It cannot be changed per campaign.
              </p>
            </div>
            <div className="mt-4 grid gap-4">
              <Field
                label="Who you are calling"
                value={instructions.audience}
                max={CONTEXT_LIMITS.audience}
                onChange={(v) => set("audience", v)}
                placeholder="Patients who have not visited in six months"
              />
              <Field
                label="What to mention (one per line)"
                value={instructions.talkingPoints}
                rows={3}
                onChange={(v) => set("talkingPoints", v)}
                placeholder="It has been six months since their last check-up"
                hint={`Up to ${CONTEXT_LIMITS.talkingPoints.items} lines`}
              />
              <Field
                label="Questions the AI should ask (one per line)"
                value={instructions.questions}
                rows={3}
                onChange={(v) => set("questions", v)}
                placeholder="Would you like to book a check-up?"
                hint={`Up to ${CONTEXT_LIMITS.questions.items} lines`}
              />
              <Field
                label="Desired outcome"
                value={instructions.desiredOutcome}
                max={CONTEXT_LIMITS.desiredOutcome}
                onChange={(v) => set("desiredOutcome", v)}
                placeholder="They book a check-up or know how to book one"
              />
              <Field
                label="If they are interested"
                value={instructions.interestedHandling}
                rows={2}
                onChange={(v) => set("interestedHandling", v)}
                placeholder="Check availability and offer the nearest free times"
              />
              <Field
                label="If they are not interested"
                value={instructions.uninterestedHandling}
                max={CONTEXT_LIMITS.objectionHandling}
                rows={2}
                onChange={(v) => set("uninterestedHandling", v)}
                placeholder="Thank them and end the call politely; do not press"
              />
              <Field
                label="If they want to be contacted later"
                value={instructions.callbackHandling}
                max={CONTEXT_LIMITS.callbackHandling}
                onChange={(v) => set("callbackHandling", v)}
                placeholder="Give the clinic's phone number"
              />
              <Field
                label="How to end the call"
                value={instructions.closing}
                max={CONTEXT_LIMITS.closing}
                onChange={(v) => set("closing", v)}
                placeholder="Thank them and say goodbye"
              />
              <Field
                label="Tone"
                value={instructions.tone}
                max={CONTEXT_LIMITS.tone}
                onChange={(v) => set("tone", v)}
                placeholder="Warm and brief"
              />
              <Field
                label="Other campaign instructions"
                value={instructions.extraInstructions}
                rows={3}
                onChange={(v) => set("extraInstructions", v)}
                hint={`Shares ${CONTEXT_LIMITS.extraInstructions} characters with "If they are interested"`}
              />
              <div className="space-y-1.5">
                <Label>Questions the AI cannot answer</Label>
                <p className="rounded-md border border-border bg-surface/50 px-3 py-2 text-sm">
                  The AI says it cannot confirm that and gives your business phone number. This is
                  part of every ClickAI agent and cannot be changed per campaign.
                </p>
              </div>
            </div>
          </SectionCard>
          <InstructionsPreview
            objective={details.objective.trim()}
            compiled={instructionCheck.compiled}
            errors={instructionCheck.errors}
          />
        </div>
      ) : null}

      {step === 3 ? (
        <SectionCard
          title="Schedule"
          description={`Calls only ever happen inside these hours and ${PLATFORM_CALLING_HOURS.start}–${PLATFORM_CALLING_HOURS.end} India time.`}
        >
          <div className="space-y-4">
            <div className="flex flex-wrap gap-4 text-sm">
              {(["immediately", "scheduled"] as const).map((m) => (
                <label key={m} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="start-mode"
                    checked={schedule.mode === m}
                    onChange={() => setSchedule((s) => ({ ...s, mode: m }))}
                  />
                  {m === "immediately" ? "Start as soon as it is launched" : "Start on a date"}
                </label>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {schedule.mode === "scheduled" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="c-start">Start date</Label>
                  <Input
                    id="c-start"
                    type="date"
                    value={schedule.startDate}
                    onChange={(e) => setSchedule((s) => ({ ...s, startDate: e.target.value }))}
                  />
                  <p className="text-xs text-muted-foreground">
                    Calls start at the calling-hours start time on this date.
                  </p>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="c-end">End date (optional)</Label>
                <Input
                  id="c-end"
                  type="date"
                  value={schedule.endDate}
                  onChange={(e) => setSchedule((s) => ({ ...s, endDate: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Time zone</Label>
                <Select
                  value={schedule.timezone}
                  onValueChange={(v) => setSchedule((s) => ({ ...s, timezone: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[...new Set([schedule.timezone, ...TIMEZONES])].map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="c-ws">Calling from</Label>
                  <Input
                    id="c-ws"
                    type="time"
                    value={schedule.windowStart}
                    onChange={(e) => setSchedule((s) => ({ ...s, windowStart: e.target.value }))}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="c-we">Until</Label>
                  <Input
                    id="c-we"
                    type="time"
                    value={schedule.windowEnd}
                    onChange={(e) => setSchedule((s) => ({ ...s, windowEnd: e.target.value }))}
                  />
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Calling days</Label>
              <div className="flex flex-wrap gap-3">
                {DAY_LABELS.map((label, i) => (
                  <label key={label} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={schedule.days.includes(i)}
                      onCheckedChange={() =>
                        setSchedule((s) => ({
                          ...s,
                          days: s.days.includes(i) ? s.days.filter((d) => d !== i) : [...s.days, i],
                        }))
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            {scheduleCheck.warnings.map((w) => (
              <p key={w} className="flex items-center gap-1.5 text-xs text-warning">
                <AlertTriangle className="size-3.5" /> {w}
              </p>
            ))}
          </div>
        </SectionCard>
      ) : null}

      {step === 4 ? (
        <SectionCard
          title="Calling controls"
          description="Safe defaults are filled in. ClickAI's own limits always apply on top."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="c-attempts">Attempts per contact</Label>
              <Input
                id="c-attempts"
                type="number"
                min={1}
                max={10}
                value={controls.maxAttempts}
                onChange={(e) =>
                  setControls((c) => ({
                    ...c,
                    maxAttempts: Math.trunc(Number(e.target.value)) || 0,
                  }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-retry">Wait before retrying (minutes)</Label>
              <Input
                id="c-retry"
                type="number"
                min={MIN_RETRY_AFTER_MINUTES}
                max={MAX_RETRY_AFTER_MINUTES}
                disabled={controls.maxAttempts <= 1}
                value={controls.retryAfterMinutes}
                onChange={(e) =>
                  setControls((c) => ({
                    ...c,
                    retryAfterMinutes: Math.trunc(Number(e.target.value)) || 0,
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">
                Also the cooldown between calls to the same person: 15 minutes to 7 days.
              </p>
            </div>
          </div>
          <div className="mt-4 space-y-1.5">
            <Label>Retry only when the call was</Label>
            <div className="flex flex-wrap gap-4">
              {RETRY_OPTIONS.map((o) => (
                <label key={o.value} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    disabled={controls.maxAttempts <= 1}
                    checked={controls.retryStatuses.includes(o.value)}
                    onCheckedChange={(v) =>
                      setControls((c) => ({
                        ...c,
                        retryStatuses:
                          v === true
                            ? [...c.retryStatuses, o.value]
                            : c.retryStatuses.filter((s) => s !== o.value),
                      }))
                    }
                  />
                  {o.label}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Someone who answered, declined or asked not to be called is never called again.
            </p>
          </div>
          <div className="mt-4 space-y-1.5">
            <Label htmlFor="c-budget">Campaign budget (₹, optional)</Label>
            <Input
              id="c-budget"
              type="number"
              min={1}
              className="w-56"
              value={controls.budgetRupees}
              onChange={(e) => setControls((c) => ({ ...c, budgetRupees: e.target.value }))}
              placeholder="No limit"
            />
            <p className="text-xs text-muted-foreground">
              Each call reserves its maximum cost until it is billed; the campaign pauses before
              going over.
            </p>
          </div>
          {orgId ? (
            <div className="mt-5">
              <OutboundConcurrencyCard organizationId={orgId} />
            </div>
          ) : null}
          <div className="mt-5 rounded-md border border-border bg-surface/50 px-4 py-3 text-sm">
            <p className="font-medium">Fixed by ClickAI (not adjustable per campaign)</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
              <li>At most {PLATFORM_PACING.contactsPerMinute} new calls started per minute.</li>
              <li>Calls last at most 5 minutes; your wallet must cover each call.</li>
            </ul>
          </div>
        </SectionCard>
      ) : null}

      {step === 5 ? (
        <ReviewStep
          state={state}
          agentName={agentName}
          businessName={businessName}
          callerNumber={callerNumber}
          eligibleNumbers={eligibleNumbers}
          ineligibleNumbers={ineligibleNumbers}
          phoneNumberId={phoneNumberId}
          onPhoneNumber={setPhoneNumberId}
          audience={audience}
          showAudience={!editing}
          compiled={instructionCheck.compiled}
          warnings={reviewWarnings(
            state,
            audience,
            instructionCheck.compiled,
            eligibleNumbers.length,
          ).filter((w) => !editing || !/contact|duplicate|outside India/i.test(w))}
        />
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" onClick={cancel} disabled={saving}>
          Cancel
        </Button>
        <div className="flex flex-wrap justify-end gap-2">
          {position > 0 ? (
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => {
                setErrors([]);
                setStep(prevOf(step)!);
              }}
            >
              Back
            </Button>
          ) : null}
          {step !== REVIEW_STEP ? (
            <Button type="button" onClick={() => goTo(nextOf(step)!)}>
              Next: {WIZARD_STEPS[nextOf(step)!]}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                disabled={saving}
                onClick={() => save(true)}
              >
                {saving ? "Saving…" : "Save as draft"}
              </Button>
              <Button type="button" disabled={saving} onClick={() => save(false)}>
                {saving ? "Saving…" : editing ? "Save changes" : "Save campaign"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Count({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "live" | "error" | "ready";
}) {
  const color =
    tone === "live"
      ? "text-success"
      : tone === "error"
        ? "text-destructive"
        : tone === "ready"
          ? "text-warning"
          : "";
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-xl font-semibold tabular ${color}`}>{value}</p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  max,
  rows = 1,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  max?: number;
  rows?: number;
  hint?: string;
}) {
  const id = `f-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {rows > 1 ? (
        <Textarea
          id={id}
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
      {hint || max ? (
        <p className="text-xs text-muted-foreground">
          {hint}
          {max ? `${hint ? " · " : ""}${value.length}/${max}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function InstructionsPreview({
  objective,
  compiled,
  errors,
}: {
  objective: string;
  compiled: { instructions: string; omitted: string[] } | null;
  errors: string[];
}) {
  const caps = platformCapabilities();
  return (
    <SectionCard
      title="What the AI will be told"
      description="Sent with every call of this campaign, after your agent's own instructions."
      className="h-fit lg:sticky lg:top-4"
    >
      <div className="space-y-3 text-sm">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Reason for the call
          </p>
          <p>{objective || "—"}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Campaign notes
          </p>
          <p className="whitespace-pre-wrap break-words">
            {compiled?.instructions || (errors.length ? "Fix the fields marked above." : "—")}
          </p>
        </div>
        {compiled?.omitted.length ? (
          <p className="text-xs text-warning">
            Too long to fit on a call, left out: {compiled.omitted.join(", ")}.
          </p>
        ) : null}
        <div className="border-t border-border pt-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">The AI can</p>
          <p>{caps.allowed.join(", ")}.</p>
          <p className="mt-1.5 font-medium text-foreground">It cannot</p>
          <p>{caps.forbidden.join(", ")}.</p>
        </div>
      </div>
    </SectionCard>
  );
}

function ReviewStep({
  state,
  agentName,
  businessName,
  callerNumber,
  eligibleNumbers,
  ineligibleNumbers = [],
  phoneNumberId,
  onPhoneNumber,
  audience,
  showAudience,
  compiled,
  warnings,
}: {
  state: WizardState;
  agentName: string;
  businessName: string | null;
  callerNumber: string | null;
  eligibleNumbers: { id: string; e164: string }[];
  /** This workspace's numbers that can't call out, each with the reason (shown, not selectable). */
  ineligibleNumbers?: { id: string; e164: string; reason: string }[];
  phoneNumberId: string;
  onPhoneNumber: (id: string) => void;
  audience: ReturnType<typeof previewAudience>;
  showAudience: boolean;
  compiled: { instructions: string } | null;
  warnings: string[];
}) {
  // A saved number that is no longer this workspace's outbound number cannot be kept.
  const savedNotEligible = Boolean(phoneNumberId) && !callerNumber;
  const s = state.schedule;
  const c = state.controls;
  const budget = budgetPaise(c.budgetRupees);
  const days =
    s.days.length === 7
      ? "Every day"
      : [...s.days]
          .sort()
          .map((d) => DAY_LABELS[d])
          .join(", ");
  return (
    <div className="space-y-6">
      <SectionCard
        title="Caller number"
        description="The number people see. Needed before calls can start."
      >
        <Select
          value={phoneNumberId || NONE}
          onValueChange={(v) => onPhoneNumber(v === NONE ? "" : v)}
        >
          <SelectTrigger className="sm:w-80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Choose later</SelectItem>
            {savedNotEligible ? (
              <SelectItem value={phoneNumberId} disabled>
                Saved number (no longer enabled for outbound)
              </SelectItem>
            ) : null}
            {eligibleNumbers.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                {n.e164}
              </SelectItem>
            ))}
            {ineligibleNumbers
              .filter((n) => n.id !== phoneNumberId)
              .map((n) => (
                <SelectItem key={n.id} value={n.id} disabled>
                  {n.e164} (cannot call out)
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {ineligibleNumbers.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {ineligibleNumbers.map((n) => (
              <li key={n.id}>
                <span className="font-medium">{n.e164}</span>: {n.reason}
              </li>
            ))}
          </ul>
        ) : null}
        {eligibleNumbers.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            None of your numbers is enabled for outbound calling yet. ClickAI support enables a
            number for outbound calls; until then, save without one and choose it later.
          </p>
        ) : null}
        {savedNotEligible ? (
          <p className="mt-2 text-xs text-destructive">
            The saved caller number is no longer enabled for outbound calls. Choose another number
            or "Choose later" to save.
          </p>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">
          Choosing a number does not start any calls.
        </p>
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Campaign">
          <Summary
            rows={[
              ["Name", state.details.name],
              ["Purpose", state.details.objective],
              ["Business", businessName ?? "—"],
              ["Agent", agentName],
              ["Caller number", callerNumber ?? "Not chosen"],
              ["Description", state.details.description || "—"],
            ]}
          />
        </SectionCard>
        {showAudience ? (
          <SectionCard title="Contacts">
            <Summary
              rows={[
                ["Rows added", String(audience.totalRows)],
                ["Valid", String(audience.valid.length)],
                ["Invalid (not added)", String(audience.invalid.length)],
                ["Duplicates (added once)", String(audience.duplicates.length)],
                ["Outside India (not called)", String(audience.notDiallable)],
              ]}
            />
          </SectionCard>
        ) : null}
        <SectionCard title="Schedule">
          <Summary
            rows={[
              ["Starts", s.mode === "scheduled" ? s.startDate : "When launched"],
              ["Ends", s.endDate || "No end date"],
              ["Days", days],
              ["Hours", `${s.windowStart}–${s.windowEnd} (${s.timezone})`],
            ]}
          />
        </SectionCard>
        <SectionCard title="Calling controls">
          <Summary
            rows={[
              ["Attempts per contact", String(c.maxAttempts)],
              [
                "Retries",
                c.maxAttempts > 1
                  ? `After ${c.retryAfterMinutes} min, when ${c.retryStatuses.join(", ").replace(/_/g, " ")}`
                  : "No retries",
              ],
              ["Budget", budget ? `₹${(budget / 100).toLocaleString("en-IN")}` : "No limit"],
            ]}
          />
        </SectionCard>
      </div>

      <SectionCard title="Call instructions">
        <p className="whitespace-pre-wrap break-words text-sm">
          <span className="font-medium">Reason: </span>
          {state.details.objective}
        </p>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {compiled?.instructions || "No extra campaign notes."}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          <strong>Save as draft</strong> saves everything, including these instructions, but leaves
          them unconfirmed, so the campaign cannot be launched. The other save button also confirms
          them (and needs an AI agent).
        </p>
      </SectionCard>

      {warnings.length ? (
        <SectionCard title="Before calls can start">
          <ul className="space-y-1.5 text-sm">
            {warnings.map((w) => (
              <li key={w} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" /> {w}
              </li>
            ))}
            <li className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" /> Saving never
              places a call. Launch from the campaign page once every check passes.
            </li>
          </ul>
        </SectionCard>
      ) : (
        <p className="text-sm text-muted-foreground">
          Saving never places a call. Launch from the campaign page once every check passes.
        </p>
      )}
    </div>
  );
}

function Summary({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,140px)_1fr] gap-x-3 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
