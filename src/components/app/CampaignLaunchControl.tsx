import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getCampaignLaunchReadiness, launchCampaign } from "@/lib/campaigns.functions";
import { campaignReadinessKey } from "@/lib/campaign-wizard";

type Readiness = Awaited<ReturnType<typeof getCampaignLaunchReadiness>>;
type Check = Readiness["checks"][number];

/**
 * The campaign's launch (or resume) button and the checklist behind it. Every
 * check is the server's own (campaign-launch-readiness.server.ts): the button
 * is enabled only when all pass, and launchCampaign re-runs them all anyway.
 * Launching places no call itself; the dispatcher picks the campaign up.
 */
export function CampaignLaunchButton({
  campaignId,
  status,
  onLaunched,
}: {
  campaignId: string;
  status: string;
  onLaunched: () => Promise<unknown> | void;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const { data: readiness } = useQuery({
    queryKey: campaignReadinessKey(campaignId),
    queryFn: () => getCampaignLaunchReadiness({ data: { campaignId } }),
  });
  const resume = status === "paused";
  const ready = readiness?.ready === true;
  const blockers = readiness?.checks.filter((c) => !c.ok) ?? [];

  async function launch() {
    if (pending) return;
    setPending(true);
    try {
      const result = await launchCampaign({ data: { campaignId } });
      if (result.ok) {
        toast.success(
          result.alreadyRunning
            ? "This campaign is already running."
            : resume
              ? "Campaign resumed. Calls start within a minute, inside your calling hours."
              : "Campaign launched. Calls start within a minute, inside your calling hours.",
        );
      } else {
        toast.error(
          `The campaign can't start yet: ${result.blockers.map((b) => b.label).join("; ")}.`,
        );
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending(false);
      setConfirming(false);
      await qc.invalidateQueries({ queryKey: campaignReadinessKey(campaignId) });
      await onLaunched();
    }
  }

  return (
    <>
      <Button
        size="sm"
        disabled={!ready || pending}
        onClick={() => setConfirming(true)}
        aria-describedby="campaign-launch-checklist"
        title={
          ready
            ? undefined
            : `Can't start yet: ${blockers.map((b) => b.label.toLowerCase()).join("; ")}.`
        }
      >
        {pending ? "Starting…" : resume ? "Resume" : "Launch campaign"}
      </Button>
      <AlertDialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {resume ? "Resume this campaign?" : "Launch this campaign?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              ClickAI will start calling {readiness?.contacts.due ?? 0} contact
              {readiness?.contacts.due === 1 ? "" : "s"} from{" "}
              {readiness?.callerNumber?.e164 ?? "your caller number"}, within your calling hours,
              charging your wallet per call. You can pause or cancel at any time; calls already in
              progress finish normally.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Not now</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                void launch();
              }}
            >
              {pending ? "Starting…" : resume ? "Resume calling" : "Start calling"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** What must be true before the campaign can start, each failing item with how to fix it. */
export function CampaignLaunchChecklist({ campaignId }: { campaignId: string }) {
  const {
    data: readiness,
    isLoading,
    error,
  } = useQuery({
    queryKey: campaignReadinessKey(campaignId),
    queryFn: () => getCampaignLaunchReadiness({ data: { campaignId } }),
  });
  if (isLoading) return <p className="text-xs text-muted-foreground">Checking launch readiness…</p>;
  if (error || !readiness)
    return (
      <p className="text-xs text-destructive">
        Could not check whether this campaign can start. Reload to try again.
      </p>
    );
  const failing = readiness.checks.filter((c: Check) => !c.ok);
  return (
    <div id="campaign-launch-checklist" className="rounded-md border p-3 text-sm">
      <p className="font-medium">
        {readiness.ready
          ? "Ready to launch. Launching starts calls; saving never does."
          : `Not ready to launch: ${failing.length} item${failing.length === 1 ? "" : "s"} to resolve. No calls are placed.`}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Caller number: {readiness.callerNumber?.e164 ?? "not chosen"} · Contacts to call:{" "}
        {readiness.contacts.due}
        {readiness.contacts.optedOut ? ` · opted out: ${readiness.contacts.optedOut}` : ""}
        {readiness.contacts.outsideAllowlist
          ? ` · outside the pilot test list: ${readiness.contacts.outsideAllowlist}`
          : ""}
      </p>
      <ul className="mt-2 space-y-1">
        {readiness.checks.map((c: Check) => (
          <li key={c.key} className="flex gap-2 text-xs">
            {c.ok ? (
              <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
            ) : (
              <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            )}
            <span>
              <span className={c.ok ? "text-muted-foreground" : "font-medium"}>{c.label}</span>
              <span className="sr-only">{c.ok ? " (done)" : " (not met)"}</span>
              {c.detail ? <span className="block text-muted-foreground">{c.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
