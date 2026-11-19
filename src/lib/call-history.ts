/**
 * How the customer's Calls page shows one call. Pure, so it is tested
 * without a browser.
 */

export interface CallHistoryRow {
  direction: string;
  status: string;
  caller_number: string | null;
  destination_number: string | null;
}

/** The other party: who called in, or whom the clinic called (never the clinic's own number). */
export function callCounterpart(call: CallHistoryRow): string {
  const number = call.direction === "outbound" ? call.destination_number : call.caller_number;
  return number ?? "Unknown";
}

const STATUS_LABELS: Record<string, string> = {
  initiated: "Calling",
  ringing: "Ringing",
  answered: "In progress",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
  busy: "Busy",
  no_answer: "No answer",
  cancelled: "Cancelled",
  outcome_unknown: "Unconfirmed",
};

export function callStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

export type CallStatusTone = "live" | "ready" | "idle" | "error" | "info";

export function callStatusTone(status: string): CallStatusTone {
  if (status === "completed") return "live";
  if (status === "failed") return "error";
  if (status === "outcome_unknown") return "ready";
  if (["initiated", "ringing", "answered", "in_progress"].includes(status)) return "info";
  return "idle";
}

/** True while a call may still change, so the page keeps refreshing. */
export function isCallOpen(status: string): boolean {
  return ["initiated", "ringing", "answered", "in_progress"].includes(status);
}
