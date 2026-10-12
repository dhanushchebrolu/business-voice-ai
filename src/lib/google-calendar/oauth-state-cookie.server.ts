/**
 * Binds a Google Calendar OAuth `state` to the browser that started the
 * flow.
 *
 * The oauth_states row already makes `state` unguessable, short-lived and
 * single-use, and carries the tenant identity. What it cannot prove on its
 * own is that the browser landing on the callback is the one that clicked
 * "Connect": without a browser binding, an attacker could start a flow for
 * THEIR business, then trick an admin of another workspace into opening the
 * resulting Google consent link (login CSRF in reverse — the victim's
 * Google calendar gets attached to the attacker's business). So
 * connectGoogleCalendar also sets this cookie, and the callback refuses any
 * state that does not match it (constant-time) before consuming the state
 * or exchanging the code.
 *
 * Cookie properties:
 *  - HttpOnly: page scripts can never read it.
 *  - Secure: HTTPS only.
 *  - SameSite=Lax: still sent on Google's top-level GET redirect back to
 *    the callback (Strict would drop it), never on cross-site subrequests.
 *  - Path limited to the callback's directory, so it is not sent anywhere
 *    else in the app.
 *  - Max-Age equal to the oauth_states TTL (10 minutes), and cleared on
 *    every callback response, success or failure (single use).
 */

import { constantTimeEquals } from "../constant-time-equals.server.ts";

export const GOOGLE_OAUTH_STATE_COOKIE = "clickai_gcal_oauth_state";
export const GOOGLE_OAUTH_STATE_COOKIE_PATH = "/api/public/integrations/google-calendar";
export const GOOGLE_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export const googleOAuthStateCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: GOOGLE_OAUTH_STATE_COOKIE_PATH,
  maxAge: GOOGLE_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
} as const;

/** Reads one cookie's value from a raw Cookie header (no decoding beyond URI-unescaping). */
export function readCookieValue(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * Whether the `state` query parameter matches the state cookie this browser
 * was given. Missing either side is a mismatch.
 */
export function oauthStateMatchesCookie(
  cookieHeader: string | null | undefined,
  state: string | null | undefined,
): boolean {
  const cookieState = readCookieValue(cookieHeader, GOOGLE_OAUTH_STATE_COOKIE);
  if (!cookieState || !state) return false;
  return constantTimeEquals(cookieState, state);
}

/** Set-Cookie header value that deletes the state cookie. */
export function clearOAuthStateCookieHeader(): string {
  return `${GOOGLE_OAUTH_STATE_COOKIE}=; Path=${GOOGLE_OAUTH_STATE_COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
