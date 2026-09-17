/**
 * Selects which LLM answers each conversational turn on a live call —
 * the one thing this file controls is which function
 * voice-runtime.server.ts's `RuntimeDeps.generateReply` points at.
 * Speech-to-text, text-to-speech, and the Exotel media WebSocket bridge are
 * entirely unaffected by this choice: all three providers implement the
 * exact same `(messages: ChatMessage[]) => Promise<{ reply: string }>`
 * shape (see sarvam.server.ts's, claude.server.ts's, and gemini.server.ts's
 * `runConversation`), so swapping which one `defaultRuntimeDeps` uses never
 * touches STT/TTS/the bridge/the runtime state machine.
 *
 * DEFAULTS TO SARVAM — this is deliberate, not an oversight. This
 * production system currently runs on Sarvam end to end; adding Claude or
 * Gemini as available LLMs must not silently change what a live deployment
 * does the next time it builds, unless `VOICE_LLM_PROVIDER` is set
 * explicitly as a Cloudflare Worker environment variable. Flipping the
 * default is a separate, deliberate decision for later — not something
 * this change makes on its own.
 */

import { sarvam, type ChatMessage } from "./sarvam.server.ts";
import { claude } from "./claude.server.ts";
import { gemini } from "./gemini.server.ts";

export type GenerateReply = (messages: ChatMessage[]) => Promise<{ reply: string }>;

export type VoiceLlmProvider = "sarvam" | "claude" | "gemini";

/** Reads directly from process.env rather than caching — matches the existing convention (apiKey() in sarvam.server.ts, claude.server.ts, and gemini.server.ts also reads lazily at call time), and keeps this testable without a module-reload trick. */
export function resolveVoiceLlmProvider(): VoiceLlmProvider {
  const raw = (process.env["VOICE_LLM_PROVIDER"] ?? "sarvam").trim().toLowerCase();
  if (raw === "claude") return "claude";
  if (raw === "gemini") return "gemini";
  return "sarvam";
}

export function resolveGenerateReply(): GenerateReply {
  const provider = resolveVoiceLlmProvider();
  if (provider === "claude") return claude.runConversation;
  if (provider === "gemini") return gemini.runConversation;
  return sarvam.runConversation;
}
