/**
 * Sarvam AI provider adapter. Server-only — the API key never leaves this layer.
 *
 * Implemented against the currently documented Sarvam APIs:
 *   - POST /v1/chat/completions  (Sarvam conversational LLM)
 *   - POST /text-to-speech       (Bulbul v3)
 *   - POST /speech-to-text       (Saaras)
 * Operations that Sarvam does not expose publicly (agent deployment / number
 * provisioning) are declared here as unsupported instead of being faked.
 */

const BASE_URL = "https://api.sarvam.ai";

export const SARVAM_MODELS = {
  chat: "sarvam-m",
  tts: "bulbul:v3",
  stt: "saaras:v2.5",
} as const;

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env["SARVAM_API_KEY"];
  if (!key) throw new ProviderError("The AI voice provider is not configured for this workspace.", 503);
  return key;
}

async function call<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": apiKey(),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ProviderError("Could not reach the AI voice provider. Please retry.", 503);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403)
      throw new ProviderError("The AI voice provider rejected the platform credentials.", res.status);
    if (res.status === 429) throw new ProviderError("The AI voice provider is rate limiting requests. Try again shortly.", 429);
    throw new ProviderError(`AI voice provider error (${res.status}). ${text.slice(0, 180)}`, res.status);
  }
  return (await res.json()) as T;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const sarvam = {
  isConfigured(): boolean {
    return Boolean(process.env["SARVAM_API_KEY"]);
  },

  /** Conversational turn used by the in-dashboard test console. */
  async runConversation(messages: ChatMessage[]): Promise<{ reply: string; usage: { input_tokens: number; output_tokens: number } }> {
    const data = await call<{
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>("/v1/chat/completions", {
      model: SARVAM_MODELS.chat,
      messages,
      temperature: 0.3,
      max_tokens: 400,
    });
    return {
      reply: data.choices?.[0]?.message?.content?.trim() ?? "",
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
      },
    };
  },

  /** Bulbul v3 speech synthesis. Returns base64 wav chunks. */
  async generateSpeech(input: { text: string; speaker: string; language: string; pace: number }): Promise<string> {
    const data = await call<{ audios: string[] }>("/text-to-speech", {
      text: input.text.slice(0, 480),
      target_language_code: input.language,
      speaker: input.speaker,
      model: SARVAM_MODELS.tts,
      pace: Math.min(2, Math.max(0.5, input.pace)),
    });
    const audio = data.audios?.[0];
    if (!audio) throw new ProviderError("The provider returned no audio for this voice.", 502);
    return audio;
  },

  /**
   * Agent deployment / telephony provisioning is handled by Sarvam's Voice
   * Agents platform, which has no public management API we can call yet.
   * We record the generated configuration locally and report it honestly.
   */
  deploymentSupported(): boolean {
    return false;
  },
};
