import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { claude, ProviderError } from "./claude.server.ts";

/**
 * Claude (Anthropic Messages API) LLM client (claude.server.ts) — the
 * "Claude text pipeline works independently" proof this change was asked
 * to produce before anything telephony-related is touched: request shape,
 * the ChatMessage[] -> system+messages conversion, error/timeout handling,
 * and secret-safety, all exercised without a live network call or a real
 * ANTHROPIC_API_KEY. Same mocking technique as sarvam.server.test.ts (a
 * per-test global.fetch stub), so this module's actual call site
 * (voice-runtime.server.ts, via llm-provider.server.ts) can swap providers
 * with the same confidence level the existing Sarvam client already has.
 */

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prior[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

describe("claude.isConfigured", () => {
  test("false when ANTHROPIC_API_KEY is unset", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      assert.equal(claude.isConfigured(), false);
    });
  });

  test("true when ANTHROPIC_API_KEY is set", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "secret-test-key" }, async () => {
      assert.equal(claude.isConfigured(), true);
    });
  });
});

describe("claude.runConversation — request shape and success path", () => {
  test("sends the platform key as x-api-key (never Authorization or a URL param), with the required anthropic-version header", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "super-secret-abc123" }, async () => {
      let seenUrl = "";
      let seenHeaders: Record<string, string> = {};
      let seenBody: unknown;
      await withFetch(
        (async (url: string | URL, init?: RequestInit) => {
          seenUrl = String(url);
          seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
          seenBody = init?.body ? JSON.parse(init.body as string) : undefined;
          return new Response(
            JSON.stringify({
              content: [{ type: "text", text: "Hello there" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 12, output_tokens: 3 },
            }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          const result = await claude.runConversation([{ role: "user", content: "hi" }]);
          assert.equal(result.reply, "Hello there");
          assert.equal(result.usage.input_tokens, 12);
          assert.equal(result.usage.output_tokens, 3);
        },
      );
      assert.equal(seenUrl, "https://api.anthropic.com/v1/messages");
      assert.equal(seenHeaders["x-api-key"], "super-secret-abc123");
      assert.equal(seenHeaders["authorization"], undefined);
      assert.equal(seenHeaders["anthropic-version"], "2023-06-01");
      assert.ok(!seenUrl.includes("super-secret-abc123"), "API key must never appear in the URL");
      assert.equal((seenBody as { model: string }).model, "claude-sonnet-5");
    });
  });

  test("splits a leading system ChatMessage into the top-level `system` field — never leaves it inside `messages`", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      let seenBody: { system?: string; messages?: { role: string; content: string }[] } = {};
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          seenBody = JSON.parse(init!.body as string) as typeof seenBody;
          return new Response(
            JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          await claude.runConversation([
            { role: "system", content: "You are a helpful receptionist." },
            { role: "assistant", content: "Hello, thanks for calling." },
            { role: "user", content: "What are your hours?" },
          ]);
        },
      );
      assert.equal(seenBody.system, "You are a helpful receptionist.");
      assert.deepEqual(seenBody.messages, [
        { role: "assistant", content: "Hello, thanks for calling." },
        { role: "user", content: "What are your hours?" },
      ]);
      assert.ok(
        !seenBody.messages!.some((m) => (m as { role: string }).role === "system"),
        "no system-role entry may remain inside messages",
      );
    });
  });

  test("multiple system ChatMessages are joined, not dropped", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      let seenBody: { system?: string } = {};
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          seenBody = JSON.parse(init!.body as string) as typeof seenBody;
          return new Response(
            JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          await claude.runConversation([
            { role: "system", content: "Part one." },
            { role: "system", content: "Part two." },
            { role: "user", content: "hi" },
          ]);
        },
      );
      assert.equal(seenBody.system, "Part one.\n\nPart two.");
    });
  });

  test("concatenates multiple text content blocks into one reply string", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      await withFetch(
        (async () =>
          new Response(
            JSON.stringify({
              content: [
                { type: "text", text: "Hello " },
                { type: "text", text: "there." },
              ],
              stop_reason: "end_turn",
            }),
            { status: 200 },
          )) as typeof fetch,
        async () => {
          const result = await claude.runConversation([{ role: "user", content: "hi" }]);
          assert.equal(result.reply, "Hello there.");
        },
      );
    });
  });

  test("a tool_use content block (no text) resolves to an empty reply, never throws or crashes on missing `text`", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      await withFetch(
        (async () =>
          new Response(
            JSON.stringify({
              content: [{ type: "tool_use", id: "toolu_1", name: "some_tool", input: {} }],
              stop_reason: "tool_use",
            }),
            { status: 200 },
          )) as typeof fetch,
        async () => {
          const result = await claude.runConversation([{ role: "user", content: "hi" }]);
          assert.equal(result.reply, "");
        },
      );
    });
  });

  test("an optional `tools` array, when passed, is forwarded verbatim in the request body", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      let seenBody: { tools?: unknown } = {};
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          seenBody = JSON.parse(init!.body as string) as typeof seenBody;
          return new Response(
            JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          await claude.runConversation([{ role: "user", content: "hi" }], {
            tools: [
              { name: "check_availability", description: "d", input_schema: { type: "object" } },
            ],
          });
        },
      );
      assert.deepEqual(seenBody.tools, [
        { name: "check_availability", description: "d", input_schema: { type: "object" } },
      ]);
    });
  });

  test("omitting `tools` sends no tools field at all", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      let seenBody: Record<string, unknown> = {};
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          seenBody = JSON.parse(init!.body as string) as Record<string, unknown>;
          return new Response(
            JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          await claude.runConversation([{ role: "user", content: "hi" }]);
        },
      );
      assert.equal("tools" in seenBody, false);
    });
  });
});

describe("claude.runConversation — error handling never leaks the API key", () => {
  test("missing ANTHROPIC_API_KEY fails fast (never calls fetch) with a 503 that names no key", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      let fetchCalled = false;
      await withFetch(
        (async () => {
          fetchCalled = true;
          throw new Error("must not be called");
        }) as typeof fetch,
        async () => {
          await assert.rejects(
            () => claude.runConversation([{ role: "user", content: "hi" }]),
            (err: unknown) => {
              assert.ok(err instanceof ProviderError);
              assert.equal(err.status, 503);
              assert.doesNotMatch(err.message, /ANTHROPIC_API_KEY/);
              return true;
            },
          );
        },
      );
      assert.equal(fetchCalled, false);
    });
  });

  test("a network-level fetch failure maps to a 503 ProviderError, key never in the message", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "leak-me-not-1" }, async () => {
      await withFetch(
        (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
        async () => {
          await assert.rejects(
            () => claude.runConversation([{ role: "user", content: "hi" }]),
            (err: unknown) => {
              assert.ok(err instanceof ProviderError);
              assert.equal(err.status, 503);
              assert.doesNotMatch(err.message, /leak-me-not-1/);
              return true;
            },
          );
        },
      );
    });
  });

  test("an AbortSignal timeout maps to a 504 ProviderError, carries a bounded signal on every request", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "leak-me-not-2" }, async () => {
      let sawAbortSignal = false;
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          sawAbortSignal = init?.signal instanceof AbortSignal;
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }) as typeof fetch,
        async () => {
          await assert.rejects(
            () => claude.runConversation([{ role: "user", content: "hi" }]),
            (err: unknown) => {
              assert.ok(err instanceof ProviderError);
              assert.equal(err.status, 504);
              assert.match(err.message, /timed out/i);
              assert.doesNotMatch(err.message, /leak-me-not-2/);
              return true;
            },
          );
        },
      );
      assert.ok(sawAbortSignal, "expected every request to actually carry a bounded AbortSignal");
    });
  });

  test("a 401/403 response maps to a clear 'credentials rejected' error, never echoing the key", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "leak-me-not-3" }, async () => {
      await withFetch(
        (async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
        async () => {
          await assert.rejects(
            () => claude.runConversation([{ role: "user", content: "hi" }]),
            (err: unknown) => {
              assert.ok(err instanceof ProviderError);
              assert.equal(err.status, 401);
              assert.doesNotMatch(err.message, /leak-me-not-3/);
              return true;
            },
          );
        },
      );
    });
  });

  test("a 429 response maps to a rate-limit error", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      await withFetch(
        (async () => new Response("slow down", { status: 429 })) as typeof fetch,
        async () => {
          await assert.rejects(
            () => claude.runConversation([{ role: "user", content: "hi" }]),
            (err: unknown) => {
              assert.ok(err instanceof ProviderError);
              assert.equal(err.status, 429);
              assert.match(err.message, /rate limit/i);
              return true;
            },
          );
        },
      );
    });
  });

  test("a generic 500 response maps to a ProviderError carrying the status, response body truncated, key never echoed", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "leak-me-not-4" }, async () => {
      await withFetch(
        (async () => new Response("x".repeat(500), { status: 500 })) as typeof fetch,
        async () => {
          await assert.rejects(
            () => claude.runConversation([{ role: "user", content: "hi" }]),
            (err: unknown) => {
              assert.ok(err instanceof ProviderError);
              assert.equal(err.status, 500);
              assert.ok(err.message.length < 500, "the raw response body must be truncated");
              assert.doesNotMatch(err.message, /leak-me-not-4/);
              return true;
            },
          );
        },
      );
    });
  });
});

describe("claude.runConversationWithTools — single tool-call round", () => {
  test("no tool_use requested: behaves like a plain call, empty toolCalls, no follow-up request made", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      let callCount = 0;
      await withFetch(
        (async () => {
          callCount++;
          return new Response(
            JSON.stringify({
              content: [{ type: "text", text: "Hello there" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 2 },
            }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          const executed: string[] = [];
          const result = await claude.runConversationWithTools(
            [{ role: "user", content: "hi" }],
            [{ name: "check_availability", description: "d", input_schema: { type: "object" } }],
            async (name) => {
              executed.push(name);
              return { content: "{}" };
            },
          );
          assert.equal(result.reply, "Hello there");
          assert.deepEqual(result.toolCalls, []);
          assert.deepEqual(executed, []);
          assert.equal(result.usage.input_tokens, 10);
        },
      );
      assert.equal(callCount, 1, "no tool requested means exactly one API call");
    });
  });

  test("a tool_use response executes the tool once, then makes exactly one follow-up call with the tool_result appended", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      const requests: { body: Record<string, unknown> }[] = [];
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          const body = JSON.parse(init!.body as string) as Record<string, unknown>;
          requests.push({ body });
          if (requests.length === 1) {
            return new Response(
              JSON.stringify({
                content: [
                  { type: "text", text: "Let me check." },
                  {
                    type: "tool_use",
                    id: "toolu_1",
                    name: "check_availability",
                    input: { date: "2026-10-01" },
                  },
                ],
                stop_reason: "tool_use",
                usage: { input_tokens: 20, output_tokens: 8 },
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              content: [{ type: "text", text: "You're free at 3pm." }],
              stop_reason: "end_turn",
              usage: { input_tokens: 30, output_tokens: 6 },
            }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          const executed: { name: string; input: Record<string, unknown> }[] = [];
          const result = await claude.runConversationWithTools(
            [{ role: "user", content: "Any slots tomorrow?" }],
            [{ name: "check_availability", description: "d", input_schema: { type: "object" } }],
            async (name, input) => {
              executed.push({ name, input });
              return { content: JSON.stringify({ success: true, data: { slots: ["15:00"] } }) };
            },
          );
          assert.equal(result.reply, "You're free at 3pm.");
          assert.equal(result.toolCalls.length, 1);
          assert.equal(result.toolCalls[0]!.name, "check_availability");
          assert.equal(result.toolCalls[0]!.isError, false);
          assert.deepEqual(executed, [
            { name: "check_availability", input: { date: "2026-10-01" } },
          ]);
          // Token usage summed across both round trips.
          assert.equal(result.usage.input_tokens, 50);
          assert.equal(result.usage.output_tokens, 14);
        },
      );
      assert.equal(
        requests.length,
        2,
        "exactly one tool round: first call + one follow-up, never more",
      );

      const firstBody = requests[0]!.body as { tools?: unknown };
      assert.ok(firstBody.tools, "the first call must offer tools");

      const secondBody = requests[1]!.body as {
        tools?: unknown;
        messages: { role: string; content: unknown }[];
      };
      assert.equal(
        "tools" in secondBody,
        false,
        "the follow-up call must never offer tools again — that is the single-round boundary",
      );
      // The follow-up must echo the assistant's own tool_use content back,
      // then a user turn carrying the matching tool_result.
      const assistantTurn = secondBody.messages.find((m) => m.role === "assistant");
      const userToolResultTurn = secondBody.messages[secondBody.messages.length - 1]!;
      assert.ok(Array.isArray(assistantTurn?.content));
      assert.ok((assistantTurn!.content as { type: string }[]).some((b) => b.type === "tool_use"));
      assert.equal(userToolResultTurn.role, "user");
      assert.ok(Array.isArray(userToolResultTurn.content));
      const resultBlock = (userToolResultTurn.content as Record<string, unknown>[])[0]!;
      assert.equal(resultBlock["type"], "tool_result");
      assert.equal(resultBlock["tool_use_id"], "toolu_1");
    });
  });

  test("a tool executor that throws is caught and reported as an error tool_result, never crashes the turn", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      const requests: Record<string, unknown>[] = [];
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          const body = JSON.parse(init!.body as string) as Record<string, unknown>;
          requests.push(body);
          if (requests.length === 1) {
            return new Response(
              JSON.stringify({
                content: [{ type: "tool_use", id: "toolu_9", name: "request_payment", input: {} }],
                stop_reason: "tool_use",
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              content: [{ type: "text", text: "Something went wrong requesting payment." }],
              stop_reason: "end_turn",
            }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          const result = await claude.runConversationWithTools(
            [{ role: "user", content: "charge me" }],
            [{ name: "request_payment", description: "d", input_schema: { type: "object" } }],
            async () => {
              throw new Error("boom");
            },
          );
          assert.equal(result.reply, "Something went wrong requesting payment.");
          assert.equal(result.toolCalls.length, 1);
          assert.equal(result.toolCalls[0]!.isError, true);
        },
      );
      const secondBody = requests[1] as { messages: { role: string; content: unknown }[] };
      const userTurn = secondBody.messages[secondBody.messages.length - 1]!;
      const block = (userTurn.content as Record<string, unknown>[])[0]!;
      assert.equal(block["is_error"], true);
    });
  });

  test("multiple tool_use blocks in one response are all executed before the single follow-up call", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "k" }, async () => {
      const requests: Record<string, unknown>[] = [];
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          const body = JSON.parse(init!.body as string) as Record<string, unknown>;
          requests.push(body);
          if (requests.length === 1) {
            return new Response(
              JSON.stringify({
                content: [
                  { type: "tool_use", id: "toolu_a", name: "tool_a", input: {} },
                  { type: "tool_use", id: "toolu_b", name: "tool_b", input: {} },
                ],
                stop_reason: "tool_use",
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          const executed: string[] = [];
          const result = await claude.runConversationWithTools(
            [{ role: "user", content: "do both" }],
            [
              { name: "tool_a", description: "d", input_schema: { type: "object" } },
              { name: "tool_b", description: "d", input_schema: { type: "object" } },
            ],
            async (name) => {
              executed.push(name);
              return { content: "{}" };
            },
          );
          assert.deepEqual(executed, ["tool_a", "tool_b"]);
          assert.equal(result.toolCalls.length, 2);
          assert.equal(result.reply, "done");
        },
      );
      assert.equal(
        requests.length,
        2,
        "still exactly one round trip regardless of how many tools were called in it",
      );
    });
  });
});

describe("claude.server.ts reuses sarvam.server.ts's ProviderError, not a parallel class", () => {
  test("voice-runtime.server.ts's `error instanceof ProviderError` check (speakFallback) works identically regardless of which LLM provider raised the error", async () => {
    const { ProviderError: SarvamProviderError } = await import("./sarvam.server.ts");
    assert.equal(ProviderError, SarvamProviderError);
  });
});
