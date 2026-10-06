/**
 * Selects which LLM answers each conversational turn on a live call —
 * the one thing this file controls is which function
 * voice-runtime.server.ts's `RuntimeDeps.generateReply` points at.
 * Speech-to-text, text-to-speech, and the Exotel media WebSocket bridge are
 * entirely unaffected by this choice: both providers implement the exact
 * same `(messages: ChatMessage[]) => Promise<{ reply: string }>` shape (see
 * sarvam.server.ts's and claude.server.ts's `runConversation`), so swapping
 * which one `defaultRuntimeDeps` uses never touches STT/TTS/the bridge/the
 * runtime state machine.
 *
 * DEFAULTS TO SARVAM — this is deliberate, not an oversight. This
 * production system runs on Sarvam end to end (STT, TTS, and the LLM turn);
 * Claude is available as an alternative LLM via `VOICE_LLM_PROVIDER`, but
 * that must not silently change what a live deployment does.
 *
 * GEMINI REMOVED (testing-only experiment concluded): `gemini.server.ts`
 * and its tests were deleted outright rather than left as unreachable dead
 * code. `VOICE_LLM_PROVIDER=gemini` is no longer a recognized value — it
 * now falls through to the same "unrecognized value fails closed to
 * sarvam" behavior any other garbage value already got (see
 * resolveVoiceLlmProvider below), so a stale Cloudflare env var left over
 * from the experiment harmlessly reverts to Sarvam instead of erroring.
 */

import { sarvam, type ChatMessage } from "./sarvam.server.ts";
import { claude, type ClaudeTool } from "./claude.server.ts";

export type GenerateReply = (messages: ChatMessage[]) => Promise<{ reply: string }>;

export type GenerateReplyWithTools = (
  messages: ChatMessage[],
  tools: ClaudeTool[],
  executeTool: (
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ content: string; isError?: boolean }>,
) => Promise<{
  reply: string;
  toolCalls: { name: string; input: Record<string, unknown>; isError: boolean }[];
}>;

export type VoiceLlmProvider = "sarvam" | "claude";

/** Reads directly from process.env rather than caching — matches the existing convention (apiKey() in sarvam.server.ts and claude.server.ts also reads lazily at call time), and keeps this testable without a module-reload trick. */
export function resolveVoiceLlmProvider(): VoiceLlmProvider {
  const raw = (process.env["VOICE_LLM_PROVIDER"] ?? "sarvam").trim().toLowerCase();
  if (raw === "claude") return "claude";
  return "sarvam";
}

export function resolveGenerateReply(): GenerateReply {
  const provider = resolveVoiceLlmProvider();
  if (provider === "claude") return claude.runConversation;
  return sarvam.runConversation;
}

/**
 * Phase 4 AI tool-calling — only Claude implements the single-tool-call-
 * round exchange today (runConversationWithTools; see claude.server.ts's
 * own doc comment for why it's a separate function from runConversation).
 * Sarvam returns undefined here, not a shim that ignores tools silently —
 * voice-runtime.server.ts's defaultRuntimeDeps reads this return value to
 * decide whether to wire the tool-calling deps in at all, so an agent
 * running on Sarvam never has tools half-enabled with no way to actually
 * call them.
 */
export function resolveGenerateReplyWithTools(): GenerateReplyWithTools | undefined {
  return resolveVoiceLlmProvider() === "claude" ? claude.runConversationWithTools : undefined;
}
