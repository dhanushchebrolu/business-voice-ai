import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifyMetaWebhookSignature,
  signMetaWebhookBody,
} from "./meta-webhook-signature.server.ts";

const SECRET = "test-app-secret";
const BODY = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

describe("verifyMetaWebhookSignature", () => {
  test("accepts Meta's exact header format (sha256=<hex HMAC of the raw body>)", () => {
    const header = "sha256=" + createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex");
    assert.equal(verifyMetaWebhookSignature(BODY, header, SECRET), true);
    assert.equal(signMetaWebhookBody(BODY, SECRET), header);
  });

  test("accepts upper-case hex", () => {
    const header = signMetaWebhookBody(BODY, SECRET);
    assert.equal(
      verifyMetaWebhookSignature(BODY, "sha256=" + header.slice(7).toUpperCase(), SECRET),
      true,
    );
  });

  test("rejects a signature made with a different secret", () => {
    assert.equal(
      verifyMetaWebhookSignature(BODY, signMetaWebhookBody(BODY, "other"), SECRET),
      false,
    );
  });

  test("rejects when the body was changed after signing (even whitespace)", () => {
    const header = signMetaWebhookBody(BODY, SECRET);
    assert.equal(verifyMetaWebhookSignature(BODY + " ", header, SECRET), false);
    assert.equal(
      verifyMetaWebhookSignature(JSON.stringify(JSON.parse(BODY), null, 2), header, SECRET),
      false,
    );
  });

  test("fails closed with no secret configured, even for a body signed with an empty secret", () => {
    assert.equal(verifyMetaWebhookSignature(BODY, signMetaWebhookBody(BODY, ""), ""), false);
    assert.equal(
      verifyMetaWebhookSignature(BODY, signMetaWebhookBody(BODY, SECRET), undefined),
      false,
    );
  });

  test("rejects missing, wrong-prefix, truncated and non-hex headers without throwing", () => {
    const good = signMetaWebhookBody(BODY, SECRET);
    for (const header of [
      null,
      undefined,
      "",
      "sha256=",
      good.replace("sha256=", "sha1="),
      good.slice(7), // no prefix
      good.slice(0, -2),
      good.slice(0, -1) + "z",
      good + "00",
    ]) {
      assert.equal(verifyMetaWebhookSignature(BODY, header, SECRET), false, String(header));
    }
  });
});
