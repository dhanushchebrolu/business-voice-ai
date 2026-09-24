import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  encryptCredential,
  decryptCredential,
  CredentialCryptoError,
} from "./razorpay-crypto.server.ts";

const ENV_KEY = "RAZORPAY_CREDENTIAL_ENCRYPTION_KEY";
let originalValue: string | undefined;

beforeEach(() => {
  originalValue = process.env[ENV_KEY];
  process.env[ENV_KEY] = randomBytes(32).toString("base64");
});

afterEach(() => {
  if (originalValue === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalValue;
});

describe("round trip", () => {
  test("decrypting an encrypted value returns the exact original plaintext", () => {
    const plaintext = JSON.stringify({ refreshToken: "example_razorpay_refresh_token" });
    const stored = encryptCredential(plaintext);
    assert.equal(decryptCredential(stored), plaintext);
  });

  test("round-trips unicode content without corruption", () => {
    const plaintext = "token-with-emoji-🔒-and-unicode-café";
    const stored = encryptCredential(plaintext);
    assert.equal(decryptCredential(stored), plaintext);
  });
});

describe("ciphertext shape", () => {
  test("is versioned and dot-delimited: razorpay_cred.v1 prefix + 3 more parts (iv, tag, ciphertext)", () => {
    const stored = encryptCredential("secret-value");
    assert.equal(stored.startsWith("razorpay_cred.v1."), true);
    const remainder = stored.slice("razorpay_cred.v1.".length).split(".");
    assert.equal(remainder.length, 3);
  });

  test("never contains the plaintext as a literal substring", () => {
    const plaintext = "super_secret_razorpay_refresh_token_xyz";
    const stored = encryptCredential(plaintext);
    assert.doesNotMatch(stored, new RegExp(plaintext));
  });
});

const PREFIX = "razorpay_cred.v1";

function splitStored(stored: string): { iv: string; tag: string; ciphertext: string } {
  const [iv, tag, ciphertext] = stored.slice(PREFIX.length + 1).split(".") as [
    string,
    string,
    string,
  ];
  return { iv, tag, ciphertext };
}

function joinStored(iv: string, tag: string, ciphertext: string): string {
  return [PREFIX, iv, tag, ciphertext].join(".");
}

describe("non-determinism / IV uniqueness", () => {
  test("encrypting the same plaintext twice produces different ciphertext (unique random IV each call)", () => {
    const a = encryptCredential("same-plaintext-both-times");
    const b = encryptCredential("same-plaintext-both-times");
    assert.notEqual(a, b);
    assert.equal(decryptCredential(a), "same-plaintext-both-times");
    assert.equal(decryptCredential(b), "same-plaintext-both-times");
  });

  test("the IV segment differs between two encryptions", () => {
    const a = splitStored(encryptCredential("x")).iv;
    const b = splitStored(encryptCredential("x")).iv;
    assert.notEqual(a, b);
  });
});

describe("tamper detection (authenticated encryption)", () => {
  test("flipping a character in the ciphertext segment fails authentication", () => {
    const stored = encryptCredential("a-token-that-must-not-be-forgeable");
    const { iv, tag, ciphertext } = splitStored(stored);
    const flipped = ciphertext[0] === "A" ? "B" : "A";
    const tampered = joinStored(iv, tag, flipped + ciphertext.slice(1));
    assert.throws(() => decryptCredential(tampered), CredentialCryptoError);
  });

  test("flipping a character in the auth tag fails authentication", () => {
    const stored = encryptCredential("another-token");
    const { iv, tag, ciphertext } = splitStored(stored);
    const flipped = tag[0] === "A" ? "B" : "A";
    const tampered = joinStored(iv, flipped + tag.slice(1), ciphertext);
    assert.throws(() => decryptCredential(tampered), CredentialCryptoError);
  });

  test("swapping in a different (validly-encrypted) ciphertext segment fails authentication", () => {
    const a = splitStored(encryptCredential("token-a"));
    const b = splitStored(encryptCredential("token-b"));
    const frankensteined = joinStored(a.iv, a.tag, b.ciphertext);
    assert.throws(() => decryptCredential(frankensteined), CredentialCryptoError);
  });
});

describe("malformed ciphertext", () => {
  test("wrong version tag is rejected", () => {
    const stored = encryptCredential("x");
    const { iv, tag, ciphertext } = splitStored(stored);
    const wrongVersion = ["razorpay_cred.v2", iv, tag, ciphertext].join(".");
    assert.throws(() => decryptCredential(wrongVersion), CredentialCryptoError);
  });

  test("empty string is rejected", () => {
    assert.throws(() => decryptCredential(""), CredentialCryptoError);
  });

  test("completely unrelated string is rejected, not silently accepted", () => {
    assert.throws(
      () => decryptCredential("plain text, not ciphertext at all"),
      CredentialCryptoError,
    );
  });
});

describe("key handling", () => {
  test("encrypting with no encryption key configured fails safely", () => {
    delete process.env[ENV_KEY];
    assert.throws(() => encryptCredential("x"), CredentialCryptoError);
  });

  test("decrypting with the WRONG (but validly-shaped) key fails authentication rather than returning garbage", () => {
    const stored = encryptCredential("token-encrypted-under-key-a");
    process.env[ENV_KEY] = randomBytes(32).toString("base64");
    assert.throws(() => decryptCredential(stored), CredentialCryptoError);
  });

  test("no key material or plaintext ever appears in a thrown error message", () => {
    const key = process.env[ENV_KEY]!;
    delete process.env[ENV_KEY];
    try {
      encryptCredential("super-secret-value-should-never-appear-in-errors");
      assert.fail("expected encryptCredential to throw");
    } catch (err) {
      const message = (err as Error).message;
      assert.doesNotMatch(message, /super-secret-value-should-never-appear-in-errors/);
      assert.doesNotMatch(message, new RegExp(key));
    }
  });
});

describe("input validation", () => {
  test("refuses to encrypt an empty plaintext", () => {
    assert.throws(() => encryptCredential(""), CredentialCryptoError);
  });
});
