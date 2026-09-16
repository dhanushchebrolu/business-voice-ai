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
 * MODEL NAME UPDATE (chat = "sarvam-105b-conversations", stt = "saaras:v3") —
 * this sandbox still cannot reach docs.sarvam.ai (network egress blocked;
 * see sarvam-realtime.server.ts's own note for the re-tested confirmation),
 * so these values were NOT independently verified against Sarvam's docs
 * from here. They were supplied directly by the user from their own access
 * to Sarvam's current documentation, which also matches this repo's own
 * README.md spec section ("sarvam-105b-conversations for conversational
 * voice workloads", "Saaras v3 / realtime where appropriate", "Bulbul v3")
 * predating this change — two independent sources agreeing is stronger
 * evidence than this repo previously had for the old "sarvam-m"/"saaras:v2.5"
 * values. Still, "supplied + matches our own spec doc" is not the same as
 * "confirmed by a real API call" — that confirmation is exactly what the
 * live LLM/STT smoke tests (docs/voice-pipeline-testing.md Tier 3) are for,
 * run separately after this change lands.
 *
 * `top_p` was added to the chat completion request body per the same
 * user-supplied reference (previously omitted; only `temperature` and
 * `max_tokens` were sent). No specific value was given, so 0.9 was chosen —
 * a standard nucleus-sampling default — as the smallest change that adds
 * the field without altering the existing low-temperature (0.3), fairly
 * deterministic tone the receptionist prompt was tuned against. If the live
 * smoke test's replies read differently than before, this is the first
 * value to reconsider.
 *
 * STT REST field names (multipart "file", "model", "language_code"; JSON
 * response "transcript") are UNCHANGED — only the "saaras:v2.5"->"saaras:v3"
 * model string moved. No field-level STT REST spec was supplied this round,
 * and inventing one (e.g. a transcription-mode field) is explicitly out of
 * bounds per the user's own instruction — if "saaras:v3" turns out to need
 * different fields, that is exactly the kind of error the STT smoke test
 * surfaces (a 4xx naming an unexpected/missing field), not something to
 * guess at now.
 *
 * `SARVAM_MODELS.tts = "bulbul:v3"` is unchanged (already correct per the
 * same reference). Its response parsing (`data.audios[0]`, a base64 WAV
 * string) is used only by the public web voice-widget path
 * (public-assistant.functions.ts) — the live phone-call pipeline does not
 * use this REST TTS function at all. It uses the separate realtime
 * WebSocket TTS client in sarvam-realtime.server.ts instead, which
 * negotiates `outputCodec`/`outputSampleRateHz` explicitly at connect time
 * to match the Exotel media bridge's native format (linear16, 8kHz — see
 * exotel-media-bridge.server.ts's NATIVE_FORMAT) and was already on
 * `bulbul:v3` before this change. So "is TTS audio compatible with Exotel"
 * is a question about that realtime client, not this REST one.
 */

const BASE_URL = "https://api.sarvam.ai";
const REQUEST_TIMEOUT_MS = 15_000;

export const SARVAM_MODELS = {
  chat: "sarvam-105b-conversations",
  tts: "bulbul:v3",
  stt: "saaras:v3",
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
      top_p: 0.9,
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
