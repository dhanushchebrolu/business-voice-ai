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
 */
import { createServerFn } from "@tanstack/react-start";
import { sarvam, type ChatMessage } from "@/lib/sarvam.server";

const MAX_MESSAGE_LENGTH = 800;
const MAX_HISTORY_TURNS = 6;
const DEFAULT_FALLBACK =
  "I'm not sure about that. You're welcome to book a demo and our team can help directly.";
const DEFAULT_WELCOME =
  "Hi! I'm the Vaani assistant. Ask me about features, languages, pricing or getting started.";

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

interface PublicChatInput {
  message: string;
  history?: { role: "user" | "assistant"; content: string }[];
}

export const publicChat = createServerFn({ method: "POST" })
  .inputValidator((input: PublicChatInput) => {
    if (!input?.message?.trim()) throw new Error("A message is required");
    return {
      message: input.message.trim().slice(0, MAX_MESSAGE_LENGTH),
      history: (input.history ?? []).slice(-MAX_HISTORY_TURNS * 2),
    };
  })
  .handler(async ({ data }) => {
    const settings = await loadSettings();
    if (!settings.chatbotEnabled) {
      return {
        reply: "The chat assistant is currently turned off. Please use the contact form instead.",
        ok: false as const,
      };
    }
    if (!sarvam.isConfigured()) {
      return {
        reply:
          "The AI assistant isn't configured on this deployment yet (missing provider credentials). Please book a demo instead.",
        ok: false as const,
      };
    }

    const systemPrompt = await buildSystemPrompt();
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...data.history.map((h) => ({
        role: h.role,
        content: h.content.slice(0, MAX_MESSAGE_LENGTH),
      })),
      { role: "user", content: data.message },
    ];

    try {
      const result = await sarvam.runConversation(messages);
      return { reply: result.reply || settings.fallbackResponse, ok: true as const };
    } catch {
      return {
        reply: "Sorry, I couldn't process that just now. Please try again shortly.",
        ok: false as const,
      };
    }
  });

export const getWebsiteAiPublicSettings = createServerFn({ method: "GET" }).handler(async () => {
  const settings = await loadSettings();
  return {
    chatbotEnabled: settings.chatbotEnabled,
    voiceEnabled: settings.voiceEnabled && sarvam.isConfigured(),
    welcomeMessage: settings.welcomeMessage,
  };
});

interface PublicVoiceTurnInput {
  /** Base64-encoded audio recorded in the browser (no data: URL prefix). */
  audioBase64: string;
  mimeType: string;
  history?: { role: "user" | "assistant"; content: string }[];
}

export const publicVoiceTurn = createServerFn({ method: "POST" })
  .inputValidator((input: PublicVoiceTurnInput) => {
    if (!input?.audioBase64) throw new Error("audioBase64 is required");
    if (!input?.mimeType) throw new Error("mimeType is required");
    if (input.audioBase64.length > 8_000_000) throw new Error("Recording is too long");
    return {
      audioBase64: input.audioBase64,
      mimeType: input.mimeType,
      history: (input.history ?? []).slice(-MAX_HISTORY_TURNS * 2),
    };
  })
  .handler(async ({ data }) => {
    const settings = await loadSettings();
    if (!settings.voiceEnabled) {
      return { ok: false as const, reason: "The voice assistant is currently turned off." };
    }
    if (!sarvam.isConfigured()) {
      return {
        ok: false as const,
        reason:
          "The AI voice provider isn't configured on this deployment (missing SARVAM_API_KEY).",
      };
    }

    const buffer = Buffer.from(data.audioBase64, "base64");
    const audioBlob = new Blob([buffer], { type: data.mimeType });

    const { transcript } = await sarvam.speechToText({ audio: audioBlob });
    if (!transcript) {
      return {
        ok: false as const,
        reason: "Could not understand the recording. Please try again.",
      };
    }

    const systemPrompt = await buildSystemPrompt();
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...data.history.map((h) => ({
        role: h.role,
        content: h.content.slice(0, MAX_MESSAGE_LENGTH),
      })),
      { role: "user", content: transcript.slice(0, MAX_MESSAGE_LENGTH) },
    ];

    const result = await sarvam.runConversation(messages);
    const replyText = result.reply || settings.fallbackResponse;

    const audioB64 = await sarvam.generateSpeech({
      text: replyText,
      speaker: "anushka",
      language: "en-IN",
      pace: 1,
    });

    return { ok: true as const, transcript, reply: replyText, audioBase64: audioB64 };
  });
