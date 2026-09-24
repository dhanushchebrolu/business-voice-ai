import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  fetchGoogleAccountInfo,
  GoogleOAuthError,
} from "./google-oauth.server.ts";
import type { GoogleCalendarConfig } from "./google-calendar-config.server.ts";

const CONFIG: GoogleCalendarConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "https://clickai.in/api/public/integrations/google-calendar/callback",
};
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

function fakeFetch(response: { status: number; body: unknown }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("buildAuthorizationUrl", () => {
  test("points at Google's consent screen with the right client/redirect/scope/state", () => {
    const url = new URL(buildAuthorizationUrl(CONFIG, SCOPES, "the-state-token"));
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("client_id"), "test-client-id");
    assert.equal(url.searchParams.get("redirect_uri"), CONFIG.redirectUri);
    assert.equal(url.searchParams.get("scope"), SCOPES.join(" "));
    assert.equal(url.searchParams.get("state"), "the-state-token");
    assert.equal(url.searchParams.get("response_type"), "code");
  });

  test("requests offline access + forces consent so a refresh token is always returned", () => {
    const url = new URL(buildAuthorizationUrl(CONFIG, SCOPES, "s"));
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
  });

  test("never includes the client secret in the URL", () => {
    const url = buildAuthorizationUrl(CONFIG, SCOPES, "s");
    assert.doesNotMatch(url, /test-client-secret/);
  });
});

describe("exchangeAuthorizationCode", () => {
  test("returns the access token, refresh token, and expiry on success", async () => {
    const fetchImpl = fakeFetch({
      status: 200,
      body: { access_token: "access-123", refresh_token: "refresh-456", expires_in: 3600 },
    });
    const result = await exchangeAuthorizationCode(CONFIG, "auth-code", fetchImpl);
    assert.deepEqual(result, {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresInSeconds: 3600,
    });
  });

  test("maps invalid_grant to a clear, safe error (expired/reused/revoked code)", async () => {
    const fetchImpl = fakeFetch({
      status: 400,
      body: { error: "invalid_grant", error_description: "Malformed auth code." },
    });
    await assert.rejects(
      () => exchangeAuthorizationCode(CONFIG, "bad-code", fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof GoogleOAuthError);
        assert.equal(err.status, 401);
        return true;
      },
    );
  });

  test("maps a 429 to a rate-limit error", async () => {
    const fetchImpl = fakeFetch({ status: 429, body: { error: "rate_limit" } });
    await assert.rejects(
      () => exchangeAuthorizationCode(CONFIG, "code", fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof GoogleOAuthError);
        assert.equal(err.status, 429);
        return true;
      },
    );
  });

  test("maps a 5xx to a retryable 'temporarily unavailable' error", async () => {
    const fetchImpl = fakeFetch({ status: 503, body: {} });
    await assert.rejects(
      () => exchangeAuthorizationCode(CONFIG, "code", fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof GoogleOAuthError);
        assert.equal(err.status, 503);
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
      GoogleOAuthError,
    );
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
        assert.ok(err instanceof GoogleOAuthError);
        assert.equal(err.status, 401);
        return true;
      },
    );
  });
});

describe("fetchGoogleAccountInfo", () => {
  test("returns the connected account's id and email", async () => {
    const fetchImpl = fakeFetch({
      status: 200,
      body: { id: "google-account-1", email: "business@example.com" },
    });
    const info = await fetchGoogleAccountInfo("access-token", fetchImpl);
    assert.deepEqual(info, { googleAccountId: "google-account-1", email: "business@example.com" });
  });

  test("throws when Google's response is missing an account id", async () => {
    const fetchImpl = fakeFetch({ status: 200, body: { email: "business@example.com" } });
    await assert.rejects(() => fetchGoogleAccountInfo("access-token", fetchImpl), GoogleOAuthError);
  });

  test("throws a GoogleOAuthError (not a raw fetch error) on a failed response", async () => {
    const fetchImpl = fakeFetch({ status: 401, body: {} });
    await assert.rejects(() => fetchGoogleAccountInfo("bad-token", fetchImpl), GoogleOAuthError);
  });
});
