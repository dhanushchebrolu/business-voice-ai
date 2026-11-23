import { StatusPill } from "@/components/app/primitives";

const TONE: Record<string, "live" | "ready" | "idle" | "error" | "info"> = {
  draft: "idle",
  scheduled: "info",
  queued: "ready",
  running: "live",
  paused: "ready",
  completed: "info",
  failed: "error",
  cancelled: "error",
};

/** The campaign's stored status, as stored: never a status the campaign is not in. */
export function CampaignStatusPill({ status }: { status: string }) {
  return (
    <StatusPill tone={TONE[status] ?? "idle"} dot={status === "running"}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </StatusPill>
  );
}

/** Draft setup state: the call instructions are confirmed only once saved through review. */
export function CampaignSetupPill({ reviewedAt }: { reviewedAt: string | null }) {
  return reviewedAt ? (
    <StatusPill tone="info" dot={false}>
      Instructions confirmed
    </StatusPill>
  ) : (
    <StatusPill tone="ready" dot={false}>
      Setup incomplete
    </StatusPill>
  );
}

export function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
}

export function formatDateTime(value: string | null | undefined): string {
  return value
    ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";
}
