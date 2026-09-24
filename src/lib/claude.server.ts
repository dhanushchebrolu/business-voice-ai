/**
 * Claude (Anthropic Messages API) provider — server-only, API key never
 * leaves this layer.
 *
 * SCOPE: this module implements only the text-in/text-out reasoning step of
 * the voice pipeline — the same role `sarvam.runConversation` plays today
 * (see sarvam.server.ts). It is a drop-in replacement for that one call
 * site in voice-runtime.server.ts's `RuntimeDeps.generateReply`
 * (`(messages: ChatMessage[]) => Promise<{ reply: string }>`), selected via
 * llm-provider.server.ts. Speech-to-text, text-to-speech, and the Exotel
 * media WebSocket bridge are all untouched by this module and remain
 * Sarvam's realtime clients (sarvam-realtime.server.ts) — switching the LLM
 * here has zero effect on how audio reaches or leaves the call.
 *
 * SHAPE DIFFERENCE FROM SARVAM'S CHAT ENDPOINT: Sarvam's
 * `/v1/chat/completions` is OpenAI-shaped — a system message is just
 * another entry in the `messages` array. Anthropic's Messages API is not:
 * it takes a single top-level `system` string and a `messages` array that
 * must contain only "user"/"assistant" turns. `toAnthropicRequest` below
 * does that conversion — every `ChatMessage` with `role: "system"` is
 * pulled out and joined into the top-level `system` field (voice-runtime.
 * server.ts's `handleUserUtterance` only ever puts one system message, at
 * index 0, but this handles more than one defensively rather than
 * silently dropping them). This is the only structural adaptation Claude
 * needs; everything else about the call site is unchanged.
 *
 * TOOL-CALLING: `tools` is accepted as an optional parameter (Anthropic's
 * own tool-use schema — https://docs.anthropic.com/en/docs/build-with-claude/tool-use),
 * so this module is forward-compatible with a future tool-calling phase
 * without another interface change. No tools are wired in yet — no
 * business-logic tool (appointment booking, lead creation, etc.) exists in
 * this codebase today (confirmed: no `appointments` table, no tool-dispatch
 * loop in voice-runtime.server.ts). Passing `tools` here without a caller
 * that also implements the dispatch loop and re-prompts on a `tool_use`
 * stop_reason would just leave a call hanging on an unanswered tool
 * request — that loop is explicitly out of scope for this change.
 */

const BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 15_000;

/** Overridable via CLAUDE_MODEL — defaults to the latest Sonnet model id at the time this was written. */
const DEFAULT_MODEL = "claude-sonnet-5";

function model(): string {
  return process.env["CLAUDE_MODEL"] || DEFAULT_MODEL;
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
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key)
    throw new ProviderError("The AI voice provider is not configured for this workspace.", 503);
  return key;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function toAnthropicRequest(messages: ChatMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const turns: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    turns.push({ role: m.role, content: m.content });
  }
  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, messages: turns };
}

async function call(body: Record<string, unknown>): Promise<AnthropicResponse> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey(),
        "anthropic-version": ANTHROPIC_VERSION,
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
  return (await res.json()) as AnthropicResponse;
}

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const claude = {
  isConfigured(): boolean {
    return Boolean(process.env["ANTHROPIC_API_KEY"]);
  },

  /**
   * Drop-in replacement for sarvam.runConversation at the exact same call
   * site (voice-runtime.server.ts's `RuntimeDeps.generateReply`) — same
   * `(messages) => Promise<{ reply, usage }>` shape, `usage` field names
   * translated from Anthropic's `input_tokens`/`output_tokens` (Sarvam's
   * own `runConversation` already uses that naming, so no translation is
   * actually needed there — both providers happen to use the same field
   * names for token counts).
   */
  async runConversation(
    messages: ChatMessage[],
    options?: { tools?: ClaudeTool[] },
  ): Promise<{ reply: string; usage: { input_tokens: number; output_tokens: number } }> {
    const { system, messages: turns } = toAnthropicRequest(messages);
    const data = await call({
      model: model(),
      system,
      messages: turns,
      max_tokens: 400,
      temperature: 0.3,
      top_p: 0.9,
      ...(options?.tools ? { tools: options.tools } : {}),
    });
    const reply = data.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();
    return {
      reply,
      usage: {
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
      },
    };
  },

  /**
   * Single-tool-call-round conversation turn (Phase 4 AI tool-calling
   * architecture). Deliberately a SEPARATE function from runConversation
   * rather than a mode flag on it — runConversation's behavior (including
   * its documented tool_use-resolves-to-empty-reply case, when called
   * without an executor) stays byte-for-byte unchanged for every existing
   * caller, so an agent with no tools/capabilities configured is
   * completely unaffected by this addition.
   *
   * Exactly one round trip for tool execution: if the first call's
   * stop_reason is "tool_use", every tool_use block in that single
   * response is executed via `executeTool`, their results are appended as
   * `tool_result` blocks, and ONE follow-up call is made — with `tools`
   * omitted, so Claude cannot request a second round no matter what it
   * decides — to get the final natural-language reply. If the first call
   * doesn't request a tool at all, this behaves exactly like
   * runConversation (one call, text reply, empty toolCalls).
   */
  async runConversationWithTools(
    messages: ChatMessage[],
    tools: ClaudeTool[],
    executeTool: (
      name: string,
      input: Record<string, unknown>,
    ) => Promise<{ content: string; isError?: boolean }>,
  ): Promise<{
    reply: string;
    toolCalls: { name: string; input: Record<string, unknown>; isError: boolean }[];
    usage: { input_tokens: number; output_tokens: number };
  }> {
    const { system, messages: turns } = toAnthropicRequest(messages);
    const usage = { input_tokens: 0, output_tokens: 0 };

    const first = await call({
      model: model(),
      system,
      messages: turns,
      max_tokens: 400,
      temperature: 0.3,
      top_p: 0.9,
      tools,
    });
    usage.input_tokens += first.usage?.input_tokens ?? 0;
    usage.output_tokens += first.usage?.output_tokens ?? 0;

    const toolUseBlocks = first.content.filter(
      (block): block is AnthropicContentBlock & { id: string; name: string } =>
        block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string",
    );

    if (first.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
      const reply = first.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("")
        .trim();
      return { reply, toolCalls: [], usage };
    }

    const toolCalls: { name: string; input: Record<string, unknown>; isError: boolean }[] = [];
    const toolResultBlocks: AnthropicContentBlock[] = [];
    for (const block of toolUseBlocks) {
      const input = block.input ?? {};
      let result: { content: string; isError?: boolean };
      try {
        result = await executeTool(block.name, input);
      } catch (err) {
        result = {
          content: JSON.stringify({
            success: false,
            error: { code: "TOOL_EXECUTION_FAILED", message: (err as Error).message },
          }),
          isError: true,
        };
      }
      toolCalls.push({ name: block.name, input, isError: Boolean(result.isError) });
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      });
    }

    const followUp = await call({
      model: model(),
      system,
      messages: [
        ...turns,
        { role: "assistant", content: first.content },
        { role: "user", content: toolResultBlocks },
      ],
      max_tokens: 400,
      temperature: 0.3,
      top_p: 0.9,
      // No `tools` here — this is the single round-trip boundary: Claude
      // cannot request a second tool call because none are offered.
    });
    usage.input_tokens += followUp.usage?.input_tokens ?? 0;
    usage.output_tokens += followUp.usage?.output_tokens ?? 0;

    const reply = followUp.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();

    return { reply, toolCalls, usage };
  },
};
