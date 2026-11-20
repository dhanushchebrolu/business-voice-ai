import type { AgentSnapshot } from "./agent-instructions.ts";
import { normalizeCustomerPhone } from "./phone-number.ts";
import { sarvamAgentConfigPatch, validateVoiceLanguageSettings } from "./sarvam-voice-catalog.ts";
import { OUTBOUND_AGENT_TOOLS, OUTBOUND_FORBIDDEN_TOOLS } from "./agent-roles.ts";

/**
 * The customer-specific configuration of ClickAI's ONE universal Sarvam
 * master agent (decided 2026-11-14: no Booking/Enquiry or industry
 * templates). Every customer gets their own copy of the master agent; what
 * differs between customers is only:
 *   - which capabilities are switched on (from agent_configs.capabilities,
 *     agent_configs.transfer_number and the business type), and
 *   - their business data, which the agent reads live at call time through
 *     the on-start context hook (clickai_business_context), never baked in.
 *
 * Pure and deterministic: the same snapshot always yields the same config
 * and the same fingerprint, so a provisioning run can tell whether the
 * customer's Sarvam agent is out of date.
 */

/** Bump when the master agent's tool set or prompt contract changes. */
export const UNIVERSAL_AGENT_TEMPLATE_VERSION = 1;

export type UniversalCapabilityId =
  | "answer_questions"
  | "appointment_booking"
  | "restaurant_reservations"
  | "lead_capture"
  | "take_messages"
  | "call_transfer";

/** Tools on the universal master agent (Sarvam tool names). */
export const MASTER_AGENT_TOOLS = [
  "clickai_business_context",
  "get_business_info",
  "check_availability",
  "book_appointment",
  "request_callback",
  "record_call_outcome",
  "call_transfer",
] as const;
export type MasterAgentTool = (typeof MASTER_AGENT_TOOLS)[number];

/** Always on: the business data hook, the outcome log and plain Q&A reads. */
const ALWAYS_ON: MasterAgentTool[] = [
  "clickai_business_context",
  "get_business_info",
  "record_call_outcome",
];

interface CapabilityDef {
  id: UniversalCapabilityId;
  label: string;
  /** agent_configs.capabilities keys that switch it on (any one). */
  keys: string[];
  tools: MasterAgentTool[];
  appliesTo?: (businessType: string) => boolean;
}

const isRestaurant = (t: string) => t === "restaurant";

export const UNIVERSAL_CAPABILITIES: readonly CapabilityDef[] = [
  {
    id: "answer_questions",
    label: "Answer business questions",
    keys: ["answer_faqs", "explain_services", "quote_prices", "check_hours"],
    tools: [],
  },
  {
    id: "appointment_booking",
    label: "Appointment booking",
    keys: ["calendar_book", "book_appointment"],
    tools: ["check_availability", "book_appointment"],
    appliesTo: (t) => !isRestaurant(t),
  },
  {
    id: "restaurant_reservations",
    label: "Restaurant reservations",
    keys: ["calendar_book", "book_appointment", "make_reservation"],
    tools: ["check_availability", "book_appointment"],
    appliesTo: isRestaurant,
  },
  {
    id: "lead_capture",
    label: "Lead capture",
    keys: ["capture_lead", "collect_details"],
    tools: ["request_callback"],
  },
  {
    id: "take_messages",
    label: "Take messages",
    keys: ["take_callback", "take_message"],
    tools: ["request_callback"],
  },
  {
    id: "call_transfer",
    label: "Human call transfer",
    keys: ["transfer_to_human", "call_transfer"],
    tools: ["call_transfer"],
  },
];

export interface CapabilityStatus {
  id: UniversalCapabilityId;
  label: string;
  enabled: boolean;
  /** Enabled but missing data it needs; the customer cannot be activated until fixed. */
  missing: string[];
}

export interface UniversalAgentConfig {
  templateVersion: number;
  businessType: string;
  capabilities: CapabilityStatus[];
  /** Master-agent tools to switch on / off for this customer's own agent. */
  tools: { enable: MasterAgentTool[]; disable: MasterAgentTool[] };
  /** Destination for Sarvam's call_transfer, E.164; null when transfer is off. */
  callTransferNumber: string | null;
  /** Problems that block activation (missing data for an enabled capability, or no business data at all). */
  blockers: string[];
  /** The customer's validated voice and languages, with the exact Sarvam settings; null when not set or invalid. */
  voiceLanguage: VoiceLanguageConfig | null;
  /** Why voiceLanguage is null (not set / invalid); null when it is fine or was not checked. */
  voiceLanguageProblem: string | null;
  /** Stable fingerprint of everything above (voice and languages included). */
  fingerprint: string;
}

function anyKey(capabilities: Record<string, boolean>, keys: string[]) {
  return keys.some((k) => capabilities[k] === true);
}

function bookableHours(s: AgentSnapshot) {
  return s.hours.some((h) => !h.is_closed && h.intervals.length > 0);
}

/** Requirements for a capability that is switched on. */
function missingFor(
  id: UniversalCapabilityId,
  s: AgentSnapshot,
  transfer: string | null,
): string[] {
  const missing: string[] = [];
  const activeServices = s.services.filter((x) => x.is_active);
  switch (id) {
    case "answer_questions":
      if (!s.business.description?.trim() && activeServices.length === 0 && s.faqs.length === 0)
        missing.push("a business description, services or FAQs to answer from");
      break;
    case "appointment_booking":
      if (activeServices.length === 0) missing.push("at least one active service to book");
      if (!bookableHours(s)) missing.push("opening hours on at least one day");
      break;
    case "restaurant_reservations":
      if (activeServices.length === 0)
        missing.push("at least one active reservation type (for example Table booking)");
      if (!bookableHours(s)) missing.push("opening hours on at least one day");
      break;
    case "call_transfer":
      if (!transfer) missing.push("a valid transfer phone number");
      break;
    default:
      break;
  }
  return missing;
}

/** FNV-1a over a canonical JSON string — deterministic, no crypto needed. */
function fingerprintOf(value: unknown, prefix = `u${UNIVERSAL_AGENT_TEMPLATE_VERSION}`): string {
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${prefix}-${h.toString(16).padStart(8, "0")}`;
}

/** A saved agent_voice_language_settings row, as the generator needs it. */
export interface SavedVoiceLanguage {
  default_language: string;
  allowed_languages: string[];
  auto_language_switch: boolean;
  sarvam_voice_internal_id: string;
}

export interface VoiceLanguageConfig {
  defaultLanguage: string;
  allowedLanguages: string[];
  autoLanguageSwitch: boolean;
  voice: { internalId: string; name: string };
  warnings: string[];
  /** The exact Sarvam agent config to apply (language_config, llm supported languages, TTS voice). */
  sarvamConfig: ReturnType<typeof sarvamAgentConfigPatch>;
}

/** Validates saved voice/language settings; null config plus a reason when missing or invalid. */
export function voiceLanguageConfig(saved: SavedVoiceLanguage | null): {
  config: VoiceLanguageConfig | null;
  problem: string | null;
} {
  if (!saved)
    return { config: null, problem: "Voice and languages are not set for this customer yet." };
  try {
    const v = validateVoiceLanguageSettings({
      defaultLanguage: saved.default_language,
      allowedLanguages: saved.allowed_languages,
      autoLanguageSwitch: saved.auto_language_switch,
      voiceInternalId: saved.sarvam_voice_internal_id,
    });
    return {
      config: {
        defaultLanguage: v.defaultLanguage,
        allowedLanguages: v.allowedLanguages,
        autoLanguageSwitch: v.autoLanguageSwitch,
        voice: { internalId: v.voice.internalId, name: v.voice.name },
        warnings: v.warnings,
        sarvamConfig: sarvamAgentConfigPatch(v),
      },
      problem: null,
    };
  } catch (err) {
    return {
      config: null,
      problem: `Saved voice/language settings are invalid: ${(err as Error).message}`,
    };
  }
}

/**
 * `voiceLanguage`: the customer's saved agent_voice_language_settings row
 * (null when none is saved). Omit it only where voice/language does not
 * matter; the provisioning pipeline and admin screens always pass it.
 */
export function buildUniversalAgentConfig(
  s: AgentSnapshot,
  voiceLanguage?: SavedVoiceLanguage | null,
): UniversalAgentConfig {
  const businessType = s.business.business_type;
  const caps = s.agent.capabilities ?? {};
  const transfer = s.agent.transfer_number
    ? normalizeCustomerPhone(s.agent.transfer_number, s.business.country ?? "IN")
    : null;

  const capabilities: CapabilityStatus[] = UNIVERSAL_CAPABILITIES.map((def) => {
    const applies = def.appliesTo ? def.appliesTo(businessType) : true;
    // Answering questions is the floor of every receptionist; it can't be switched off.
    const enabled = applies && (def.id === "answer_questions" || anyKey(caps, def.keys));
    return {
      id: def.id,
      label: def.label,
      enabled,
      missing: enabled ? missingFor(def.id, s, transfer) : [],
    };
  });

  const enable = new Set<MasterAgentTool>(ALWAYS_ON);
  for (const c of capabilities)
    if (c.enabled)
      for (const t of UNIVERSAL_CAPABILITIES.find((d) => d.id === c.id)!.tools) enable.add(t);
  const enabledTools = MASTER_AGENT_TOOLS.filter((t) => enable.has(t));
  const disabledTools = MASTER_AGENT_TOOLS.filter((t) => !enable.has(t));

  const blockers: string[] = [];
  if (!s.business.name?.trim()) blockers.push("Business name is missing.");
  for (const c of capabilities)
    for (const m of c.missing) blockers.push(`${c.label} is on but needs ${m}.`);

  const callTransferNumber = capabilities.find((c) => c.id === "call_transfer")?.enabled
    ? transfer
    : null;
  const vl =
    voiceLanguage === undefined
      ? { config: null, problem: null }
      : voiceLanguageConfig(voiceLanguage);
  const core = {
    templateVersion: UNIVERSAL_AGENT_TEMPLATE_VERSION,
    businessType,
    capabilities,
    tools: { enable: enabledTools, disable: disabledTools },
    callTransferNumber,
    blockers,
    voiceLanguage: vl.config,
    voiceLanguageProblem: vl.problem,
  };
  return { ...core, fingerprint: fingerprintOf(core) };
}

/** Whether an enabled capability allows a given agent API tool (runtime guard). */
export function capabilityAllowsTool(
  config: Pick<UniversalAgentConfig, "tools">,
  tool: MasterAgentTool,
): boolean {
  return config.tools.enable.includes(tool);
}

/* ------------------------------------------------------------------ */
/* Outbound agent (agent-roles.ts)                                       */
/* ------------------------------------------------------------------ */

/** Bump when the outbound template's tool set, variables or prompt contract change. */
export const OUTBOUND_AGENT_TEMPLATE_VERSION = 1;

/**
 * The customer's OUTBOUND agent: the same business data (read live by the
 * on-start hook) and the same voice and languages as the inbound agent, but a
 * fixed tool set that does not depend on capabilities. Booking, callbacks,
 * reminders and transfer are never on it, whatever the customer enables.
 */
export interface OutboundAgentConfig {
  role: "outbound";
  templateVersion: number;
  businessType: string;
  tools: { enable: string[]; forbidden: string[] };
  /** Agent variables ClickAI sets on every outbound call; the agent must declare them. */
  callVariables: string[];
  blockers: string[];
  voiceLanguage: VoiceLanguageConfig | null;
  voiceLanguageProblem: string | null;
  fingerprint: string;
}

export function buildOutboundAgentConfig(
  s: AgentSnapshot,
  voiceLanguage?: SavedVoiceLanguage | null,
): OutboundAgentConfig {
  const blockers: string[] = [];
  if (!s.business.name?.trim()) blockers.push("Business name is missing.");
  const vl =
    voiceLanguage === undefined
      ? { config: null, problem: null }
      : voiceLanguageConfig(voiceLanguage);
  const core = {
    role: "outbound" as const,
    templateVersion: OUTBOUND_AGENT_TEMPLATE_VERSION,
    businessType: s.business.business_type,
    tools: { enable: [...OUTBOUND_AGENT_TOOLS], forbidden: [...OUTBOUND_FORBIDDEN_TOOLS] },
    callVariables: [
      "call_direction",
      "clickai_call_id",
      "campaign_objective",
      "campaign_instructions",
    ],
    blockers,
    voiceLanguage: vl.config,
    voiceLanguageProblem: vl.problem,
  };
  return { ...core, fingerprint: fingerprintOf(core, `o${OUTBOUND_AGENT_TEMPLATE_VERSION}`) };
}
