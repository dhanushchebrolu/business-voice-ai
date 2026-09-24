/**
 * Orchestrates the Razorpay merchant CONNECTION lifecycle: completing
 * OAuth, verifying connection health, disconnecting, and minting a valid
 * access token for an existing connection (decrypt stored credential ->
 * refresh if needed -> return a ready-to-use access token). This is the
 * one place that touches both the encrypted-credential storage and the
 * OAuth/provider mechanics — every other module (razorpay.functions.ts,
 * and eventually any Phase 4 payment-transaction code) goes through this,
 * never decrypts a credential itself. Mirrors
 * google-calendar-connection.server.ts's structure closely.
 *
 * Like whatsapp-onboarding.server.ts, callers own authentication and
 * tenant derivation (organizationId/businessId are trusted parameters
 * here, already validated by the caller against the authenticated
 * session) — this file's own job is orchestration, not auth.
 *
 * Status lifecycle (razorpay_connections.connection_status):
 *   DISCONNECTED -> CONNECTING (not persisted as a distinct step; OAuth
 *     completes atomically, matching google-calendar-connection.server.ts's
 *     own precedent) -> CONNECTED (credentials stored + usable) ->
 *     REAUTH_REQUIRED (refresh failed with invalid_grant / a 401, or no
 *     refresh token is available and the access token has expired) ->
 *     ERROR (any other persistent verification failure, e.g. Razorpay
 *     unavailable). DISCONNECTED again after an explicit disconnect.
 *
 * Scope note: this file implements CONNECTION management only —
 * connect/verify/disconnect/token-refresh. It deliberately has no
 * createPaymentRequest/createPaymentLink/refund/etc. — those belong to
 * Phase 4's payment-transaction system and are out of scope here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { encryptCredential, decryptCredential } from "./razorpay-crypto.server.ts";
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  fetchMerchantDetails,
  RazorpayOAuthError,
  type RazorpayMerchantDetails,
} from "./razorpay-oauth.server.ts";
import { resolveRazorpayConfig } from "./razorpay-config.server.ts";

type Client = SupabaseClient<Database>;

export class RazorpayConnectionError extends Error {
  code: "NOT_CONFIGURED" | "NOT_FOUND" | "REAUTH_REQUIRED" | "OAUTH_FAILED" | "ERROR" | "UNKNOWN";
  constructor(message: string, code: RazorpayConnectionError["code"]) {
    super(message);
    this.code = code;
  }
}

/**
 * Credentials as actually returned by Razorpay's token endpoint, whose
 * exact shape this session could not independently verify. refreshToken
 * is optional (spec: "if the flow provides refresh tokens") — when
 * absent, getValidAccessToken() below falls back to reusing the stored
 * access token until it expires, then requires reconnect (there is
 * nothing to refresh from).
 */
interface StoredCredentials {
  accessToken: string;
  refreshToken?: string | undefined;
}

const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

/**
 * Completes a Razorpay OAuth flow: exchange the authorization code,
 * optionally fetch merchant details (if RAZORPAY_MERCHANT_DETAILS_URL is
 * configured), encrypt and upsert the connection row as CONNECTED. Used
 * for BOTH an initial connect and a reconnect — the unique
 * (organization_id, business_id, provider) constraint means a reconnect
 * upserts onto the same row rather than creating a duplicate, which also
 * makes a retried/duplicate callback safe (spec: idempotent OAuth
 * callback processing).
 */
export async function completeRazorpayOAuth(
  supabaseAdmin: Client,
  input: { organizationId: string; businessId: string; code: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ connectionId: string }> {
  const config = resolveRazorpayConfig();
  if (!config) {
    throw new RazorpayConnectionError(
      "Razorpay is not configured on this deployment.",
      "NOT_CONFIGURED",
    );
  }

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode(config, input.code, fetchImpl);
  } catch (err) {
    throw new RazorpayConnectionError(
      err instanceof RazorpayOAuthError
        ? err.message
        : "Failed to complete Razorpay authorization.",
      "OAUTH_FAILED",
    );
  }

  let merchant: RazorpayMerchantDetails | null = null;
  try {
    merchant = await fetchMerchantDetails(config, tokens.accessToken, fetchImpl);
  } catch {
    // Non-fatal: the connection is still real and usable even if the
    // optional merchant-details lookup fails or is unconfigured. Display
    // fields simply stay unset until the next successful verification.
    merchant = null;
  }

  const encrypted = encryptCredential(
    JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    } satisfies StoredCredentials),
  );
  const tokenExpiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();
  const now = new Date().toISOString();
  const accountId = merchant?.accountId ?? tokens.accountId ?? null;

  const { data, error } = await supabaseAdmin
    .from("razorpay_connections")
    .upsert(
      {
        organization_id: input.organizationId,
        business_id: input.businessId,
        provider: "razorpay",
        connection_status: "CONNECTED",
        merchant_status: merchant?.status ?? null,
        razorpay_account_id: accountId,
        business_name: merchant?.businessName ?? null,
        display_name: merchant?.displayName ?? null,
        email: merchant?.email ?? null,
        phone: merchant?.phone ?? null,
        encrypted_credentials: encrypted,
        token_expires_at: tokenExpiresAt,
        connected_at: now,
        last_verified_at: now,
        disconnected_at: null,
        last_error: null,
      },
      { onConflict: "organization_id,business_id,provider" },
    )
    .select("id")
    .single();
  if (error || !data) {
    throw new RazorpayConnectionError(
      `Failed to store the Razorpay connection: ${error?.message ?? "unknown error"}`,
      "UNKNOWN",
    );
  }
  return { connectionId: data.id };
}

/**
 * Disconnects ClickAI's access. Razorpay's exact token-revocation endpoint
 * (if one exists for this OAuth flow) could not be confirmed in this
 * session — see razorpay-config.server.ts's module doc comment — so this
 * does not attempt to call one; it removes the locally-held credentials
 * and marks the connection DISCONNECTED, which is sufficient to stop
 * ClickAI from using them regardless of server-side revocation support.
 * Non-sensitive historical metadata (business_name/display_name/
 * razorpay_account_id/connected_at) is preserved rather than cleared, per
 * spec section 34 ("preserve non-sensitive historical metadata").
 */
export async function disconnectRazorpayConnection(
  supabaseAdmin: Client,
  input: { organizationId: string; connectionId: string },
): Promise<void> {
  const { data: existing, error: readError } = await supabaseAdmin
    .from("razorpay_connections")
    .select("id, organization_id")
    .eq("id", input.connectionId)
    .maybeSingle();
  if (readError) throw readError;
  if (!existing || existing.organization_id !== input.organizationId) {
    throw new RazorpayConnectionError(
      "That connection does not belong to your workspace.",
      "NOT_FOUND",
    );
  }

  const { error } = await supabaseAdmin
    .from("razorpay_connections")
    .update({
      connection_status: "DISCONNECTED",
      encrypted_credentials: null,
      token_expires_at: null,
      disconnected_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", input.connectionId);
  if (error) throw error;
}

/**
 * Mints a currently-valid access token for a connection: reads the row,
 * decrypts stored credentials. If the cached access token is still valid
 * (with a safety margin), reuses it without a network call. Otherwise, if
 * a refresh token is available, refreshes it. On invalid_grant/401 (or no
 * refresh token and an expired access token), marks the connection
 * REAUTH_REQUIRED and throws — callers must never silently proceed as if
 * the connection were healthy.
 */
async function getValidAccessToken(
  supabaseAdmin: Client,
  connectionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const { data: connection, error } = await supabaseAdmin
    .from("razorpay_connections")
    .select("id, connection_status, encrypted_credentials, token_expires_at")
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw error;
  if (!connection) {
    throw new RazorpayConnectionError("Razorpay connection not found.", "NOT_FOUND");
  }
  if (connection.connection_status === "DISCONNECTED") {
    throw new RazorpayConnectionError(
      "This business's Razorpay account needs to be connected.",
      "REAUTH_REQUIRED",
    );
  }
  if (connection.connection_status === "REAUTH_REQUIRED") {
    throw new RazorpayConnectionError(
      "This business's Razorpay connection needs to be re-authorized.",
      "REAUTH_REQUIRED",
    );
  }
  if (!connection.encrypted_credentials) {
    throw new RazorpayConnectionError("No Razorpay credentials are stored.", "REAUTH_REQUIRED");
  }

  const stored = JSON.parse(
    decryptCredential(connection.encrypted_credentials),
  ) as StoredCredentials;

  const expiresAt = connection.token_expires_at
    ? new Date(connection.token_expires_at).getTime()
    : 0;
  const stillValid = expiresAt - TOKEN_EXPIRY_SAFETY_MARGIN_MS > Date.now();
  if (stillValid) {
    return stored.accessToken;
  }

  if (!stored.refreshToken) {
    await supabaseAdmin
      .from("razorpay_connections")
      .update({
        connection_status: "REAUTH_REQUIRED",
        last_error: "Access token expired and no refresh token is available.",
      })
      .eq("id", connectionId);
    throw new RazorpayConnectionError(
      "This Razorpay connection has expired. Please reconnect.",
      "REAUTH_REQUIRED",
    );
  }

  const config = resolveRazorpayConfig();
  if (!config) {
    throw new RazorpayConnectionError(
      "Razorpay is not configured on this deployment.",
      "NOT_CONFIGURED",
    );
  }

  let tokens;
  try {
    tokens = await refreshAccessToken(config, stored.refreshToken, fetchImpl);
  } catch (err) {
    if (err instanceof RazorpayOAuthError && err.status === 401) {
      await supabaseAdmin
        .from("razorpay_connections")
        .update({ connection_status: "REAUTH_REQUIRED", last_error: err.message })
        .eq("id", connectionId);
      throw new RazorpayConnectionError(
        "Razorpay access has expired or been revoked. Please reconnect.",
        "REAUTH_REQUIRED",
      );
    }
    await supabaseAdmin
      .from("razorpay_connections")
      .update({
        last_error:
          err instanceof Error ? err.message : "Unknown error refreshing Razorpay access.",
      })
      .eq("id", connectionId);
    throw new RazorpayConnectionError(
      "Unable to verify your Razorpay connection. Please try again.",
      "ERROR",
    );
  }

  const nextCredentials = encryptCredential(
    JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? stored.refreshToken,
    } satisfies StoredCredentials),
  );

  await supabaseAdmin
    .from("razorpay_connections")
    .update({
      encrypted_credentials: nextCredentials,
      token_expires_at: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
      last_error: null,
    })
    .eq("id", connectionId);

  return tokens.accessToken;
}

/** Exposed for razorpay.functions.ts's getRazorpayValidAccessToken server function. Never expose the returned token to the browser. */
export { getValidAccessToken as getValidRazorpayAccessToken };

export type RazorpayConnectionHealthStatus =
  "CONNECTED" | "REAUTH_REQUIRED" | "ERROR" | "DISCONNECTED";

/**
 * ACTUALLY verifies a connection is usable — not just that a row exists.
 * Attempts to obtain a valid access token (refreshing if necessary) and,
 * when a merchant-details endpoint is configured, re-fetches merchant
 * info too. Persists the resulting connection_status so the UI reflects
 * reality on next read.
 */
export async function verifyRazorpayConnection(
  supabaseAdmin: Client,
  input: { organizationId: string; connectionId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: RazorpayConnectionHealthStatus }> {
  const { data: existing, error: readError } = await supabaseAdmin
    .from("razorpay_connections")
    .select("id, organization_id, connection_status")
    .eq("id", input.connectionId)
    .maybeSingle();
  if (readError) throw readError;
  if (!existing || existing.organization_id !== input.organizationId) {
    throw new RazorpayConnectionError(
      "That connection does not belong to your workspace.",
      "NOT_FOUND",
    );
  }
  if (existing.connection_status === "DISCONNECTED") {
    return { status: "DISCONNECTED" };
  }

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(supabaseAdmin, input.connectionId, fetchImpl);
  } catch (err) {
    if (err instanceof RazorpayConnectionError && err.code === "REAUTH_REQUIRED") {
      return { status: "REAUTH_REQUIRED" };
    }
    await supabaseAdmin
      .from("razorpay_connections")
      .update({
        connection_status: "ERROR",
        last_error: err instanceof Error ? err.message : "Unknown verification error.",
      })
      .eq("id", input.connectionId);
    return { status: "ERROR" };
  }

  const config = resolveRazorpayConfig();
  let merchant: RazorpayMerchantDetails | null = null;
  if (config) {
    try {
      merchant = await fetchMerchantDetails(config, accessToken, fetchImpl);
    } catch (err) {
      if (err instanceof RazorpayOAuthError && err.status === 401) {
        await supabaseAdmin
          .from("razorpay_connections")
          .update({ connection_status: "REAUTH_REQUIRED", last_error: err.message })
          .eq("id", input.connectionId);
        return { status: "REAUTH_REQUIRED" };
      }
      // A merchant-details lookup failure that isn't a 401 doesn't
      // invalidate an otherwise-successful token refresh above — the
      // connection is still CONNECTED, just without freshened display
      // fields this round.
      merchant = null;
    }
  }

  await supabaseAdmin
    .from("razorpay_connections")
    .update({
      connection_status: "CONNECTED",
      last_verified_at: new Date().toISOString(),
      last_error: null,
      ...(merchant
        ? {
            merchant_status: merchant.status ?? null,
            business_name: merchant.businessName ?? null,
            display_name: merchant.displayName ?? null,
            email: merchant.email ?? null,
            phone: merchant.phone ?? null,
          }
        : {}),
    })
    .eq("id", input.connectionId);

  return { status: "CONNECTED" };
}
