import { z } from "zod";
import { normalizeVoiceLanguageCode, type VoiceLanguageCode } from "./voice-languages.ts";
import { voiceById } from "./voices.ts";

/**
 * Input validators for the agent's voice and language settings, shared by
 * saveAgentConfiguration and synthesizeVoicePreview (agent.functions.ts).
 * Kept free of server-only imports so they can be tested directly.
 */

/**
 * A language code the voice agent supports end to end, in its canonical form
 * (voice-languages.ts): `or-IN` or `OD-in` becomes `od-IN`, and anything
 * outside the 11 supported languages is rejected rather than saved and then
 * silently ignored at call time.
 */
export const voiceLanguageCode = z.string().transform((value, ctx): VoiceLanguageCode => {
  const code = normalizeVoiceLanguageCode(value);
  if (!code) {
    ctx.addIssue({ code: "custom", message: `Unsupported language: ${value.slice(0, 20)}` });
    return z.NEVER;
  }
  return code;
});

/**
 * A bulbul:v3 speaker id (stored lowercase). Anything else would only fail
 * at call start, when the voice connection is opened with it.
 */
export const voiceIdInput = z
  .string()
  .trim()
  .toLowerCase()
  .refine((id) => Boolean(voiceById(id)), { message: "Choose one of the available voices." });
