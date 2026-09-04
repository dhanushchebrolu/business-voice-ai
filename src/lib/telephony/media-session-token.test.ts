import { test } from "node:test";
import assert from "node:assert/strict";
import { mintMediaSessionToken, verifyMediaSessionToken } from "./media-session-token.ts";

const payload = {
  callId: "11111111-1111-1111-1111-111111111111",
  providerCallId: "CAtest123",
  organizationId: "22222222-2222-2222-2222-222222222222",
};

test("mint + verify round trip succeeds", () => {
  process.env["MEDIA_SESSION_TOKEN_SECRET"] = "test-secret";
  const token = mintMediaSessionToken({ ...payload, exp: Math.floor(Date.now() / 1000) + 60 });
  const result = verifyMediaSessionToken(token);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payload.callId, payload.callId);
    assert.equal(result.payload.organizationId, payload.organizationId);
  }
});

test("expired token is rejected", () => {
  process.env["MEDIA_SESSION_TOKEN_SECRET"] = "test-secret";
  const token = mintMediaSessionToken({ ...payload, exp: Math.floor(Date.now() / 1000) - 10 });
  const result = verifyMediaSessionToken(token);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "expired");
});

test("tampered signature is rejected", () => {
  process.env["MEDIA_SESSION_TOKEN_SECRET"] = "test-secret";
  const token = mintMediaSessionToken({ ...payload, exp: Math.floor(Date.now() / 1000) + 60 });
  const [body] = token.split(".");
  const tampered = `${body}.not-the-real-signature-aaaaaaaaaaaaaaaaaaaaaaaa`;
  const result = verifyMediaSessionToken(tampered);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_signature");
});

test("token signed with a different secret is rejected (cross-tenant / forged token style attack)", () => {
  process.env["MEDIA_SESSION_TOKEN_SECRET"] = "secret-a";
  const token = mintMediaSessionToken({ ...payload, exp: Math.floor(Date.now() / 1000) + 60 });
  process.env["MEDIA_SESSION_TOKEN_SECRET"] = "secret-b";
  const result = verifyMediaSessionToken(token);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "invalid_signature");
  process.env["MEDIA_SESSION_TOKEN_SECRET"] = "secret-a"; // restore for subsequent tests
});

test("malformed token string is rejected without throwing", () => {
  process.env["MEDIA_SESSION_TOKEN_SECRET"] = "test-secret";
  assert.doesNotThrow(() => verifyMediaSessionToken("not-a-real-token"));
  const result = verifyMediaSessionToken("not-a-real-token");
  assert.equal(result.ok, false);
});

test("missing secret configuration fails closed, never throws", () => {
  delete process.env["MEDIA_SESSION_TOKEN_SECRET"];
  const result = verifyMediaSessionToken("anything.anything");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not_configured");
});
