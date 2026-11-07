/**
 * Phase 2.19: Sarvam authentication modes (src/agent/sarvam-llm.ts).
 *
 *  - api-key (default): the key is sent exactly once, as api-subscription-key.
 *  - proxy-injected (explicit only): no credential header leaves the process;
 *    an egress proxy adds api-subscription-key for api.sarvam.ai.
 *
 * Every request here goes to an in-process fake: nothing reaches Sarvam.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- SDK errors and fake payloads are untyped here */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { initializeLogger, llm } from "@livekit/agents";
import {
  SarvamAuthConfigError,
  SarvamAuthGuardError,
  createSarvamClient,
  createSarvamLlm,
  resolveSarvamAuth,
  sarvamAuthGuard,
  sarvamAuthProblems,
  type SarvamLlmOptions,
} from "../src/agent/sarvam-llm.ts";
import { buildLlm } from "../src/worker.ts";
import { loadConfig } from "../src/runtime/config.ts";

initializeLogger({ pretty: false, level: "fatal" });

const KEY = "sk_test_auth_canary_9fQ";
const CREDENTIAL_HEADERS = ["authorization", "api-subscription-key", "api-key"];
const PLACEHOLDER = "proxy-injected:no-local-credential";

type Captured = { url: string; headers: Headers };

function fakeSarvam() {
  const requests: Captured[] = [];
  const f = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    requests.push({ url, headers });
    const enc = new TextEncoder();
    const sse = [
      {
        id: "c",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }],
      },
      {
        id: "c",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of sse) c.enqueue(enc.encode(`data: ${JSON.stringify(s)}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetch: f, requests };
}

async function chatOnce(model: llm.LLM): Promise<string> {
  const ctx = llm.ChatContext.empty();
  ctx.addMessage({ role: "user", content: "hello" });
  const stream = model.chat({
    chatCtx: ctx,
    connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 2000 },
  });
  let out = "";
  for await (const c of stream) out += c.delta?.content ?? "";
  return out;
}

/** Every header value, for "the key/placeholder appears nowhere" checks. */
const allValues = (h: Headers) => {
  const v: string[] = [];
  h.forEach((x) => v.push(x));
  return v.join("\n");
};

// Environment the OpenAI SDK would otherwise read and forward.
const SDK_ENV = {
  OPENAI_API_KEY: "sk_openai_env_canary",
  OPENAI_ORG_ID: "org_env_canary",
  OPENAI_PROJECT_ID: "proj_env_canary",
  OPENAI_BASE_URL: "https://env-canary.example/v1",
};
// Settings that must NOT switch the adapter into proxy mode on their own.
const PROXY_LOOKING_ENV = {
  SARVAM_AUTH_MODE: "proxy-injected",
  SARVAM_SMOKE_AUTH_MODE: "proxy-injected",
  NODE_USE_ENV_PROXY: "1",
  HTTPS_PROXY: "http://127.0.0.1:9",
};
const touched = new Map<string, string | undefined>();
function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) {
    if (!touched.has(k)) touched.set(k, process.env[k]);
    process.env[k] = v;
  }
}
afterEach(() => {
  for (const [k, v] of touched) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  touched.clear();
});

/* ------------------------------------------------------------------ api-key mode */

describe("Sarvam auth: api-key mode (default, Cloudflare/klyro/worker)", () => {
  for (const [label, extra] of [
    ["auth omitted", {}],
    ["auth: 'api-key'", { auth: "api-key" as const }],
  ] as const) {
    test(`${label}: exactly one credential header, api-subscription-key = the key`, async () => {
      setEnv(SDK_ENV);
      const fake = fakeSarvam();
      const m = createSarvamLlm({ ...extra, apiKey: KEY, fetch: fake.fetch });
      assert.equal(await chatOnce(m), "Hi");
      assert.equal(fake.requests.length, 1);
      const q = fake.requests[0]!;
      assert.equal(q.url, "https://api.sarvam.ai/v1/chat/completions", "OPENAI_BASE_URL ignored");
      assert.equal(q.headers.get("api-subscription-key"), KEY);
      assert.equal(q.headers.get("authorization"), null, "no duplicate Bearer copy");
      assert.equal(q.headers.get("api-key"), null);
      assert.equal(q.headers.get("openai-organization"), null, "OPENAI_ORG_ID not forwarded");
      assert.equal(q.headers.get("openai-project"), null, "OPENAI_PROJECT_ID not forwarded");
      const values = allValues(q.headers);
      assert.equal(values.split(KEY).length - 1, 1, "the key is in exactly one header");
      assert.ok(!values.includes(SDK_ENV.OPENAI_API_KEY), "OPENAI_API_KEY never sent");
    });
  }

  test("proxy-looking environment does not switch an api-key caller into proxy mode", async () => {
    setEnv(PROXY_LOOKING_ENV);
    const fake = fakeSarvam();
    await chatOnce(createSarvamLlm({ apiKey: KEY, fetch: fake.fetch }));
    assert.equal(fake.requests[0]!.headers.get("api-subscription-key"), KEY);
  });

  test("the worker (buildLlm from config) uses api-key mode with SARVAM_API_KEY", async () => {
    setEnv(PROXY_LOOKING_ENV);
    const fake = fakeSarvam();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fake.fetch; // captured when the client is built
    let model: llm.LLM;
    try {
      model = buildLlm(
        loadConfig({
          LIVEKIT_URL: "ws://localhost:7880",
          LIVEKIT_API_KEY: "k",
          LIVEKIT_API_SECRET: "s".repeat(32),
          SARVAM_API_KEY: KEY,
          KLYRO_BASE_URL: "http://localhost:3000",
          VOICE_AGENT_HMAC_SECRET: "h".repeat(32),
          LLM_PROVIDER: "sarvam",
          // Development-only override: a dead local port, so nothing can leave even if the stub failed.
          SARVAM_LLM_BASE_URL: "http://127.0.0.1:9/v1",
        }),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    await chatOnce(model);
    assert.equal(fake.requests.length, 1, "the stubbed fetch handled the request");
    const h = fake.requests[0]!.headers;
    assert.equal(h.get("api-subscription-key"), KEY);
    assert.equal(h.get("authorization"), null);
  });

  test("missing, empty or blank key is refused at construction", () => {
    for (const apiKey of [undefined, "", "   "])
      assert.throws(
        () => createSarvamClient({ apiKey } as unknown as SarvamLlmOptions),
        SarvamAuthConfigError,
      );
  });

  test("the proxy-mode placeholder is refused as a key", () => {
    assert.throws(() => resolveSarvamAuth({ apiKey: PLACEHOLDER }), SarvamAuthConfigError);
  });
});

/* ------------------------------------------------------------------ proxy-injected mode */

describe("Sarvam auth: proxy-injected mode (explicit only)", () => {
  test("no credential header leaves the process; request goes to api.sarvam.ai", async () => {
    setEnv(SDK_ENV);
    const fake = fakeSarvam();
    const m = createSarvamLlm({ auth: "proxy-injected", fetch: fake.fetch });
    assert.equal(await chatOnce(m), "Hi");
    assert.equal(fake.requests.length, 1);
    const q = fake.requests[0]!;
    assert.equal(q.url, "https://api.sarvam.ai/v1/chat/completions");
    for (const h of CREDENTIAL_HEADERS) assert.equal(q.headers.get(h), null, `${h} must be absent`);
    assert.equal(q.headers.get("openai-organization"), null);
    assert.equal(q.headers.get("openai-project"), null);
    const values = allValues(q.headers);
    assert.ok(!values.includes(PLACEHOLDER), "the SDK placeholder is never sent");
    assert.ok(!values.includes(SDK_ENV.OPENAI_API_KEY), "OPENAI_API_KEY never sent");
    assert.ok(!values.includes(KEY));
  });

  test("an apiKey alongside proxy-injected is refused (no local key in this mode)", () => {
    assert.throws(
      () =>
        createSarvamClient({ auth: "proxy-injected", apiKey: KEY } as unknown as SarvamLlmOptions),
      (e: Error) => e instanceof SarvamAuthConfigError && !e.message.includes(KEY),
    );
  });

  test("only https://api.sarvam.ai is accepted as the base URL", () => {
    for (const baseURL of [
      "http://api.sarvam.ai/v1",
      "https://api.sarvam.ai:8443/v1",
      "https://api.sarvam.ai.evil.example/v1",
      "https://example.com/v1",
      "not a url",
    ])
      assert.throws(
        () => resolveSarvamAuth({ auth: "proxy-injected", baseURL }),
        SarvamAuthConfigError,
        baseURL,
      );
    assert.deepEqual(resolveSarvamAuth({ auth: "proxy-injected" }), { mode: "proxy-injected" });
  });

  test("unknown or differently spelled modes are refused, never treated as proxy mode", () => {
    for (const auth of ["proxy", "Proxy-Injected", "PROXY-INJECTED", "auto", "", null, true])
      assert.throws(() => resolveSarvamAuth({ auth, apiKey: KEY }), SarvamAuthConfigError);
  });
});

/* ------------------------------------------------------------------ the guard */

describe("Sarvam auth guard: conflicting headers are never sent", () => {
  async function attempt(
    opts: SarvamLlmOptions,
    headers: Record<string, string>,
  ): Promise<{ sent: number; error: any }> {
    const fake = fakeSarvam();
    const client = createSarvamClient({ ...opts, fetch: fake.fetch } as SarvamLlmOptions);
    let error: any = null;
    try {
      await client.chat.completions.create(
        { model: "sarvam-105b-conversations", messages: [{ role: "user", content: "hi" }] },
        { headers },
      );
    } catch (e) {
      error = e;
    }
    return { sent: fake.requests.length, error };
  }
  const guardCause = (e: any) => {
    for (let x = e; x; x = x.cause) if (x instanceof SarvamAuthGuardError) return x;
    return null;
  };

  for (const [name, value] of [
    ["api-subscription-key", "sk_other"],
    ["Authorization", "Bearer sk_other"],
    ["api-key", "sk_other"],
    ["OpenAI-Organization", "org_x"],
  ] as const) {
    test(`proxy-injected: a per-request ${name} header is refused before sending`, async () => {
      const r = await attempt({ auth: "proxy-injected" }, { [name]: value });
      assert.equal(r.sent, 0, "nothing reached the network layer");
      const g = guardCause(r.error);
      assert.ok(g, "refused by the auth guard");
      assert.ok(!g.message.includes(value), "the message names headers, never values");
    });
  }

  for (const [name, value] of [
    ["Authorization", `Bearer ${KEY}`],
    ["Authorization", "Bearer sk_other"],
    ["api-subscription-key", "sk_other"],
    ["api-key", KEY],
  ] as const) {
    test(`api-key: a conflicting/duplicate ${name} header is refused before sending`, async () => {
      const r = await attempt({ apiKey: KEY }, { [name]: value });
      assert.equal(r.sent, 0);
      const g = guardCause(r.error);
      assert.ok(g, "refused by the auth guard");
      assert.ok(!g.message.includes(KEY) && !g.message.includes("sk_other"));
    });
  }

  test("guard unit: Request objects are inspected too", async () => {
    let called = 0;
    const base = (async () => {
      called++;
      return new Response("ok");
    }) as typeof fetch;
    const guarded = sarvamAuthGuard({ mode: "proxy-injected" }, base);
    await assert.rejects(
      guarded(
        new Request("https://api.sarvam.ai/v1/chat/completions", {
          headers: { "api-subscription-key": "x" },
        }),
      ),
      SarvamAuthGuardError,
    );
    await assert.rejects(guarded("https://example.com/v1/x"), SarvamAuthGuardError);
    assert.equal(called, 0);
    await guarded("https://api.sarvam.ai/v1/chat/completions");
    assert.equal(called, 1);
  });

  test("api-key: a duplicated key header (two values) is a problem", () => {
    const h = new Headers();
    h.append("api-subscription-key", KEY);
    h.append("api-subscription-key", KEY);
    const p = sarvamAuthProblems(
      { mode: "api-key", apiKey: KEY },
      new URL("https://api.sarvam.ai/v1"),
      h,
    );
    assert.ok(p.length > 0);
    assert.ok(!p.join(" ").includes(KEY));
  });
});
