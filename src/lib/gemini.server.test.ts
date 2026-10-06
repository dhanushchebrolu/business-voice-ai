import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  gemini,
  ProviderError,
  TOTAL_RECOVERY_BUDGET_MS,
  remainingAttemptTimeoutMs,
} from "./gemini.server.ts";

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

describe('gemini model resolution — production incident: Google returned 404 "models/gemini-2.5-flash is no longer available to new users", naming models/gemini-3.8-flash as the replacement', () => {
  test("defaults to gemini-3.8-flash when GEMINI_MODEL is unset", async () => {
    await withEnv({ GEMINI_API_KEY: "k", GEMINI_MODEL: undefined }, async () => {
      let seenUrl = "";
      await withFetch(
        (async (url: string | URL) => {
          seenUrl = String(url);
          return new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] }), {
            status: 200,
          });
        }) as typeof fetch,
        async () => {
          await gemini.runConversation([{ role: "user", content: "hi" }]);
        },
      );
      assert.match(seenUrl, /\/models\/gemini-3\.8-flash:generateContent\?/);
    });
  });

  test("never defaults back to gemini-2.5-flash under any code path", async () => {
    await withEnv({ GEMINI_API_KEY: "k", GEMINI_MODEL: undefined }, async () => {
      let seenUrl = "";
      await withFetch(
        (async (url: string | URL) => {
          seenUrl = String(url);
          return new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] }), {
            status: 200,
          });
        }) as typeof fetch,
        async () => {
          await gemini.runConversation([{ role: "user", content: "hi" }]);
        },
      );
      assert.doesNotMatch(seenUrl, /gemini-2\.5-flash/);
    });
  });

  test("GEMINI_MODEL, when explicitly set, still overrides the default — an operator can point at a different model without a code change", async () => {
    await withEnv({ GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-3.8-flash-lite" }, async () => {
      let seenUrl = "";
      await withFetch(
        (async (url: string | URL) => {
          seenUrl = String(url);
          return new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] }), {
            status: 200,
          });
        }) as typeof fetch,
        async () => {
          await gemini.runConversation([{ role: "user", content: "hi" }]);
        },
      );
      assert.match(seenUrl, /\/models\/gemini-3\.8-flash-lite:generateContent\?/);
    });
  });
});

describe("gemini generationConfig — 3.8 Flash compatibility: temperature/top_p/top_k are deprecated and silently ignored by the backend, so they must not be sent at all (not merely harmless to leave in)", () => {
  test("generationConfig carries only maxOutputTokens — no temperature, topP, topK, candidateCount, or thinking_budget/thinking_level", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      let seenBody: { generationConfig?: Record<string, unknown> } = {};
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          seenBody = JSON.parse(init!.body as string) as typeof seenBody;
          return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          await gemini.runConversation([{ role: "user", content: "hi" }]);
        },
      );
      assert.deepEqual(seenBody.generationConfig, { maxOutputTokens: 400 });
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
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=super-secret-abc123",
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

describe('gemini 503 retry — production incident: Google returned 503 "This model is currently experiencing high demand... Please try again later." and the previous single-attempt call() turned every momentary spike into the caller-facing fallback', () => {
  test("a 503 followed by a 200 succeeds — the transient spike is retried, not surfaced to the caller", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      let callCount = 0;
      await withFetch(
        (async () => {
          callCount += 1;
          if (callCount === 1) {
            return new Response("This model is currently experiencing high demand.", {
              status: 503,
            });
          }
          return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          const result = await gemini.runConversation([{ role: "user", content: "hi" }]);
          assert.equal(result.reply, "ok");
        },
      );
      assert.equal(callCount, 2, "expected exactly one retry after the first 503");
    });
  });

  test("gives up and throws after exhausting primary retries AND the fallback attempt if every attempt returns 503 — never retries forever", async () => {
    await withEnv({ GEMINI_API_KEY: "leak-me-not-5" }, async () => {
      let callCount = 0;
      await withFetch(
        (async () => {
          callCount += 1;
          return new Response("This model is currently experiencing high demand.", {
            status: 503,
          });
        }) as typeof fetch,
        async () => {
          await assert.rejects(
            () => gemini.runConversation([{ role: "user", content: "hi" }]),
            (err: unknown) => {
              assert.ok(err instanceof ProviderError);
              assert.equal(err.status, 503);
              assert.doesNotMatch(err.message, /leak-me-not-5/);
              return true;
            },
          );
        },
      );
      assert.equal(
        callCount,
        3,
        "expected exactly 2 primary attempts + 1 fallback attempt, not an unbounded retry loop",
      );
    });
  });

  test("a 429 is never retried — fails on the first attempt, unlike a 503", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      let callCount = 0;
      await withFetch(
        (async () => {
          callCount += 1;
          return new Response("slow down", { status: 429 });
        }) as typeof fetch,
        async () => {
          await assert.rejects(() => gemini.runConversation([{ role: "user", content: "hi" }]));
        },
      );
      assert.equal(callCount, 1, "a 429 must not trigger the 503 retry path");
    });
  });

  test("a 401 is never retried either", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      let callCount = 0;
      await withFetch(
        (async () => {
          callCount += 1;
          return new Response("unauthorized", { status: 401 });
        }) as typeof fetch,
        async () => {
          await assert.rejects(() => gemini.runConversation([{ role: "user", content: "hi" }]));
        },
      );
      assert.equal(callCount, 1);
    });
  });
});

describe('gemini 3.7 fallback on exhausted 3.8 overload — production incident: both of the primary model\'s 503 retries came back "This model is currently experiencing high demand..." — the fallback must trigger ONLY for this specific exhausted-503 case, never for 429/401/403/timeout, which keep their existing immediate-throw behavior unchanged', () => {
  test("3.8 succeeds on the first attempt — no fallback, no retry", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      let callCount = 0;
      let seenUrl = "";
      await withFetch(
        (async (url: string | URL) => {
          callCount += 1;
          seenUrl = String(url);
          return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          const result = await gemini.runConversation([{ role: "user", content: "hi" }]);
          assert.equal(result.reply, "ok");
        },
      );
      assert.equal(callCount, 1);
      assert.match(seenUrl, /\/models\/gemini-3\.8-flash:generateContent\?/);
    });
  });

  test("3.8 first attempt 503, 400ms retry, 3.8 second attempt succeeds — no fallback reached", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      let callCount = 0;
      const seenUrls: string[] = [];
      await withFetch(
        (async (url: string | URL) => {
          callCount += 1;
          seenUrls.push(String(url));
          if (callCount === 1) {
            return new Response("high demand", { status: 503 });
          }
          return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          const result = await gemini.runConversation([{ role: "user", content: "hi" }]);
          assert.equal(result.reply, "ok");
        },
      );
      assert.equal(callCount, 2, "exactly the two primary attempts, no fallback call");
      for (const url of seenUrls)
        assert.match(url, /\/models\/gemini-3\.8-flash:generateContent\?/);
    });
  });

  test("3.8 first AND second attempts return 503 — falls back to 3.7, which succeeds", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      let callCount = 0;
      const seenUrls: string[] = [];
      await withFetch(
        (async (url: string | URL) => {
          callCount += 1;
          seenUrls.push(String(url));
          if (callCount <= 2) {
            return new Response("high demand", { status: 503 });
          }
          return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: "fallback reply" }] } }] }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          const result = await gemini.runConversation([{ role: "user", content: "hi" }]);
          assert.equal(result.reply, "fallback reply");
        },
      );
      assert.equal(callCount, 3, "two primary attempts + exactly one fallback attempt");
      assert.match(seenUrls[0]!, /\/models\/gemini-3\.8-flash:generateContent\?/);
      assert.match(seenUrls[1]!, /\/models\/gemini-3\.8-flash:generateContent\?/);
      assert.match(
        seenUrls[2]!,
        /\/models\/gemini-3\.7-flash:generateContent\?/,
        "the third request must target gemini-3.7-flash",
      );
    });
  });

  test("3.8 exhausted (both 503) AND 3.7 fallback also fails — the existing final error path is preserved", async () => {
    await withEnv({ GEMINI_API_KEY: "leak-me-not-6" }, async () => {
      let callCount = 0;
      await withFetch(
        (async () => {
          callCount += 1;
          if (callCount <= 2) return new Response("high demand", { status: 503 });
          return new Response("fallback also down", { status: 500 });
        }) as typeof fetch,
        async () => {
          await assert.rejects(
            () => gemini.runConversation([{ role: "user", content: "hi" }]),
            (err: unknown) => {
              assert.ok(err instanceof ProviderError);
              assert.equal(err.status, 500);
              assert.doesNotMatch(err.message, /leak-me-not-6/);
              return true;
            },
          );
        },
      );
      assert.equal(callCount, 3);
    });
  });

  test("a 429 on the first attempt never reaches the fallback model", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      const seenUrls: string[] = [];
      await withFetch(
        (async (url: string | URL) => {
          seenUrls.push(String(url));
          return new Response("slow down", { status: 429 });
        }) as typeof fetch,
        async () => {
          await assert.rejects(() => gemini.runConversation([{ role: "user", content: "hi" }]));
        },
      );
      assert.equal(seenUrls.length, 1);
      assert.doesNotMatch(seenUrls[0]!, /gemini-3\.7-flash/);
    });
  });

  test("401/403 never reach the fallback model", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      const seenUrls: string[] = [];
      await withFetch(
        (async (url: string | URL) => {
          seenUrls.push(String(url));
          return new Response("unauthorized", { status: 403 });
        }) as typeof fetch,
        async () => {
          await assert.rejects(() => gemini.runConversation([{ role: "user", content: "hi" }]));
        },
      );
      assert.equal(seenUrls.length, 1);
      assert.doesNotMatch(seenUrls[0]!, /gemini-3\.7-flash/);
    });
  });

  test("a timeout on the first attempt never reaches the fallback model — timeout is not treated as retryable, matching existing behavior", async () => {
    await withEnv({ GEMINI_API_KEY: "k" }, async () => {
      let callCount = 0;
      await withFetch(
        (async () => {
          callCount += 1;
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }) as typeof fetch,
        async () => {
          await assert.rejects(
            () => gemini.runConversation([{ role: "user", content: "hi" }]),
            (err: unknown) => {
              assert.ok(err instanceof ProviderError);
              assert.equal(err.status, 504);
              return true;
            },
          );
        },
      );
      assert.equal(callCount, 1, "a timeout must not trigger a retry or a fallback attempt");
    });
  });

  test("gemini:falling_back_to_secondary_model logs safe metadata only — never the API key or request body", async () => {
    const originalInfo = console.info;
    const logs: { event: string; data: unknown }[] = [];
    console.info = (event: unknown, data?: unknown) => {
      logs.push({ event: String(event), data });
    };
    try {
      await withEnv({ GEMINI_API_KEY: "test-key-not-a-real-secret" }, async () => {
        let callCount = 0;
        await withFetch(
          (async () => {
            callCount += 1;
            if (callCount <= 2) return new Response("high demand", { status: 503 });
            return new Response(
              JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
              { status: 200 },
            );
          }) as typeof fetch,
          async () => {
            await gemini.runConversation([{ role: "user", content: "hi" }]);
          },
        );
      });
    } finally {
      console.info = originalInfo;
    }

    const entry = logs.find((l) => l.event === "gemini:falling_back_to_secondary_model");
    assert.ok(entry, "expected the fallback diagnostic to fire");
    const data = entry!.data as Record<string, unknown>;
    assert.equal(data["primaryModel"], "gemini-3.8-flash");
    assert.equal(data["fallbackModel"], "gemini-3.7-flash");
    assert.equal(data["reason"], "primary_503_exhausted");
    assert.equal(typeof data["elapsedMs"], "number");
    assert.equal(typeof data["remainingBudgetMs"], "number");

    const serialized = JSON.stringify(logs);
    assert.doesNotMatch(serialized, /test-key-not-a-real-secret/);
    assert.doesNotMatch(serialized, /api-subscription-key/);
  });
});

describe("gemini recovery budget — IMPORTANT LATENCY REQUIREMENT: the primary retry + fallback sequence must never stack independent 15s timeouts into 30-45s of dead air on a live call; each attempt's own timeout is bounded by whatever's left of a single shared ~5-8s budget", () => {
  test("remainingAttemptTimeoutMs never exceeds the shared recovery budget, even though the per-request ceiling (15s) is larger", () => {
    assert.equal(remainingAttemptTimeoutMs(0, 0), TOTAL_RECOVERY_BUDGET_MS);
    assert.ok(TOTAL_RECOVERY_BUDGET_MS >= 5_000 && TOTAL_RECOVERY_BUDGET_MS <= 8_000);
  });

  test("remainingAttemptTimeoutMs shrinks as elapsed time grows, and never goes negative", () => {
    assert.equal(
      remainingAttemptTimeoutMs(0, 3_000),
      TOTAL_RECOVERY_BUDGET_MS - 3_000,
      "an attempt starting 3s in should get only the budget remaining",
    );
    assert.equal(remainingAttemptTimeoutMs(0, TOTAL_RECOVERY_BUDGET_MS), 0);
    assert.equal(
      remainingAttemptTimeoutMs(0, TOTAL_RECOVERY_BUDGET_MS + 10_000),
      0,
      "must clamp to 0, never go negative, once the budget is exhausted",
    );
  });

  test("each real attempt's AbortSignal.timeout is bounded by the shared budget, and shrinks across the sequence — proven by spying on AbortSignal.timeout itself, not by waiting out real time", async () => {
    const originalTimeout = AbortSignal.timeout;
    const seenTimeouts: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AbortSignal as any).timeout = (ms: number) => {
      seenTimeouts.push(ms);
      return originalTimeout(ms);
    };
    try {
      await withEnv({ GEMINI_API_KEY: "k" }, async () => {
        await withFetch(
          (async () => new Response("high demand", { status: 503 })) as typeof fetch,
          async () => {
            await assert.rejects(() => gemini.runConversation([{ role: "user", content: "hi" }]));
          },
        );
      });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (AbortSignal as any).timeout = originalTimeout;
    }

    assert.equal(seenTimeouts.length, 3, "2 primary attempts + 1 fallback attempt");
    for (const ms of seenTimeouts) {
      assert.ok(ms > 0);
      assert.ok(
        ms <= TOTAL_RECOVERY_BUDGET_MS,
        `attempt timeout ${ms}ms must never exceed the shared recovery budget — this is what prevents three independent 15s timeouts from stacking into 30-45s`,
      );
    }
    assert.ok(
      seenTimeouts[1]! <= seenTimeouts[0]!,
      "each later attempt gets no more time than the one before it",
    );
    assert.ok(seenTimeouts[2]! <= seenTimeouts[1]!);
  });
});

describe("gemini.server.ts reuses sarvam.server.ts's ProviderError, not a parallel class", () => {
  test("voice-runtime.server.ts's `error instanceof ProviderError` check (speakFallback) works identically regardless of which LLM provider raised the error", async () => {
    const { ProviderError: SarvamProviderError } = await import("./sarvam.server.ts");
    assert.equal(ProviderError, SarvamProviderError);
  });
});
