import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  validateInstagramEnv,
  resolveInstagramConfig,
  buildInstagramAuthorizationUrl,
  INSTAGRAM_OAUTH_SCOPES,
} from "./instagram-config.server.ts";

const ENV_KEYS = [
  "META_APP_ID",
  "META_APP_SECRET",
  "META_GRAPH_API_VERSION",
  "INSTAGRAM_REDIRECT_URI",
];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function setAllEnv() {
  process.env["META_APP_ID"] = "app-123";
  process.env["META_APP_SECRET"] = "secret-should-never-leak";
  process.env["META_GRAPH_API_VERSION"] = "v23.0";
  process.env["INSTAGRAM_REDIRECT_URI"] =
    "https://clickai.in/api/public/integrations/instagram/callback";
}

beforeEach(clearEnv);

describe("validateInstagramEnv / resolveInstagramConfig", () => {
  test("reports every missing variable by name, never a value", () => {
    const result = validateInstagramEnv();
    assert.equal(result.allPresent, false);
    assert.deepEqual(result.missing.sort(), [...ENV_KEYS].sort());
  });

  test("resolveInstagramConfig returns null (never throws) when anything is missing", () => {
    setAllEnv();
    delete process.env["INSTAGRAM_REDIRECT_URI"];
    assert.equal(resolveInstagramConfig(), null);
  });

  test("resolveInstagramConfig returns the full config once everything is set", () => {
    setAllEnv();
    const config = resolveInstagramConfig();
    assert.deepEqual(config, {
      appId: "app-123",
      appSecret: "secret-should-never-leak",
      graphApiVersion: "v23.0",
      redirectUri: "https://clickai.in/api/public/integrations/instagram/callback",
    });
  });
});

describe("buildInstagramAuthorizationUrl", () => {
  test("builds the Facebook OAuth dialog URL with client_id/redirect_uri/scope/state", () => {
    setAllEnv();
    const config = resolveInstagramConfig()!;
    const url = new URL(buildInstagramAuthorizationUrl(config, "state-token-xyz"));
    assert.equal(url.origin, "https://www.facebook.com");
    assert.equal(url.pathname, "/v23.0/dialog/oauth");
    assert.equal(url.searchParams.get("client_id"), "app-123");
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://clickai.in/api/public/integrations/instagram/callback",
    );
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("state"), "state-token-xyz");
    assert.equal(url.searchParams.get("scope"), INSTAGRAM_OAUTH_SCOPES.join(","));
  });

  test("never includes the app secret anywhere in the URL", () => {
    setAllEnv();
    const config = resolveInstagramConfig()!;
    const url = buildInstagramAuthorizationUrl(config, "state");
    assert.doesNotMatch(url, /secret-should-never-leak/);
  });

  test("requests instagram_manage_messages and instagram_manage_comments scopes", () => {
    assert.ok(INSTAGRAM_OAUTH_SCOPES.includes("instagram_manage_messages"));
    assert.ok(INSTAGRAM_OAUTH_SCOPES.includes("instagram_manage_comments"));
  });
});
