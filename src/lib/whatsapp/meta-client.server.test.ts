import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MetaWhatsAppClient, MetaApiError } from "./meta-client.server.ts";

/**
 * Every test here injects fetchImpl — never a real network call, per
 * Phase 2's explicit requirement (spec §N: "Do NOT make real Meta API
 * calls from automated tests").
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(
  fetchImpl: typeof fetch,
  overrides: Partial<{ appId: string; appSecret: string; graphApiVersion: string }> = {},
) {
  return new MetaWhatsAppClient({
    appId: overrides.appId ?? "test-app-id",
    appSecret: overrides.appSecret ?? "test-app-secret-should-never-leak",
    graphApiVersion: overrides.graphApiVersion ?? "v23.0",
    fetchImpl,
  });
}

describe("request construction", () => {
  test("exchangeAuthorizationCode requests GET /{version}/oauth/access_token with client_id, client_secret, code", async () => {
    let capturedUrl: URL | undefined;
    let capturedMethod: string | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = new URL(String(input));
      capturedMethod = init?.method;
      return jsonResponse(200, { access_token: "tok-123", token_type: "bearer" });
    }) as typeof fetch;

    const client = makeClient(fetchImpl, { appId: "my-app-id", appSecret: "my-app-secret" });
    await client.exchangeAuthorizationCode("auth-code-xyz");

    assert.equal(capturedMethod, "GET");
    assert.equal(capturedUrl?.origin, "https://graph.facebook.com");
    assert.equal(capturedUrl?.pathname, "/v23.0/oauth/access_token");
    assert.equal(capturedUrl?.searchParams.get("client_id"), "my-app-id");
    assert.equal(capturedUrl?.searchParams.get("client_secret"), "my-app-secret");
    assert.equal(capturedUrl?.searchParams.get("code"), "auth-code-xyz");
  });

  test("getPhoneNumber requests GET /{version}/{phoneNumberId} with a Bearer token and the expected fields", async () => {
    let capturedUrl: URL | undefined;
    let capturedHeaders: Headers | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = new URL(String(input));
      capturedHeaders = new Headers(init?.headers);
      return jsonResponse(200, {
        id: "1234567890",
        display_phone_number: "+91 98765 43210",
        verified_name: "ClickAI Demo",
        quality_rating: "GREEN",
      });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.getPhoneNumber("1234567890", "access-token-abc");

    assert.equal(capturedUrl?.pathname, "/v23.0/1234567890");
    assert.equal(
      capturedUrl?.searchParams.get("fields"),
      "id,display_phone_number,verified_name,quality_rating",
    );
    assert.equal(capturedHeaders?.get("authorization"), "Bearer access-token-abc");
    assert.deepEqual(result, {
      id: "1234567890",
      displayPhoneNumber: "+91 98765 43210",
      verifiedName: "ClickAI Demo",
      qualityRating: "GREEN",
    });
  });

  test("registerPhoneNumber POSTs {messaging_product, pin} with a Bearer token", async () => {
    let capturedUrl: URL | undefined;
    let capturedMethod: string | undefined;
    let capturedBody: unknown;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = new URL(String(input));
      capturedMethod = init?.method;
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, { success: true });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.registerPhoneNumber("1234567890", "042871", "access-token-abc");

    assert.equal(capturedMethod, "POST");
    assert.equal(capturedUrl?.pathname, "/v23.0/1234567890/register");
    assert.deepEqual(capturedBody, { messaging_product: "whatsapp", pin: "042871" });
    assert.deepEqual(result, { success: true });
  });

  test("subscribeApp POSTs to /{version}/{wabaId}/subscribed_apps with an empty body", async () => {
    let capturedUrl: URL | undefined;
    let capturedMethod: string | undefined;
    let capturedBody: string | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = new URL(String(input));
      capturedMethod = init?.method;
      capturedBody = init?.body as string | undefined;
      return jsonResponse(200, { success: true });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.subscribeApp("waba-999", "access-token-abc");

    assert.equal(capturedMethod, "POST");
    assert.equal(capturedUrl?.pathname, "/v23.0/waba-999/subscribed_apps");
    assert.equal(
      capturedBody,
      undefined,
      "no override_callback_uri/verify_token body — the app-level callback is used",
    );
    assert.deepEqual(result, { success: true });
  });

  test("uses the configured graphApiVersion, not a hardcoded one", async () => {
    let capturedUrl: URL | undefined;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl = new URL(String(input));
      return jsonResponse(200, { access_token: "tok" });
    }) as typeof fetch;
    const client = makeClient(fetchImpl, { graphApiVersion: "v99.0" });
    await client.exchangeAuthorizationCode("code");
    assert.equal(capturedUrl?.pathname.startsWith("/v99.0/"), true);
  });
});

describe("error handling", () => {
  test("maps a 401 to a safe MetaApiError without leaking the app secret", async () => {
    const fetchImpl = (async () =>
      jsonResponse(401, {
        error: { message: "Invalid OAuth access token.", code: 190 },
      })) as typeof fetch;
    const client = makeClient(fetchImpl, { appSecret: "super-secret-value-must-not-leak" });
    await assert.rejects(
      () => client.exchangeAuthorizationCode("bad-code"),
      (err: unknown) => {
        assert.ok(err instanceof MetaApiError);
        assert.equal(err.status, 401);
        assert.doesNotMatch(err.message, /super-secret-value-must-not-leak/);
        return true;
      },
    );
  });

  test("maps a 403 to a safe MetaApiError (token doesn't cover this asset)", async () => {
    const fetchImpl = (async () =>
      jsonResponse(403, { error: { message: "Unsupported request", code: 100 } })) as typeof fetch;
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.getPhoneNumber("999", "tok"),
      (err: unknown) => {
        assert.ok(err instanceof MetaApiError);
        assert.equal(err.status, 403);
        return true;
      },
    );
  });

  test("maps a 429 to a retryable MetaApiError", async () => {
    const fetchImpl = (async () =>
      jsonResponse(429, { error: { message: "rate limited" } })) as typeof fetch;
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.subscribeApp("waba", "tok"),
      (err: unknown) => {
        assert.ok(err instanceof MetaApiError);
        assert.equal(err.status, 429);
        return true;
      },
    );
  });

  test("maps a 500 to a retryable 503 MetaApiError", async () => {
    const fetchImpl = (async () =>
      jsonResponse(500, { error: { message: "internal error" } })) as typeof fetch;
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.registerPhoneNumber("1", "042871", "tok"),
      (err: unknown) => {
        assert.ok(err instanceof MetaApiError);
        assert.equal(err.status, 503);
        return true;
      },
    );
  });

  test("a network/timeout failure never includes the app secret", async () => {
    const fetchImpl = (async () => {
      throw new Error("network unreachable");
    }) as typeof fetch;
    const client = makeClient(fetchImpl, { appSecret: "another-secret-value" });
    await assert.rejects(
      () => client.exchangeAuthorizationCode("code"),
      (err: unknown) => {
        assert.ok(err instanceof MetaApiError);
        assert.doesNotMatch(err.message, /another-secret-value/);
        return true;
      },
    );
  });

  test("an AbortError (timeout) maps to a safe 503 MetaApiError", async () => {
    const fetchImpl = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.exchangeAuthorizationCode("code"),
      (err: unknown) => {
        assert.ok(err instanceof MetaApiError);
        assert.equal(err.status, 503);
        return true;
      },
    );
  });

  test("exchangeAuthorizationCode throws a safe error if Meta's 200 response has no access_token", async () => {
    const fetchImpl = (async () => jsonResponse(200, { token_type: "bearer" })) as typeof fetch;
    const client = makeClient(fetchImpl);
    await assert.rejects(() => client.exchangeAuthorizationCode("code"), MetaApiError);
  });

  test("getPhoneNumber throws a safe error if Meta's 200 response has no id", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { display_phone_number: "+911234567890" })) as typeof fetch;
    const client = makeClient(fetchImpl);
    await assert.rejects(() => client.getPhoneNumber("1", "tok"), MetaApiError);
  });

  test("a non-JSON error body still produces a safe MetaApiError, not a crash", async () => {
    const fetchImpl = (async () =>
      new Response("<html>Service Unavailable</html>", { status: 503 })) as typeof fetch;
    const client = makeClient(fetchImpl);
    await assert.rejects(() => client.subscribeApp("waba", "tok"), MetaApiError);
  });
});

describe("secret handling", () => {
  test("the app secret never appears in a thrown error's message across any failure mode", async () => {
    const secret = "app-secret-that-must-never-surface";
    const scenarios: (() => Promise<unknown>)[] = [
      async () => {
        const client = makeClient(
          (async () => jsonResponse(400, { error: { message: "bad" } })) as typeof fetch,
          {
            appSecret: secret,
          },
        );
        return client.exchangeAuthorizationCode("code");
      },
      async () => {
        const client = makeClient(
          (async () => {
            throw new Error("boom");
          }) as typeof fetch,
          { appSecret: secret },
        );
        return client.exchangeAuthorizationCode("code");
      },
    ];
    for (const run of scenarios) {
      try {
        await run();
        assert.fail("expected rejection");
      } catch (err) {
        assert.doesNotMatch((err as Error).message, new RegExp(secret));
      }
    }
  });
});

describe("sendTextMessage", () => {
  test("POSTs /{version}/{phone-number-id}/messages with messaging_product/to/type=text/text.body", async () => {
    let capturedUrl: URL | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    let capturedAuth: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = new URL(String(input));
      capturedBody = JSON.parse(String(init?.body));
      capturedAuth = (init?.headers as Record<string, string>)["Authorization"] ?? null;
      return jsonResponse(200, {
        messaging_product: "whatsapp",
        contacts: [{ input: "+919876543210", wa_id: "919876543210" }],
        messages: [{ id: "wamid.ABC123" }],
      });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.sendTextMessage(
      "phone-number-id-1",
      "+919876543210",
      "Here is your payment link: https://rzp.io/i/abc",
      "access-token-xyz",
    );

    assert.equal(result.messageId, "wamid.ABC123");
    assert.equal(capturedUrl?.pathname, "/v23.0/phone-number-id-1/messages");
    assert.equal(capturedBody?.["messaging_product"], "whatsapp");
    assert.equal(capturedBody?.["to"], "+919876543210");
    assert.equal(capturedBody?.["type"], "text");
    assert.deepEqual(capturedBody?.["text"], {
      body: "Here is your payment link: https://rzp.io/i/abc",
    });
    assert.equal(capturedAuth, "Bearer access-token-xyz");
  });

  test("throws MetaApiError (never fabricates a message id) when the response has no messages array", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { messaging_product: "whatsapp" })) as typeof fetch;
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.sendTextMessage("phone-id", "+91123", "hi", "token"),
      MetaApiError,
    );
  });
});

describe("sendTemplateMessage", () => {
  test("POSTs a template payload with name/language/body parameters", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, { messages: [{ id: "wamid.TEMPLATE1" }] });
    }) as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.sendTemplateMessage(
      "phone-id",
      "+919876543210",
      "payment_link_notify",
      "en_US",
      ["Priya", "https://rzp.io/i/abc"],
      "access-token-xyz",
    );

    assert.equal(result.messageId, "wamid.TEMPLATE1");
    assert.equal(capturedBody?.["type"], "template");
    const template = capturedBody?.["template"] as Record<string, unknown>;
    assert.equal(template["name"], "payment_link_notify");
    assert.deepEqual(template["language"], { code: "en_US" });
    const components = template["components"] as { parameters: { text: string }[] }[];
    assert.equal(components[0]!.parameters[0]!.text, "Priya");
    assert.equal(components[0]!.parameters[1]!.text, "https://rzp.io/i/abc");
  });

  test("omits the components array entirely when no body params are given", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, { messages: [{ id: "wamid.TEMPLATE2" }] });
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    await client.sendTemplateMessage(
      "phone-id",
      "+91123",
      "generic_notice",
      "en_US",
      undefined,
      "token",
    );
    const template = capturedBody?.["template"] as Record<string, unknown>;
    assert.equal("components" in template, false);
  });
});
