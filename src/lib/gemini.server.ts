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
 *
 * 503 RETRY (production incident, after the 404 gemini-2.5-flash migration
 * above was already resolved): Google returned 503 "This model is
 * currently experiencing high demand... Please try again later." — a
 * standard transient-overload response, not a model/auth/quota/request-
 * shape problem. `call()` previously made exactly one attempt and threw
 * immediately on any non-2xx, so a single momentary spike always reached
 * the caller as the generic fallback speech. Now retries once more on a
 * 503 specifically after a short fixed delay — short because this blocks a
 * live phone call, not a background job.
 *
 * 429 RETRY + FALLBACK (production incident, after the 503 fix above):
 * Google returned 429 "RESOURCE_EXHAUSTED" on a live call, and — unlike
 * 503 — `call()` treated it as an immediate, non-retried, non-fallback
 * failure (an earlier revision of this comment justified that choice as
 * "a real rate limit shouldn't be hammered again immediately"). Google's
 * own guidance recommends exponential-backoff retry for 429 the same as
 * for 503, so `call()` now gives 429 the same shape as 503 — one short
 * backoff-delayed retry of the primary model, then fall back once to the
 * secondary model if the retry also comes back 429 — reusing the exact
 * same MAX_PRIMARY_ATTEMPTS loop and recovery budget as 503, not a
 * parallel mechanism. The one real difference from 503 is the delay
 * itself: 429's retry waits `RETRY_429_BASE_DELAY_MS` (not 503's
 * `RETRY_DELAY_MS`), honoring Google's own suggested retryDelay from the
 * error body when present, but hard-capped by `MAX_429_RETRY_DELAY_MS` and
 * by whatever's left of `TOTAL_RECOVERY_BUDGET_MS` — Google's suggested
 * delay is sized for a background retry loop, not a caller holding the
 * line, so it is a hint here, never something this code sleeps out in
 * full. Diagnostic detail from Google's 429 body (code/status/message/
 * details/retryDelay) is logged via `gemini:429_received` — safe fields
 * only, never the API key or request body (see `parseGoogleErrorBody`).
 */

const BASE_URL = "https://generativelanguage.googleapis.com";
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Overridable via GEMINI_MODEL — defaults to the latest Flash model id at
 * the time this was written.
 *
 * gemini-2.5-flash -> gemini-3.8-flash (production incident: Google's API
 * returned 404 "models/gemini-2.5-flash is no longer available to new
 * users", explicitly naming models/gemini-3.8-flash as the replacement).
 * If GEMINI_MODEL is set as a Cloudflare dashboard secret, it still wins
 * over this constant (see `model()` below) — this fix does not reach a
 * deployment that has GEMINI_MODEL explicitly pinned to the old id.
 */
const DEFAULT_MODEL = "gemini-3.8-flash";

/**
 * Tried exactly once, only after the primary model's own 503 retries are
 * exhausted (production incident: Google returned 503 "This model is
 * currently experiencing high demand..." on BOTH of the primary's two
 * attempts). gemini-3.7-flash is the immediate predecessor in the same
 * model family, confirmed request/response-compatible with the exact
 * shape already used here (no generationConfig/tool/parsing change
 * needed — see gemini.server's own 503-retry history above for why
 * temperature/top_p/top_k/thinking_budget/candidate_count are already
 * absent). Overridable via GEMINI_FALLBACK_MODEL, but no new env var is
 * required for normal operation — the default is sufficient.
 */
const DEFAULT_FALLBACK_MODEL = "gemini-3.7-flash";

function model(): string {
  return process.env["GEMINI_MODEL"] || DEFAULT_MODEL;
}

function fallbackModel(): string {
  return process.env["GEMINI_FALLBACK_MODEL"] || DEFAULT_FALLBACK_MODEL;
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

// A 503 or 429 from generateContent are both standard transient conditions
// Google's own guidance recommends retrying with backoff — neither is a
// malformed request, an auth/quota-exhaustion, or a model-id problem (those
// are 400/401/403/404 respectively, each handled distinctly below, and
// never retried). One short, bounded retry per status gives a momentary
// spike or rate-limit window a real chance to clear before the caller
// hears a fallback; delays are kept short because this blocks a live phone
// call, not a background job — a long backoff would make the caller wait
// longer than just speaking the fallback would. Both statuses share the
// same MAX_PRIMARY_ATTEMPTS loop (see call()) — a 503 retries at a fixed
// RETRY_DELAY_MS, a 429 retries at its own, separately-capped delay (see
// RETRY_429_BASE_DELAY_MS/MAX_429_RETRY_DELAY_MS below).
const MAX_PRIMARY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;

/**
 * 429's own retry delay — deliberately separate from 503's RETRY_DELAY_MS
 * rather than reusing it, since a rate limit and a capacity spike are
 * different conditions that may clear on different timescales. Used as the
 * default when Google's error body carries no retryDelay hint (see
 * parseGoogleErrorBody); when it does, the hint is preferred but still
 * capped by MAX_429_RETRY_DELAY_MS and by whatever's left of
 * TOTAL_RECOVERY_BUDGET_MS — see backoff429DelayMs.
 */
const RETRY_429_BASE_DELAY_MS = 500;

/**
 * Hard ceiling on the 429 retry delay regardless of what Google's own
 * retryDelay suggests. Google's suggested delay is sized for a background
 * retry loop; a live caller holding the line cannot wait out a multi-second
 * (or longer) suggestion, and the whole point of retrying within
 * TOTAL_RECOVERY_BUDGET_MS is to stay well inside a tolerable live-call
 * latency, not to honor Google's hint at full length.
 */
const MAX_429_RETRY_DELAY_MS = 1_500;

/**
 * Bounds the ENTIRE primary-retry + fallback sequence to a latency a live
 * caller can tolerate. Without this, three independent fetches each
 * carrying their own full REQUEST_TIMEOUT_MS (15s) could stack into
 * 30-45s of dead air if every attempt genuinely hung rather than fast-
 * failing with a 503 (production incident: both of the primary's 503
 * attempts came back quickly, but nothing bounded the worst case). Each
 * attempt's own AbortSignal.timeout is capped to whatever's left of this
 * shared budget via `remainingAttemptTimeoutMs`, never to more than
 * REQUEST_TIMEOUT_MS itself — that per-request ceiling is preserved, not
 * weakened, it's just no longer the only one.
 */
export const TOTAL_RECOVERY_BUDGET_MS = 7_000;

/** Exported as a pure function so the budget arithmetic is directly unit-testable without timer mocking. */
export function remainingAttemptTimeoutMs(startedAt: number, now: number): number {
  return Math.max(0, Math.min(REQUEST_TIMEOUT_MS, TOTAL_RECOVERY_BUDGET_MS - (now - startedAt)));
}

function errorForStatus(status: number, text: string): ProviderError {
  if (status === 401 || status === 403)
    return new ProviderError("The AI voice provider rejected the platform credentials.", status);
  if (status === 429)
    return new ProviderError(
      "The AI voice provider is rate limiting requests. Try again shortly.",
      429,
    );
  return new ProviderError(`AI voice provider error (${status}). ${text.slice(0, 180)}`, status);
}

/**
 * Best-effort parse of Google's standard JSON error body
 * ({"error":{code,message,status,details}}) — never throws, used only for
 * diagnostics. `details` may include a google.rpc.RetryInfo entry
 * ({"@type":"...RetryInfo","retryDelay":"13s"}), which retryDelayMs
 * extracts when present. This is the standard shape documented across
 * Google APIs generally, not independently re-verified against live
 * Gemini docs from this sandbox (ai.google.dev is unreachable here, same
 * caveat as this file's other Gemini-specific claims) — if a real 429
 * body doesn't match this shape, every field below simply comes back
 * undefined rather than throwing, so this never breaks the error path.
 */
function parseGoogleErrorBody(text: string): {
  code?: number;
  status?: string;
  message?: string;
  details?: unknown;
  retryDelayMs?: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const error = (parsed as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return {};
  const errorObj = error as Record<string, unknown>;
  const details = errorObj["details"];

  let retryDelayMs: number | undefined;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (typeof detail !== "object" || detail === null) continue;
      const retryDelay = (detail as Record<string, unknown>)["retryDelay"];
      if (typeof retryDelay !== "string") continue;
      const match = /^(\d+(?:\.\d+)?)s$/.exec(retryDelay);
      const seconds = match?.[1];
      if (seconds !== undefined) retryDelayMs = Math.round(parseFloat(seconds) * 1000);
    }
  }

  const code = typeof errorObj["code"] === "number" ? (errorObj["code"] as number) : undefined;
  const status =
    typeof errorObj["status"] === "string" ? (errorObj["status"] as string) : undefined;
  const message =
    typeof errorObj["message"] === "string" ? (errorObj["message"] as string) : undefined;

  // Built via conditional spreads, never an explicit `key: undefined` —
  // this file's tsconfig has exactOptionalPropertyTypes on, which treats
  // those as distinct from an absent key.
  return {
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(details !== undefined ? { details } : {}),
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
  };
}

/**
 * Logs whatever useful, non-secret detail Google's 429 body carries — the
 * one thing the pre-this-change code fetched over the network and then
 * discarded unused (errorForStatus's 429 branch never read its `text`
 * argument). Safe fields only: a length-capped raw-body preview and a few
 * shallow, independently-truncated structured fields — never the API key
 * (never present in Google's own response body in the first place; this
 * function only ever reads `text`, never the request or the key) and never
 * the full response body unbounded.
 */
function logGoogle429(text: string): void {
  const { code, status, message, details, retryDelayMs } = parseGoogleErrorBody(text);
  console.info("gemini:429_received", {
    bodyPreview: text.slice(0, 300),
    errorCode: code ?? null,
    errorStatus: status ?? null,
    errorMessage: message ? message.slice(0, 200) : null,
    errorDetailsPreview: details ? JSON.stringify(details).slice(0, 300) : null,
    retryDelayMs: retryDelayMs ?? null,
  });
}

/**
 * The one 429 retry's delay — see RETRY_429_BASE_DELAY_MS/
 * MAX_429_RETRY_DELAY_MS above for why this is separate from 503's fixed
 * RETRY_DELAY_MS. Google's own suggested retryDelay (when present) is
 * preferred over the fixed default, but both are capped by
 * MAX_429_RETRY_DELAY_MS and by remainingBudgetMs — never longer than
 * what's actually left of TOTAL_RECOVERY_BUDGET_MS, and never negative.
 * Exported as a pure function so the capping logic is directly
 * unit-testable without timer mocking — same reasoning as
 * remainingAttemptTimeoutMs above.
 */
export function backoff429DelayMs(bodyText: string, remainingBudgetMs: number): number {
  const { retryDelayMs } = parseGoogleErrorBody(bodyText);
  const suggested = retryDelayMs ?? RETRY_429_BASE_DELAY_MS;
  return Math.max(0, Math.min(suggested, MAX_429_RETRY_DELAY_MS, remainingBudgetMs));
}

/** One HTTP attempt against a given model id. Never retries, never falls back — call() owns that. */
async function requestOnce(
  modelId: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; text: string; data?: GeminiResponse }> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1beta/models/${modelId}:generateContent?key=${apiKey()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new ProviderError("The AI voice provider timed out. Please retry.", 504);
    }
    throw new ProviderError("Could not reach the AI voice provider. Please retry.", 503);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { status: res.status, text };
  }
  return { status: res.status, text: "", data: (await res.json()) as GeminiResponse };
}

async function call(body: Record<string, unknown>): Promise<GeminiResponse> {
  const startedAt = Date.now();
  let lastErrorText = "";
  // Which retryable status the primary model last failed with — decides
  // the fallback log's `reason` and, in the near-impossible case the
  // budget runs out before the fallback can even be attempted, the final
  // thrown error's status. Defaults to 503 to preserve the exact prior
  // behavior for that edge case when the loop somehow never runs (budget
  // already exhausted before attempt 1 — not reachable in practice since
  // attempt 1 starts at ~0ms elapsed).
  let lastErrorStatus: 429 | 503 = 503;

  for (let attempt = 1; attempt <= MAX_PRIMARY_ATTEMPTS; attempt++) {
    const timeoutMs = remainingAttemptTimeoutMs(startedAt, Date.now());
    if (timeoutMs <= 0) break; // recovery budget already exhausted before this attempt could start

    const result = await requestOnce(model(), body, timeoutMs);
    if (result.data) return result.data;

    if (result.status === 429) {
      logGoogle429(result.text);
      lastErrorStatus = 429;
      lastErrorText = result.text;
      if (attempt < MAX_PRIMARY_ATTEMPTS) {
        const remainingMs = remainingAttemptTimeoutMs(startedAt, Date.now());
        const delayMs = backoff429DelayMs(result.text, remainingMs);
        // Safe to log: attempt count and delay only, never the request
        // body, the response body, or the API key.
        console.info("gemini:retrying_after_429", { attempt, delayMs });
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      continue;
    }

    if (result.status === 503) {
      lastErrorStatus = 503;
      lastErrorText = result.text;
      if (attempt < MAX_PRIMARY_ATTEMPTS) {
        // Safe to log: attempt count and delay only, never the request
        // body, the response body, or the API key.
        console.info("gemini:retrying_after_503", { attempt, delayMs: RETRY_DELAY_MS });
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
      continue;
    }

    // Any other status (400/401/403/404/500/502/...) is not retried —
    // matches the existing, unchanged behavior for every status besides
    // 503/429.
    throw errorForStatus(result.status, result.text);
  }

  // Primary model's retries are exhausted — try the fallback model exactly
  // once (never its own retry loop), using only whatever's left of the
  // shared recovery budget. Reaching here means every prior attempt was
  // specifically a 503 and/or a 429 (possibly a mix of both); any other
  // status already threw above and never reaches this point
  // (401/403/400/404/timeout/network errors do not trigger the fallback,
  // matching their existing, unchanged behavior).
  const fallbackTimeoutMs = remainingAttemptTimeoutMs(startedAt, Date.now());
  if (fallbackTimeoutMs > 0) {
    console.info("gemini:falling_back_to_secondary_model", {
      primaryModel: model(),
      fallbackModel: fallbackModel(),
      reason: lastErrorStatus === 429 ? "primary_429_exhausted" : "primary_503_exhausted",
      elapsedMs: Date.now() - startedAt,
      remainingBudgetMs: fallbackTimeoutMs,
    });
    const fallbackResult = await requestOnce(fallbackModel(), body, fallbackTimeoutMs);
    if (fallbackResult.data) return fallbackResult.data;
    if (fallbackResult.status === 429) logGoogle429(fallbackResult.text);
    throw errorForStatus(fallbackResult.status, fallbackResult.text);
  }

  // Recovery budget exhausted before the fallback could even be attempted —
  // preserve the exact existing final-failure shape (a ProviderError
  // carrying whichever retryable status was last seen) rather than
  // inventing a new error path for this edge case.
  throw new ProviderError(
    `AI voice provider error (${lastErrorStatus}). ${lastErrorText.slice(0, 180)}`,
    lastErrorStatus,
  );
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
      // temperature/topP removed for the gemini-3.8-flash migration: Google's
      // 3.8 Flash backend deprecates and silently ignores temperature/
      // top_p/top_k (replaced, where sampling control is needed at all, by
      // thinking_level — not used here, since this codebase never set
      // thinking_budget/candidate_count/top_k either). maxOutputTokens is
      // unaffected and kept.
      generationConfig: { maxOutputTokens: 400 },
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
