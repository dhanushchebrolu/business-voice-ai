/**
 * Orchestrates the Google Calendar connection lifecycle: completing OAuth,
 * selecting a calendar, disconnecting, and minting a valid access token for
 * an existing connection (decrypt refresh token -> refresh -> return a
 * ready-to-use provider). This is the one place that touches both the
 * encrypted-credential storage and the OAuth/provider mechanics — every
 * other module (calendar-service, calendar-tools, the dashboard server
 * functions) goes through this, never decrypts a credential itself.
 *
 * Like whatsapp-onboarding.server.ts, callers own authentication and
 * tenant derivation (organizationId/businessId are trusted parameters
 * here, already validated by the caller against the authenticated
 * session) — this file's own job is orchestration, not auth.
 *
 * Status lifecycle (google_calendar_connections.status):
 *   DISCONNECTED -> CONNECTING (not persisted as a distinct step; OAuth
 *     completes atomically) -> NEEDS_CALENDAR_SELECTION (tokens stored,
 *     no calendar chosen yet) -> CONNECTED (calendar chosen) -> NEEDS_REAUTH
 *     (refresh failed with invalid_grant) -> ERROR (any other persistent
 *     failure). DISCONNECTED again after an explicit disconnect.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { encryptCredential, decryptCredential } from "./google-calendar-crypto.server.ts";
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  fetchGoogleAccountInfo,
  GoogleOAuthError,
} from "./google-oauth.server.ts";
import {
  resolveGoogleCalendarConfig,
  GOOGLE_CALENDAR_SCOPES,
} from "./google-calendar-config.server.ts";
import { GoogleCalendarProvider } from "../calendar/google-calendar-provider.server.ts";
import type { CalendarProvider } from "../calendar/calendar-provider.ts";

type Client = SupabaseClient<Database>;

export class GoogleCalendarConnectionError extends Error {
  code: "NOT_CONFIGURED" | "NOT_FOUND" | "NEEDS_REAUTH" | "OAUTH_FAILED" | "UNKNOWN";
  constructor(message: string, code: GoogleCalendarConnectionError["code"]) {
    super(message);
    this.code = code;
  }
}

interface StoredCredentials {
  refreshToken: string;
}

/**
 * Step 1 of OAuth completion: exchange the authorization code, read back
 * which Google account this is, and upsert the connection row. Leaves
 * calendar_id unset — the caller (server function) still needs to ask the
 * client which calendar to use (spec: "do not assume primary").
 */
export async function completeGoogleCalendarOAuth(
  supabaseAdmin: Client,
  input: { organizationId: string; businessId: string; code: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ connectionId: string }> {
  const config = resolveGoogleCalendarConfig();
  if (!config) {
    throw new GoogleCalendarConnectionError(
      "Google Calendar is not configured on this deployment.",
      "NOT_CONFIGURED",
    );
  }

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode(config, input.code, fetchImpl);
  } catch (err) {
    throw new GoogleCalendarConnectionError(
      err instanceof GoogleOAuthError ? err.message : "Failed to complete Google authorization.",
      "OAUTH_FAILED",
    );
  }
  if (!tokens.refreshToken) {
    // Should not happen with access_type=offline + prompt=consent, but if
    // Google ever omits it, there is nothing to persist for future
    // refreshes — fail loudly rather than silently storing an
    // access-token-only connection that will die in ~1 hour.
    throw new GoogleCalendarConnectionError(
      "Google did not grant offline access. Please try connecting again.",
      "OAUTH_FAILED",
    );
  }

  const accountInfo = await fetchGoogleAccountInfo(tokens.accessToken, fetchImpl).catch(() => null);

  const encrypted = encryptCredential(
    JSON.stringify({ refreshToken: tokens.refreshToken } satisfies StoredCredentials),
  );
  const tokenExpiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("google_calendar_connections")
    .upsert(
      {
        organization_id: input.organizationId,
        business_id: input.businessId,
        provider: "google",
        google_account_id: accountInfo?.googleAccountId ?? null,
        google_email: accountInfo?.email ?? null,
        status: "NEEDS_CALENDAR_SELECTION",
        scopes: [...GOOGLE_CALENDAR_SCOPES],
        encrypted_credentials: encrypted,
        token_expires_at: tokenExpiresAt,
        last_connected_at: new Date().toISOString(),
        last_error: null,
      },
      { onConflict: "organization_id,business_id,provider" },
    )
    .select("id")
    .single();
  if (error || !data) {
    throw new GoogleCalendarConnectionError(
      `Failed to store the Google Calendar connection: ${error?.message ?? "unknown error"}`,
      "UNKNOWN",
    );
  }
  return { connectionId: data.id };
}

/** Step 2: the client picks which calendar ClickAI should use. */
export async function selectCalendarForConnection(
  supabaseAdmin: Client,
  input: { organizationId: string; connectionId: string; calendarId: string; calendarName: string },
): Promise<void> {
  const { data: existing, error: readError } = await supabaseAdmin
    .from("google_calendar_connections")
    .select("id, organization_id")
    .eq("id", input.connectionId)
    .maybeSingle();
  if (readError) throw readError;
  if (!existing || existing.organization_id !== input.organizationId) {
    throw new GoogleCalendarConnectionError(
      "That connection does not belong to your workspace.",
      "NOT_FOUND",
    );
  }

  const { error } = await supabaseAdmin
    .from("google_calendar_connections")
    .update({
      calendar_id: input.calendarId,
      calendar_name: input.calendarName,
      status: "CONNECTED",
    })
    .eq("id", input.connectionId);
  if (error) throw error;
}

/**
 * Disconnects ClickAI's access without touching the customer's actual
 * Google Calendar or any already-created events, and without deleting
 * ClickAI's own historical bookings (spec section 33) — those keep their
 * calendar_connection_id reference; only this connection's own credential
 * and status change.
 */
export async function disconnectGoogleCalendarConnection(
  supabaseAdmin: Client,
  input: { organizationId: string; connectionId: string },
): Promise<void> {
  const { data: existing, error: readError } = await supabaseAdmin
    .from("google_calendar_connections")
    .select("id, organization_id")
    .eq("id", input.connectionId)
    .maybeSingle();
  if (readError) throw readError;
  if (!existing || existing.organization_id !== input.organizationId) {
    throw new GoogleCalendarConnectionError(
      "That connection does not belong to your workspace.",
      "NOT_FOUND",
    );
  }

  const { error } = await supabaseAdmin
    .from("google_calendar_connections")
    .update({ status: "DISCONNECTED", encrypted_credentials: null, token_expires_at: null })
    .eq("id", input.connectionId);
  if (error) throw error;
}

/**
 * Mints a currently-valid access token for a connection: reads the row,
 * decrypts the stored refresh token, calls Google to refresh. On
 * invalid_grant (revoked/expired authorization), marks the connection
 * NEEDS_REAUTH and throws — callers must never silently proceed as if the
 * connection were healthy.
 */
async function getValidAccessToken(
  supabaseAdmin: Client,
  connectionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; calendarId: string }> {
  const { data: connection, error } = await supabaseAdmin
    .from("google_calendar_connections")
    .select("id, status, calendar_id, encrypted_credentials")
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw error;
  if (!connection) {
    throw new GoogleCalendarConnectionError("Google Calendar connection not found.", "NOT_FOUND");
  }
  if (connection.status === "DISCONNECTED" || connection.status === "NEEDS_REAUTH") {
    throw new GoogleCalendarConnectionError(
      "This business's Google Calendar needs to be (re)connected.",
      "NEEDS_REAUTH",
    );
  }
  if (!connection.calendar_id) {
    throw new GoogleCalendarConnectionError(
      "This business has not selected a Google Calendar yet.",
      "NOT_FOUND",
    );
  }
  if (!connection.encrypted_credentials) {
    throw new GoogleCalendarConnectionError(
      "No Google Calendar credentials are stored.",
      "NEEDS_REAUTH",
    );
  }

  const config = resolveGoogleCalendarConfig();
  if (!config) {
    throw new GoogleCalendarConnectionError(
      "Google Calendar is not configured on this deployment.",
      "NOT_CONFIGURED",
    );
  }

  const stored = JSON.parse(
    decryptCredential(connection.encrypted_credentials),
  ) as StoredCredentials;

  let tokens;
  try {
    tokens = await refreshAccessToken(config, stored.refreshToken, fetchImpl);
  } catch (err) {
    if (err instanceof GoogleOAuthError && err.status === 401) {
      await supabaseAdmin
        .from("google_calendar_connections")
        .update({ status: "NEEDS_REAUTH", last_error: err.message })
        .eq("id", connectionId);
      throw new GoogleCalendarConnectionError(
        "Google Calendar access has expired or been revoked. Please reconnect.",
        "NEEDS_REAUTH",
      );
    }
    await supabaseAdmin
      .from("google_calendar_connections")
      .update({
        last_error: err instanceof Error ? err.message : "Unknown error refreshing Google access.",
      })
      .eq("id", connectionId);
    throw err;
  }

  // A refresh token rotation (Google returning a new one) must be
  // persisted, or the next refresh would use a now-invalid token.
  const nextCredentials = tokens.refreshToken
    ? encryptCredential(
        JSON.stringify({ refreshToken: tokens.refreshToken } satisfies StoredCredentials),
      )
    : connection.encrypted_credentials;

  await supabaseAdmin
    .from("google_calendar_connections")
    .update({
      encrypted_credentials: nextCredentials,
      token_expires_at: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
      last_sync_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", connectionId);

  return { accessToken: tokens.accessToken, calendarId: connection.calendar_id };
}

/** Convenience: a ready-to-use CalendarProvider for a connection, plus which calendar it's scoped to. */
export async function getCalendarProviderForConnection(
  supabaseAdmin: Client,
  connectionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ provider: CalendarProvider; calendarId: string }> {
  const { accessToken, calendarId } = await getValidAccessToken(
    supabaseAdmin,
    connectionId,
    fetchImpl,
  );
  return { provider: new GoogleCalendarProvider({ accessToken, fetchImpl }), calendarId };
}
