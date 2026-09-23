import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  encryptCredential,
  decryptCredential,
  CredentialCryptoError,
} from "./whatsapp-token-crypto.server.ts";

const ENV_KEY = "WHATSAPP_CREDENTIAL_ENCRYPTION_KEY";
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
    const plaintext = "EAAG_business_integration_system_user_token_example";
    const stored = encryptCredential(plaintext);
    assert.equal(decryptCredential(stored), plaintext);
  });

  test("round-trips a 6-digit PIN", () => {
    const stored = encryptCredential("042871");
    assert.equal(decryptCredential(stored), "042871");
  });

  test("round-trips unicode content without corruption", () => {
    const plaintext = "token-with-emoji-🔒-and-unicode-café";
    const stored = encryptCredential(plaintext);
    assert.equal(decryptCredential(stored), plaintext);
  });
});

describe("ciphertext shape", () => {
  test("is versioned and dot-delimited: whatsapp_cred.v1 prefix + 3 more parts (iv, tag, ciphertext)", () => {
    const stored = encryptCredential("secret-value");
    assert.equal(stored.startsWith("whatsapp_cred.v1."), true);
    const remainder = stored.slice("whatsapp_cred.v1.".length).split(".");
    assert.equal(remainder.length, 3);
  });

  test("never contains the plaintext as a literal substring", () => {
    const plaintext = "EAAG_super_secret_token_value_xyz";
    const stored = encryptCredential(plaintext);
    assert.doesNotMatch(stored, new RegExp(plaintext));
  });
});

const PREFIX = "whatsapp_cred.v1";

/** Splits a stored value into its 3 dot-delimited fields after the (itself dot-containing) version prefix. */
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
    // but both still decrypt back to the same original value
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
    // Reuse token-a's IV/tag with token-b's ciphertext — must not decrypt to
    // anything, and must not silently succeed with wrong data.
    const frankensteined = joinStored(a.iv, a.tag, b.ciphertext);
    assert.throws(() => decryptCredential(frankensteined), CredentialCryptoError);
  });

  test("a tampered value never returns corrupted plaintext instead of throwing", () => {
    const stored = encryptCredential("must-not-leak-garbage");
    const { iv, tag } = splitStored(stored);
    const tampered = joinStored(iv, tag, "not-valid-base64-ciphertext!!");
    assert.throws(() => decryptCredential(tampered));
  });
});

describe("malformed ciphertext", () => {
  test("wrong version tag is rejected", () => {
    const stored = encryptCredential("x");
    const { iv, tag, ciphertext } = splitStored(stored);
    const wrongVersion = ["whatsapp_cred.v2", iv, tag, ciphertext].join(".");
    assert.throws(() => decryptCredential(wrongVersion), CredentialCryptoError);
  });

  test("wrong number of segments is rejected", () => {
    assert.throws(() => decryptCredential("whatsapp_cred.v1.onlytwoparts"), CredentialCryptoError);
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

  test("decrypting with no encryption key configured fails safely", () => {
    const stored = encryptCredential("x");
    delete process.env[ENV_KEY];
    assert.throws(() => decryptCredential(stored), CredentialCryptoError);
  });

  test("a key that is not valid base64-32-bytes (too short) is rejected", () => {
    process.env[ENV_KEY] = Buffer.from("too-short").toString("base64");
    assert.throws(() => encryptCredential("x"), CredentialCryptoError);
  });

  test("a key that decodes to the wrong length (too long) is rejected", () => {
    process.env[ENV_KEY] = randomBytes(64).toString("base64");
    assert.throws(() => encryptCredential("x"), CredentialCryptoError);
  });

  test("decrypting with the WRONG (but validly-shaped) key fails authentication rather than returning garbage", () => {
    const stored = encryptCredential("token-encrypted-under-key-a");
    process.env[ENV_KEY] = randomBytes(32).toString("base64"); // a different, equally valid key
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
