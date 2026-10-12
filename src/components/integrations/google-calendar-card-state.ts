/**
 * Pure state model for the Google Calendar integration card — which of the
 * five states a business is in and what to tell the user. Kept apart from
 * the component so it is unit-testable and so the card never renders a raw
 * provider error: last_error is deliberately NOT used for display (older
 * rows may still hold raw Google text from before errors were made
 * customer-safe).
 */

export type GoogleCalendarCardStateKind =
  "disconnected" | "choose_calendar" | "connected" | "reauth_required" | "sync_error";

export interface GoogleCalendarCardState {
  kind: GoogleCalendarCardStateKind;
  pill: { tone: "live" | "ready" | "error" | "idle"; label: string };
  /** Customer-safe explanation, or null when nothing needs saying. */
  message: string | null;
}

export function describeGoogleCalendarCardState(
  connection: { status: string; calendar_id: string | null } | null,
  options: { syncFailedCount?: number | undefined } = {},
): GoogleCalendarCardState {
  const status = connection?.status ?? "DISCONNECTED";
  const failed = Math.max(0, options.syncFailedCount ?? 0);

  if (!connection || status === "DISCONNECTED") {
    return {
      kind: "disconnected",
      pill: { tone: "idle", label: "Not connected" },
      message: null,
    };
  }
  if (status === "NEEDS_REAUTH") {
    return {
      kind: "reauth_required",
      pill: { tone: "error", label: "Reconnect needed" },
      message:
        "Google access has expired or was revoked, so ClickAI can't check availability or add bookings to this calendar. Reconnect to resume.",
    };
  }
  if (status === "NEEDS_CALENDAR_SELECTION" || !connection.calendar_id) {
    return {
      kind: "choose_calendar",
      pill: { tone: "ready", label: "Choose a calendar" },
      message: "Choose the calendar ClickAI should use for this business's appointments.",
    };
  }
  if (status === "ERROR") {
    return {
      kind: "sync_error",
      pill: { tone: "error", label: "Sync problem" },
      message:
        "ClickAI couldn't use the selected calendar. Run “Test connection” to check it, choose another calendar, or reconnect.",
    };
  }
  if (failed > 0) {
    return {
      kind: "sync_error",
      pill: { tone: "error", label: "Sync problem" },
      message: `${failed} upcoming ${failed === 1 ? "booking is" : "bookings are"} saved in ClickAI but not yet in Google Calendar. ClickAI retries automatically; you can also retry from the Bookings page.`,
    };
  }
  return { kind: "connected", pill: { tone: "live", label: "Connected" }, message: null };
}
