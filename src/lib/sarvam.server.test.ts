import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sarvam, ProviderError } from "./sarvam.server.ts";

/**
 * Sarvam LLM/TTS/batch-STT client (sarvam.server.ts) — error/timeout
 * handling and secret-safety coverage. This is the counterpart to
 * sarvam-realtime.server.test.ts (which covers the streaming STT/TTS
 * WebSocket clients used by the live telephony path); this file covers the
 * plain HTTP client used for the LLM turn (voice-runtime.server.ts's
 * generateReply) and the batch TTS/STT endpoints.
 *
 * global.fetch is mocked per test (same technique as
 * sarvam-outbound-call.server.test.ts) — no live network call, no real
 * SARVAM_API_KEY needed for any test in this file.
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

describe("sarvam.isConfigured", () => {
  test("false when SARVAM_API_KEY is unset", async () => {
    await withEnv({ SARVAM_API_KEY: undefined }, async () => {
      assert.equal(sarvam.isConfigured(), false);
    });
  });

  test("true when SARVAM_API_KEY is set", async () => {
    await withEnv({ SARVAM_API_KEY: "secret-test-key" }, async () => {
      assert.equal(sarvam.isConfigured(), true);
    });
  });
});

describe("sarvam.runConversation — request shape and success path", () => {
  test("sends the platform key as api-subscription-key and never as a URL param or Authorization header", async () => {
    await withEnv({ SARVAM_API_KEY: "super-secret-abc123" }, async () => {
      let seenUrl = "";
      let seenHeaders: Record<string, string> = {};
      let seenBody: unknown;
      await withFetch(
        (async (url: string | URL, init?: RequestInit) => {
          seenUrl = String(url);
          seenHeaders = Object.fromEntries(new Headers(init?.headers).entries());
          seenBody = init?.body ? JSON.parse(init.body as string) : undefined;
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "Hello there" } }] }),
            { status: 200 },
          );
        }) as typeof fetch,
        async () => {
          const result = await sarvam.runConversation([{ role: "user", content: "hi" }]);
          assert.equal(result.reply, "Hello there");
        },
      );
      assert.equal(seenUrl, "https://api.sarvam.ai/v1/chat/completions");
      assert.equal(seenHeaders["api-subscription-key"], "super-secret-abc123");
      assert.equal(seenHeaders["authorization"], undefined);
      assert.ok(!seenUrl.includes("super-secret-abc123"), "API key must never appear in the URL");
      assert.equal((seenBody as { model: string }).model, "sarvam-105b-conversations");
      assert.equal((seenBody as { top_p: number }).top_p, 0.9);
    });
  });

  test("an empty/missing reply resolves to an empty string, never throws", async () => {
    await withEnv({ SARVAM_API_KEY: "k" }, async () => {
      await withFetch(
        (async () =>
          new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch,
        async () => {
          const result = await sarvam.runConversation([{ role: "user", content: "hi" }]);
          assert.equal(result.reply, "");
        },
      );
    });
  });
});

describe("sarvam.runConversation — error handling never leaks the API key", () => {
  test("missing SARVAM_API_KEY fails fast (never calls fetch) with a 503 that names no key", async () => {
    await withEnv({ SARVAM_API_KEY: undefined }, async () => {
      let fetchCalled = false;
      await withFetch(
        (async () => {
          fetchCalled = true;
          throw new Error("must not be called");
        }) as typeof fetch,
        async () => {
          await assert.rejects(
            () => sarvam.runConversation([{ role: "user", content: "hi" }]),
            (err: unknown) => {
              assert.ok(err instanceof ProviderError);
              assert.equal(err.status, 503);
              assert.doesNotMatch(err.message, /SARVAM_API_KEY/);
              return true;
            },
          );
        },
      );
      assert.equal(fetchCalled, false);
    });
  });

  test("a network-level fetch failure maps to a 503 ProviderError, key never in the message", async () => {
    await withEnv({ SARVAM_API_KEY: "leak-me-not-1" }, async () => {
      await withFetch(
        (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
        async () => {
          await assert.rejects(
            () => sarvam.runConversation([{ role: "user", content: "hi" }]),
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

  test("an AbortSignal timeout (the shape AbortSignal.timeout() actually rejects with) maps to a 504 ProviderError, not a raw network error", async () => {
    await withEnv({ SARVAM_API_KEY: "leak-me-not-2" }, async () => {
      let sawAbortSignal = false;
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          sawAbortSignal = init?.signal instanceof AbortSignal;
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }) as typeof fetch,
        async () => {
          await assert.rejects(
            () => sarvam.runConversation([{ role: "user", content: "hi" }]),
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
    await withEnv({ SARVAM_API_KEY: "leak-me-not-3" }, async () => {
      await withFetch(
        (async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
        async () => {
          await assert.rejects(
            () => sarvam.runConversation([{ role: "user", content: "hi" }]),
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
    await withEnv({ SARVAM_API_KEY: "k" }, async () => {
      await withFetch(
        (async () => new Response("slow down", { status: 429 })) as typeof fetch,
        async () => {
          await assert.rejects(
            () => sarvam.runConversation([{ role: "user", content: "hi" }]),
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

  test("a generic 500 response maps to a ProviderError carrying the status, response body truncated", async () => {
    await withEnv({ SARVAM_API_KEY: "leak-me-not-4" }, async () => {
      await withFetch(
        (async () => new Response("x".repeat(500), { status: 500 })) as typeof fetch,
        async () => {
          await assert.rejects(
            () => sarvam.runConversation([{ role: "user", content: "hi" }]),
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

describe("sarvam.generateSpeech", () => {
  test("returns the first base64 audio chunk", async () => {
    await withEnv({ SARVAM_API_KEY: "k" }, async () => {
      await withFetch(
        (async () =>
          new Response(JSON.stringify({ audios: ["QUJD"] }), { status: 200 })) as typeof fetch,
        async () => {
          const audio = await sarvam.generateSpeech({
            text: "hello",
            speaker: "ritu",
            language: "en-IN",
            pace: 1,
          });
          assert.equal(audio, "QUJD");
        },
      );
    });
  });

  test("no audio in the response is a clear 502 error, not an undefined-access crash", async () => {
    await withEnv({ SARVAM_API_KEY: "k" }, async () => {
      await withFetch(
        (async () => new Response(JSON.stringify({ audios: [] }), { status: 200 })) as typeof fetch,
        async () => {
          await assert.rejects(
            () =>
              sarvam.generateSpeech({ text: "hello", speaker: "ritu", language: "en-IN", pace: 1 }),
            (err: unknown) => {
              assert.ok(err instanceof ProviderError);
              assert.equal(err.status, 502);
              return true;
            },
          );
        },
      );
    });
  });
});

describe("sarvam.speechToText", () => {
  test("also carries a bounded AbortSignal and maps a timeout the same way as runConversation", async () => {
    await withEnv({ SARVAM_API_KEY: "leak-me-not-5" }, async () => {
      let sawAbortSignal = false;
      await withFetch(
        (async (_url: string | URL, init?: RequestInit) => {
          sawAbortSignal = init?.signal instanceof AbortSignal;
          throw new DOMException("timeout", "TimeoutError");
        }) as typeof fetch,
        async () => {
          await assert.rejects(
            () => sarvam.speechToText({ audio: new Blob(["x"]) }),
            (err: unknown) => {
              assert.ok(err instanceof ProviderError);
              assert.equal(err.status, 504);
              assert.doesNotMatch(err.message, /leak-me-not-5/);
              return true;
            },
          );
        },
      );
      assert.ok(sawAbortSignal);
    });
  });
});
