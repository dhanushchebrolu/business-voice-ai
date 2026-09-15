/**
 * Readiness state for the Klyro-owned Exotel runtime (Exotel telephony +
 * voice-runtime.server.ts's Sarvam STT/LLM/TTS orchestration) — distinct
 * from provisioning-state.ts's 7-state machine, which is specifically for
 * the Sarvam-*managed* telephony path (Sarvam Voice Agents running the
 * whole call itself). The two paths have genuinely different
 * prerequisites (this one needs no Sarvam app/connection mapping at all —
 * see agent-status.ts), so this is a separate, purpose-built check rather
 * than bent onto the existing one.
 *
 * Pure function, structural input type, zero `@/`-aliased imports — same
 * convention as agent-status.ts/provisioning-state.ts, directly unit
 * testable via `node --test`. Every boolean here must come from something
 * genuinely checked by the caller (an env var read, a real DB row) — never
 * assumed true. `runtimeVerified` is honest about the one thing this
 * module cannot itself check: whether the realtime pipeline (the Durable
 * Object, the live Sarvam WS connections) is actually healthy right now.
 * No live health probe exists yet, so it always reports `runtimeVerified:
 * false` — "not verified," never a fabricated "verified healthy." Wiring a
 * real probe (e.g. a lightweight DO /internal/status ping) is future work,
 * not something this module pretends to already do.
 */

export type KlyroRuntimeState =
  | "missing_exotel_credentials"
  | "missing_sarvam_key"
  | "agent_incomplete"
  | "number_not_assigned"
  | "webhook_not_configured"
  | "runtime_unavailable"
  | "ready_for_test_call";

export interface KlyroRuntimeReadinessInput {
  /** EXOTEL_SID/EXOTEL_API_KEY/EXOTEL_TOKEN/EXOTEL_WEBHOOK_SECRET all present. */
  exotelCredentialsPresent: boolean;
  /** A usable Sarvam API key resolves (see telephony.server.ts's resolveSarvamKeys/sarvam.server.ts's isConfigured) — the STT/LLM/TTS backend, not a telephony credential. */
  sarvamKeyPresent: boolean;
  /** agent_configs.status is "ready" or "live" for this org's agent — see agent-status.ts. */
  agentReady: boolean;
  /** This org has a non-released phone number assigned (to any provider — assignment and provider-correctness are checked separately). */
  numberAssigned: boolean;
  /** The assigned number's provider is "exotel" — only meaningful once numberAssigned is true. */
  numberIsExotel: boolean;
  /** TELEPHONY_WEBHOOK_BASE_URL is set — the minimum Klyro-side prerequisite for Exotel's status callback and media-stream URLs to resolve to anything. This does NOT prove Exotel's own dashboard is pointed at it (no API exists to check that) — only that Klyro's side is ready to receive it. */
  webhookBaseUrlConfigured: boolean;
  /**
   * Whether a live runtime health probe was actually run and what it
   * found. `null` (the default everywhere today) means no probe exists yet
   * — never treated as "healthy," always surfaced as unverified.
   */
  runtimeHealthCheck?: boolean | null;
}

export interface KlyroRuntimeReadiness {
  state: KlyroRuntimeState;
  /** True only once a real health probe has run and passed — see the module doc. Always false today (runtimeHealthCheck is never wired to a real probe yet). */
  runtimeVerified: boolean;
  checklist: {
    exotelCredentialsPresent: boolean;
    sarvamKeyPresent: boolean;
    agentReady: boolean;
    numberAssigned: boolean;
    numberIsExotel: boolean;
    webhookBaseUrlConfigured: boolean;
  };
}

export function computeKlyroRuntimeReadiness(
  input: KlyroRuntimeReadinessInput,
): KlyroRuntimeReadiness {
  const checklist = {
    exotelCredentialsPresent: input.exotelCredentialsPresent,
    sarvamKeyPresent: input.sarvamKeyPresent,
    agentReady: input.agentReady,
    numberAssigned: input.numberAssigned,
    numberIsExotel: input.numberIsExotel,
    webhookBaseUrlConfigured: input.webhookBaseUrlConfigured,
  };
  const runtimeVerified = input.runtimeHealthCheck === true;

  let state: KlyroRuntimeState;
  if (!input.exotelCredentialsPresent) {
    state = "missing_exotel_credentials";
  } else if (!input.sarvamKeyPresent) {
    state = "missing_sarvam_key";
  } else if (!input.agentReady) {
    state = "agent_incomplete";
  } else if (!input.numberAssigned || !input.numberIsExotel) {
    // A number assigned to a different provider is functionally "not
    // assigned" for this runtime — it will never route a call here.
    state = "number_not_assigned";
  } else if (!input.webhookBaseUrlConfigured) {
    state = "webhook_not_configured";
  } else if (input.runtimeHealthCheck === false) {
    state = "runtime_unavailable";
  } else {
    // Every checkable prerequisite passes. runtimeHealthCheck being
    // null/undefined (no probe run) does not block this — it is reported
    // honestly via `runtimeVerified: false` instead of being treated as a
    // blocking failure, since "unverified" and "broken" are not the same
    // claim and only one of them is actually known here.
    state = "ready_for_test_call";
  }

  return { state, runtimeVerified, checklist };
}

export const KLYRO_RUNTIME_STATE_LABEL: Record<KlyroRuntimeState, string> = {
  missing_exotel_credentials: "Missing Exotel credentials",
  missing_sarvam_key: "Missing Sarvam API key",
  agent_incomplete: "Agent incomplete",
  number_not_assigned: "Phone number not assigned",
  webhook_not_configured: "Webhook not configured",
  runtime_unavailable: "Runtime unavailable",
  ready_for_test_call: "Ready for test call",
};
