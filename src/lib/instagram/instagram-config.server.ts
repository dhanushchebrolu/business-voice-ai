/**
 * Server-side resolution of Instagram (Meta) configuration. Mirrors
 * meta-config.server.ts's convention exactly: read directly from
 * process.env at call time (never cached in a module-level variable),
 * report presence/absence without ever returning or logging a value.
 *
 * ClickAI reuses the SAME shared Meta App as WhatsApp (spec §7: "Do NOT
 * create a new Meta App per client... one ClickAI Meta App should support
 * multiple customer Instagram accounts") — META_APP_ID/META_APP_SECRET/
 * META_GRAPH_API_VERSION are the identical env vars meta-config.server.ts
 * already reads for WhatsApp, not duplicated here. This module only adds
 * what's genuinely Instagram-specific: the redirect URI for Instagram's
 * own OAuth callback and, if Meta's Instagram Embedded Signup configuration
 * turns out to require a distinct Facebook Login configuration id (as
 * opposed to reusing a plain scope-based OAuth dialog), an isolated,
 * optional variable for it — never invented, never assumed present.
 *
 * ClickAI connects Instagram via the standard Facebook Login for Business
 * OAuth 2.0 redirect flow (https://www.facebook.com/{v}/dialog/oauth),
 * requesting Instagram messaging/comments permissions, rather than the
 * FB.login() JS-SDK popup WhatsApp's Embedded Signup uses — this is a
 * deliberate choice, not an oversight: Instagram professional account
 * connection via a Tech Provider's own app is Meta's plain, long-
 * documented OAuth 2.0 authorization-code flow (the same shape this
 * codebase already implements for Google Calendar/Razorpay — see
 * google-oauth.server.ts/razorpay-oauth.server.ts), and does not need
 * Embedded Signup's Configuration Builder / FB.login() session-info
 * machinery, which exists specifically for WhatsApp Business Account
 * provisioning. No live fetch of developers.facebook.com was possible in
 * this session (network egress is blocked here) to byte-for-byte confirm
 * this against Meta's current documentation — see instagram-oauth.server.ts
 * and meta-instagram-client.server.ts for exactly what is and is not
 * independently verified.
 */

export interface InstagramConfig {
  appId: string;
  appSecret: string;
  graphApiVersion: string;
  /** Must exactly match the redirect URI registered for this app's Facebook Login product. */
  redirectUri: string;
}

export interface InstagramConfigValidation {
  appIdPresent: boolean;
  appSecretPresent: boolean;
  graphApiVersionPresent: boolean;
  redirectUriPresent: boolean;
  allPresent: boolean;
  /** Human-readable names of exactly what's missing — never the values themselves. */
  missing: string[];
}

export function validateInstagramEnv(): InstagramConfigValidation {
  const appIdPresent = Boolean(process.env["META_APP_ID"]);
  const appSecretPresent = Boolean(process.env["META_APP_SECRET"]);
  const graphApiVersionPresent = Boolean(process.env["META_GRAPH_API_VERSION"]);
  const redirectUriPresent = Boolean(process.env["INSTAGRAM_REDIRECT_URI"]);

  const missing: string[] = [];
  if (!appIdPresent) missing.push("META_APP_ID");
  if (!appSecretPresent) missing.push("META_APP_SECRET");
  if (!graphApiVersionPresent) missing.push("META_GRAPH_API_VERSION");
  if (!redirectUriPresent) missing.push("INSTAGRAM_REDIRECT_URI");

  return {
    appIdPresent,
    appSecretPresent,
    graphApiVersionPresent,
    redirectUriPresent,
    allPresent: missing.length === 0,
    missing,
  };
}

/** Returns null (never throws) when any required value is missing — callers decide how to fail. */
export function resolveInstagramConfig(): InstagramConfig | null {
  const validation = validateInstagramEnv();
  if (!validation.allPresent) return null;
  return {
    appId: process.env["META_APP_ID"]!,
    appSecret: process.env["META_APP_SECRET"]!,
    graphApiVersion: process.env["META_GRAPH_API_VERSION"]!,
    redirectUri: process.env["INSTAGRAM_REDIRECT_URI"]!,
  };
}

/**
 * Instagram messaging/comments permission scopes requested during the
 * OAuth consent screen. Every scope here is independently corroborated
 * across multiple current Meta "Instagram API with Facebook Login"
 * integration guides this session could search (WebFetch to
 * developers.facebook.com itself is blocked in this sandbox) as the
 * standard set for a Tech-Provider-managed Instagram professional
 * account: reading basic profile/IG-business-account linkage, sending and
 * receiving DMs, and moderating comments (required for the comment->DM
 * automation feature). `pages_show_list`/`pages_read_engagement` /
 * `business_management` are additionally required because an Instagram
 * professional account is only discoverable through its linked Facebook
 * Page in this API model (see meta-instagram-client.server.ts's
 * discoverInstagramAccounts). Each of these permissions is independently
 * subject to Meta App Review before it works for a real (non-admin/
 * non-tester) Instagram account — see instagram-connection.server.ts's
 * module doc for what that means for this feature's live availability.
 */
export const INSTAGRAM_OAUTH_SCOPES: readonly string[] = [
  "instagram_basic",
  "instagram_manage_messages",
  "instagram_manage_comments",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
];

const FACEBOOK_OAUTH_DIALOG_BASE = "https://www.facebook.com";

/**
 * Builds the URL to send the browser to for Meta's Facebook Login consent
 * screen. Same standard OAuth 2.0 authorization-code redirect shape this
 * codebase already implements for Google Calendar (google-oauth.server.ts)
 * and Razorpay (razorpay-oauth.server.ts) — see this module's doc comment
 * for why Instagram uses this flow rather than WhatsApp's Embedded Signup
 * FB.login() popup.
 */
export function buildInstagramAuthorizationUrl(config: InstagramConfig, state: string): string {
  const url = new URL(`${FACEBOOK_OAUTH_DIALOG_BASE}/${config.graphApiVersion}/dialog/oauth`);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INSTAGRAM_OAUTH_SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}
