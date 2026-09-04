/**
 * Telephony provider abstraction. Each provider must be configured with
 * server-side credentials before numbers can be searched or provisioned.
 * Nothing here fabricates inventory or pricing.
 *
 * `getTelephonyAdapter()` below is the ONE place the rest of the codebase
 * asks for a live `TelephonyProviderAdapter` (see ./telephony/adapter.ts).
 * Nothing else may import a provider SDK or call a provider's API directly.
 */

import { GenericTelephonyAdapter } from "./telephony/generic-provider";
import { MockTelephonyAdapter } from "./telephony/mock-provider";
import { ExotelTelephonyAdapter } from "./telephony/exotel-provider";
import type { TelephonyProviderAdapter } from "./telephony/adapter";

export interface TelephonyProviderDef {
  id: string;
  label: string;
  /** env vars that must exist for this provider to be usable */
  requiredSecrets: string[];
  supportsPurchase: boolean;
}

export const TELEPHONY_PROVIDERS: TelephonyProviderDef[] = [
  { id: "sarvam", label: "Sarvam rented number", requiredSecrets: ["SARVAM_TELEPHONY_ACCOUNT"], supportsPurchase: true },
  // Phase D.1: corrected from supportsPurchase:true — Exotel has no
  // confirmed public self-service number-purchase API; numbers are
  // acquired through the account/sales process, then attached (see
  // exotel-provider.ts's provisionNumber). requiredSecrets corrected from
  // 2 to 3 values — Exotel's REST auth is Account SID + API Key + API
  // Token, not SID + a single token (see PHASE_D1_EXOTEL_FINAL_REPORT.md §5).
  {
    id: "exotel",
    label: "Exotel",
    requiredSecrets: ["EXOTEL_SID", "EXOTEL_API_KEY", "EXOTEL_TOKEN"],
    supportsPurchase: false,
  },
  { id: "twilio", label: "Twilio", requiredSecrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"], supportsPurchase: true },
  { id: "smartflo", label: "Tata Smartflo", requiredSecrets: ["SMARTFLO_TOKEN"], supportsPurchase: false },
  { id: "vobiz", label: "Vobiz", requiredSecrets: ["VOBIZ_API_KEY"], supportsPurchase: false },
  { id: "pulse", label: "Pulse", requiredSecrets: ["PULSE_API_KEY"], supportsPurchase: false },
  { id: "intalk", label: "Intalk", requiredSecrets: ["INTALK_API_KEY"], supportsPurchase: false },
];

export function providerStatus() {
  return TELEPHONY_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    supportsPurchase: p.supportsPurchase,
    configured: p.requiredSecrets.every((s) => Boolean(process.env[s])),
    missing: p.requiredSecrets.filter((s) => !process.env[s]),
  }));
}

export function anyProviderConfigured(): boolean {
  return providerStatus().some((p) => p.configured);
}

/** Base REST URL for a generically-adapted provider's API. */
function providerBaseUrl(providerId: string): string | undefined {
  return process.env[`${providerId.toUpperCase()}_BASE_URL`];
}

/**
 * Resolves a live adapter for a provider ID, or null if that provider is
 * not configured. The mock adapter is only ever reachable when an operator
 * has explicitly set TELEPHONY_ALLOW_MOCK=true (never on by default, never
 * silently substituted for a misconfigured real provider) — see
 * ./telephony/mock-provider.ts.
 */
export function getTelephonyAdapter(providerId: string): TelephonyProviderAdapter | null {
  if (providerId === "mock") {
    return process.env["TELEPHONY_ALLOW_MOCK"] === "true" ? new MockTelephonyAdapter() : null;
  }

  const def = TELEPHONY_PROVIDERS.find((p) => p.id === providerId);
  if (!def) return null;
  const status = providerStatus().find((p) => p.id === providerId);
  if (!status?.configured) return null;

  // Exotel's real credential/auth shape (SID + API key + API token, and a
  // "verify token" comparison instead of HMAC — see exotel-provider.ts)
  // doesn't fit GenericTelephonyAdapter's single-apiKey/HMAC assumption,
  // so it gets its own dedicated construction branch rather than being
  // forced through the generic path.
  if (providerId === "exotel") {
    const accountSid = process.env["EXOTEL_SID"];
    const apiKey = process.env["EXOTEL_API_KEY"];
    const apiToken = process.env["EXOTEL_TOKEN"];
    const webhookVerifyToken = process.env["EXOTEL_WEBHOOK_SECRET"];
    const subdomain = process.env["EXOTEL_SUBDOMAIN"] ?? "api.exotel.com";
    if (!accountSid || !apiKey || !apiToken || !webhookVerifyToken) return null;
    return new ExotelTelephonyAdapter({
      accountSid,
      apiKey,
      apiToken,
      subdomain,
      webhookVerifyToken,
    });
  }

  const baseUrl = providerBaseUrl(providerId);
  const apiKey = process.env[def.requiredSecrets[0]!];
  const webhookSecret = process.env[`${providerId.toUpperCase()}_WEBHOOK_SECRET`];
  if (!baseUrl || !apiKey || !webhookSecret) return null;

  return new GenericTelephonyAdapter({
    id: providerId,
    supportsPurchase: def.supportsPurchase,
    baseUrl,
    apiKey,
    webhookSecret,
  });
}
