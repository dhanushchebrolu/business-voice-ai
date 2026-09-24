/**
 * Google OAuth 2.0 mechanics for Calendar access: the authorization URL,
 * the authorization-code exchange, refresh-token renewal, and reading back
 * which Google account was connected. Deliberately separate from
 * google-calendar-provider.server.ts (the Calendar *data* API) — this file
 * knows nothing about events/availability, only about obtaining and
 * renewing an access token.
 *
 * `fetchImpl` is always injectable (defaults to global fetch), matching
 * meta-client.server.ts's convention — tests never hit a real network.
 */

import type { GoogleCalendarConfig } from "./google-calendar-config.server.ts";

export class GoogleOAuthError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface TokenSet {
  accessToken: string;
  /** Only present on the FIRST authorization-code exchange, or when Google chooses to rotate it — a refresh call does not necessarily return a new one. */
  refreshToken?: string | undefined;
  expiresInSeconds: number;
}

export interface GoogleAccountInfo {
  googleAccountId: string;
  email: string | undefined;
}

/**
 * Builds the URL to send the browser to for Google's consent screen.
 * access_type=offline + prompt=consent guarantees a refresh_token comes
 * back even if this Google account previously authorized ClickAI — without
 * prompt=consent, a returning user's exchange can silently omit it, which
 * would leave ClickAI unable to refresh once the short-lived access token
 * expires.
 */
export function buildAuthorizationUrl(
  config: GoogleCalendarConfig,
  scopes: readonly string[],
  state: string,
): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

interface GoogleTokenErrorBody {
  error?: string;
  error_description?: string;
}

function mapTokenErrorResponse(
  status: number,
  parsed: GoogleTokenErrorBody | undefined,
): GoogleOAuthError {
  const code = parsed?.error;
  const description = parsed?.error_description;
  if (code === "invalid_grant") {
    return new GoogleOAuthError(
      "This Google authorization is no longer valid — it may have expired, already been used, or been revoked.",
      401,
    );
  }
  if (status === 429)
    return new GoogleOAuthError("Google rate-limited this request. Please retry shortly.", 429);
  if (status >= 500)
    return new GoogleOAuthError("Google is temporarily unavailable. Please retry.", 503);
  return new GoogleOAuthError(
    `Google rejected the request${description ? `: ${description}` : ""}.`,
    status,
  );
}

async function postToTokenEndpoint(
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new GoogleOAuthError("Google did not respond in time. Please retry.", 503);
    }
    throw new GoogleOAuthError("Could not reach Google. Please retry.", 503);
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = rawText ? JSON.parse(rawText) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!res.ok) {
    throw mapTokenErrorResponse(res.status, parsed as GoogleTokenErrorBody | undefined);
  }
  const body2 = parsed as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!body2.access_token || typeof body2.expires_in !== "number") {
    throw new GoogleOAuthError("Google returned an unexpected token response.", 502);
  }
  return {
    access_token: body2.access_token,
    ...(body2.refresh_token ? { refresh_token: body2.refresh_token } : {}),
    expires_in: body2.expires_in,
  };
}

/** Exchanges a one-time authorization code for an access token + (usually) a refresh token. */
export async function exchangeAuthorizationCode(
  config: GoogleCalendarConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const result = await postToTokenEndpoint(
    {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    },
    fetchImpl,
  );
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresInSeconds: result.expires_in,
  };
}

/** Mints a fresh access token from a previously-stored refresh token. Never persist the returned access token — mint on demand each time it's needed. */
export async function refreshAccessToken(
  config: GoogleCalendarConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const result = await postToTokenEndpoint(
    {
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    },
    fetchImpl,
  );
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresInSeconds: result.expires_in,
  };
}

/** Reads back which Google account/email this access token belongs to, for display in the dashboard ("Connected as business@gmail.com"). */
export async function fetchGoogleAccountInfo(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleAccountInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } catch {
    throw new GoogleOAuthError("Could not reach Google to read account info. Please retry.", 503);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new GoogleOAuthError("Could not read the connected Google account's info.", res.status);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string; email?: string };
  if (!data.id)
    throw new GoogleOAuthError("Google's account info response was missing an id.", 502);
  return { googleAccountId: data.id, email: data.email };
}
