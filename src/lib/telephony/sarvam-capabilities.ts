/**
 * Static capability manifest for the Sarvam Voice Agents integration —
 * spec §5/§9/§44's "isolate the capability, report the limitation,
 * automate everything that is officially supported" requirement, made
 * visible rather than left implicit in scattered comments. This is
 * deliberately NOT a re-implementation of TelephonyProviderAdapter: the
 * real boundary is already SarvamTelephonyAdapter (sarvam-provider.server.ts),
 * which already throws/fails closed for every unsupported operation listed
 * here. This manifest exists only so the admin UI and this report can show
 * the same list without re-deriving it from code comments.
 *
 * Nothing here changes behavior — it is pure, static, read-only metadata.
 */

export type CapabilityStatus = "automated" | "manual_provider_step" | "not_available";

export interface CapabilityEntry {
  key: string;
  label: string;
  status: CapabilityStatus;
  /** Why — and, for manual steps, exactly what a Klyro admin must still do in Sarvam's own dashboard. */
  detail: string;
}

export const SARVAM_CAPABILITIES: CapabilityEntry[] = [
  {
    key: "single_outbound_call",
    label: "Place one outbound call",
    status: "automated",
    detail:
      "SarvamTelephonyAdapter.createInstantOutbound (POST .../outbounds) — used by both the single-call outbound flow and the campaign dispatcher, one call per contact.",
  },
  {
    key: "campaign_pacing_retries",
    label: "Campaign pacing, scheduling window, retries",
    status: "automated",
    detail:
      "Entirely Klyro-side (campaign-dispatch.server.ts + campaign-schedule.ts + campaign-outcome.ts) — no Sarvam 'campaign' or 'cohort' creation API has ever been verified, so Klyro owns this instead of guessing one.",
  },
  {
    key: "inbound_deployment",
    label: "Route a phone number to an agent (inbound deployment)",
    status: "automated",
    detail:
      "createSarvamInboundDeployment (POST .../deployments) — implemented, but per the Sarvam API verification audit this exact endpoint/schema has never been confirmed against official documentation or a live response. Used only for inbound; this build is outbound-first and does not add new inbound surface.",
  },
  {
    key: "agent_create_update_publish",
    label: "Create / update / publish an agent's configuration (persona, instructions, voice)",
    status: "not_available",
    detail:
      "NOT DOCUMENTED — DO NOT IMPLEMENT. No verified endpoint, method, or request/response body was found for this despite exhaustive search of official docs, SDKs, and cookbooks. An agent must still be authored once in Sarvam's own dashboard by a Klyro admin; Klyro can inject per-call/per-campaign data into it afterward via agent_variables on createInstantOutbound.",
  },
  {
    key: "phone_number_rental",
    label: "Rent a new phone number from Sarvam",
    status: "manual_provider_step",
    detail:
      "MANUAL SARVAM STEP. 'Rent from Sarvam' is a dashboard-only action (Deploy -> Phone Numbers). An admin rents the number in Sarvam's dashboard once; from then on it is tracked, assigned, and used entirely from Klyro.",
  },
  {
    key: "telephony_connection_creation",
    label: "Register a telephony connection (Sarvam-managed or BYO)",
    status: "manual_provider_step",
    detail:
      "MANUAL SARVAM STEP. 'Add Connection' is a dashboard-only action. An admin does this once per number/provider in Sarvam's dashboard, then records the resulting connection id in Klyro via registerTelephonyConnection.",
  },
  {
    key: "webhook_signature_verification",
    label: "Cryptographically verify a webhook came from Sarvam",
    status: "not_available",
    detail:
      "No official Sarvam signature/HMAC/signing-secret mechanism has been found. Klyro's own SARVAM_WEBHOOK_SECRET/verify_token is Klyro-side defense-in-depth, not proof the request originated from Sarvam's servers.",
  },
];
