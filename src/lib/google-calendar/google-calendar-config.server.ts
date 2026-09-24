/**
 * Server-side resolution of Google Calendar OAuth configuration. Mirrors
 * meta-config.server.ts's convention: read directly from process.env at
 * call time (never cached in a module-level variable), report presence/
 * absence without ever returning or logging a value.
 *
 * GOOGLE_CALENDAR_SCOPES is centralized here (spec section 8: "keep the
 * scope list centralized... do not scatter scopes throughout the
 * codebase") rather than being an environment variable — it's a code-level
 * decision (what this feature needs), not a per-deployment configuration
 * choice, so it lives next to the rest of the OAuth config it's used
 * alongside.
 */

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleCalendarConfigValidation {
  clientIdPresent: boolean;
  clientSecretPresent: boolean;
  redirectUriPresent: boolean;
  allPresent: boolean;
  /** Human-readable names of exactly what's missing — never the values themselves. */
  missing: string[];
}

/**
 * Minimum Google Calendar scopes this feature needs: read the user's
 * calendar list (to let them pick one) and full events access (create,
 * read, update, delete — required for booking/reschedule/cancel). No
 * broader Calendar or unrelated Google scope is requested.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

export function validateGoogleCalendarEnv(): GoogleCalendarConfigValidation {
  const clientIdPresent = Boolean(process.env["GOOGLE_CALENDAR_CLIENT_ID"]);
  const clientSecretPresent = Boolean(process.env["GOOGLE_CALENDAR_CLIENT_SECRET"]);
  const redirectUriPresent = Boolean(process.env["GOOGLE_CALENDAR_REDIRECT_URI"]);

  const missing: string[] = [];
  if (!clientIdPresent) missing.push("GOOGLE_CALENDAR_CLIENT_ID");
  if (!clientSecretPresent) missing.push("GOOGLE_CALENDAR_CLIENT_SECRET");
  if (!redirectUriPresent) missing.push("GOOGLE_CALENDAR_REDIRECT_URI");

  return {
    clientIdPresent,
    clientSecretPresent,
    redirectUriPresent,
    allPresent: missing.length === 0,
    missing,
  };
}

/** Returns null (never throws) when any required value is missing — callers decide how to fail. */
export function resolveGoogleCalendarConfig(): GoogleCalendarConfig | null {
  const validation = validateGoogleCalendarEnv();
  if (!validation.allPresent) return null;
  return {
    clientId: process.env["GOOGLE_CALENDAR_CLIENT_ID"]!,
    clientSecret: process.env["GOOGLE_CALENDAR_CLIENT_SECRET"]!,
    redirectUri: process.env["GOOGLE_CALENDAR_REDIRECT_URI"]!,
  };
}
