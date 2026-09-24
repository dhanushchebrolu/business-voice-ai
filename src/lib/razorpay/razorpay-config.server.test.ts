import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { validateRazorpayEnv, resolveRazorpayConfig } from "./razorpay-config.server.ts";

const VARS = [
  "RAZORPAY_CLIENT_ID",
  "RAZORPAY_CLIENT_SECRET",
  "RAZORPAY_REDIRECT_URI",
  "RAZORPAY_OAUTH_AUTHORIZE_URL",
  "RAZORPAY_OAUTH_TOKEN_URL",
  "RAZORPAY_OAUTH_SCOPE",
  "RAZORPAY_MERCHANT_DETAILS_URL",
] as const;

let originalValues: Record<string, string | undefined>;

beforeEach(() => {
  originalValues = {};
  for (const key of VARS) {
    originalValues[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of VARS) {
    if (originalValues[key] === undefined) delete process.env[key];
    else process.env[key] = originalValues[key];
  }
});

function setAllRequired(): void {
  process.env["RAZORPAY_CLIENT_ID"] = "test-client-id";
  process.env["RAZORPAY_CLIENT_SECRET"] = "test-client-secret";
  process.env["RAZORPAY_REDIRECT_URI"] =
    "https://example.com/api/public/integrations/razorpay/callback";
  process.env["RAZORPAY_OAUTH_AUTHORIZE_URL"] = "https://example-auth.test/authorize";
  process.env["RAZORPAY_OAUTH_TOKEN_URL"] = "https://example-auth.test/token";
  process.env["RAZORPAY_OAUTH_SCOPE"] = "read_write";
}

describe("validateRazorpayEnv", () => {
  test("reports allPresent=false and lists every missing var when nothing is configured", () => {
    const result = validateRazorpayEnv();
    assert.equal(result.allPresent, false);
    assert.deepEqual(result.missing.sort(), [
      "RAZORPAY_CLIENT_ID",
      "RAZORPAY_CLIENT_SECRET",
      "RAZORPAY_OAUTH_AUTHORIZE_URL",
      "RAZORPAY_OAUTH_SCOPE",
      "RAZORPAY_OAUTH_TOKEN_URL",
      "RAZORPAY_REDIRECT_URI",
    ]);
  });

  test("reports allPresent=true once every required var is set", () => {
    setAllRequired();
    const result = validateRazorpayEnv();
    assert.equal(result.allPresent, true);
    assert.deepEqual(result.missing, []);
  });

  test("does not require RAZORPAY_MERCHANT_DETAILS_URL (optional var)", () => {
    setAllRequired();
    const result = validateRazorpayEnv();
    assert.equal(result.allPresent, true);
    assert.equal(result.missing.includes("RAZORPAY_MERCHANT_DETAILS_URL"), false);
  });

  test("flags exactly one missing var when only that one is absent", () => {
    setAllRequired();
    delete process.env["RAZORPAY_OAUTH_TOKEN_URL"];
    const result = validateRazorpayEnv();
    assert.equal(result.allPresent, false);
    assert.deepEqual(result.missing, ["RAZORPAY_OAUTH_TOKEN_URL"]);
  });

  test("never includes the actual configured values in the validation result", () => {
    setAllRequired();
    const result = validateRazorpayEnv();
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /test-client-secret/);
  });
});

describe("resolveRazorpayConfig", () => {
  test("returns null (never throws) when configuration is incomplete", () => {
    assert.equal(resolveRazorpayConfig(), null);
  });

  test("returns the full config object once everything required is set", () => {
    setAllRequired();
    const config = resolveRazorpayConfig();
    assert.ok(config);
    assert.equal(config!.clientId, "test-client-id");
    assert.equal(config!.clientSecret, "test-client-secret");
    assert.equal(config!.oauthAuthorizeUrl, "https://example-auth.test/authorize");
    assert.equal(config!.oauthTokenUrl, "https://example-auth.test/token");
    assert.equal(config!.oauthScope, "read_write");
  });

  test("merchantDetailsUrl is undefined when unset, and set when configured", () => {
    setAllRequired();
    assert.equal(resolveRazorpayConfig()!.merchantDetailsUrl, undefined);
    process.env["RAZORPAY_MERCHANT_DETAILS_URL"] = "https://example-api.test/merchant";
    assert.equal(resolveRazorpayConfig()!.merchantDetailsUrl, "https://example-api.test/merchant");
  });

  test("returns null when only RAZORPAY_MERCHANT_DETAILS_URL is set and required vars are missing", () => {
    process.env["RAZORPAY_MERCHANT_DETAILS_URL"] = "https://example-api.test/merchant";
    assert.equal(resolveRazorpayConfig(), null);
  });
});
