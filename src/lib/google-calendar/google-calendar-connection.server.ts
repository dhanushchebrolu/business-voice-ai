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
  revokeGoogleToken,
  GoogleOAuthError,
} from "./google-oauth.server.ts";
import {
  resolveGoogleCalendarConfig,
  GOOGLE_CALENDAR_SCOPES,
} from "./google-calendar-config.server.ts";
import { googleCalendarIssueCode, googleCalendarIssueMessage } from "./google-calendar-errors.ts";
import { GoogleCalendarProvider } from "../calendar/google-calendar-provider.server.ts";
import {
  calendarAllowsWrites,
  type CalendarListEntry,
  type CalendarProvider,
} from "../calendar/calendar-provider.ts";

type Client = SupabaseClient<Database>;

export class GoogleCalendarConnectionError extends Error {
  code:
    | "NOT_CONFIGURED"
    | "NOT_FOUND"
    | "NEEDS_REAUTH"
    | "OAUTH_FAILED"
    | "CALENDAR_NOT_SELECTED"
    | "CALENDAR_NOT_WRITABLE"
    | "UNKNOWN";
  constructor(message: string, code: GoogleCalendarConnectionError["code"]) {
    super(message);
    this.code = code;
  }
}

interface StoredCredentials {
  refreshToken: string;
}

const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Connection fields that describe WHICH calendar of WHICH Google account
 * ClickAI is attached to. All of them become meaningless (and dangerous —
 * a stale calendar_id would point bookings at a calendar the new account
 * may not even see) once the connection is re-pointed at another account.
 */
const ACCOUNT_SCOPED_RESET = {
  calendar_id: null,
  calendar_name: null,
  sync_token: null,
  channel_id: null,
  channel_resource_id: null,
  channel_expiration: null,
  channel_token: null,
} as const;

/**
 * The connected account's identity, read without any extra OAuth scope.
 *
 * ClickAI only requests calendar scopes (no openid/email), so Google's
 * userinfo endpoint normally refuses to answer and google_email used to stay
 * null. The primary calendar is the reliable substitute: for every Google
 * account (consumer Gmail, Workspace, or a Google account on a non-Gmail
 * address) the primary calendar's id IS the account's primary email
 * address, and reading it needs only calendar.readonly, which is already
 * granted. It is used only when it is actually email-shaped. The one case
 * where it changes for the same person — a Workspace admin renaming the
 * user's primary address — is detected as an account switch, which fails
 * safe (the calendar must be chosen again), never the other way round.
 */
async function readAccountIdentity(
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<{ googleAccountId: string | null; email: string | null }> {
  const userinfo = await fetchGoogleAccountInfo(accessToken, fetchImpl).catch(() => null);
  let primaryId: string | null = null;
  try {
    const calendars = await new GoogleCalendarProvider({ accessToken, fetchImpl }).listCalendars();
    primaryId = calendars.find((c) => c.primary)?.id ?? null;
  } catch {
    primaryId = null;
  }
  const primaryEmail = primaryId && EMAIL_SHAPED.test(primaryId) ? primaryId.toLowerCase() : null;
  const userinfoEmail =
    userinfo?.email && EMAIL_SHAPED.test(userinfo.email) ? userinfo.email.toLowerCase() : null;
  return {
    googleAccountId: userinfo?.googleAccountId ?? null,
    email: primaryEmail ?? userinfoEmail,
  };
}

/**
 * Whether a reconnect is provably the SAME Google account as the stored
 * connection. Unknown on either side counts as "not the same" — keeping a
 * stale calendar is the dangerous direction, re-choosing one is cheap.
 */
export function isSameGoogleAccount(
  previous: { google_account_id: string | null; google_email: string | null },
  next: { googleAccountId: string | null; email: string | null },
): boolean {
  if (previous.google_account_id && next.googleAccountId) {
    return previous.google_account_id === next.googleAccountId;
  }
  if (previous.google_email && next.email) {
    return previous.google_email.toLowerCase() === next.email.toLowerCase();
  }
  return false;
}

function decryptRefreshToken(encrypted: string | null): string | null {
  if (!encrypted) return null;
  try {
    return (JSON.parse(decryptCredential(encrypted)) as StoredCredentials).refreshToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether any OTHER connection still holds credentials for this Google
 * account, in any business or workspace.
 *
 * Revoking a token at Google's revoke endpoint withdraws ClickAI's whole
 * grant for that Google account — every refresh token ClickAI holds for
 * it stops working, not just this connection's. So the grant may only be
 * revoked when no other connection still depends on it.
 *
 * Fails safe: an unknown account, or a lookup error, counts as "in use"
 * (the grant is kept). This connection's own credential is still deleted
 * locally, so ClickAI holds no token for it either way; the user can also
 * remove access themselves in their Google account settings.
 */
export async function isGoogleAccountUsedElsewhere(
  supabaseAdmin: Client,
  input: {
    excludeConnectionId: string;
    googleAccountId: string | null | undefined;
    googleEmail: string | null | undefined;
  },
): Promise<boolean> {
  const email = input.googleEmail ? input.googleEmail.toLowerCase() : null;
  const accountId = input.googleAccountId || null;
  if (!email && !accountId) return true;

  const lookups: [column: "google_email" | "google_account_id", value: string][] = [];
  if (email) lookups.push(["google_email", email]);
  if (accountId) lookups.push(["google_account_id", accountId]);
  for (const [column, value] of lookups) {
    const { data, error } = await supabaseAdmin
      .from("google_calendar_connections")
      .select("id")
      .eq(column, value)
      .neq("id", input.excludeConnectionId)
      .not("encrypted_credentials", "is", null)
      .limit(1);
    if (error) return true;
    if ((data ?? []).length > 0) return true;
  }
  return false;
}

/**
 * Step 1 of OAuth completion: exchange the authorization code, read back
 * which Google account this is, and upsert the connection row.
 *
 * First connect: NEEDS_CALENDAR_SELECTION (spec: "do not assume primary").
 * Reconnect with the SAME account and a calendar already chosen: straight
 * back to CONNECTED with the calendar and sync state kept.
 * Reconnect with a DIFFERENT (or unverifiable) account: every
 * account-scoped field is cleared so nothing keeps pointing at the old
 * account's calendar, and the old account's grant is revoked best-effort
 * when it is provably a different account (revoking a token also revokes
 * the new one when the account is the same, so that is never attempted
 * on a guess).
 */
export async function completeGoogleCalendarOAuth(
  supabaseAdmin: Client,
  input: { organizationId: string; businessId: string; code: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ connectionId: string; accountChanged: boolean; status: string }> {
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

  const identity = await readAccountIdentity(tokens.accessToken, fetchImpl);

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("google_calendar_connections")
    .select("id, google_account_id, google_email, calendar_id, encrypted_credentials")
    .eq("organization_id", input.organizationId)
    .eq("business_id", input.businessId)
    .eq("provider", "google")
    .maybeSingle();
  if (existingError) {
    throw new GoogleCalendarConnectionError(
      "Failed to read the existing Google Calendar connection.",
      "UNKNOWN",
    );
  }

  const sameAccount = existing ? isSameGoogleAccount(existing, identity) : false;
  const keepCalendar = sameAccount && Boolean(existing?.calendar_id);
  const accountChanged = Boolean(existing) && !sameAccount;

  const encrypted = encryptCredential(
    JSON.stringify({ refreshToken: tokens.refreshToken } satisfies StoredCredentials),
  );
  const tokenExpiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();
  const status = keepCalendar ? "CONNECTED" : "NEEDS_CALENDAR_SELECTION";

  const { data, error } = await supabaseAdmin
    .from("google_calendar_connections")
    .upsert(
      {
        organization_id: input.organizationId,
        business_id: input.businessId,
        provider: "google",
        google_account_id: identity.googleAccountId,
        google_email: identity.email,
        status,
        scopes: [...GOOGLE_CALENDAR_SCOPES],
        encrypted_credentials: encrypted,
        token_expires_at: tokenExpiresAt,
        last_connected_at: new Date().toISOString(),
        last_error: null,
        ...(keepCalendar ? {} : ACCOUNT_SCOPED_RESET),
      },
      { onConflict: "organization_id,business_id,provider" },
    )
    .select("id")
    .single();
  if (error || !data) {
    throw new GoogleCalendarConnectionError(
      "Failed to store the Google Calendar connection.",
      "UNKNOWN",
    );
  }

  if (accountChanged && existing && identity.email && existing.google_email) {
    const oldRefreshToken = decryptRefreshToken(existing.encrypted_credentials);
    if (oldRefreshToken && oldRefreshToken !== tokens.refreshToken) {
      // The previous account's credential is already gone from this row
      // (overwritten by the upsert above). Its grant is revoked only when
      // no other business still uses that same Google account.
      const shared = await isGoogleAccountUsedElsewhere(supabaseAdmin, {
        excludeConnectionId: data.id,
        googleAccountId: existing.google_account_id,
        googleEmail: existing.google_email,
      });
      if (shared) {
        console.info("google_calendar_connection:previous_account_revoke_skipped", {
          connectionId: data.id,
          reason: "account_in_use_elsewhere",
        });
      } else {
        const revoked = await revokeGoogleToken(oldRefreshToken, fetchImpl);
        console.info("google_calendar_connection:previous_account_revoked", {
          connectionId: data.id,
          ok: revoked.ok,
        });
      }
    }
  }

  return { connectionId: data.id, accountChanged, status };
}

async function readConnectionInOrg<R extends object>(
  supabaseAdmin: Client,
  organizationId: string,
  connectionId: string,
  columns: string,
): Promise<R> {
  const { data, error } = await supabaseAdmin
    .from("google_calendar_connections")
    .select(columns)
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw error;
  const row = data as unknown as { organization_id?: string } | null;
  if (!row || row.organization_id !== organizationId) {
    throw new GoogleCalendarConnectionError(
      "That connection does not belong to your workspace.",
      "NOT_FOUND",
    );
  }
  return row as unknown as R;
}

/**
 * The calendars the connected account can actually add events to — the
 * only ones offered for selection. Works before a calendar is chosen
 * (NEEDS_CALENDAR_SELECTION), which the booking-path token helper does
 * not allow.
 */
export async function listWritableCalendarsForConnection(
  supabaseAdmin: Client,
  input: { organizationId: string; connectionId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarListEntry[]> {
  await readConnectionInOrg(
    supabaseAdmin,
    input.organizationId,
    input.connectionId,
    "id, organization_id",
  );
  const { provider } = await getProviderForSetup(supabaseAdmin, input.connectionId, fetchImpl);
  const calendars = await provider.listCalendars();
  return calendars.filter(calendarAllowsWrites);
}

/**
 * Step 2: the client picks which calendar ClickAI should use. The choice
 * is re-validated against Google server-side — the client only sends an
 * id; the calendar must exist in the connected account's calendar list
 * with owner/writer access, and its display name is taken from Google,
 * not from the request. Choosing a different calendar than before drops
 * the old calendar's sync token and push-channel metadata (the old
 * channel is stopped best-effort).
 */
export async function selectCalendarForConnection(
  supabaseAdmin: Client,
  input: { organizationId: string; connectionId: string; calendarId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ calendarId: string; calendarName: string }> {
  const existing = await readConnectionInOrg<{
    calendar_id: string | null;
    channel_id: string | null;
    channel_resource_id: string | null;
  }>(
    supabaseAdmin,
    input.organizationId,
    input.connectionId,
    "id, organization_id, calendar_id, channel_id, channel_resource_id",
  );

  const { provider } = await getProviderForSetup(supabaseAdmin, input.connectionId, fetchImpl);
  const calendars = await provider.listCalendars();
  const chosen = calendars.find((c) => c.id === input.calendarId);
  if (!chosen || !calendarAllowsWrites(chosen)) {
    throw new GoogleCalendarConnectionError(
      googleCalendarIssueMessage("CALENDAR_NOT_WRITABLE"),
      "CALENDAR_NOT_WRITABLE",
    );
  }

  const calendarChanged = existing.calendar_id !== chosen.id;
  if (calendarChanged && existing.channel_id && existing.channel_resource_id) {
    await (provider as GoogleCalendarProvider)
      .stopChannel(existing.channel_id, existing.channel_resource_id)
      .catch(() => {});
  }

  const { error } = await supabaseAdmin
    .from("google_calendar_connections")
    .update({
      calendar_id: chosen.id,
      calendar_name: chosen.name,
      status: "CONNECTED",
      last_error: null,
      ...(calendarChanged
        ? {
            sync_token: null,
            channel_id: null,
            channel_resource_id: null,
            channel_expiration: null,
            channel_token: null,
          }
        : {}),
    })
    .eq("id", input.connectionId);
  if (error) throw error;
  return { calendarId: chosen.id, calendarName: chosen.name };
}

/** Why a disconnect deleted the local credential but kept the Google grant. */
export type RevokeSkipReason =
  "account_in_use_elsewhere" | "account_unknown" | "already_disconnected";

/**
 * Disconnects ClickAI's access without touching the customer's actual
 * Google Calendar or any already-created events, and without deleting
 * ClickAI's own historical bookings (spec section 33) — those keep their
 * calendar_connection_id reference; only this connection's own credential
 * and status change.
 *
 * Order:
 *  1. Stop this connection's push channel (best-effort; needs a live
 *     access token, minted from this connection's own refresh token).
 *  2. Delete the credential locally. The update only matches while the row
 *     still holds credentials, so when two disconnects of the same
 *     connection race, exactly one of them "owns" the rest of the steps.
 *  3. Only then decide on revoking: the Google grant is shared by every
 *     connection to the same Google account (isGoogleAccountUsedElsewhere),
 *     so it is revoked only when no other connection still holds
 *     credentials for that account. Checking AFTER step 2 means two
 *     businesses sharing an account that disconnect at the same moment
 *     each see the other already gone, so the grant is still revoked;
 *     the worst interleaving is a revoke that runs twice, which is
 *     harmless. A connection whose Google account was never identified
 *     keeps its grant ("account_unknown") — it cannot be proven unshared.
 *     Remaining race: if the same account is being freshly connected to
 *     another business while this revoke is in flight, that new connection
 *     can end up "Reconnect needed". Nothing here can lock against Google,
 *     and the card makes that state visible and recoverable.
 *
 * Steps 1 and 3 never block the local disconnect. A channel that could not
 * be stopped is rejected by the webhook anyway once its channel_id and
 * channel_token are cleared.
 */
export async function disconnectGoogleCalendarConnection(
  supabaseAdmin: Client,
  input: { organizationId: string; connectionId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{
  channelStopped: boolean;
  revoked: boolean;
  revokeSkipped: RevokeSkipReason | null;
}> {
  const existing = await readConnectionInOrg<{
    encrypted_credentials?: string | null;
    channel_id?: string | null;
    channel_resource_id?: string | null;
    google_email?: string | null;
    google_account_id?: string | null;
  }>(
    supabaseAdmin,
    input.organizationId,
    input.connectionId,
    "id, organization_id, encrypted_credentials, channel_id, channel_resource_id, google_email, google_account_id",
  );

  let channelStopped = false;
  const refreshToken = decryptRefreshToken(existing.encrypted_credentials ?? null);
  const config = resolveGoogleCalendarConfig();
  if (refreshToken && config && existing.channel_id && existing.channel_resource_id) {
    try {
      const tokens = await refreshAccessToken(config, refreshToken, fetchImpl);
      await new GoogleCalendarProvider({
        accessToken: tokens.accessToken,
        fetchImpl,
      }).stopChannel(existing.channel_id, existing.channel_resource_id);
      channelStopped = true;
    } catch {
      channelStopped = false;
    }
  }

  const { data: cleared, error } = await supabaseAdmin
    .from("google_calendar_connections")
    .update({
      status: "DISCONNECTED",
      encrypted_credentials: null,
      token_expires_at: null,
      sync_token: null,
      channel_id: null,
      channel_resource_id: null,
      channel_expiration: null,
      channel_token: null,
      last_error: null,
    })
    .eq("id", input.connectionId)
    .not("encrypted_credentials", "is", null)
    .select("id");
  if (error) throw error;
  const clearedByThisCall = (cleared ?? []).length > 0;

  let revoked = false;
  let revokeSkipped: RevokeSkipReason | null = null;
  if (!clearedByThisCall) {
    // Nothing was stored, or a concurrent disconnect already removed it
    // and owns the revoke decision. Make sure the row still ends up
    // DISCONNECTED (e.g. a credential-less NEEDS_REAUTH row).
    const { error: statusError } = await supabaseAdmin
      .from("google_calendar_connections")
      .update({
        status: "DISCONNECTED",
        sync_token: null,
        channel_id: null,
        channel_resource_id: null,
        channel_expiration: null,
        channel_token: null,
        last_error: null,
      })
      .eq("id", input.connectionId);
    if (statusError) throw statusError;
    if (refreshToken) revokeSkipped = "already_disconnected";
  } else if (refreshToken && config && !existing.google_email && !existing.google_account_id) {
    // Connected before the account identity was recorded: there is no way
    // to tell whether another business shares this grant, so it is kept.
    revokeSkipped = "account_unknown";
  } else if (refreshToken && config) {
    const shared = await isGoogleAccountUsedElsewhere(supabaseAdmin, {
      excludeConnectionId: input.connectionId,
      googleAccountId: existing.google_account_id ?? null,
      googleEmail: existing.google_email ?? null,
    });
    if (shared) {
      revokeSkipped = "account_in_use_elsewhere";
    } else {
      revoked = (await revokeGoogleToken(refreshToken, fetchImpl)).ok;
    }
  }

  console.info("google_calendar_connection:disconnected", {
    connectionId: input.connectionId,
    channelStopped,
    revoked,
    revokeSkipped,
  });
  return { channelStopped, revoked, revokeSkipped };
}

/**
 * Mints a currently-valid access token for a connection: reads the row,
 * decrypts the stored refresh token, calls Google to refresh. On
 * invalid_grant (revoked/expired authorization), marks the connection
 * NEEDS_REAUTH and throws — callers must never silently proceed as if the
 * connection were healthy.
 *
 * `requireCalendar: false` is for the setup steps (listing/selecting a
 * calendar) that legitimately run before calendar_id is set.
 */
async function mintAccessToken(
  supabaseAdmin: Client,
  connectionId: string,
  fetchImpl: typeof fetch,
  options: { requireCalendar: boolean },
): Promise<{ accessToken: string; calendarId: string | null }> {
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
  if (options.requireCalendar && !connection.calendar_id) {
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
        .update({ status: "NEEDS_REAUTH", last_error: googleCalendarIssueMessage("NEEDS_REAUTH") })
        .eq("id", connectionId);
      throw new GoogleCalendarConnectionError(
        "Google Calendar access has expired or been revoked. Please reconnect.",
        "NEEDS_REAUTH",
      );
    }
    const code =
      err instanceof GoogleOAuthError && (err.status === 429 || err.status >= 500)
        ? "CALENDAR_UNAVAILABLE"
        : googleCalendarIssueCode(err);
    await supabaseAdmin
      .from("google_calendar_connections")
      .update({ last_error: googleCalendarIssueMessage(code) })
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

async function getValidAccessToken(
  supabaseAdmin: Client,
  connectionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; calendarId: string }> {
  const { accessToken, calendarId } = await mintAccessToken(
    supabaseAdmin,
    connectionId,
    fetchImpl,
    {
      requireCalendar: true,
    },
  );
  return { accessToken, calendarId: calendarId! };
}

/** Provider for the setup steps that run before a calendar is chosen. */
async function getProviderForSetup(
  supabaseAdmin: Client,
  connectionId: string,
  fetchImpl: typeof fetch,
): Promise<{ provider: GoogleCalendarProvider }> {
  const { accessToken } = await mintAccessToken(supabaseAdmin, connectionId, fetchImpl, {
    requireCalendar: false,
  });
  return { provider: new GoogleCalendarProvider({ accessToken, fetchImpl }) };
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

export type GoogleCalendarTestResult =
  { ok: true; checkedAt: string } | { ok: false; code: string; message: string };

/**
 * "Test connection": proves the stored grant still works end to end — a
 * token refresh, then a free/busy read of the selected calendar for the
 * next hour. Records the outcome on the connection (CONNECTED + cleared
 * error, or ERROR + friendly error; NEEDS_REAUTH is set by the refresh
 * itself) and returns only a code + customer-safe message.
 */
export async function testGoogleCalendarConnection(
  supabaseAdmin: Client,
  input: { organizationId: string; connectionId: string },
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<GoogleCalendarTestResult> {
  const row = await readConnectionInOrg<{ status: string; calendar_id: string | null }>(
    supabaseAdmin,
    input.organizationId,
    input.connectionId,
    "id, organization_id, status, calendar_id",
  );
  if (!row.calendar_id) {
    return {
      ok: false,
      code: "CALENDAR_NOT_SELECTED",
      message: googleCalendarIssueMessage("CALENDAR_NOT_SELECTED"),
    };
  }

  try {
    const { provider, calendarId } = await getCalendarProviderForConnection(
      supabaseAdmin,
      input.connectionId,
      fetchImpl,
    );
    await provider.getBusyPeriods({
      calendarId,
      timeMinIso: now.toISOString(),
      timeMaxIso: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    });
  } catch (err) {
    const code =
      err instanceof GoogleOAuthError && (err.status === 429 || err.status >= 500)
        ? "CALENDAR_UNAVAILABLE"
        : googleCalendarIssueCode(err);
    const message = googleCalendarIssueMessage(code);
    if (code !== "NEEDS_REAUTH" && code !== "GOOGLE_AUTH_REQUIRED") {
      // A transient Google outage is reported but does not flip a healthy
      // connection to ERROR; a persistent problem (lost access, deleted
      // calendar) does.
      const transient = code === "CALENDAR_UNAVAILABLE" || code === "CALENDAR_RATE_LIMITED";
      await supabaseAdmin
        .from("google_calendar_connections")
        .update(transient ? { last_error: message } : { status: "ERROR", last_error: message })
        .eq("id", input.connectionId);
    }
    console.info("google_calendar_connection:test_failed", {
      connectionId: input.connectionId,
      code,
    });
    return { ok: false, code, message };
  }

  const checkedAt = now.toISOString();
  await supabaseAdmin
    .from("google_calendar_connections")
    .update({ status: "CONNECTED", last_error: null, last_sync_at: checkedAt })
    .eq("id", input.connectionId);
  return { ok: true, checkedAt };
}

// Exported under this name (same alias-export convention as
// razorpay-connection.server.ts's own getValidRazorpayAccessToken) for the
// Google-specific sync service (google-calendar-sync.server.ts), which
// needs the raw access token to call events.watch/events.list directly —
// operations that are Google Calendar-specific (not part of the
// provider-agnostic CalendarProvider interface) and therefore deliberately
// bypass getCalendarProviderForConnection's generic wrapper.
export { getValidAccessToken as getValidGoogleAccessToken };
