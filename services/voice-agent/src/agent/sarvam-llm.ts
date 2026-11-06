/**
 * Sarvam chat completions as a LiveKit `llm.LLM` (Phase 2.18).
 *
 * The @livekit/agents-plugin-sarvam 1.9.5 package has STT and TTS only, so
 * the LLM uses LiveKit's OpenAI plugin pointed at Sarvam's
 * OpenAI-compatible endpoint (`POST {base}/chat/completions`, documented at
 * docs.sarvam.ai). The plugin's stream parser (inference.LLMStream in
 * @livekit/agents 1.9.5) makes assumptions an OpenAI-compatible provider
 * does not always meet, so the HTTP layer is wrapped by `normalizeSarvamSse`,
 * which rewrites the SSE stream into the exact shape that parser handles.
 * Each item below was reproduced against the unwrapped plugin (Phase 2.18
 * control run) and is covered by tests/sarvam-llm.spec.ts:
 *
 *  - a tool call without an `id` is silently dropped (the parser only emits
 *    a pending call when it has an id): ids are synthesised per call index;
 *  - several tool calls in one delta: only the first is emitted: the delta
 *    is split into one chunk per call;
 *  - a `finish_reason` on the chunk that starts a new call is skipped, so the
 *    last call is lost: the finish reason is moved to its own empty chunk;
 *  - a repeated `name` on a continuation fragment resets the accumulated
 *    arguments: continuation fragments carry arguments only;
 *  - object-valued `arguments` are serialised to the JSON string the parser
 *    expects;
 *  - a chunk without `choices` throws ("chunk.choices is not iterable"):
 *    `choices` defaults to [];
 *  - a stream that ends with tool calls but no finish_reason never emits
 *    them: a `[DONE]` after tool calls gets a synthetic finish_reason;
 *  - a stream that closes without `[DONE]` or a finish_reason (a cut
 *    connection), or that finishes with nothing to say, becomes a provider
 *    error. LiveKit retries it only while nothing has reached the caller
 *    (inference.LLMStream sets retryable=false at the first content or tool
 *    call), so a retry can never execute a tool twice.
 *
 * Whether Sarvam actually sends any of these shapes is unverified (no live
 * call has been made); the normaliser is a no-op for well-formed OpenAI
 * streams.
 *
 * A call truncated by `finish_reason: "length"` is left as is: the parser
 * does not emit it, so a tool call with cut-off arguments is never run.
 *
 * Booking safety does not depend on any of this. The three tools take no
 * arguments from the model (receptionist.ts: `z.object({})`); they act on the
 * deterministic call state and go through klyro, which owns authorization,
 * availability, idempotency and duplicate prevention. The model cannot write
 * to the database. Unknown tools and invalid arguments are rejected by
 * LiveKit's tool executor before anything runs.
 *
 * No Anthropic fallback: when LLM_PROVIDER=sarvam this is the only LLM.
 */
import * as openai from "@livekit/agents-plugin-openai";
import OpenAI from "openai";

/** Documented V1 chat models (docs.sarvam.ai, sarvam-105b model page). */
export const SARVAM_LLM_MODELS = ["sarvam-105b-conversations", "sarvam-105b"] as const;
export type SarvamLlmModel = (typeof SARVAM_LLM_MODELS)[number];
export const SARVAM_LLM_DEFAULT_BASE_URL = "https://api.sarvam.ai/v1";
export const SARVAM_LLM_DEFAULT_MODEL: SarvamLlmModel = "sarvam-105b-conversations";

export interface SarvamLlmOptions {
  apiKey: string;
  model?: string;
  baseURL?: string;
  /** Sent as `reasoning_effort` only when set (Sarvam reasons by default; unverified). */
  reasoningEffort?: "low" | "medium" | "high";
  temperature?: number;
  /** Client-level timeout; LiveKit's per-request connOptions.timeoutMs takes precedence. */
  timeoutMs?: number;
  /** Test seam: the HTTP layer (defaults to global fetch). */
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;
type ToolFrag = {
  index?: unknown;
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

const enc = new TextEncoder();
const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

/**
 * Rewrites one Sarvam chat-completions SSE body (see module comment).
 * `callIdPrefix` must be unique per request so synthetic ids never collide
 * within a conversation.
 */
export function normalizeSarvamSse(callIdPrefix: string): TransformStream<Uint8Array, Uint8Array> {
  const dec = new TextDecoder();
  let buf = "";
  // Per stream: call index -> id. Calls are keyed by `index` when sent, else by id, else by position.
  const calls = new Map<number, string>();
  const byId = new Map<string, number>();
  let lastIndex: number | null = null;
  let finished = false;
  let done = false;
  let spoke = false;

  const normFrag = (f: ToolFrag): Json | null => {
    const fn = f.function ?? {};
    const name = typeof fn.name === "string" && fn.name ? fn.name : undefined;
    const rawArgs = fn.arguments;
    const args =
      typeof rawArgs === "string"
        ? rawArgs
        : rawArgs !== undefined && rawArgs !== null
          ? JSON.stringify(rawArgs)
          : "";
    const id = typeof f.id === "string" && f.id ? f.id : undefined;
    let index: number | undefined =
      typeof f.index === "number" && Number.isInteger(f.index) && f.index >= 0
        ? f.index
        : id !== undefined
          ? byId.get(id)
          : undefined;
    if (index === undefined) {
      if (name !== undefined)
        index = calls.size; // a new call
      else if (lastIndex !== null)
        index = lastIndex; // a continuation
      else return null; // arguments with no call to attach to: malformed, dropped
    }
    // A start with a name for an index we already know but a different id is a new call.
    if (calls.has(index) && name !== undefined && id !== undefined && calls.get(index) !== id) {
      index = calls.size;
    }
    lastIndex = index;
    if (!calls.has(index)) {
      if (name === undefined) return null; // a call must start with its name
      const callId = id ?? `${callIdPrefix}_${index}`;
      calls.set(index, callId);
      if (id !== undefined) byId.set(id, index);
      return { index, id: callId, type: "function", function: { name, arguments: args } };
    }
    return args ? { index, function: { arguments: args } } : null;
  };

  const rewrite = (obj: Json): Json[] => {
    if (!Array.isArray(obj.choices)) obj.choices = [];
    const choices = obj.choices as Json[];
    const out: Json[] = [];
    const base = { ...obj };
    delete base.choices;
    const withChoice = (choice: Json): Json => ({ ...base, usage: undefined, choices: [choice] });
    let usageOut = obj.usage !== undefined && obj.usage !== null;
    const passthrough: Json[] = [];
    for (const raw of choices) {
      const choice: Json = { ...raw };
      const delta: Json =
        choice.delta && typeof choice.delta === "object" ? { ...(choice.delta as Json) } : {};
      const finish = choice.finish_reason ?? null;
      if (finish !== null) finished = true;
      if (typeof delta.content === "string" && delta.content.trim()) spoke = true;
      const frags = Array.isArray(delta.tool_calls) ? (delta.tool_calls as ToolFrag[]) : null;
      if (!frags) {
        passthrough.push({ ...choice, delta });
        continue;
      }
      delete delta.tool_calls;
      if (typeof delta.content === "string" && delta.content) {
        out.push(withChoice({ index: choice.index ?? 0, delta, finish_reason: null }));
      }
      for (const f of frags) {
        const n = normFrag(f ?? {});
        if (n) {
          spoke = true;
          out.push(
            withChoice({
              index: choice.index ?? 0,
              delta: { role: "assistant", tool_calls: [n] },
              finish_reason: null,
            }),
          );
        }
      }
      if (finish !== null) {
        out.push(withChoice({ index: choice.index ?? 0, delta: {}, finish_reason: finish }));
      }
    }
    if (passthrough.length || (out.length === 0 && choices.length === 0)) {
      out.unshift({ ...obj, choices: passthrough });
      usageOut = false;
    }
    if (usageOut) out.push({ ...base, choices: [] }); // keep usage in its own final chunk
    return out;
  };

  const synthesizedEnd = (): Uint8Array[] => {
    if (!finished && calls.size > 0) {
      finished = true;
      return [
        sse({
          id: `${callIdPrefix}_end`,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }),
      ];
    }
    return [];
  };

  const handleLine = (line: string, ctl: TransformStreamDefaultController<Uint8Array>) => {
    if (!line.startsWith("data:")) {
      if (line.trim()) ctl.enqueue(enc.encode(`${line}\n`)); // event:, id:, retry:, comments
      return;
    }
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      for (const b of synthesizedEnd()) ctl.enqueue(b);
      if (!spoke) {
        ctl.enqueue(
          sse({ error: { message: "sarvam returned an empty response", code: "empty_response" } }),
        );
      }
      done = true;
      ctl.enqueue(enc.encode("data: [DONE]\n\n"));
      return;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(payload);
    } catch {
      ctl.enqueue(enc.encode(`${line}\n\n`)); // the OpenAI SDK reports it as a provider error
      return;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      ctl.enqueue(enc.encode(`${line}\n\n`));
      return;
    }
    if ((obj as Json).error) {
      ctl.enqueue(enc.encode(`data: ${payload}\n\n`));
      return;
    }
    for (const c of rewrite(obj as Json)) ctl.enqueue(sse(c));
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + (buf[i] === "\r" ? 2 : 1));
        handleLine(line, ctl);
      }
    },
    flush(ctl) {
      buf += dec.decode();
      if (buf) handleLine(buf, ctl);
      buf = "";
      if (!done) {
        if (finished) {
          // A finish_reason without [DONE]: complete as far as the content goes.
          if (!spoke)
            ctl.enqueue(
              sse({
                error: { message: "sarvam returned an empty response", code: "empty_response" },
              }),
            );
          return;
        }
        ctl.enqueue(
          sse({
            error: {
              message: "sarvam stream ended without a finish_reason or [DONE]",
              code: "stream_interrupted",
            },
          }),
        );
      }
    },
  });
}

let requestSeq = 0;

/** fetch wrapper: normalises streamed chat-completion bodies; everything else is passed through. */
export function sarvamFetch(base: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await base(input, init);
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !res.body || !type.includes("text/event-stream")) return res;
    requestSeq = (requestSeq + 1) % 1_000_000_000;
    const prefix = `sarvam_${Date.now().toString(36)}_${requestSeq}`;
    return new Response(res.body.pipeThrough(normalizeSarvamSse(prefix)), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }) as typeof fetch;
}

export function createSarvamClient(o: SarvamLlmOptions): OpenAI {
  return new OpenAI({
    apiKey: o.apiKey, // sent as Authorization: Bearer (documented as accepted)
    baseURL: o.baseURL ?? SARVAM_LLM_DEFAULT_BASE_URL,
    defaultHeaders: { "api-subscription-key": o.apiKey }, // Sarvam's documented header
    // Retries belong to LiveKit's LLMStream, which knows whether anything
    // reached the caller; SDK-level retries would multiply them.
    maxRetries: 0,
    // Pinned so OPENAI_LOG=debug|info cannot enable the SDK's request logs:
    // they print request headers and redact `authorization` but not
    // `api-subscription-key`, which would leak the Sarvam key (Phase 2.19).
    logLevel: "warn",
    timeout: o.timeoutMs ?? 10_000,
    fetch: sarvamFetch(o.fetch ?? fetch),
  });
}

export function createSarvamLlm(o: SarvamLlmOptions): openai.LLM {
  return new openai.LLM({
    client: createSarvamClient(o),
    model: o.model ?? SARVAM_LLM_DEFAULT_MODEL,
    temperature: o.temperature ?? 0.2,
    // One tool call at a time (check before book). Documented as possibly not
    // enforced by Sarvam; the normaliser handles several calls either way.
    parallelToolCalls: false,
    ...(o.reasoningEffort ? { reasoningEffort: o.reasoningEffort } : {}),
  });
}
