/**
 * Telephony provider abstraction. Each provider must be configured with
 * server-side credentials before numbers can be searched or provisioned.
 * Nothing here fabricates inventory or pricing.
 */

export interface TelephonyProviderDef {
  id: string;
  label: string;
  /** env vars that must exist for this provider to be usable */
  requiredSecrets: string[];
  supportsPurchase: boolean;
}

export const TELEPHONY_PROVIDERS: TelephonyProviderDef[] = [
  { id: "sarvam", label: "Sarvam rented number", requiredSecrets: ["SARVAM_TELEPHONY_ACCOUNT"], supportsPurchase: true },
  { id: "exotel", label: "Exotel", requiredSecrets: ["EXOTEL_SID", "EXOTEL_TOKEN"], supportsPurchase: true },
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
