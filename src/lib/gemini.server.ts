/**
 * Gemini (Google Generative Language API) provider — server-only, API key
 * never leaves this layer.
 *
 * SCOPE: this module implements only the text-in/text-out reasoning step of
 * the voice pipeline — the same role `sarvam.runConversation` and
 * `claude.runConversation` play today (see sarvam.server.ts and
 * claude.server.ts). It is a drop-in replacement for that one call site in
 * voice-runtime.server.ts's `RuntimeDeps.generateReply`
 * (`(messages: ChatMessage[]) => Promise<{ reply: string }>`), selected via
 * llm-provider.server.ts. Speech-to-text, text-to-speech, and the Exotel
 * media WebSocket bridge are all untouched by this module and remain
 * Sarvam's realtime clients (sarvam-realtime.server.ts) — switching the LLM
 * here has zero effect on how audio reaches or leaves the call.
 *
 * BUSINESS-GROUNDING IS UNAFFECTED BY WHICH LLM IS SELECTED:
 * voice-runtime.server.ts's `handleUserUtterance` always sends a `role:
 * "system"` ChatMessage built by `buildAgentInstructions()`
 * (agent-instructions.ts) — the business's real name, hours, services,
 * pricing, FAQs, knowledge base, rules, and escalation policy. That
 * happens identically no matter which provider `generateReply` resolves
 * to, so Gemini answers from the same business-grounded prompt Sarvam and
 * Claude do.
 *
 * SHAPE DIFFERENCE FROM SARVAM'S CHAT ENDPOINT: Sarvam's
 * `/v1/chat/completions` is OpenAI-shaped — a system message is just
 * another entry in the `messages` array. Gemini's generateContent API is
 * not: it takes a top-level `system_instruction` object and a `contents`
 * array whose turns use `role: "user" | "model"` (not "assistant") and
 * wrap text in a `parts` array. `toGeminiRequest` below does that
 * conversion — every `ChatMessage` with `role: "system"` is pulled out and
 * joined into `system_instruction` (voice-runtime.server.ts's
 * `handleUserUtterance` only ever puts one system message, at index 0, but
 * this handles more than one defensively rather than silently dropping
 * them), and `role: "assistant"` is translated to Gemini's `"model"`.
 *
 * TOOL-CALLING: `tools` is accepted as an optional parameter (Gemini's own
 * function-declaration schema —
 * https://ai.google.dev/gemini-api/docs/function-calling), so this module
 * is forward-compatible with a future tool-calling phase without another
 * interface change. No tools are wired in yet — no business-logic tool
 * (appointment booking, lead creation, etc.) exists in this codebase today
 * (confirmed: no `appointments` table, no tool-dispatch loop in
 * voice-runtime.server.ts). Passing `tools` here without a caller that
 * also implements the dispatch loop and re-prompts on a function-call
 * response would just leave a call hanging on an unanswered tool request —
 * that loop is explicitly out of scope for this change.
 */

const BASE_URL = "https://generativelanguage.googleapis.com";
const REQUEST_TIMEOUT_MS = 15_000;

/** Overridable via GEMINI_MODEL — defaults to the latest Flash model id at the time this was written. */
const DEFAULT_MODEL = "gemini-2.5-flash";

function model(): string {
  return process.env["GEMINI_MODEL"] || DEFAULT_MODEL;
}

// Reused from sarvam.server.ts rather than re-declared here: voice-runtime.
// server.ts's speakFallback does `error instanceof ProviderError` to choose
// a more specific caller-facing message for a provider failure — sharing
// the one class means that check keeps working regardless of which LLM
// provider is selected, without voice-runtime.server.ts needing to know or
// care which one raised it. See llm-provider.server.ts's own doc comment
// for the same reasoning applied to the provider-selection layer.
import { ProviderError, type ChatMessage } from "./sarvam.server.ts";
export { ProviderError };

function apiKey(): string {
  const key = process.env["GEMINI_API_KEY"];
  if (!key)
    throw new ProviderError("The AI voice provider is not configured for this workspace.", 503);
  return key;
}

// Unlike Sarvam/Claude (which take the key in a header), Google's
// generateContent endpoint is authenticated via a `key` query parameter —
// that is this API's own documented auth mechanism, not a shortcut taken
// here. The key still never appears in a thrown ProviderError message (see
// `call` below, which only ever echoes the response body, truncated).

interface GeminiContent {
  role: "user" | "model";
  parts: { text: string }[];
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function toGeminiRequest(messages: ChatMessage[]): {
  systemInstruction: string | undefined;
  contents: GeminiContent[];
} {
  const systemParts: string[] = [];
  const turns: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    turns.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }
  return {
    systemInstruction: systemParts.length ? systemParts.join("\n\n") : undefined,
    contents: turns,
  };
}

async function call(body: Record<string, unknown>): Promise<GeminiResponse> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1beta/models/${model()}:generateContent?key=${apiKey()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ProviderError("The AI voice provider timed out. Please retry.", 504);
    }
    throw new ProviderError("Could not reach the AI voice provider. Please retry.", 503);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403)
      throw new ProviderError(
        "The AI voice provider rejected the platform credentials.",
        res.status,
      );
    if (res.status === 429)
      throw new ProviderError(
        "The AI voice provider is rate limiting requests. Try again shortly.",
        429,
      );
    throw new ProviderError(
      `AI voice provider error (${res.status}). ${text.slice(0, 180)}`,
      res.status,
    );
  }
  return (await res.json()) as GeminiResponse;
}

export interface GeminiTool {
  functionDeclarations: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }[];
}

export const gemini = {
  isConfigured(): boolean {
    return Boolean(process.env["GEMINI_API_KEY"]);
  },

  /**
   * Drop-in replacement for sarvam.runConversation at the exact same call
   * site (voice-runtime.server.ts's `RuntimeDeps.generateReply`) — same
   * `(messages) => Promise<{ reply, usage }>` shape, `usage` field names
   * translated from Gemini's `promptTokenCount`/`candidatesTokenCount` to
   * the `input_tokens`/`output_tokens` naming shared by sarvam.server.ts
   * and claude.server.ts.
   */
  async runConversation(
    messages: ChatMessage[],
    options?: { tools?: GeminiTool[] },
  ): Promise<{ reply: string; usage: { input_tokens: number; output_tokens: number } }> {
    const { systemInstruction, contents } = toGeminiRequest(messages);
    const data = await call({
      contents,
      ...(systemInstruction
        ? { system_instruction: { parts: [{ text: systemInstruction }] } }
        : {}),
      generationConfig: { maxOutputTokens: 400, temperature: 0.3, topP: 0.9 },
      ...(options?.tools ? { tools: options.tools } : {}),
    });
    const reply = (data.candidates?.[0]?.content?.parts ?? [])
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text)
      .join("")
      .trim();
    return {
      reply,
      usage: {
        input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  },
};
