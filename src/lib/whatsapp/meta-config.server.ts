/**
 * Server-side resolution of Meta WhatsApp Business Platform configuration.
 * Mirrors telephony.server.ts's resolveSarvamKeys()/validateSarvamEnv()
 * convention: read directly from process.env at call time (never cached
 * in a module-level variable), report presence/absence without ever
 * returning or logging a value.
 *
 * ClickAI operates as a Meta TECH PROVIDER (confirmed against current
 * Meta documentation before Phase 2 began) — each onboarded customer owns
 * their own WhatsApp Business Account and pays Meta directly for
 * conversations. Nothing here implements or assumes a Solution Partner
 * credit line.
 */

export interface MetaWhatsAppConfig {
  appId: string;
  appSecret: string;
  /** Facebook Login for Business configuration id (Embedded Signup v4 Builder) — safe to expose to the browser, unlike the fields above. */
  configId: string;
  /** Graph API version, e.g. "v23.0". Deliberately has NO hardcoded default: this session could not independently verify the current Meta Graph API version (network egress to developers.facebook.com is blocked in this environment) — silently guessing a version number here could send every request against a deprecated or wrong endpoint. Set explicitly from the Meta App Dashboard's currently-selected API version. */
  graphApiVersion: string;
}

export interface MetaConfigValidation {
  appIdPresent: boolean;
  appSecretPresent: boolean;
  configIdPresent: boolean;
  graphApiVersionPresent: boolean;
  allPresent: boolean;
  /** Human-readable names of exactly what's missing — never the values themselves. */
  missing: string[];
}

export function validateMetaWhatsAppEnv(): MetaConfigValidation {
  const appIdPresent = Boolean(process.env["META_APP_ID"]);
  const appSecretPresent = Boolean(process.env["META_APP_SECRET"]);
  const configIdPresent = Boolean(process.env["META_WHATSAPP_CONFIG_ID"]);
  const graphApiVersionPresent = Boolean(process.env["META_GRAPH_API_VERSION"]);

  const missing: string[] = [];
  if (!appIdPresent) missing.push("META_APP_ID");
  if (!appSecretPresent) missing.push("META_APP_SECRET");
  if (!configIdPresent) missing.push("META_WHATSAPP_CONFIG_ID");
  if (!graphApiVersionPresent) missing.push("META_GRAPH_API_VERSION");

  return {
    appIdPresent,
    appSecretPresent,
    configIdPresent,
    graphApiVersionPresent,
    allPresent: missing.length === 0,
    missing,
  };
}

/** Returns null (never throws) when any required value is missing — callers decide how to fail. */
export function resolveMetaWhatsAppConfig(): MetaWhatsAppConfig | null {
  const validation = validateMetaWhatsAppEnv();
  if (!validation.allPresent) return null;
  return {
    appId: process.env["META_APP_ID"]!,
    appSecret: process.env["META_APP_SECRET"]!,
    configId: process.env["META_WHATSAPP_CONFIG_ID"]!,
    graphApiVersion: process.env["META_GRAPH_API_VERSION"]!,
  };
}
