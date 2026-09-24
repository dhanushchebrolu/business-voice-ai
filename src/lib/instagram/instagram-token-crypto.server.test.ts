import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  encryptCredential,
  decryptCredential,
  CredentialCryptoError,
} from "./instagram-token-crypto.server.ts";

/** Mirrors whatsapp-token-crypto.server.test.ts's coverage exactly, against the Instagram-specific key/module. */

function freshKey(): string {
  return randomBytes(32).toString("base64");
}

beforeEach(() => {
  process.env["INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY"] = freshKey();
});

describe("round trip", () => {
  test("encrypts then decrypts back to the original plaintext", () => {
    const plaintext = "IGAAsomeLongLivedAccessToken1234567890";
    const ciphertext = encryptCredential(plaintext);
    assert.equal(decryptCredential(ciphertext), plaintext);
  });

  test("ciphertext never contains the plaintext substring", () => {
    const plaintext = "super-secret-instagram-token-value";
    const ciphertext = encryptCredential(plaintext);
    assert.doesNotMatch(ciphertext, new RegExp(plaintext));
  });

  test("ciphertext is versioned and dot-delimited", () => {
    const ciphertext = encryptCredential("x");
    assert.match(
      ciphertext,
      /^instagram_cred\.v1\.[A-Za-z0-9+/=_-]+\.[A-Za-z0-9+/=_-]+\.[A-Za-z0-9+/=_-]+$/,
    );
  });

  test("two encryptions of the same plaintext produce different ciphertext (fresh IV)", () => {
    const a = encryptCredential("same-value");
    const b = encryptCredential("same-value");
    assert.notEqual(a, b);
  });
});

describe("key handling", () => {
  test("throws when the key is not configured", () => {
    delete process.env["INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY"];
    assert.throws(() => encryptCredential("x"), CredentialCryptoError);
  });

  test("throws when the key is the wrong length", () => {
    process.env["INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY"] =
      Buffer.from("too-short").toString("base64");
    assert.throws(() => encryptCredential("x"), CredentialCryptoError);
  });

  test("decrypting with a different key fails loudly rather than returning garbage", () => {
    const ciphertext = encryptCredential("secret");
    process.env["INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY"] = freshKey();
    assert.throws(() => decryptCredential(ciphertext), CredentialCryptoError);
  });

  test("a WhatsApp-format ciphertext is rejected by the Instagram decrypter (different version tag)", () => {
    assert.throws(
      () => decryptCredential("whatsapp_cred.v1.aaaa.bbbb.cccc"),
      CredentialCryptoError,
    );
  });
});

describe("tamper detection", () => {
  test("a bit-flipped ciphertext fails authentication rather than decrypting to corrupt plaintext", () => {
    const ciphertext = encryptCredential("original-value");
    const parts = ciphertext.split(".");
    const tampered = [...parts.slice(0, 4), parts[4]!.slice(0, -2) + "zz"].join(".");
    assert.throws(() => decryptCredential(tampered), CredentialCryptoError);
  });

  test("a malformed ciphertext string never throws anything other than CredentialCryptoError", () => {
    assert.throws(() => decryptCredential("not-even-close-to-valid"), CredentialCryptoError);
    assert.throws(() => decryptCredential(""), CredentialCryptoError);
  });
});

describe("input validation", () => {
  test("refuses to encrypt an empty plaintext", () => {
    assert.throws(() => encryptCredential(""), CredentialCryptoError);
  });
});
