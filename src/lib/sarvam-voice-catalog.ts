import { SARVAM_VOICE_CATALOG } from "./sarvam-voice-catalog.data.ts";

/**
 * Languages and voices for Sarvam-managed agents (one Sarvam agent per
 * customer). Separate from voice-languages.ts, which describes ClickAI's own
 * legacy voice pipeline (bulbul:v3, no Assamese).
 *
 * Language list: Sarvam Voice Agents docs (voice-agents/overview) — 11 Indian
 * languages plus English. Names are Sarvam's own spellings, which is what
 * the agent config takes (language_config.supported_languages).
 *
 * Voices: a dated snapshot of this workspace's catalog
 * (sarvam-voice-catalog.data.ts). Sarvam has no REST endpoint for the Voice
 * Agents voice catalog; it is read through the MCP server only.
 */

export const SARVAM_LANGUAGES = [
  { name: "English", code: "en-IN", native: "English" },
  { name: "Hindi", code: "hi-IN", native: "हिन्दी" },
  { name: "Bengali", code: "bn-IN", native: "বাংলা" },
  { name: "Tamil", code: "ta-IN", native: "தமிழ்" },
  { name: "Telugu", code: "te-IN", native: "తెలుగు" },
  { name: "Gujarati", code: "gu-IN", native: "ગુજરાતી" },
  { name: "Kannada", code: "kn-IN", native: "ಕನ್ನಡ" },
  { name: "Malayalam", code: "ml-IN", native: "മലയാളം" },
  { name: "Marathi", code: "mr-IN", native: "मराठी" },
  { name: "Punjabi", code: "pa-IN", native: "ਪੰਜਾਬੀ" },
  { name: "Odia", code: "od-IN", native: "ଓଡ଼ିଆ" },
  { name: "Assamese", code: "as-IN", native: "অসমীয়া" },
] as const;

export type SarvamLanguageName = (typeof SARVAM_LANGUAGES)[number]["name"];

export const SARVAM_LANGUAGE_NAMES = SARVAM_LANGUAGES.map((l) => l.name) as [
  SarvamLanguageName,
  ...SarvamLanguageName[],
];

/** Every customer agent always understands these two (onboarding policy, 2026-11-14). */
export const ALWAYS_ALLOWED: readonly SarvamLanguageName[] = ["English", "Hindi"];
/** Regional languages beyond the default, English and Hindi. */
export const MAX_EXTRA_REGIONAL = 2;

/**
 * Sarvam's change_output_language tool lists 11 targets and omits Assamese
 * (seen on an agent's tool spec, 2026-11-14), so a mid-call switch INTO
 * Assamese is not available through it.
 */
export const NO_SWITCH_TOOL_TARGET: readonly SarvamLanguageName[] = ["Assamese"];

export interface SarvamVoice {
  internalId: string;
  name: string;
  gender: string;
  /** v4 = sarvam-tts-v4.0-beta; v3.1 = sarvam-tts-v3.1-rl-hd (legacy). */
  model: "v4" | "v3.1";
  languages: string[];
  nativeLanguages: string[];
  useCases: string[];
  description: string;
}

export { SARVAM_VOICE_CATALOG };

export function isSarvamLanguage(name: unknown): name is SarvamLanguageName {
  return typeof name === "string" && (SARVAM_LANGUAGE_NAMES as string[]).includes(name);
}

export function findSarvamVoice(internalId: string): SarvamVoice | undefined {
  return SARVAM_VOICE_CATALOG.find((v) => v.internalId === internalId);
}

/** v4 voices that list every given language, native speakers of the first language first. */
export function voicesForLanguages(languages: readonly string[]): SarvamVoice[] {
  const [first] = languages;
  return SARVAM_VOICE_CATALOG.filter(
    (v) => v.model === "v4" && languages.every((l) => v.languages.includes(l)),
  ).sort(
    (a, b) =>
      Number(b.nativeLanguages.includes(first ?? "")) -
      Number(a.nativeLanguages.includes(first ?? "")),
  );
}

export interface VoiceLanguageSettingsInput {
  defaultLanguage: string;
  allowedLanguages: string[];
  autoLanguageSwitch: boolean;
  voiceInternalId: string;
}

export interface ValidatedVoiceLanguageSettings {
  defaultLanguage: SarvamLanguageName;
  /** Default first, then English, Hindi, then the regional extras; no duplicates. */
  allowedLanguages: SarvamLanguageName[];
  autoLanguageSwitch: boolean;
  voice: SarvamVoice;
  warnings: string[];
}

/** Applies the onboarding policy; throws a plain-language Error on anything invalid. */
export function validateVoiceLanguageSettings(
  input: VoiceLanguageSettingsInput,
): ValidatedVoiceLanguageSettings {
  if (!isSarvamLanguage(input.defaultLanguage))
    throw new Error(`"${input.defaultLanguage}" is not a supported language.`);
  const unknown = input.allowedLanguages.filter((l) => !isSarvamLanguage(l));
  if (unknown.length) throw new Error(`Unsupported language(s): ${unknown.join(", ")}.`);
  if (typeof input.autoLanguageSwitch !== "boolean")
    throw new Error("Choose whether automatic language switching is on.");

  const defaultLanguage = input.defaultLanguage;
  const ordered = [defaultLanguage, ...ALWAYS_ALLOWED, ...input.allowedLanguages];
  const allowedLanguages = [...new Set(ordered)] as SarvamLanguageName[];
  const extras = allowedLanguages.filter(
    (l) => l !== defaultLanguage && !ALWAYS_ALLOWED.includes(l),
  );
  if (extras.length > MAX_EXTRA_REGIONAL)
    throw new Error(
      `At most ${MAX_EXTRA_REGIONAL} extra regional languages besides the default, English and Hindi (got ${extras.join(", ")}).`,
    );

  const voice = findSarvamVoice(input.voiceInternalId);
  if (!voice) throw new Error("That voice is not in the Sarvam voice catalog.");
  if (voice.model !== "v4")
    throw new Error(
      `${voice.name} is a legacy v3.1 voice. Choose a v4 voice; Sarvam lists v3 voices as end of life on Voice Agents.`,
    );
  const unsupported = allowedLanguages.filter((l) => !voice.languages.includes(l));
  if (unsupported.length)
    throw new Error(`${voice.name} does not support ${unsupported.join(", ")}.`);

  const warnings: string[] = [];
  if (!voice.nativeLanguages.includes(defaultLanguage))
    warnings.push(
      `${voice.name} is a native ${voice.nativeLanguages.join("/")} voice; have a native ${defaultLanguage} speaker check how it sounds.`,
    );
  const noTool = allowedLanguages.filter((l) => NO_SWITCH_TOOL_TARGET.includes(l));
  if (input.autoLanguageSwitch && noTool.length && defaultLanguage !== noTool[0])
    warnings.push(
      `Sarvam's language-switch tool cannot switch into ${noTool.join(", ")}; callers may stay in the previous language.`,
    );

  return {
    defaultLanguage,
    allowedLanguages,
    autoLanguageSwitch: input.autoLanguageSwitch,
    voice,
    warnings,
  };
}

/**
 * The partial Sarvam agent config these settings correspond to — what an
 * admin applies to the customer's own agent (MCP configure_agent or the
 * console). With switching off, the agent only knows its default language.
 */
export function sarvamAgentConfigPatch(s: ValidatedVoiceLanguageSettings) {
  const languages = s.autoLanguageSwitch ? s.allowedLanguages : [s.defaultLanguage];
  return {
    language_config: {
      initial_language_name: s.defaultLanguage,
      supported_languages: languages,
      lid_supported_languages: languages,
      enable_language_identification: s.autoLanguageSwitch,
    },
    llm_config: { agent_config: { supported_languages: languages } },
    text_to_speech_config: { config_version: "2.0", internal_id: s.voice.internalId },
  };
}

/** Sarvam language name for a stored code such as "te-IN" (also accepts or-IN and plain names). */
export function sarvamLanguageFromCode(code: string | null | undefined): SarvamLanguageName | null {
  if (!code) return null;
  const c = code.trim().toLowerCase().replace("_", "-");
  const normalized = c === "or-in" ? "od-in" : c;
  return (
    SARVAM_LANGUAGES.find((l) => l.code.toLowerCase() === normalized || l.name.toLowerCase() === c)
      ?.name ?? null
  );
}

/**
 * Starting point for a customer with nothing saved yet: their main language
 * (English when unknown) and the first v4 voice native in it that also
 * speaks English and Hindi. Only a suggestion; the admin still saves it.
 */
export function suggestVoiceLanguageDefaults(primaryLanguageCode: string | null | undefined): {
  defaultLanguage: SarvamLanguageName;
  voiceInternalId: string | null;
} {
  const defaultLanguage = sarvamLanguageFromCode(primaryLanguageCode) ?? "English";
  const voices = voicesForLanguages([defaultLanguage, ...ALWAYS_ALLOWED]);
  return { defaultLanguage, voiceInternalId: voices[0]?.internalId ?? null };
}
