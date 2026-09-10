/**
 * Public website chatbot + voice assistant. Deliberately unauthenticated
 * (no requireSupabaseAuth middleware) — this is the marketing-site
 * assistant, reachable by anonymous visitors.
 *
 * Security-critical isolation: this file must NEVER read organizations,
 * businesses, agent_configs, call_logs, knowledge_documents or any other
 * tenant-scoped table. The only inputs into the model are:
 *   - public_knowledge_base rows where is_active = true (admin-managed)
 *   - platform_settings pricing.* rows (already public, platform-wide)
 *   - the visitor's own message/audio
 * There is no organization_id anywhere in this file, so there is nothing to
 * accidentally leak a customer's data through.
 *
 * `runPublicChat`/`runPublicVoiceTurn` take their dependencies (rate
 * limiter, settings/prompt loaders, the Sarvam client) as parameters so
 * they can be unit-tested with fakes — see public-assistant.functions.test.ts
 * — while `publicChat`/`publicVoiceTurn` below are the thin createServerFn
 * wrappers that supply the real ones.
 */
import { createServerFn } from "@tanstack/react-start";
import { sarvam, type ChatMessage } from "./sarvam.server.ts";
import { checkChatRateLimit, checkVoiceRateLimit, getClientIdentity } from "./rate-limit.server.ts";
import type { RateLimitDecision } from "./rate-limit.server.ts";
import {
  validateHistory,
  validateMessage,
  MAX_MESSAGE_LENGTH,
  type HistoryEntry,
} from "./public-assistant-validation.ts";

const DEFAULT_FALLBACK =
  "I'm not sure about that. You're welcome to book a demo and our team can help directly.";
const DEFAULT_WELCOME =
  "Hi! I'm the Vaani assistant. Ask me about features, languages, pricing or getting started.";
const RATE_LIMIT_CHAT_MESSAGE =
  "You're sending messages too quickly. Please wait a moment and try again.";
const RATE_LIMIT_VOICE_MESSAGE =
  "You're sending requests too quickly. Please wait a moment and try again.";

interface WebsiteAiSettings {
  chatbotEnabled: boolean;
  voiceEnabled: boolean;
  welcomeMessage: string;
  fallbackResponse: string;
}

async function loadSettings(): Promise<WebsiteAiSettings> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("platform_settings")
    .select("key, value")
    .in("key", [
      "website_ai.chatbot_enabled",
      "website_ai.voice_enabled",
      "website_ai.welcome_message",
      "website_ai.fallback_response",
    ]);
  const map = new Map((data ?? []).map((r) => [r.key, r.value as Record<string, unknown>]));
  return {
    chatbotEnabled: Boolean(
      (map.get("website_ai.chatbot_enabled") as { enabled?: boolean } | undefined)?.enabled ?? true,
    ),
    voiceEnabled: Boolean(
      (map.get("website_ai.voice_enabled") as { enabled?: boolean } | undefined)?.enabled ?? false,
    ),
    welcomeMessage:
      (map.get("website_ai.welcome_message") as { text?: string } | undefined)?.text ||
      DEFAULT_WELCOME,
    fallbackResponse:
      (map.get("website_ai.fallback_response") as { text?: string } | undefined)?.text ||
      DEFAULT_FALLBACK,
  };
}

async function buildSystemPrompt(): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: knowledge }, { data: pricing }] = await Promise.all([
    supabaseAdmin
      .from("public_knowledge_base")
      .select("title, content, category")
      .eq("is_active", true)
      .order("sort_order"),
    supabaseAdmin.from("platform_settings").select("key, value").like("key", "pricing.%"),
  ]);

  const knowledgeBlock = (knowledge ?? [])
    .map((k) => `- ${k.title}${k.category ? ` (${k.category})` : ""}: ${k.content}`)
    .join("\n");

  const pricingBlock = (pricing ?? [])
    .map((p) => {
      const v = p.value as { amount?: number; currency?: string; label?: string };
      if (!v?.amount) return null;
      return `- ${v.label ?? p.key}: ${(v.amount / 100).toLocaleString("en-IN")} ${v.currency ?? "INR"}`;
    })
    .filter(Boolean)
    .join("\n");

  return [
    "You are the public website assistant for Vaani, an AI phone receptionist product for Indian businesses.",
    "Answer ONLY using the knowledge and pricing below. Do not invent features, prices, integrations or timelines that are not listed.",
    "You have no access to any customer's account, calls, transcripts, phone numbers, agent configuration or billing — you are a public marketing assistant only. If asked about a specific customer's data, explain you cannot access private customer information and suggest they sign in to their dashboard.",
    "If a question is outside the knowledge below, say you're not sure and suggest booking a demo at /contact.",
    "Keep answers concise (2-4 sentences) and friendly.",
    "",
    "## Knowledge",
    knowledgeBlock || "(no knowledge entries configured yet)",
    "",
    "## Current pricing",
    pricingBlock || "(pricing not published — direct the visitor to book a demo for pricing)",
  ].join("\n");
}

/** The subset of `sarvam` each function actually needs — narrowed so tests can inject fakes without a real Blob/FormData/network stack. */
type SarvamChatDeps = Pick<typeof sarvam, "isConfigured" | "runConversation">;
type SarvamVoiceDeps = Pick<
  typeof sarvam,
  "isConfigured" | "speechToText" | "runConversation" | "generateSpeech"
>;

export interface PublicChatDeps {
  checkRateLimit: (clientKey: string) => Promise<RateLimitDecision>;
  clientKey: string;
  loadSettings: () => Promise<WebsiteAiSettings>;
  buildSystemPrompt: () => Promise<string>;
  sarvam: SarvamChatDeps;
}

export interface PublicChatResult {
  reply: string;
  ok: boolean;
  rateLimited?: boolean;
}

export async function runPublicChat(
  input: { message: string; history: HistoryEntry[] },
  deps: PublicChatDeps,
): Promise<PublicChatResult> {
  const decision = await deps.checkRateLimit(deps.clientKey);
  if (!decision.allowed) {
    return { reply: RATE_LIMIT_CHAT_MESSAGE, ok: false, rateLimited: true };
  }

  const settings = await deps.loadSettings();
  if (!settings.chatbotEnabled) {
    return {
      reply: "The chat assistant is currently turned off. Please use the contact form instead.",
      ok: false,
    };
  }
  if (!deps.sarvam.isConfigured()) {
    return {
      reply:
        "The AI assistant isn't configured on this deployment yet (missing provider credentials). Please book a demo instead.",
      ok: false,
    };
  }

  const systemPrompt = await deps.buildSystemPrompt();
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...input.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: input.message },
  ];

  try {
    const result = await deps.sarvam.runConversation(messages);
    return { reply: result.reply || settings.fallbackResponse, ok: true };
  } catch (error) {
    console.error("public_chat:sarvam_failed", error);
    return {
      reply: "Sorry, I couldn't process that just now. Please try again shortly.",
      ok: false,
    };
  }
}

interface PublicChatInput {
  message: unknown;
  history?: unknown;
}

export const publicChat = createServerFn({ method: "POST" })
  .inputValidator((input: PublicChatInput) => ({
    message: validateMessage(input?.message),
    history: validateHistory(input?.history),
  }))
  .handler(async ({ data }) =>
    runPublicChat(data, {
      checkRateLimit: checkChatRateLimit,
      clientKey: getClientIdentity(),
      loadSettings,
      buildSystemPrompt,
      sarvam,
    }),
  );

export const getWebsiteAiPublicSettings = createServerFn({ method: "GET" }).handler(async () => {
  const settings = await loadSettings();
  return {
    chatbotEnabled: settings.chatbotEnabled,
    voiceEnabled: settings.voiceEnabled && sarvam.isConfigured(),
    welcomeMessage: settings.welcomeMessage,
  };
});

export interface PublicVoiceTurnDeps {
  checkRateLimit: (clientKey: string) => Promise<RateLimitDecision>;
  clientKey: string;
  loadSettings: () => Promise<WebsiteAiSettings>;
  buildSystemPrompt: () => Promise<string>;
  sarvam: SarvamVoiceDeps;
}

export type PublicVoiceTurnResult =
  | { ok: true; transcript: string; reply: string; audioBase64: string }
  | { ok: false; reason: string; rateLimited?: boolean };

export async function runPublicVoiceTurn(
  input: { audioBase64: string; mimeType: string; history: HistoryEntry[] },
  deps: PublicVoiceTurnDeps,
): Promise<PublicVoiceTurnResult> {
  const decision = await deps.checkRateLimit(deps.clientKey);
  if (!decision.allowed) {
    return { ok: false, reason: RATE_LIMIT_VOICE_MESSAGE, rateLimited: true };
  }

  const settings = await deps.loadSettings();
  if (!settings.voiceEnabled) {
    return { ok: false, reason: "The voice assistant is currently turned off." };
  }
  if (!deps.sarvam.isConfigured()) {
    return {
      ok: false,
      reason: "The AI voice provider isn't configured on this deployment (missing SARVAM_API_KEY).",
    };
  }

  let transcript: string;
  try {
    const buffer = Buffer.from(input.audioBase64, "base64");
    const audioBlob = new Blob([buffer], { type: input.mimeType });
    ({ transcript } = await deps.sarvam.speechToText({ audio: audioBlob }));
  } catch (error) {
    console.error("public_voice:stt_failed", error);
    return { ok: false, reason: "Could not process that recording. Please try again." };
  }
  if (!transcript) {
    return { ok: false, reason: "Could not understand the recording. Please try again." };
  }

  const systemPrompt = await deps.buildSystemPrompt();
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...input.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: transcript.slice(0, MAX_MESSAGE_LENGTH) },
  ];

  let replyText: string;
  try {
    const result = await deps.sarvam.runConversation(messages);
    replyText = result.reply || settings.fallbackResponse;
  } catch (error) {
    console.error("public_voice:chat_failed", error);
    return {
      ok: false,
      reason: "Sorry, I couldn't process that just now. Please try again shortly.",
    };
  }

  try {
    const audioBase64 = await deps.sarvam.generateSpeech({
      text: replyText,
      speaker: "anushka",
      language: "en-IN",
      pace: 1,
    });
    return { ok: true, transcript, reply: replyText, audioBase64 };
  } catch (error) {
    console.error("public_voice:tts_failed", error);
    return {
      ok: false,
      reason: "Got a reply but couldn't generate speech for it. Please try again.",
    };
  }
}

interface PublicVoiceTurnInput {
  /** Base64-encoded audio recorded in the browser (no data: URL prefix). */
  audioBase64: unknown;
  mimeType: unknown;
  history?: unknown;
}

function validateAudioInput(input: PublicVoiceTurnInput): {
  audioBase64: string;
  mimeType: string;
} {
  if (typeof input?.audioBase64 !== "string" || !input.audioBase64) {
    throw new Error("audioBase64 is required");
  }
  if (typeof input?.mimeType !== "string" || !input.mimeType) {
    throw new Error("mimeType is required");
  }
  if (input.audioBase64.length > 8_000_000) {
    throw new Error("Recording is too long");
  }
  return { audioBase64: input.audioBase64, mimeType: input.mimeType };
}

export const publicVoiceTurn = createServerFn({ method: "POST" })
  .inputValidator((input: PublicVoiceTurnInput) => ({
    ...validateAudioInput(input),
    history: validateHistory(input?.history),
  }))
  .handler(async ({ data }) =>
    runPublicVoiceTurn(data, {
      checkRateLimit: checkVoiceRateLimit,
      clientKey: getClientIdentity(),
      loadSettings,
      buildSystemPrompt,
      sarvam,
    }),
  );
