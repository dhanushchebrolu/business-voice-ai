import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  fetchMerchantDetails,
  RazorpayOAuthError,
} from "./razorpay-oauth.server.ts";
import type { RazorpayConfig } from "./razorpay-config.server.ts";

const CONFIG: RazorpayConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://clickai.in/api/public/integrations/razorpay/callback",
  oauthAuthorizeUrl: "https://example-auth.test/authorize",
  oauthTokenUrl: "https://example-auth.test/token",
  oauthScope: "read_write",
  merchantDetailsUrl: undefined,
};

function fakeFetch(response: { status: number; body: unknown }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("buildAuthorizationUrl", () => {
  test("points at the configured authorize endpoint with the right client/redirect/scope/state", () => {
    const url = new URL(buildAuthorizationUrl(CONFIG, "the-state-token"));
    assert.equal(url.origin + url.pathname, "https://example-auth.test/authorize");
    assert.equal(url.searchParams.get("client_id"), "test-client-id");
    assert.equal(url.searchParams.get("redirect_uri"), CONFIG.redirectUri);
    assert.equal(url.searchParams.get("scope"), "read_write");
    assert.equal(url.searchParams.get("state"), "the-state-token");
    assert.equal(url.searchParams.get("response_type"), "code");
  });

  test("never includes the client secret in the URL", () => {
    const url = buildAuthorizationUrl(CONFIG, "s");
    assert.doesNotMatch(url, /test-client-secret/);
  });

  test("uses whatever authorize URL is configured, not a hardcoded one", () => {
    const altConfig: RazorpayConfig = {
      ...CONFIG,
      oauthAuthorizeUrl: "https://other-auth.test/authorize",
    };
    const url = new URL(buildAuthorizationUrl(altConfig, "s"));
    assert.equal(url.origin + url.pathname, "https://other-auth.test/authorize");
  });
});

describe("exchangeAuthorizationCode", () => {
  test("returns the access token, refresh token, and expiry on success", async () => {
    const fetchImpl = fakeFetch({
      status: 200,
      body: { access_token: "access-123", refresh_token: "refresh-456", expires_in: 3600 },
    });
    const result = await exchangeAuthorizationCode(CONFIG, "auth-code", fetchImpl);
    assert.equal(result.accessToken, "access-123");
    assert.equal(result.refreshToken, "refresh-456");
    assert.equal(result.expiresInSeconds, 3600);
  });

  test("reads a connected account id when the token response includes one", async () => {
    const fetchImpl = fakeFetch({
      status: 200,
      body: {
        access_token: "access-123",
        refresh_token: "refresh-456",
        expires_in: 3600,
        razorpay_account_id: "acc_ABC123",
      },
    });
    const result = await exchangeAuthorizationCode(CONFIG, "auth-code", fetchImpl);
    assert.equal(result.accountId, "acc_ABC123");
  });

  test("leaves accountId undefined (never invented) when the response has no recognizable field", async () => {
    const fetchImpl = fakeFetch({
      status: 200,
      body: { access_token: "access-123", expires_in: 3600 },
    });
    const result = await exchangeAuthorizationCode(CONFIG, "auth-code", fetchImpl);
    assert.equal(result.accountId, undefined);
  });

  test("maps invalid_grant to a clear, safe, non-retryable error (expired/reused/revoked code)", async () => {
    const fetchImpl = fakeFetch({
      status: 400,
      body: { error: "invalid_grant", error_description: "Malformed auth code." },
    });
    await assert.rejects(
      () => exchangeAuthorizationCode(CONFIG, "bad-code", fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayOAuthError);
        assert.equal(err.status, 401);
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  test("maps a 429 to a retryable rate-limit error", async () => {
    const fetchImpl = fakeFetch({ status: 429, body: { error: "rate_limit" } });
    await assert.rejects(
      () => exchangeAuthorizationCode(CONFIG, "code", fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayOAuthError);
        assert.equal(err.status, 429);
        assert.equal(err.retryable, true);
        return true;
      },
    );
  });

  test("maps a 5xx to a retryable 'temporarily unavailable' error", async () => {
    const fetchImpl = fakeFetch({ status: 503, body: {} });
    await assert.rejects(
      () => exchangeAuthorizationCode(CONFIG, "code", fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayOAuthError);
        assert.equal(err.status, 503);
        assert.equal(err.retryable, true);
        return true;
      },
    );
  });

  test("maps a 401/403 to a non-retryable unauthorized error", async () => {
    const fetchImpl = fakeFetch({ status: 403, body: { error: "access_denied" } });
    await assert.rejects(
      () => exchangeAuthorizationCode(CONFIG, "code", fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayOAuthError);
        assert.equal(err.status, 403);
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  test("a network failure never crashes the caller with an unhandled/raw error", async () => {
    const throwingFetch: typeof fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => exchangeAuthorizationCode(CONFIG, "code", throwingFetch),
      RazorpayOAuthError,
    );
  });

  test("never includes the client secret in the thrown error message", async () => {
    const fetchImpl = fakeFetch({ status: 400, body: { error: "invalid_request" } });
    try {
      await exchangeAuthorizationCode(CONFIG, "code", fetchImpl);
      assert.fail("expected exchangeAuthorizationCode to throw");
    } catch (err) {
      assert.doesNotMatch((err as Error).message, /test-client-secret/);
    }
  });
});

describe("refreshAccessToken", () => {
  test("returns a fresh access token from a stored refresh token", async () => {
    const fetchImpl = fakeFetch({
      status: 200,
      body: { access_token: "new-access", expires_in: 3600 },
    });
    const result = await refreshAccessToken(CONFIG, "stored-refresh-token", fetchImpl);
    assert.equal(result.accessToken, "new-access");
    assert.equal(result.expiresInSeconds, 3600);
  });

  test("maps a revoked/expired refresh token to invalid_grant handling (needs re-auth)", async () => {
    const fetchImpl = fakeFetch({ status: 400, body: { error: "invalid_grant" } });
    await assert.rejects(
      () => refreshAccessToken(CONFIG, "revoked-token", fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayOAuthError);
        assert.equal(err.status, 401);
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });
});

describe("fetchMerchantDetails", () => {
  test("returns null (no network call) when RAZORPAY_MERCHANT_DETAILS_URL is not configured", async () => {
    let called = false;
    const fetchImpl: typeof fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchMerchantDetails(CONFIG, "access-token", fetchImpl);
    assert.equal(result, null);
    assert.equal(called, false);
  });

  test("returns merchant details when a details URL is configured and the response is well-formed", async () => {
    const configured: RazorpayConfig = {
      ...CONFIG,
      merchantDetailsUrl: "https://example-api.test/merchant",
    };
    const fetchImpl = fakeFetch({
      status: 200,
      body: {
        razorpay_account_id: "acc_ABC123",
        business_name: "Example Business",
        email: "business@example.com",
        phone: "+911234567890",
        status: "activated",
      },
    });
    const details = await fetchMerchantDetails(configured, "access-token", fetchImpl);
    assert.deepEqual(details, {
      accountId: "acc_ABC123",
      businessName: "Example Business",
      displayName: undefined,
      email: "business@example.com",
      phone: "+911234567890",
      status: "activated",
    });
  });

  test("throws when the configured endpoint returns 401 (needs re-auth, not a fake success)", async () => {
    const configured: RazorpayConfig = {
      ...CONFIG,
      merchantDetailsUrl: "https://example-api.test/merchant",
    };
    const fetchImpl = fakeFetch({ status: 401, body: {} });
    await assert.rejects(
      () => fetchMerchantDetails(configured, "access-token", fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayOAuthError);
        assert.equal(err.status, 401);
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  test("throws (never returns a fabricated result) when the response has no account id", async () => {
    const configured: RazorpayConfig = {
      ...CONFIG,
      merchantDetailsUrl: "https://example-api.test/merchant",
    };
    const fetchImpl = fakeFetch({ status: 200, body: { email: "business@example.com" } });
    await assert.rejects(
      () => fetchMerchantDetails(configured, "access-token", fetchImpl),
      RazorpayOAuthError,
    );
  });
});
