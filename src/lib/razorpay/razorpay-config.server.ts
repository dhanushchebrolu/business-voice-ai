/**
 * Server-side resolution of Razorpay OAuth-for-Partners configuration.
 * Mirrors meta-config.server.ts's / google-calendar-config.server.ts's
 * convention: read directly from process.env at call time (never cached
 * in a module-level variable), report presence/absence without ever
 * returning or logging a value.
 *
 * The OAuth authorize/token endpoint URLs and scope string are themselves
 * environment variables here, not hardcoded constants — this network
 * sandbox has no egress to razorpay.com (confirmed: a documentation fetch
 * against razorpay.com was blocked by the egress proxy before this module
 * was written), so this session cannot independently verify the current,
 * official values against live Razorpay Partner OAuth documentation.
 * Hardcoding a guessed endpoint could silently send every connection
 * attempt against a wrong or deprecated URL. This follows the exact
 * precedent already established in this codebase for
 * META_GRAPH_API_VERSION (meta-config.server.ts): no hardcoded default
 * where genuinely uncertain — required, explicit configuration instead.
 *
 * Before go-live, set these from the current Razorpay Partner OAuth
 * documentation (Razorpay Dashboard → Partner integration / OAuth apps):
 *   RAZORPAY_OAUTH_AUTHORIZE_URL — the authorization endpoint the browser
 *     is redirected to (e.g. an "https://auth.razorpay.com/authorize"-
 *     shaped URL, unconfirmed in this session).
 *   RAZORPAY_OAUTH_TOKEN_URL — the server-to-server token exchange /
 *     refresh endpoint (e.g. an "https://auth.razorpay.com/token"-shaped
 *     URL, unconfirmed in this session).
 *   RAZORPAY_OAUTH_SCOPE — the exact scope string Razorpay expects (this
 *     session could not confirm Razorpay's scope value(s) against live
 *     documentation either).
 *
 * RAZORPAY_MERCHANT_DETAILS_URL is OPTIONAL and deliberately excluded from
 * "required" validation below: Razorpay's OAuth token-exchange response is
 * widely documented (in training data, not independently reverified here)
 * to already include the connected account's identifier alongside the
 * access/refresh token, so a dedicated merchant-profile fetch may not be
 * necessary for a basic connection health check. If Razorpay does expose a
 * separate merchant-profile endpoint and it's needed later, set this var
 * rather than hardcoding an unverified URL — razorpay-oauth.server.ts's
 * fetchMerchantDetails() simply no-ops (returns null) when it's unset.
 */

export interface RazorpayConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  oauthAuthorizeUrl: string;
  oauthTokenUrl: string;
  oauthScope: string;
  /** Optional — see the module doc comment. */
  merchantDetailsUrl: string | undefined;
}

export interface RazorpayConfigValidation {
  clientIdPresent: boolean;
  clientSecretPresent: boolean;
  redirectUriPresent: boolean;
  oauthAuthorizeUrlPresent: boolean;
  oauthTokenUrlPresent: boolean;
  oauthScopePresent: boolean;
  allPresent: boolean;
  /** Human-readable names of exactly what's missing — never the values themselves. */
  missing: string[];
}

export function validateRazorpayEnv(): RazorpayConfigValidation {
  const clientIdPresent = Boolean(process.env["RAZORPAY_CLIENT_ID"]);
  const clientSecretPresent = Boolean(process.env["RAZORPAY_CLIENT_SECRET"]);
  const redirectUriPresent = Boolean(process.env["RAZORPAY_REDIRECT_URI"]);
  const oauthAuthorizeUrlPresent = Boolean(process.env["RAZORPAY_OAUTH_AUTHORIZE_URL"]);
  const oauthTokenUrlPresent = Boolean(process.env["RAZORPAY_OAUTH_TOKEN_URL"]);
  const oauthScopePresent = Boolean(process.env["RAZORPAY_OAUTH_SCOPE"]);

  const missing: string[] = [];
  if (!clientIdPresent) missing.push("RAZORPAY_CLIENT_ID");
  if (!clientSecretPresent) missing.push("RAZORPAY_CLIENT_SECRET");
  if (!redirectUriPresent) missing.push("RAZORPAY_REDIRECT_URI");
  if (!oauthAuthorizeUrlPresent) missing.push("RAZORPAY_OAUTH_AUTHORIZE_URL");
  if (!oauthTokenUrlPresent) missing.push("RAZORPAY_OAUTH_TOKEN_URL");
  if (!oauthScopePresent) missing.push("RAZORPAY_OAUTH_SCOPE");

  return {
    clientIdPresent,
    clientSecretPresent,
    redirectUriPresent,
    oauthAuthorizeUrlPresent,
    oauthTokenUrlPresent,
    oauthScopePresent,
    allPresent: missing.length === 0,
    missing,
  };
}

/**
 * Returns null (never throws) when any required value is missing —
 * callers decide how to fail. This is the "lazily initialize, don't crash
 * at startup" hook: nothing in this module runs at import time, so an app
 * with no Razorpay configuration at all boots and serves every other
 * feature normally, and the Razorpay integration card simply reports
 * "Not configured" (see razorpay.functions.ts).
 */
export function resolveRazorpayConfig(): RazorpayConfig | null {
  const validation = validateRazorpayEnv();
  if (!validation.allPresent) return null;
  return {
    clientId: process.env["RAZORPAY_CLIENT_ID"]!,
    clientSecret: process.env["RAZORPAY_CLIENT_SECRET"]!,
    redirectUri: process.env["RAZORPAY_REDIRECT_URI"]!,
    oauthAuthorizeUrl: process.env["RAZORPAY_OAUTH_AUTHORIZE_URL"]!,
    oauthTokenUrl: process.env["RAZORPAY_OAUTH_TOKEN_URL"]!,
    oauthScope: process.env["RAZORPAY_OAUTH_SCOPE"]!,
    merchantDetailsUrl: process.env["RAZORPAY_MERCHANT_DETAILS_URL"] || undefined,
  };
}
