import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { SectionCard, StatusPill } from "@/components/app/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CONTEXT_LIMITS,
  compileCampaignContext,
  platformCapabilities,
  validateCampaignContext,
  type CampaignContext,
} from "@/lib/campaign-context";
import {
  getCampaignEligibility,
  prepareCampaignContext,
  saveCampaignContext,
} from "@/lib/campaign-context.functions";
import { getCampaignStats } from "@/lib/campaigns.functions";
import { EXCLUSION_LABEL, RESULT_LABEL, type CampaignResult } from "@/lib/campaign-results";

interface CampaignForContext {
  id: string;
  status: string;
  description: string | null;
  context: unknown;
  context_reviewed_at: string | null;
}

const EDITABLE = ["draft", "scheduled", "paused"];

const TEXT_FIELDS: { key: keyof CampaignContext; label: string; rows: number }[] = [
  { key: "audience", label: "Who you are calling", rows: 2 },
  { key: "desiredOutcome", label: "What a good result looks like", rows: 2 },
  { key: "objectionHandling", label: "If they hesitate or say no", rows: 2 },
  { key: "callbackHandling", label: "If they want to be contacted later", rows: 2 },
  { key: "closing", label: "How to end the call", rows: 2 },
  { key: "tone", label: "Tone", rows: 1 },
  { key: "extraInstructions", label: "Anything else", rows: 3 },
  { key: "successCriteria", label: "How you'll judge success (not said on the call)", rows: 2 },
];
const LIST_FIELDS: { key: "talkingPoints" | "questions" | "servicesInScope"; label: string }[] = [
  { key: "talkingPoints", label: "What to mention (one per line)" },
  { key: "questions", label: "What to ask (one per line)" },
  { key: "servicesInScope", label: "Services the call is about (one per line)" },
];

/** Describe → prepare → review and edit → save. Nothing is said on a call until this is saved. */
export function CampaignContextPanel({
  campaign,
  onSaved,
}: {
  campaign: CampaignForContext;
  onSaved: () => Promise<void> | void;
}) {
  const stored = useMemo(() => {
    const r = validateCampaignContext(campaign.context);
    return r.ok ? r.context : null;
  }, [campaign.context]);
  const [description, setDescription] = useState(campaign.description ?? "");
  const [draft, setDraft] = useState<CampaignContext | null>(stored);
  const [source, setSource] = useState<"llm" | "rules" | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = EDITABLE.includes(campaign.status);
  const capabilities = platformCapabilities();

  const check = draft ? validateCampaignContext(draft) : null;
  const compiled = check?.ok ? compileCampaignContext(check.context) : null;

  async function prepare() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await prepareCampaignContext({ data: { campaignId: campaign.id, description } });
      setDraft(r.context);
      setSource(r.source);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (busy || !draft) return;
    setBusy(true);
    try {
      await saveCampaignContext({ data: { campaignId: campaign.id, context: draft, description } });
      toast.success("Saved. Calls will follow this.");
      await onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof CampaignContext, value: unknown) =>
    setDraft((d) => (d ? ({ ...d, [key]: value } as CampaignContext) : d));

  return (
    <SectionCard
      title="What the AI says on these calls"
      description="Describe the campaign; ClickAI prepares a structured version for you to review. Every call follows the saved version."
      actions={
        campaign.context_reviewed_at ? (
          <StatusPill tone="ready" dot={false}>
            Reviewed {new Date(campaign.context_reviewed_at).toLocaleString()}
          </StatusPill>
        ) : (
          <StatusPill tone="idle" dot={false}>
            Not reviewed — launch is blocked
          </StatusPill>
        )
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>Your description</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            maxLength={4000}
            disabled={!editable || busy}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={prepare}
            disabled={!editable || busy || !description.trim()}
          >
            {draft ? "Prepare again from description" : "Prepare from description"}
          </Button>
          {source === "rules" ? (
            <p className="text-xs text-muted-foreground">
              Prepared without AI assistance: please fill in the sections below.
            </p>
          ) : null}
        </div>

        {draft ? (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="space-y-1.5">
              <Label>Why you are calling (the AI says this)</Label>
              <Input
                value={draft.objective}
                maxLength={CONTEXT_LIMITS.objective}
                onChange={(e) => set("objective", e.target.value)}
                disabled={!editable}
              />
            </div>
            {LIST_FIELDS.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label>{f.label}</Label>
                <Textarea
                  rows={3}
                  value={draft[f.key].join("\n")}
                  onChange={(e) => set(f.key, e.target.value.split("\n"))}
                  disabled={!editable}
                />
              </div>
            ))}
            {TEXT_FIELDS.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label>{f.label}</Label>
                <Textarea
                  rows={f.rows}
                  value={String(draft[f.key] ?? "")}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={!editable}
                />
              </div>
            ))}

            <div className="rounded-md bg-surface/50 p-3 text-xs">
              <p className="font-medium">The AI can</p>
              <ul className="list-disc pl-4">
                {capabilities.allowed.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p className="mt-2 font-medium">
                The AI cannot (enforced by ClickAI, whatever is written above)
              </p>
              <ul className="list-disc pl-4">
                {capabilities.forbidden.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <p className="mt-2 text-muted-foreground">
                The AI always introduces itself as your business's virtual assistant, respects
                anyone who asks not to be called again, and never says anything was booked or
                arranged.
              </p>
            </div>

            {check && !check.ok ? (
              <ul className="text-xs text-destructive">
                {check.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : null}
            {compiled ? (
              <details className="text-xs">
                <summary className="cursor-pointer">Exactly what each call receives</summary>
                <p className="mt-1">
                  <span className="font-medium">Reason:</span> {compiled.objective}
                </p>
                <p className="mt-1 whitespace-pre-wrap">
                  <span className="font-medium">Guidance:</span> {compiled.instructions || "—"}
                </p>
                {compiled.omitted.length ? (
                  <p className="mt-1 text-destructive">
                    Too long; left out: {compiled.omitted.join(", ")}. Shorten the sections above.
                  </p>
                ) : null}
              </details>
            ) : null}

            <Button size="sm" onClick={save} disabled={!editable || busy || !check?.ok}>
              Save and mark as reviewed
            </Button>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

const money = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

/** Who will be called, and what happened: results, spend and budget. */
export function CampaignInsights({ campaignId }: { campaignId: string }) {
  const eligibility = useQuery({
    queryKey: ["campaign-eligibility", campaignId],
    queryFn: () => getCampaignEligibility({ data: { campaignId } }),
  });
  const stats = useQuery({
    queryKey: ["campaign-stats", campaignId],
    queryFn: () => getCampaignStats({ data: { campaignId } }),
    refetchInterval: 30_000,
  });
  const e = eligibility.data;
  const s = stats.data;
  return (
    <SectionCard title="Who will be called, and results">
      <div className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <p className="font-medium">Waiting to be called</p>
          {e ? (
            <>
              <p>
                {e.eligible} of {e.total} eligible
              </p>
              <ul className="text-xs text-muted-foreground">
                {Object.entries(e.excluded).map(([reason, n]) => (
                  <li key={reason}>
                    {n} excluded:{" "}
                    {EXCLUSION_LABEL[reason as keyof typeof EXCLUSION_LABEL] ?? reason}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">
                Calls happen only 9:00–21:00 India time, to +91 numbers, within your schedule.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
        </div>
        <div>
          <p className="font-medium">Spend</p>
          {s ? (
            <>
              <p>
                {money(s.spent)} spent
                {s.reserved ? `, ${money(s.reserved)} reserved for calls not yet billed` : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                Budget: {s.budgetLimit ? money(s.budgetLimit) : "no limit"}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
        </div>
      </div>
      {s ? (
        <div className="mt-4 space-y-2 text-sm">
          <p>
            {s.report.attempted} called · {s.report.connected} connected · {s.report.interested}{" "}
            interested · {s.report.callbacks} asked to be contacted · {s.report.optOuts} opted out ·{" "}
            {s.report.failed} failed · {s.report.inProgress} in progress · {s.report.queued} queued
          </p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(s.report.byResult).map(([r, n]) => (
              <StatusPill key={r} tone="idle" dot={false}>
                {RESULT_LABEL[r as CampaignResult] ?? r}: {n}
              </StatusPill>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Bookings are not counted here: this assistant cannot book. People who want an
            appointment were asked to call you.
          </p>
        </div>
      ) : null}
    </SectionCard>
  );
}
