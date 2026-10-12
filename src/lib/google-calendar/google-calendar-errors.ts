/**
 * Customer-facing wording for every Google Calendar failure ClickAI can
 * hit. Shared by the server (what gets stored in
 * google_calendar_connections.last_error and returned from server
 * functions) and the dashboard card, so a raw Google/provider message never
 * reaches the UI. Client-safe: no server imports.
 */

export type GoogleCalendarIssueCode =
  | "NOT_CONFIGURED"
  | "NEEDS_REAUTH"
  | "GOOGLE_AUTH_REQUIRED"
  | "NOT_FOUND"
  | "CALENDAR_NOT_SELECTED"
  | "CALENDAR_NOT_FOUND"
  | "CALENDAR_NOT_WRITABLE"
  | "CALENDAR_ACCESS_DENIED"
  | "CALENDAR_RATE_LIMITED"
  | "CALENDAR_UNAVAILABLE"
  | "FORBIDDEN"
  | "OAUTH_FAILED"
  | "UNKNOWN";

const MESSAGES: Record<GoogleCalendarIssueCode, string> = {
  NOT_CONFIGURED:
    "Google Calendar isn't set up on this ClickAI deployment yet. Please contact support.",
  NEEDS_REAUTH:
    "Google access has expired or was revoked. Reconnect Google Calendar to resume syncing.",
  GOOGLE_AUTH_REQUIRED:
    "Google access has expired or was revoked. Reconnect Google Calendar to resume syncing.",
  NOT_FOUND: "This calendar connection no longer exists. Refresh the page and try again.",
  CALENDAR_NOT_SELECTED: "Choose which Google Calendar ClickAI should use for bookings.",
  CALENDAR_NOT_FOUND:
    "The selected calendar can't be found anymore. It may have been deleted or unshared — choose another calendar.",
  CALENDAR_NOT_WRITABLE:
    "ClickAI can't add events to that calendar. Choose a calendar you own or can edit.",
  CALENDAR_ACCESS_DENIED:
    "Google denied access to the selected calendar. Check its sharing settings or choose another calendar.",
  CALENDAR_RATE_LIMITED: "Google is busy right now. Please try again in a few minutes.",
  CALENDAR_UNAVAILABLE: "Google Calendar didn't respond. Please try again in a few minutes.",
  FORBIDDEN: "Only workspace owners and admins can manage the Google Calendar connection.",
  OAUTH_FAILED: "Google sign-in didn't complete. Please try connecting again.",
  UNKNOWN: "Something went wrong talking to Google Calendar. Please try again.",
};

export function googleCalendarIssueMessage(code: string | null | undefined): string {
  return (code && (MESSAGES as Record<string, string>)[code]) || MESSAGES.UNKNOWN;
}

/** Maps any thrown error (with an optional `code`) to a known issue code. */
export function googleCalendarIssueCode(err: unknown): GoogleCalendarIssueCode {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code in MESSAGES) return code as GoogleCalendarIssueCode;
  if (code === "EVENT_NOT_FOUND") return "CALENDAR_NOT_FOUND";
  return "UNKNOWN";
}

/** The callback's ?reason= codes, translated for the result banner. */
export function googleCalendarCallbackMessage(reason: string | null | undefined): string {
  switch (reason) {
    case "denied":
      return "Google access wasn't granted, so nothing was connected.";
    case "invalid_state":
      return "That sign-in link expired or was opened in a different browser. Please start the connection again from this page.";
    case "missing_code":
    case "google_error":
      return "Google didn't complete the sign-in. Please try again.";
    case "not_configured":
      return MESSAGES.NOT_CONFIGURED;
    default:
      return "We couldn't finish connecting Google Calendar. Please try again.";
  }
}
