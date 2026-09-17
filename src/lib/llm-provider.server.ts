/**
 * Selects which LLM answers each conversational turn on a live call —
 * the one thing this file controls is which function
 * voice-runtime.server.ts's `RuntimeDeps.generateReply` points at.
 * Speech-to-text, text-to-speech, and the Exotel media WebSocket bridge are
 * entirely unaffected by this choice: both providers implement the exact
 * same `(messages: ChatMessage[]) => Promise<{ reply: string }>` shape (see
 * sarvam.server.ts's `runConversation` and claude.server.ts's
 * `runConversation`), so swapping which one `defaultRuntimeDeps` uses never
 * touches STT/TTS/the bridge/the runtime state machine.
 *
 * DEFAULTS TO SARVAM — this is deliberate, not an oversight. This
 * production system currently runs on Sarvam end to end; adding Claude as
 * an available LLM must not silently change what a live deployment does
 * the next time it builds, unless `VOICE_LLM_PROVIDER=claude` is set
 * explicitly as a Cloudflare Worker environment variable. Flipping the
 * default is a separate, deliberate decision for later — not something
 * this change makes on its own.
 */

import { sarvam, type ChatMessage } from "./sarvam.server.ts";
import { claude } from "./claude.server.ts";

export type GenerateReply = (messages: ChatMessage[]) => Promise<{ reply: string }>;

export type VoiceLlmProvider = "sarvam" | "claude";

/** Reads directly from process.env rather than caching — matches the existing convention (apiKey() in both sarvam.server.ts and claude.server.ts also reads lazily at call time), and keeps this testable without a module-reload trick. */
export function resolveVoiceLlmProvider(): VoiceLlmProvider {
  const raw = (process.env["VOICE_LLM_PROVIDER"] ?? "sarvam").trim().toLowerCase();
  return raw === "claude" ? "claude" : "sarvam";
}

export function resolveGenerateReply(): GenerateReply {
  return resolveVoiceLlmProvider() === "claude" ? claude.runConversation : sarvam.runConversation;
}
