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

describe("claude.server.ts reuses sarvam.server.ts's ProviderError, not a parallel class", () => {
  test("voice-runtime.server.ts's `error instanceof ProviderError` check (speakFallback) works identically regardless of which LLM provider raised the error", async () => {
    const { ProviderError: SarvamProviderError } = await import("./sarvam.server.ts");
    assert.equal(ProviderError, SarvamProviderError);
  });
});
