/**
 * Sarvam LLM adapter (src/agent/sarvam-llm.ts), driven through the real
 * LiveKit 1.9.5 stack: the OpenAI plugin's LLM, inference.LLMStream's parser,
 * the base LLMStream retry loop, and (last section) a full AgentSession with
 * the receptionist's tools. Only the HTTP layer is fake: a scripted stand-in
 * for `POST https://api.sarvam.ai/v1/chat/completions` that speaks the
 * documented OpenAI-style SSE format, including shapes an OpenAI-compatible
 * provider may send (missing tool-call ids, several calls in one delta,
 * usage-only final chunks, <think> text, object arguments).
 *
 * These prove the adapter's behaviour for those shapes. They do NOT prove
 * that Sarvam sends them, or how well sarvam-105b follows the receptionist's
 * instructions: that needs the approved live benchmark (bench/sarvam-llm.ts).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- provider payloads and LiveKit event objects are untyped JSON here */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { initializeLogger, llm, voice } from "@livekit/agents";
import { z } from "zod";
import OpenAI from "openai";
import {
  createSarvamClient,
  createSarvamLlm,
  normalizeSarvamSse,
} from "../src/agent/sarvam-llm.ts";
import { ReceptionistAgent } from "../src/agent/receptionist.ts";
import { InMemoryBookingBackend } from "../src/backend/in-memory.ts";
import { newConversation, type BusinessContext } from "../src/conversation/state.ts";
import type { ServiceRow } from "../src/conversation/understanding.ts";
import { buildLlm } from "../src/worker.ts";
import { loadConfig } from "../src/runtime/config.ts";

initializeLogger({ pretty: false, level: "fatal" });

/* ------------------------------------------------------------------ fake Sarvam */

type Req = { url: string; headers: Headers; body: Record<string, any>; signal?: AbortSignal };
type Reply =
  | { sse: Array<object | string>; done?: boolean; delayMs?: number }
  | { status: number; body: object }
  | { hang: true }
  | { throws: Error };

const chunk = (delta: object, finish: string | null = null, extra: object = {}) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  model: "sarvam-105b-conversations",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});
const usage = (p = 120, c = 9) => ({
  id: "chatcmpl-1",
  choices: [],
  usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c },
});
const text = (s: string) => ({
  sse: [chunk({ role: "assistant", content: s }), chunk({}, "stop"), usage()],
});

function fakeSarvam(reply: (req: Req, n: number) => Reply) {
  const requests: Req[] = [];
  const f = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url;
    const req: Req = {
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
      signal: init?.signal,
    };
    requests.push(req);
    const r = reply(req, requests.length);
    if ("throws" in r) throw r.throws;
    if ("hang" in r) {
      return await new Promise<Response>((_, rej) => {
        init?.signal?.addEventListener("abort", () =>
          rej(init.signal.reason ?? new Error("aborted")),
        );
      });
    }
    if ("status" in r) {
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(ctl) {
        for (const c of r.sse) {
          if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
          ctl.enqueue(enc.encode(typeof c === "string" ? c : `data: ${JSON.stringify(c)}\n\n`));
        }
        if (r.done !== false) ctl.enqueue(enc.encode("data: [DONE]\n\n"));
        ctl.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetch: f, requests };
}

const FAST = { maxRetry: 2, retryIntervalMs: 0, timeoutMs: 2000 };

const toolCtx = {
  check_availability: llm.tool({
    description: "free times",
    parameters: z.object({}),
    execute: async () => "x",
  }),
  book_appointment: llm.tool({
    description: "book",
    parameters: z.object({}),
    execute: async () => "x",
  }),
  get_service_price: llm.tool({
    description: "price",
    parameters: z.object({}),
    execute: async () => "x",
  }),
};

async function run(
  reply: (req: Req, n: number) => Reply,
  opts: { tools?: boolean; conn?: object } = {},
) {
  const fake = fakeSarvam(reply);
  const model = createSarvamLlm({ apiKey: "sk_test_not_a_real_key", fetch: fake.fetch });
  const errors: Array<{
    name: string;
    recoverable: boolean;
    status?: number;
    retryable?: boolean;
  }> = [];
  model.on("error", (e: any) =>
    errors.push({
      name: e.error?.constructor?.name,
      recoverable: e.recoverable,
      status: e.error?.statusCode,
      retryable: e.error?.retryable,
    }),
  );
  const metrics: any[] = [];
  model.on("metrics_collected", (m: any) => metrics.push(m));
  const ctx = llm.ChatContext.empty();
  ctx.addMessage({ role: "system", content: "You are a receptionist." });
  ctx.addMessage({ role: "user", content: "नमस्ते, मुझे appointment चाहिए" });
  const stream = model.chat({
    chatCtx: ctx,
    ...(opts.tools === false ? {} : { toolCtx }),
    connOptions: { ...FAST, ...(opts.conn ?? {}) },
  });
  const chunks: llm.ChatChunk[] = [];
  for await (const c of stream) chunks.push(c);
  const content = chunks.map((c) => c.delta?.content ?? "").join("");
  const calls = chunks.flatMap((c) => c.delta?.toolCalls ?? []);
  const usages = chunks.filter((c) => c.usage).map((c) => c.usage!);
  return { ...fake, errors, chunks, content, calls, usages, metrics };
}

/* ------------------------------------------------------------------ request shape */

describe("Sarvam adapter: request", () => {
  test("documented endpoint, both auth headers, model, streaming with usage, tools in OpenAI format", async () => {
    const r = await run(() => text("Sure."));
    assert.equal(r.requests.length, 1);
    const q = r.requests[0]!;
    assert.equal(q.url, "https://api.sarvam.ai/v1/chat/completions");
    assert.equal(q.headers.get("api-subscription-key"), "sk_test_not_a_real_key");
    assert.equal(q.headers.get("authorization"), "Bearer sk_test_not_a_real_key");
    assert.equal(q.body.model, "sarvam-105b-conversations");
    assert.equal(q.body.stream, true);
    assert.deepEqual(q.body.stream_options, { include_usage: true });
    assert.equal(q.body.temperature, 0.2);
    assert.equal(q.body.parallel_tool_calls, false);
    assert.equal(q.body.reasoning_effort, undefined, "not sent unless configured");
    assert.equal(q.body.tool_choice, undefined, "server default (auto)");
    assert.deepEqual(
      q.body.tools.map((t: any) => [t.type, t.function.name]),
      [
        ["function", "book_appointment"],
        ["function", "check_availability"],
        ["function", "get_service_price"],
      ],
    );
    for (const t of q.body.tools) assert.equal(t.function.parameters.type, "object");
    assert.deepEqual(
      q.body.messages.map((m: any) => m.role),
      ["system", "user"],
    );
  });

  test("no tools -> no tools, tool_choice or parallel_tool_calls in the body", async () => {
    const r = await run(() => text("ok"), { tools: false });
    const b = r.requests[0]!.body;
    assert.equal(b.tools, undefined);
    assert.equal(b.tool_choice, undefined);
    assert.equal(b.parallel_tool_calls, undefined);
  });

  test("reasoning_effort is sent only when configured", async () => {
    const fake = fakeSarvam(() => text("ok"));
    const m = createSarvamLlm({ apiKey: "k", fetch: fake.fetch, reasoningEffort: "low" });
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: "user", content: "hi" });
    for await (const _ of m.chat({ chatCtx: ctx, connOptions: FAST })) void _;
    assert.equal(fake.requests[0]!.body.reasoning_effort, "low");
  });
});

/* ------------------------------------------------------------------ text, usage, telemetry */

describe("Sarvam adapter: text, usage and telemetry", () => {
  test("streamed Telugu/Hindi/English text arrives in order; usage from the choices:[] final chunk", async () => {
    const parts = ["సరే, ", "मैं check ", "करती हूँ."];
    const r = await run(() => ({
      sse: [...parts.map((p) => chunk({ content: p })), chunk({}, "stop"), usage(321, 12)],
    }));
    assert.equal(r.content, parts.join(""));
    assert.deepEqual(r.calls, []);
    assert.equal(r.usages.length, 1);
    assert.equal(r.usages[0]!.promptTokens, 321);
    assert.equal(r.usages[0]!.completionTokens, 12);
    assert.equal(r.usages[0]!.totalTokens, 333);
    assert.deepEqual(r.errors, []);
    const m = r.metrics.find((x) => x.type === "llm_metrics");
    assert.ok(m, "LiveKit emits llm_metrics");
    assert.ok(m.ttftMs >= 0 && m.durationMs >= m.ttftMs);
    assert.equal(m.promptTokens, 321);
    assert.equal(m.completionTokens, 12);
  });

  test("usage on the same chunk as finish_reason is still reported once", async () => {
    const r = await run(() => ({
      sse: [
        chunk({ content: "Hi" }),
        chunk({}, "stop", { usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }),
      ],
    }));
    assert.equal(r.content, "Hi");
    assert.equal(r.usages.length, 1);
    assert.equal(r.usages[0]!.totalTokens, 6);
  });

  test("<think> reasoning in content is never spoken; reasoning_content deltas are ignored", async () => {
    const r = await run(() => ({
      sse: [
        chunk({ reasoning_content: "The caller wants a cleaning..." }),
        chunk({ content: "<think>internal plan</think>" }),
        chunk({ content: "Which service would you like?" }),
        chunk({}, "stop"),
      ],
    }));
    assert.equal(r.content.trim(), "Which service would you like?");
  });

  test("a chunk without choices or without delta does not crash the parser", async () => {
    const r = await run(() => ({
      sse: [
        { id: "x", object: "chat.completion.chunk" },
        { id: "x", choices: [{ index: 0, finish_reason: null }] },
        chunk({ content: "Hello" }),
        chunk({}, "stop"),
      ],
    }));
    assert.equal(r.content, "Hello");
    assert.deepEqual(r.errors, []);
  });

  test("CRLF line endings and SSE comments are handled", async () => {
    const r = await run(() => ({
      sse: [
        ": keep-alive\r\n\r\n",
        `data: ${JSON.stringify(chunk({ content: "Namaste" }))}\r\n\r\n`,
        `data: ${JSON.stringify(chunk({}, "stop"))}\r\n\r\n`,
      ],
    }));
    assert.equal(r.content, "Namaste");
    assert.deepEqual(r.errors, []);
  });
});

/* ------------------------------------------------------------------ tool calls */

const call = (
  index: number | undefined,
  id: string | undefined,
  name?: string,
  args?: unknown,
) => ({
  ...(index === undefined ? {} : { index }),
  ...(id === undefined ? {} : { id }),
  type: "function",
  function: { ...(name ? { name } : {}), ...(args === undefined ? {} : { arguments: args }) },
});

describe("Sarvam adapter: tool calls", () => {
  test("single call, streamed arguments, provider id kept", async () => {
    const r = await run(() => ({
      sse: [
        chunk({ role: "assistant", tool_calls: [call(0, "call_abc", "check_availability", "")] }),
        chunk({ tool_calls: [call(0, undefined, undefined, "{")] }),
        chunk({ tool_calls: [call(0, undefined, undefined, "}")] }),
        chunk({}, "tool_calls"),
        usage(),
      ],
    }));
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]!.callId, "call_abc");
    assert.equal(r.calls[0]!.name, "check_availability");
    assert.equal(r.calls[0]!.args, "{}");
  });

  test("missing tool-call id -> a synthetic, non-empty, unique id", async () => {
    const r = await run(() => ({
      sse: [
        chunk({ tool_calls: [call(0, undefined, "check_availability", "{}")] }),
        chunk({}, "tool_calls"),
      ],
    }));
    assert.equal(r.calls.length, 1);
    assert.match(r.calls[0]!.callId, /^sarvam_[a-z0-9]+_\d+_0$/);
    const again = await run(() => ({
      sse: [
        chunk({ tool_calls: [call(0, undefined, "check_availability", "{}")] }),
        chunk({}, "tool_calls"),
      ],
    }));
    assert.notEqual(again.calls[0]!.callId, r.calls[0]!.callId, "ids differ across requests");
  });

  test("three calls in one delta: none dropped (the raw LiveKit parser keeps only two)", async () => {
    const delta = {
      tool_calls: [
        call(0, "c1", "get_service_price", "{}"),
        call(1, "c2", "check_availability", "{}"),
        call(2, "c3", "book_appointment", "{}"),
      ],
    };
    const r = await run(() => ({ sse: [chunk(delta, "tool_calls")] }));
    assert.deepEqual(
      r.calls.map((c) => [c.callId, c.name]),
      [
        ["c1", "get_service_price"],
        ["c2", "check_availability"],
        ["c3", "book_appointment"],
      ],
    );
  });

  test("two streamed calls without ids or indexes are kept apart", async () => {
    const r = await run(() => ({
      sse: [
        chunk({ tool_calls: [call(undefined, undefined, "get_service_price", "{")] }),
        chunk({ tool_calls: [call(undefined, undefined, undefined, "}")] }),
        chunk({ tool_calls: [call(undefined, undefined, "check_availability", "{}")] }),
        chunk({}, "tool_calls"),
      ],
    }));
    assert.deepEqual(
      r.calls.map((c) => [c.name, c.args]),
      [
        ["get_service_price", "{}"],
        ["check_availability", "{}"],
      ],
    );
    assert.notEqual(r.calls[0]!.callId, r.calls[1]!.callId);
    assert.ok(r.calls.every((c) => c.callId));
  });

  test("finish_reason on the chunk that starts the last call does not lose it", async () => {
    const r = await run(() => ({
      sse: [
        chunk({ tool_calls: [call(0, "a", "get_service_price", "{}")] }),
        chunk({ tool_calls: [call(1, "b", "check_availability", "{}")] }, "tool_calls"),
      ],
    }));
    assert.deepEqual(
      r.calls.map((c) => c.callId),
      ["a", "b"],
    );
  });

  test("a name repeated on every fragment does not reset the arguments", async () => {
    const r = await run(() => ({
      sse: [
        chunk({ tool_calls: [call(0, "a", "check_availability", '{"x"')] }),
        chunk({ tool_calls: [call(0, "a", "check_availability", ":1}")] }),
        chunk({}, "tool_calls"),
      ],
    }));
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]!.args, '{"x":1}');
  });

  test("object-valued arguments are serialised to a JSON string", async () => {
    const r = await run(() => ({
      sse: [chunk({ tool_calls: [call(0, "a", "check_availability", {})] }, "tool_calls")],
    }));
    assert.equal(r.calls[0]!.args, "{}");
  });

  test("[DONE] after a call with no finish_reason still emits the call", async () => {
    const r = await run(() => ({
      sse: [chunk({ tool_calls: [call(0, "a", "book_appointment", "{}")] })],
    }));
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]!.name, "book_appointment");
  });

  test("finish_reason 'length' with a cut-off call: the call is NOT emitted (never executed)", async () => {
    const r = await run(() => ({
      sse: [
        chunk({ tool_calls: [call(0, "a", "book_appointment", '{"x":')] }),
        chunk({}, "length"),
      ],
    }));
    assert.deepEqual(r.calls, []);
  });

  test("text then a call in the same reply: both arrive", async () => {
    const r = await run(() => ({
      sse: [
        chunk({
          content: "Let me check. ",
          tool_calls: [call(0, "a", "check_availability", "{}")],
        }),
        chunk({}, "tool_calls"),
      ],
    }));
    assert.equal(r.content, "Let me check. ");
    assert.equal(r.calls.length, 1);
  });

  test("argument fragments with no call to attach to are dropped, not crashed on", async () => {
    const r = await run(() => ({
      sse: [
        chunk({ tool_calls: [call(undefined, undefined, undefined, "{}")] }),
        chunk({ content: "Hi" }),
        chunk({}, "stop"),
      ],
    }));
    assert.deepEqual(r.calls, []);
    assert.equal(r.content, "Hi");
  });
});

/* ------------------------------------------------------------------ errors and retries */

describe("Sarvam adapter: errors, retries, timeouts, cancellation", () => {
  test("429 and 503 are retried (LiveKit's loop, no SDK-level retries); the call then succeeds", async () => {
    const r = await run((_, n) =>
      n === 1
        ? {
            status: 429,
            body: { error: { message: "rate limited", code: "rate_limit_exceeded_error" } },
          }
        : n === 2
          ? { status: 503, body: { error: { message: "overloaded" } } }
          : text("ok"),
    );
    assert.equal(r.requests.length, 3, "exactly one request per LiveKit attempt");
    assert.equal(r.content, "ok");
    assert.deepEqual(
      r.errors.map((e) => [e.status, e.recoverable]),
      [
        [429, true],
        [503, true],
      ],
    );
  });

  test("auth failure (403) and validation errors (400, 422) are not retried", async () => {
    for (const status of [400, 403, 422]) {
      const r = await run(() => ({ status, body: { error: { message: "no" } } }));
      assert.equal(r.requests.length, 1, `status ${status}`);
      assert.equal(r.content, "");
      assert.deepEqual(r.calls, []);
      assert.equal(r.errors.length, 1);
      assert.equal(r.errors[0]!.status, status);
      assert.equal(r.errors[0]!.recoverable, false);
    }
  });

  test("the API key never appears in error messages", async () => {
    const fake = fakeSarvam(() => ({
      status: 403,
      body: { error: { message: "invalid api key" } },
    }));
    const m = createSarvamLlm({ apiKey: "sk_secret_value_123", fetch: fake.fetch });
    const msgs: string[] = [];
    m.on("error", (e: any) => msgs.push(String(e.error), JSON.stringify(e.error?.body ?? null)));
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: "user", content: "hi" });
    for await (const _ of m.chat({ chatCtx: ctx, connOptions: FAST })) void _;
    assert.ok(msgs.length > 0);
    for (const s of msgs) assert.ok(!s.includes("sk_secret_value_123"), s);
  });

  test("retries exhausted -> one non-recoverable error, nothing emitted", async () => {
    const r = await run(() => ({ status: 503, body: { error: { message: "overloaded" } } }));
    assert.equal(r.requests.length, FAST.maxRetry + 1);
    assert.equal(r.errors.at(-1)!.recoverable, false);
    assert.equal(r.content, "");
  });

  test("malformed JSON before anything was said -> retried", async () => {
    const r = await run((_, n) => (n === 1 ? { sse: ["data: {not json\n\n"] } : text("ok")));
    assert.equal(r.requests.length, 2);
    assert.equal(r.content, "ok");
  });

  test("empty response (finish 'stop', nothing said) -> retried, not a silent turn", async () => {
    const r = await run((_, n) =>
      n === 1 ? { sse: [chunk({}, "stop"), usage(100, 0)] } : text("Hello"),
    );
    assert.equal(r.requests.length, 2);
    assert.equal(r.content, "Hello");
  });

  test("an error object inside the stream -> provider error, retried if nothing said", async () => {
    const r = await run((_, n) =>
      n === 1
        ? { sse: [{ error: { message: "internal", code: "internal_server_error" } }] }
        : text("ok"),
    );
    assert.equal(r.requests.length, 2);
    assert.equal(r.content, "ok");
  });

  test("stream cut before anything was said -> retried", async () => {
    const r = await run((_, n) => (n === 1 ? { sse: [], done: false } : text("ok")));
    assert.equal(r.requests.length, 2);
    assert.equal(r.content, "ok");
  });

  test("stream cut after a tool call started (no finish, no [DONE]) -> call NOT emitted; retried", async () => {
    let n = 0;
    const r = await run((_, k) => {
      n = k;
      return k === 1
        ? { sse: [chunk({ tool_calls: [call(0, "a", "book_appointment", "{}")] })], done: false }
        : text("Shall I book it?");
    });
    assert.equal(n, 2);
    assert.deepEqual(r.calls, [], "a half-received call is never executed");
    assert.equal(r.content, "Shall I book it?");
  });

  test("stream cut after text was spoken -> NOT retried (no repeated speech)", async () => {
    const r = await run(() => ({ sse: [chunk({ content: "I'll check" })], done: false }));
    assert.equal(r.requests.length, 1);
    assert.equal(r.content, "I'll check");
    assert.equal(r.errors.at(-1)!.recoverable, false);
  });

  test("a completed tool call is never re-requested even if the stream then fails", async () => {
    const r = await run(() => ({
      sse: [
        chunk({ tool_calls: [call(0, "a", "book_appointment", "{}")] }, "tool_calls"),
        "data: {broken\n\n",
      ],
    }));
    assert.equal(r.requests.length, 1, "no retry after a tool call reached LiveKit");
    assert.equal(r.calls.length, 1);
  });

  test("timeout before the response -> APITimeoutError, retried", async () => {
    const r = await run((_, n) => (n === 1 ? { hang: true } : text("ok")), {
      conn: { timeoutMs: 100 },
    });
    assert.equal(r.requests.length, 2);
    assert.equal(r.errors[0]!.name, "APITimeoutError");
    assert.equal(r.content, "ok");
  });

  test("network failure -> retryable provider error, retried", async () => {
    const r = await run((_, n) =>
      n === 1 ? { throws: new TypeError("fetch failed") } : text("ok"),
    );
    assert.equal(r.requests.length, 2);
    // The OpenAI SDK wraps network errors in its APIError hierarchy, which
    // LiveKit maps to a retryable APIStatusError without an HTTP status.
    assert.equal(r.errors[0]!.recoverable, true);
    assert.equal(r.errors[0]!.status, -1);
    assert.equal(r.content, "ok");
  });

  test("cancellation (caller interrupts): closing the stream aborts the HTTP request", async () => {
    const fake = fakeSarvam(() => ({
      sse: Array.from({ length: 50 }, (_, i) => chunk({ content: `w${i} ` })),
      delayMs: 20,
    }));
    const m = createSarvamLlm({ apiKey: "k", fetch: fake.fetch });
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: "user", content: "hi" });
    const s = m.chat({ chatCtx: ctx, connOptions: FAST });
    let got = 0;
    for await (const _ of s) {
      if (++got === 2) {
        await s.close();
        break;
      }
    }
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]!.signal?.aborted, true);
  });
});

/* ------------------------------------------------------------------ secret hygiene */

describe("Sarvam adapter: the API key never reaches SDK logs (Phase 2.19)", () => {
  const CANARY = "sk_canary_7Qx2_must_not_log";
  const levels = ["debug", "info", "log", "warn", "error"] as const;

  async function captureConsole(fn: () => Promise<void>): Promise<string> {
    const saved = levels.map((l) => console[l]);
    const lines: string[] = [];
    for (const l of levels)
      console[l] = (...a: unknown[]) => {
        lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
      };
    try {
      await fn();
    } finally {
      levels.forEach((l, i) => (console[l] = saved[i]!));
    }
    return lines.join("\n");
  }

  async function exercise(client: OpenAI) {
    // One success and one failing request, so request, response and error logs all run.
    await client.chat.completions.create({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    await client.chat.completions
      .create({ model: "m", messages: [{ role: "user", content: "hi" }] })
      .catch(() => undefined);
  }

  const fakeFetch = (() => {
    let n = 0;
    return (async () =>
      ++n % 2
        ? new Response(JSON.stringify({ id: "x", choices: [] }), {
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({ error: { message: "nope" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          })) as typeof fetch;
  })();

  test("OPENAI_LOG=debug is ignored: logLevel pinned to warn, no key in any console output", async () => {
    const prev = process.env.OPENAI_LOG;
    process.env.OPENAI_LOG = "debug";
    try {
      const out = await captureConsole(async () => {
        const c = createSarvamClient({ apiKey: CANARY, fetch: fakeFetch });
        assert.equal(c.logLevel, "warn");
        await exercise(c);
      });
      assert.ok(!out.includes(CANARY), "the key appeared in SDK logs");
      assert.ok(!/sending request/.test(out), "debug request logs must be off");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_LOG;
      else process.env.OPENAI_LOG = prev;
    }
  });

  test("control: an unpinned client with the same headers DOES leak the key at debug", async () => {
    // Proves the test above can fail: the SDK redacts `authorization` but not
    // `api-subscription-key`.
    const prev = process.env.OPENAI_LOG;
    process.env.OPENAI_LOG = "debug";
    try {
      const out = await captureConsole(async () => {
        const c = new OpenAI({
          apiKey: CANARY,
          baseURL: "https://api.sarvam.ai/v1",
          defaultHeaders: { "api-subscription-key": CANARY },
          maxRetries: 0,
          fetch: fakeFetch,
        });
        await exercise(c);
      });
      assert.ok(out.includes(CANARY), "expected the unpinned SDK to log the header");
      assert.ok(!out.includes(`Bearer ${CANARY}`), "authorization itself is redacted by the SDK");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_LOG;
      else process.env.OPENAI_LOG = prev;
    }
  });
});

/* ------------------------------------------------------------------ normaliser unit */

describe("normalizeSarvamSse", () => {
  async function norm(input: string): Promise<string> {
    const src = new Response(input).body!;
    return await new Response(src.pipeThrough(normalizeSarvamSse("p"))).text();
  }
  test("passes OpenAI-shaped text streams through unchanged in substance", async () => {
    const out = await norm(
      `data: ${JSON.stringify(chunk({ content: "a" }))}\n\ndata: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`,
    );
    const events = out.split("\n\n").filter(Boolean);
    assert.equal(events.length, 3);
    assert.equal(JSON.parse(events[0]!.slice(6)).choices[0].delta.content, "a");
    assert.equal(events[2], "data: [DONE]");
  });
  test("a chunk split across network reads is reassembled", async () => {
    const line = `data: ${JSON.stringify(chunk({ content: "తెలుగు" }))}\n\n`;
    const bytes = new TextEncoder().encode(
      line + "data: " + JSON.stringify(chunk({}, "stop")) + "\n\ndata: [DONE]\n\n",
    );
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    const out = await new Response(src.pipeThrough(normalizeSarvamSse("p"))).text();
    assert.equal(JSON.parse(out.split("\n\n")[0]!.slice(6)).choices[0].delta.content, "తెలుగు");
  });
});

/* ------------------------------------------------------------------ provider selection */

describe("provider configuration", () => {
  const BASE = {
    LIVEKIT_URL: "ws://localhost:7880",
    LIVEKIT_API_KEY: "k",
    LIVEKIT_API_SECRET: "s".repeat(32),
    SARVAM_API_KEY: "sv",
    KLYRO_BASE_URL: "http://localhost:3000",
    VOICE_AGENT_HMAC_SECRET: "h".repeat(32),
  };
  test("LLM_PROVIDER=sarvam builds the Sarvam LLM only, even with ANTHROPIC_API_KEY present", () => {
    const c = loadConfig({ ...BASE, LLM_PROVIDER: "sarvam", ANTHROPIC_API_KEY: "ak" });
    const l = buildLlm(c);
    assert.ok(!(l instanceof llm.FallbackAdapter), "no fallback adapter");
    assert.equal(l.model, "sarvam-105b-conversations");
    assert.equal(l.label(), "openai.LLM");
  });
  test("LLM_PROVIDER=sarvam needs no Anthropic key", () => {
    const c = loadConfig({ ...BASE, LLM_PROVIDER: "sarvam" });
    assert.equal(c.LLM_PROVIDER, "sarvam");
  });
  test("LLM_PROVIDER=sarvam refuses a configured fallback", () => {
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          LLM_PROVIDER: "sarvam",
          FALLBACK_LLM_BASE_URL: "https://x.example/v1",
        }),
      /FALLBACK_LLM_BASE_URL must not be set/,
    );
  });
  test("SARVAM_LLM_BASE_URL is pinned outside development (the key is sent there)", () => {
    const staging = {
      ...BASE,
      APP_ENV: "staging",
      LIVEKIT_URL: "wss://x.livekit.cloud",
      KLYRO_BASE_URL: "https://klyro.example",
      LLM_PROVIDER: "sarvam",
    };
    assert.doesNotThrow(() => loadConfig(staging));
    assert.throws(
      () => loadConfig({ ...staging, SARVAM_LLM_BASE_URL: "https://evil.example/v1" }),
      /SARVAM_LLM_BASE_URL must be https:\/\/api\.sarvam\.ai\/v1/,
    );
  });
  test("unknown provider and unknown Sarvam model are rejected", () => {
    assert.throws(() => loadConfig({ ...BASE, LLM_PROVIDER: "openai" }), /LLM_PROVIDER/);
    assert.throws(
      () => loadConfig({ ...BASE, LLM_PROVIDER: "sarvam", SARVAM_LLM_MODEL: "sarvam-m" }),
      /SARVAM_LLM_MODEL/,
    );
  });
  test("default stays anthropic until acceptance (explicit opt-in to Sarvam)", () => {
    assert.equal(loadConfig({ ...BASE, ANTHROPIC_API_KEY: "ak" }).LLM_PROVIDER, "anthropic");
  });
});

/* ------------------------------------------------------------------ full booking lifecycle */

const SERVICES: ServiceRow[] = [
  {
    id: "svc-cleaning",
    name: "Cleaning",
    aliases: ["క్లీనింగ్", "क्लीनिंग"],
    durationMinutes: 30,
    priceInr: 800,
  },
];
const NOW = new Date("2026-11-02T04:30:00Z"); // 10:00 IST, Monday
const BUSINESS: BusinessContext = {
  businessName: "Smile Dental",
  timeZone: "Asia/Kolkata",
  services: SERVICES,
  now: () => NOW,
};
const HOURS = ["10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00"];

type Turn = { text?: string; tool?: string };
/** A scripted Sarvam that keys its reply on the last message, like LiveKit's FakeLLM, and checks continuation. */
function scriptedSarvam(script: Map<string, Turn>, opts: { omitIds?: boolean } = {}) {
  const issued: string[] = [];
  const problems: string[] = [];
  const answered = new Set<string>();
  let seq = 0;
  const fake = fakeSarvam((req) => {
    const msgs = req.body.messages as any[];
    // The receptionist's per-turn directive is a system message; LiveKit's
    // OpenAI format puts it after the tool result (tool messages stay right
    // after their assistant tool_calls). Key on the last non-system message.
    const at = msgs.findLastIndex((m: any) => m.role !== "system");
    const last = msgs[at];
    if (
      !msgs
        .slice(1)
        .some((m: any) => m.role === "system" && String(m.content).includes("NEXT STEP"))
    )
      problems.push("directive missing");
    const key =
      typeof last.content === "string"
        ? last.content
        : (last.content ?? []).map((p: any) => p.text ?? "").join("");
    if (last.role === "tool") {
      // Continuation: the tool result must answer the call we issued, and the
      // assistant turn before it must carry that call.
      const prev = msgs[at - 1];
      const ids = (prev?.tool_calls ?? []).map((t: any) => t.id);
      const id = last.tool_call_id;
      if (opts.omitIds && typeof id === "string" && id.startsWith("sarvam_") && !answered.has(id))
        issued.push(id);
      if (!id || !issued.includes(id) || !ids.includes(id) || answered.has(id))
        problems.push(`bad continuation: tool_call_id=${id} prev=${JSON.stringify(ids)}`);
      answered.add(id);
    }
    const t =
      script.get(key) ??
      [...script].find(([k]) => k.endsWith("*") && key.startsWith(k.slice(0, -1)))?.[1];
    if (!t) {
      problems.push(`unscripted input: ${key.slice(0, 80)}`);
      return text("Sorry?");
    }
    if (t.tool) {
      const id = `srv_${++seq}`;
      if (!opts.omitIds) issued.push(id);
      return {
        sse: [
          chunk({
            role: "assistant",
            content: t.text ?? null,
            tool_calls: [call(0, opts.omitIds ? undefined : id, t.tool, "{}")],
          }),
          chunk({}, "tool_calls"),
          usage(),
        ],
      };
    }
    return text(t.text!);
  });
  // With omitted ids the adapter synthesises them (sarvam_*); they are
  // recorded when they come back as tool_call_id, and must be unique.
  return { fake, issued, problems };
}

const sessions: voice.AgentSession[] = [];
after(async () => {
  for (const s of sessions) await s.close();
});

async function sarvamCall(script: Map<string, Turn>, opts: { omitIds?: boolean } = {}) {
  const backend = new InMemoryBookingBackend({
    timeZoneOffset: "+05:30",
    openHours: HOURS,
    callId: "call-1",
  });
  const state = newConversation({
    callId: "call-1",
    callerId: "+919876543210",
    primaryLanguage: "en-IN",
  });
  const tools: string[] = [];
  const guarded: string[] = [];
  const agent = new ReceptionistAgent({
    business: BUSINESS,
    backend,
    state,
    onGuard: (r) => guarded.push(...r.map((x) => x.rule)),
    onTool: (t) => tools.push(`${t.name}:${t.ok}`),
  });
  const s = scriptedSarvam(script, opts);
  // The adapter normalises the fake's raw SSE exactly as it would Sarvam's.
  const model = createSarvamLlm({ apiKey: "k", fetch: s.fake.fetch });
  const session = new voice.AgentSession({ llm: model });
  sessions.push(session);
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    const item = ev.item;
    if (item.type === "message" && item.role === "assistant") agent.recordSpoken(item.interrupted);
  });
  await session.start({ agent });
  const said: string[] = [];
  const turn = async (t: string) => {
    const r = await session.run({ userInput: t }).wait();
    said.push(
      ...r.events
        .filter((e) => e.type === "message")
        .map((e) => (e as { item: { textContent?: string } }).item.textContent ?? ""),
    );
  };
  return { backend, state, tools, guarded, said, turn, ...s };
}

const q = (s: string) => JSON.stringify(s); // tool output as the model sees it

function lifecycleScript(): Map<string, Turn> {
  return new Map<string, Turn>([
    ["Hello", { text: "Hello! How can I help you today?" }],
    ["నాకు అపాయింట్మెంట్ బుక్ చేయాలి", { text: "తప్పకుండా. మీకు ఏ సర్వీస్ కావాలి?" }],
    ["cleaning kosam, ఈరోజు ఏ టైం free?", { text: "ఈరోజు ఏ సమయం కావాలి?" }],
    [
      "आज शाम चार बजे क्लीनिंग चाहिए",
      { text: "मैं कैलेंडर देख रही हूँ।", tool: "check_availability" },
    ],
    [
      q("AVAILABLE: 4 PM is free. Ask if they want it."),
      { text: "शाम 4 बजे खाली है। क्या यह समय ठीक रहेगा?" },
    ],
    ["जी हाँ", { text: "आपका नाम क्या है?" }],
    [
      "मेरा नाम धनुष है",
      { text: "धन्यवाद धनुष जी। क्या हम 3210 पर खत्म होने वाला यही नंबर इस्तेमाल करें?" },
    ],
    [
      "हाँ जी, इसी नंबर पर",
      { text: "क्लीनिंग, आज शाम 4 बजे, धनुष, नंबर 3210। क्या मैं इसे पक्का करूँ?" },
    ],
    ["हाँ, बुक कर दीजिए", { tool: "book_appointment" }],
    [
      q("BOOKED: the booking for 4 PM is confirmed."),
      { text: "आपका अपॉइंटमेंट शाम 4 बजे के लिए बुक हो गया है।" },
    ],
  ]);
}
const LIFECYCLE_TURNS = [
  "Hello",
  "నాకు అపాయింట్మెంట్ బుక్ చేయాలి",
  "cleaning kosam, ఈరోజు ఏ టైం free?",
  "आज शाम चार बजे क्लीनिंग चाहिए",
  "जी हाँ",
  "मेरा नाम धनुष है",
  "हाँ जी, इसी नंबर पर",
  "हाँ, बुक कर दीजिए",
];

describe("AgentSession + Sarvam adapter: booking lifecycle (scripted model, in-memory backend)", () => {
  for (const omitIds of [false, true]) {
    test(`Telugu -> code-mixed -> Hindi, check -> confirm -> book${omitIds ? " (provider omits tool-call ids)" : ""}`, async () => {
      const c = await sarvamCall(lifecycleScript(), { omitIds });
      for (const t of LIFECYCLE_TURNS) await c.turn(t);
      assert.deepEqual(
        c.problems,
        [],
        "every request was scripted and every continuation matched its call id",
      );
      assert.equal(c.state.booking.status, "confirmed");
      assert.equal(c.backend.bookings.size, 1);
      assert.equal(c.backend.calls.book, 1);
      assert.deepEqual(c.tools, ["check_availability:true", "book_appointment:true"]);
      assert.equal(c.issued.length, 2);
      assert.equal(
        c.said.findIndex((x) => /बुक हो गया/.test(x)),
        c.said.length - 1,
        "the booked claim comes only after the tool confirmed it",
      );
      assert.deepEqual(c.guarded, []);
      for (const k of ["service", "date", "time", "customerName", "phone"] as const)
        assert.equal(c.state[k]?.provenance, "confirmed", k);
    });
  }

  test("a model that books before confirmation, invents availability, or calls an unknown tool changes nothing", async () => {
    const c = await sarvamCall(
      new Map<string, Turn>([
        ["Hello", { text: "Hello! How can I help?" }],
        ["book a cleaning today at 4 pm", { tool: "book_appointment" }],
        ['"NOT_ALLOWED*', { text: "4 PM is free and you're booked!" }],
        ["Unknown function*", { text: "Everything is free all day." }],
        ["what is free?", { tool: "delete_all_bookings" }],
      ]),
    );
    await c.turn("Hello");
    await c.turn("book a cleaning today at 4 pm");
    await c.turn("what is free?");
    assert.deepEqual(c.problems, []);
    assert.equal(c.backend.bookings.size, 0);
    assert.equal(c.backend.calls.book, 0);
    assert.ok(c.guarded.length > 0, "the invented availability/booking claim was removed");
    assert.ok(!c.said.some((x) => /booked/i.test(x)), JSON.stringify(c.said));
  });
});
