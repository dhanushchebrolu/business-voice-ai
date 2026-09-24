/**
 * Razorpay OAuth-for-Partners mechanics: the authorization URL, the
 * authorization-code exchange, refresh-token renewal, and (optionally)
 * reading back merchant/account details. Deliberately separate from any
 * future payments-data API client — this file knows nothing about
 * payments/orders/refunds, only about obtaining and renewing an access
 * token for a connected merchant account.
 *
 * Every endpoint this module calls is read from RazorpayConfig (i.e. from
 * environment configuration), never hardcoded — see
 * razorpay-config.server.ts's module doc comment for why: this session
 * has no network egress to razorpay.com and cannot independently confirm
 * Razorpay's current OAuth endpoint URLs or response shape against live
 * documentation. The token-exchange/refresh response parsing below only
 * assumes an OAuth2-standard shape (access_token/refresh_token/expires_in)
 * plus an optional, defensively-read account identifier field —
 * nothing Razorpay-specific is assumed beyond that.
 *
 * `fetchImpl` is always injectable (defaults to global fetch), matching
 * google-oauth.server.ts's / meta-client.server.ts's convention — tests
 * never hit a real network.
 */

import type { RazorpayConfig } from "./razorpay-config.server.ts";

export class RazorpayOAuthError extends Error {
  status: number;
  /** Whether a caller may safely retry this exact request unmodified. */
  retryable: boolean;
  constructor(message: string, status = 502, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

export interface RazorpayTokenSet {
  accessToken: string;
  /** Only present on the FIRST authorization-code exchange, or when Razorpay chooses to rotate it — a refresh call does not necessarily return a new one. */
  refreshToken?: string | undefined;
  expiresInSeconds: number;
  /**
   * The connected merchant/account identifier, if the token response
   * included one (read defensively from a handful of plausible field
   * names — see readAccountId below — since this session could not
   * confirm Razorpay's exact response shape). Undefined if none was
   * present; callers should fall back to fetchMerchantDetails() or leave
   * the field unset rather than inventing a value.
   */
  accountId?: string | undefined;
}

export interface RazorpayMerchantDetails {
  accountId: string;
  businessName: string | undefined;
  displayName: string | undefined;
  email: string | undefined;
  phone: string | undefined;
  /** Whatever activation/KYC status string the provider reports, if any. Opaque — not interpreted by ClickAI. */
  status: string | undefined;
}

/** Builds the URL to send the browser to for Razorpay's OAuth consent screen. */
export function buildAuthorizationUrl(config: RazorpayConfig, state: string): string {
  const url = new URL(config.oauthAuthorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.oauthScope);
  url.searchParams.set("state", state);
  return url.toString();
}

interface OAuthErrorBody {
  error?: string;
  error_description?: string;
}

function mapTokenErrorResponse(
  status: number,
  parsed: OAuthErrorBody | undefined,
): RazorpayOAuthError {
  const code = parsed?.error;
  const description = parsed?.error_description;
  if (code === "invalid_grant") {
    return new RazorpayOAuthError(
      "This Razorpay authorization is no longer valid — it may have expired, already been used, or been revoked.",
      401,
      false,
    );
  }
  if (status === 401 || status === 403) {
    return new RazorpayOAuthError("Razorpay rejected this request as unauthorized.", status, false);
  }
  if (status === 429) {
    return new RazorpayOAuthError(
      "Razorpay rate-limited this request. Please retry shortly.",
      429,
      true,
    );
  }
  if (status >= 500) {
    return new RazorpayOAuthError("Razorpay is temporarily unavailable. Please retry.", 503, true);
  }
  return new RazorpayOAuthError(
    `Razorpay rejected the request${description ? `: ${description}` : ""}.`,
    status,
    false,
  );
}

/**
 * Reads a connected-account identifier out of a token response body,
 * trying a small set of plausible field names defensively rather than
 * assuming one specific Razorpay field name this session could not
 * confirm. Returns undefined (never throws, never invents a value) if
 * none of them are present.
 */
function readAccountId(body: Record<string, unknown>): string | undefined {
  for (const key of ["razorpay_account_id", "account_id", "merchant_id"]) {
    const value = body[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

async function postToTokenEndpoint(
  config: RazorpayConfig,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  accountId?: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(config.oauthTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new RazorpayOAuthError("Razorpay did not respond in time. Please retry.", 503, true);
    }
    throw new RazorpayOAuthError("Could not reach Razorpay. Please retry.", 503, true);
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
    throw mapTokenErrorResponse(res.status, parsed as OAuthErrorBody | undefined);
  }
  const responseBody = (parsed as Record<string, unknown>) ?? {};
  const accessToken = responseBody["access_token"];
  const expiresIn = responseBody["expires_in"];
  if (typeof accessToken !== "string" || typeof expiresIn !== "number") {
    throw new RazorpayOAuthError("Razorpay returned an unexpected token response.", 502, false);
  }
  const refreshToken = responseBody["refresh_token"];
  const accountId = readAccountId(responseBody);
  return {
    access_token: accessToken,
    ...(typeof refreshToken === "string" ? { refresh_token: refreshToken } : {}),
    expires_in: expiresIn,
    ...(accountId !== undefined ? { accountId } : {}),
  };
}

/** Exchanges a one-time authorization code for an access token + (usually) a refresh token. */
export async function exchangeAuthorizationCode(
  config: RazorpayConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RazorpayTokenSet> {
  const result = await postToTokenEndpoint(
    config,
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
    accountId: result.accountId,
  };
}

/** Mints a fresh access token from a previously-stored refresh token. Never persist the returned access token — mint on demand each time it's needed. */
export async function refreshAccessToken(
  config: RazorpayConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RazorpayTokenSet> {
  const result = await postToTokenEndpoint(
    config,
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
    accountId: result.accountId,
  };
}

/**
 * Fetches merchant/account details for the connected account, if a
 * dedicated endpoint has been configured (RAZORPAY_MERCHANT_DETAILS_URL —
 * optional, see razorpay-config.server.ts). Returns null without making
 * any network call when unconfigured, rather than guessing an endpoint
 * URL — callers fall back to whatever fields the token-exchange response
 * already provided.
 */
export async function fetchMerchantDetails(
  config: RazorpayConfig,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RazorpayMerchantDetails | null> {
  if (!config.merchantDetailsUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(config.merchantDetailsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } catch {
    throw new RazorpayOAuthError(
      "Could not reach Razorpay to read merchant account info. Please retry.",
      503,
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new RazorpayOAuthError(
      "Razorpay rejected this request as unauthorized.",
      res.status,
      false,
    );
  }
  if (!res.ok) {
    throw new RazorpayOAuthError(
      "Could not read the connected Razorpay account's info.",
      res.status,
      res.status === 429 || res.status >= 500,
    );
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const accountId = readAccountId(data);
  if (!accountId) {
    throw new RazorpayOAuthError(
      "Razorpay's account info response was missing an account id.",
      502,
      false,
    );
  }
  const readString = (key: string): string | undefined => {
    const value = data[key];
    return typeof value === "string" ? value : undefined;
  };
  return {
    accountId,
    businessName: readString("business_name"),
    displayName: readString("display_name") ?? readString("name"),
    email: readString("email"),
    phone: readString("phone") ?? readString("contact"),
    status: readString("status") ?? readString("activation_status"),
  };
}
