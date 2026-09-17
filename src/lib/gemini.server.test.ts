import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gemini, ProviderError } from "./gemini.server.ts";

/**
 * Gemini (Google Generative Language API) LLM client (gemini.server.ts) —
 * proves the Gemini text pipeline works independently, the same way
 * claude.server.test.ts does for claude.server.ts: request shape, the
 * ChatMessage[] -> system_instruction+contents conversion, error/timeout
 * handling, and secret-safety, all exercised without a live network call or
 * a real GEMINI_API_KEY. Same mocking technique as sarvam.server.test.ts
 * and claude.server.test.ts (a per-test global.fetch stub).
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

describe("gemini.isConfigured", () => {
  test("false when GEMINI_API_KEY is unset", async () => {
    await withEnv({ GEMINI_API_KEY: undefined }, async () => {
      assert.equal(gemini.isConfigured(), false);
    });
  });

  test("true when GEMINI_API_KEY is set", async () => {
    await withEnv({ GEMINI_API_KEY: "secret-test-key" }, async () => {
      assert.equal(gemini.isConfigured(), true);
    });
  });
});

describe("gemini.runConversation — request shape and success path", () => {
  test("sends the platform key as the documented `key` query parameter, to the correct model endpoint", async () => {
    await withEnv({ GEMINI_API_KEY: "super-secret-abc123" }, async () => {
      let seenUrl = "";
      let seenBody: unknown;
      await withFetch(
        (async (url: string | URL, init?: RequestInit) => {
          seenUrl = String(url);
          seenBody = init?.body ? JSON.parse(init.body as string) : undefined;
          return new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: "Hello there" }] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
            }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          const result = await gemini.runConversation([{ role: "user", content: "hi" }]);
          assert.equal(result.reply, "Hello there");
          assert.equal(result.usage.input_tokens, 12);
          assert.equal(result.usage.output_tokens, 3);
        },
      );
      assert.equal(
        seenUrl,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=super-secret-abc123",
      );
      assert.equal((seenBody as { contents: unknown[] }).contents.length, 1);
    });
  });

  test("splits a leading system ChatMessage into `system_instruction` — never leaves it inside `contents`, and maps assistant -> model", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      let seenBody: {
        system_instruction?: { parts: { text: string }[] };
        contents?: { role: string; parts: { text: string }[] }[];
      } = {};
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          seenBody = JSON.parse(init!.body as string) as typeof seenBody;
          return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          await gemini.runConversation([
            { role: "system", content: "You are a helpful receptionist." },
            { role: "assistant", content: "Hello, thanks for calling." },
            { role: "user", content: "What are your hours?" },
          ]);
        },
      );
      assert.equal(seenBody.system_instruction?.parts[0]?.text, "You are a helpful receptionist.");
      assert.deepEqual(seenBody.contents, [
        { role: "model", parts: [{ text: "Hello, thanks for calling." }] },
        { role: "user", parts: [{ text: "What are your hours?" }] },
      ]);
      assert.ok(
        !seenBody.contents!.some((c) => c.role === "system"),
        "no system-role entry may remain inside contents",
      );
    });
  });

  test("multiple system ChatMessages are joined, not dropped", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      let seenBody: { system_instruction?: { parts: { text: string }[] } } = {};
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          seenBody = JSON.parse(init!.body as string) as typeof seenBody;
          return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          await gemini.runConversation([
            { role: "system", content: "Part one." },
            { role: "system", content: "Part two." },
            { role: "user", content: "hi" },
          ]);
        },
      );
      assert.equal(seenBody.system_instruction?.parts[0]?.text, "Part one.\n\nPart two.");
    });
  });

  test("no system message at all means no `system_instruction` field is sent", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      let seenBody: Record<string, unknown> = {};
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          seenBody = JSON.parse(init!.body as string) as Record<string, unknown>;
          return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          await gemini.runConversation([{ role: "user", content: "hi" }]);
        },
      );
      assert.equal("system_instruction" in seenBody, false);
    });
  });

  test("concatenates multiple text parts into one reply string", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      await withFetch(
        (async () =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { parts: [{ text: "Hello " }, { text: "there." }] },
                  finishReason: "STOP",
                },
              ],
            }),
            { status: 200 },
          )) as typeof fetch,
        async () => {
          const result = await gemini.runConversation([{ role: "user", content: "hi" }]);
          assert.equal(result.reply, "Hello there.");
        },
      );
    });
  });

  test("a functionCall-only part (no text) resolves to an empty reply, never throws or crashes on missing `text`", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      await withFetch(
        (async () =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { parts: [{ functionCall: { name: "some_tool", args: {} } }] },
                  finishReason: "STOP",
                },
              ],
            }),
            { status: 200 },
          )) as typeof fetch,
        async () => {
          const result = await gemini.runConversation([{ role: "user", content: "hi" }]);
          assert.equal(result.reply, "");
        },
      );
    });
  });

  test("no candidates at all resolves to an empty reply rather than throwing", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      await withFetch(
        (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch,
        async () => {
          const result = await gemini.runConversation([{ role: "user", content: "hi" }]);
          assert.equal(result.reply, "");
          assert.equal(result.usage.input_tokens, 0);
          assert.equal(result.usage.output_tokens, 0);
        },
      );
    });
  });

  test("an optional `tools` array, when passed, is forwarded verbatim in the request body", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      let seenBody: { tools?: unknown } = {};
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          seenBody = JSON.parse(init!.body as string) as typeof seenBody;
          return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          await gemini.runConversation([{ role: "user", content: "hi" }], {
            tools: [
              {
                functionDeclarations: [
                  {
                    name: "check_availability",
                    description: "d",
                    parameters: { type: "object" },
                  },
                ],
              },
            ],
          });
        },
      );
      assert.deepEqual(seenBody.tools, [
        {
          functionDeclarations: [
            { name: "check_availability", description: "d", parameters: { type: "object" } },
          ],
        },
      ]);
    });
  });

  test("omitting `tools` sends no tools field at all", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      let seenBody: Record<string, unknown> = {};
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          seenBody = JSON.parse(init!.body as string) as Record<string, unknown>;
          return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          await gemini.runConversation([{ role: "user", content: "hi" }]);
        },
      );
      assert.equal("tools" in seenBody, false);
    });
  });
});

describe("gemini.runConversation — error handling never leaks the API key", () => {
  test("missing GEMINI_API_KEY fails fast (never calls fetch) with a 503 that names no key", async () => {
    await withEnv({ GEMINI_API_KEY: undefined }, async () => {
      let fetchCalled = false;
      await withFetch(
        (async () => {
          fetchCalled = true;
          throw new Error("must not be called");
        }) as typeof fetch,
        async () => {
          await assert.rejects(
            () => gemini.runConversation([{ role: "user", content: "hi" }]),
            (err: unknown) => {
              assert.ok(err instanceof ProviderError);
              assert.equal(err.status, 503);
              assert.doesNotMatch(err.message, /GEMINI_API_KEY/);
              return true;
            },
          );
        },
      );
      assert.equal(fetchCalled, false);
    });
  });

  test("a network-level fetch failure maps to a 503 ProviderError, key never in the message", async () => {
    await withEnv({ GEMINI_API_KEY: "leak-me-not-1" }, async () => {
      await withFetch(
        (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
        async () => {
          await assert.rejects(
            () => gemini.runConversation([{ role: "user", content: "hi" }]),
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
    await withEnv({ GEMINI_API_KEY: "leak-me-not-2" }, async () => {
      let sawAbortSignal = false;
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          sawAbortSignal = init?.signal instanceof AbortSignal;
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }) as typeof fetch,
        async () => {
          await assert.rejects(
            () => gemini.runConversation([{ role: "user", content: "hi" }]),
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
    await withEnv({ GEMINI_API_KEY: "leak-me-not-3" }, async () => {
      await withFetch(
        (async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
        async () => {
          await assert.rejects(
            () => gemini.runConversation([{ role: "user", content: "hi" }]),
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
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      await withFetch(
        (async () => new Response("slow down", { status: 429 })) as typeof fetch,
        async () => {
          await assert.rejects(
            () => gemini.runConversation([{ role: "user", content: "hi" }]),
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
    await withEnv({ GEMINI_API_KEY: "leak-me-not-4" }, async () => {
      await withFetch(
        (async () => new Response("x".repeat(500), { status: 500 })) as typeof fetch,
        async () => {
          await assert.rejects(
            () => gemini.runConversation([{ role: "user", content: "hi" }]),
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

describe("gemini.server.ts reuses sarvam.server.ts's ProviderError, not a parallel class", () => {
  test("voice-runtime.server.ts's `error instanceof ProviderError` check (speakFallback) works identically regardless of which LLM provider raised the error", async () => {
    const { ProviderError: SarvamProviderError } = await import("./sarvam.server.ts");
    assert.equal(ProviderError, SarvamProviderError);
  });
});
