/**
 * Sarvam AI provider adapter. Server-only — the API key never leaves this layer.
 *
 * Implemented against the currently documented Sarvam APIs:
 *   - POST /v1/chat/completions  (Sarvam conversational LLM)
 *   - POST /text-to-speech       (Bulbul v3)
 *   - POST /speech-to-text       (Saaras)
 * Operations that Sarvam does not expose publicly (agent deployment / number
 * provisioning) are declared here as unsupported instead of being faked.
 *
 * REQUEST_TIMEOUT_MS bounds every call here (`call()`'s `fetch`, via
 * `AbortSignal.timeout`) — previously unbounded, so a stuck Sarvam
 * connection during a live voice call could hang indefinitely (silence on
 * the line, or a call that never terminates) instead of failing fast into
 * the existing fallback-speech/retry path (voice-runtime.server.ts's
 * speakFallback). No official Sarvam-documented timeout exists to match
 * against (see this repo's standing verification-note convention for this
 * provider); 15s is chosen to stay well inside a caller's patience for a
 * single conversational turn while still being generous for a real
 * completion, matching the order of magnitude of
 * sarvam-realtime.server.ts's own CONNECT_TIMEOUT_MS for the streaming
 * STT/TTS sockets.
 *
 * MODEL NAME VERIFICATION NOTE — SARVAM_MODELS.chat = "sarvam-m" —
 * genuinely unresolved, flagged rather than silently changed: docs.sarvam.ai
 * is unreachable from this sandbox (confirmed again — see
 * sarvam-realtime.server.ts's own note), so this was checked via WebSearch
 * and a third-party community Rust SDK instead, and the two sources
 * DISAGREE. WebSearch summaries of Sarvam's own docs (twice, independently)
 * state sarvam-m has been deprecated and the Chat Completions API now
 * rejects `model: "sarvam-m"`, recommending `sarvam-105b`. But
 * github.com/skundu42/sarvam-rs's `ChatModel` enum (src/types/chat.rs)
 * still lists `"sarvam-m"` as a valid variant alongside `"sarvam-105b"`/
 * `"sarvam-30b"`, with no deprecation notice in that source — though a
 * third-party SDK's enum can simply lag behind a provider's own API
 * changes, so this doesn't resolve it either. NOT changed here because
 * guessing wrong either way is an unforced error when the real answer is
 * one API call away: this is exactly what docs/voice-pipeline-testing.md's
 * Tier 3a smoke test is for — a rejected/deprecated-model error there means
 * switch this constant to "sarvam-105b"; a normal reply means leave it.
 */

const BASE_URL = "https://api.sarvam.ai";
const REQUEST_TIMEOUT_MS = 15_000;

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
  if (!key)
    throw new ProviderError("The AI voice provider is not configured for this workspace.", 503);
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
  async runConversation(
    messages: ChatMessage[],
  ): Promise<{ reply: string; usage: { input_tokens: number; output_tokens: number } }> {
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
  async generateSpeech(input: {
    text: string;
    speaker: string;
    language: string;
    pace: number;
  }): Promise<string> {
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
   * Saaras batch speech-to-text. Used by the public voice assistant (a
   * turn-based "record, transcribe, respond, speak" flow — not the
   * continuous telephony media stream, which uses the separate realtime
   * WebSocket client in sarvam-realtime.server.ts). Sarvam's REST STT
   * endpoint takes multipart/form-data, unlike the JSON endpoints above.
   */
  async speechToText(input: {
    audio: Blob;
    languageCode?: string;
  }): Promise<{ transcript: string }> {
    const form = new FormData();
    form.append("file", input.audio, "audio.webm");
    form.append("model", SARVAM_MODELS.stt);
    if (input.languageCode) form.append("language_code", input.languageCode);

    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/speech-to-text`, {
        method: "POST",
        headers: { "api-subscription-key": apiKey() },
        body: form,
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
      throw new ProviderError(
        `AI voice provider error (${res.status}). ${text.slice(0, 180)}`,
        res.status,
      );
    }
    const data = (await res.json()) as { transcript?: string };
    return { transcript: data.transcript?.trim() ?? "" };
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
