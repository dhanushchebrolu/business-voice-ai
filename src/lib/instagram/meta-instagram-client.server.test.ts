import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MetaInstagramClient, MetaApiError } from "./meta-instagram-client.server.ts";

/** Every test injects fetchImpl — never a real network call (same requirement as meta-client.server.test.ts). */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(fetchImpl: typeof fetch) {
  return new MetaInstagramClient({
    appId: "test-app-id",
    appSecret: "test-app-secret-should-never-leak",
    graphApiVersion: "v23.0",
    fetchImpl,
  });
}

describe("OAuth mechanics (shared base)", () => {
  test("exchangeAuthorizationCode requests GET /{version}/oauth/access_token", async () => {
    let capturedUrl: URL | undefined;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl = new URL(String(input));
      return jsonResponse(200, { access_token: "tok-123" });
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    const result = await client.exchangeAuthorizationCode("auth-code-xyz");
    assert.equal(result.accessToken, "tok-123");
    assert.equal(capturedUrl?.pathname, "/v23.0/oauth/access_token");
    assert.equal(capturedUrl?.searchParams.get("code"), "auth-code-xyz");
  });

  test("exchangeForLongLivedToken requests grant_type=fb_exchange_token", async () => {
    let capturedUrl: URL | undefined;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl = new URL(String(input));
      return jsonResponse(200, { access_token: "long-lived-tok", expires_in: 5184000 });
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    const result = await client.exchangeForLongLivedToken("short-lived-tok");
    assert.equal(result.accessToken, "long-lived-tok");
    assert.equal(result.expiresIn, 5184000);
    assert.equal(capturedUrl?.searchParams.get("grant_type"), "fb_exchange_token");
    assert.equal(capturedUrl?.searchParams.get("fb_exchange_token"), "short-lived-tok");
  });
});

describe("listPagesWithInstagramAccounts", () => {
  test("parses Pages with a linked Instagram business account", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, {
        data: [
          { id: "page-1", name: "Demo Cafe", instagram_business_account: { id: "ig-1" } },
          { id: "page-2", name: "No IG Page" },
        ],
      })) as typeof fetch;
    const client = makeClient(fetchImpl);
    const result = await client.listPagesWithInstagramAccounts("tok");
    assert.deepEqual(result, [
      { pageId: "page-1", pageName: "Demo Cafe", instagramBusinessAccountId: "ig-1" },
      { pageId: "page-2", pageName: "No IG Page", instagramBusinessAccountId: null },
    ]);
  });

  test("returns an empty list when there is no data array", async () => {
    const fetchImpl = (async () => jsonResponse(200, {})) as typeof fetch;
    const client = makeClient(fetchImpl);
    const result = await client.listPagesWithInstagramAccounts("tok");
    assert.deepEqual(result, []);
  });
});

describe("getInstagramAccount", () => {
  test("requests GET /{version}/{igId} with the expected fields", async () => {
    let capturedUrl: URL | undefined;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      capturedUrl = new URL(String(input));
      return jsonResponse(200, { id: "ig-1", username: "democafe", name: "Demo Cafe" });
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    const result = await client.getInstagramAccount("ig-1", "tok");
    assert.equal(capturedUrl?.pathname, "/v23.0/ig-1");
    assert.equal(capturedUrl?.searchParams.get("fields"), "id,username,name,profile_picture_url");
    assert.deepEqual(result, {
      id: "ig-1",
      username: "democafe",
      name: "Demo Cafe",
      profilePictureUrl: null,
    });
  });

  test("throws a safe error if Meta's response has no id", async () => {
    const fetchImpl = (async () => jsonResponse(200, { username: "x" })) as typeof fetch;
    const client = makeClient(fetchImpl);
    await assert.rejects(() => client.getInstagramAccount("ig-1", "tok"), MetaApiError);
  });
});

describe("subscribePageWebhook", () => {
  test("POSTs /{version}/{pageId}/subscribed_apps with subscribed_fields=messages,comments", async () => {
    let capturedUrl: URL | undefined;
    let capturedMethod: string | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = new URL(String(input));
      capturedMethod = init?.method;
      return jsonResponse(200, { success: true });
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    const result = await client.subscribePageWebhook("page-1", "tok");
    assert.equal(capturedMethod, "POST");
    assert.equal(capturedUrl?.pathname, "/v23.0/page-1/subscribed_apps");
    assert.equal(capturedUrl?.searchParams.get("subscribed_fields"), "messages,comments");
    assert.deepEqual(result, { success: true });
  });
});

describe("sendDirectMessage", () => {
  test("POSTs {recipient:{id},message:{text}} and returns the message id", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, { message_id: "mid.ABC" });
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    const result = await client.sendDirectMessage("ig-1", "igsid-999", "Hello!", "tok");
    assert.equal(result.messageId, "mid.ABC");
    assert.deepEqual(capturedBody?.["recipient"], { id: "igsid-999" });
    assert.deepEqual(capturedBody?.["message"], { text: "Hello!" });
  });

  test("throws MetaApiError (never fabricates a message id) when neither message_id nor id is present", async () => {
    const fetchImpl = (async () => jsonResponse(200, {})) as typeof fetch;
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.sendDirectMessage("ig-1", "igsid-999", "hi", "tok"),
      MetaApiError,
    );
  });
});

describe("sendPrivateReplyToComment", () => {
  test("POSTs /{version}/{commentId}/private_replies with {message} and returns the message id", async () => {
    let capturedUrl: URL | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = new URL(String(input));
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, { message_id: "mid.PRIVATE1" });
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    const result = await client.sendPrivateReplyToComment("comment-1", "Thanks! DM sent.", "tok");
    assert.equal(capturedUrl?.pathname, "/v23.0/comment-1/private_replies");
    assert.equal(capturedBody?.["message"], "Thanks! DM sent.");
    assert.deepEqual(result, { messageId: "mid.PRIVATE1" });
  });

  test("throws MetaApiError when neither message_id nor id is present", async () => {
    const fetchImpl = (async () => jsonResponse(200, {})) as typeof fetch;
    const client = makeClient(fetchImpl);
    await assert.rejects(
      () => client.sendPrivateReplyToComment("comment-1", "hi", "tok"),
      MetaApiError,
    );
  });
});

describe("replyToComment", () => {
  test("POSTs /{version}/{commentId}/replies with {message}", async () => {
    let capturedUrl: URL | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = new URL(String(input));
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, { id: "reply-1" });
    }) as typeof fetch;
    const client = makeClient(fetchImpl);
    const result = await client.replyToComment("comment-1", "Thanks for your comment!", "tok");
    assert.equal(capturedUrl?.pathname, "/v23.0/comment-1/replies");
    assert.equal(capturedBody?.["message"], "Thanks for your comment!");
    assert.deepEqual(result, { replyId: "reply-1" });
  });
});

describe("error handling (shared base)", () => {
  test("maps a 401 to a safe MetaApiError without leaking the app secret", async () => {
    const fetchImpl = (async () =>
      jsonResponse(401, { error: { message: "Invalid OAuth access token." } })) as typeof fetch;
    const client = new MetaInstagramClient({
      appId: "a",
      appSecret: "super-secret-value-must-not-leak",
      graphApiVersion: "v23.0",
      fetchImpl,
    });
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

  test("a non-JSON error body still produces a safe MetaApiError, not a crash", async () => {
    const fetchImpl = (async () =>
      new Response("<html>Service Unavailable</html>", { status: 503 })) as typeof fetch;
    const client = makeClient(fetchImpl);
    await assert.rejects(() => client.getInstagramAccount("ig-1", "tok"), MetaApiError);
  });
});
