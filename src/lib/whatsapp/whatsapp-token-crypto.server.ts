/**
 * AES-256-GCM authenticated encryption for WhatsApp connection credentials
 * — the Business Integration System User access token and the two-step-
 * verification PIN (whatsapp_connections.access_token_ciphertext /
 * two_step_pin_ciphertext, see the Phase 1 migration). Server-only; never
 * imported by anything that ships to the browser bundle.
 *
 * Ciphertext format (versioned so a future algorithm/parameter change can
 * be migrated without breaking already-stored rows):
 *
 *   whatsapp_cred.v1.<ivB64>.<tagB64>.<ciphertextB64>
 *
 * v1 = AES-256-GCM, a fresh random 12-byte IV per call, a 16-byte GCM
 * authentication tag. Dot-delimited; base64's own alphabet never contains
 * ".", so splitting on it is unambiguous.
 *
 * This is authenticated encryption, not just encryption: GCM's tag makes
 * tampering with the ciphertext, the IV, or a bit-flip anywhere in the
 * stored string fail LOUDLY at decrypt time (decipher.final() throws)
 * rather than silently returning corrupted plaintext. decryptCredential
 * collapses every failure mode (bad format, wrong key, tampered tag) into
 * one generic CredentialCryptoError — never reveals which check failed,
 * and never includes the ciphertext, the key, or any decrypted plaintext
 * in that message.
 *
 * The key is read fresh from WHATSAPP_CREDENTIAL_ENCRYPTION_KEY on every
 * call rather than cached at module load, matching this codebase's
 * existing lazy-env-read convention (sarvam.server.ts's apiKey(),
 * telephony.server.ts's resolveSarvamKeys()) — keeps this module testable
 * (set/unset the env var per test) and never holds key material in a
 * long-lived module-level variable.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION_TAG = "whatsapp_cred.v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class CredentialCryptoError extends Error {}

/**
 * Reads and validates WHATSAPP_CREDENTIAL_ENCRYPTION_KEY (expected: 32
 * random bytes, base64-encoded — generate with `openssl rand -base64 32`).
 * Fails loudly and immediately on a missing/malformed/wrong-length key,
 * before any encrypt/decrypt is attempted — a misconfigured key must never
 * produce ciphertext that can never be decrypted again, or a decrypt that
 * mysteriously always fails for reasons a caller can't diagnose.
 */
function resolveEncryptionKey(): Buffer {
  const raw = process.env["WHATSAPP_CREDENTIAL_ENCRYPTION_KEY"];
  if (!raw) {
    throw new CredentialCryptoError("WHATSAPP_CREDENTIAL_ENCRYPTION_KEY is not configured.");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new CredentialCryptoError(
      `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

/** Encrypts a plaintext credential. Never logs the input or the output. */
export function encryptCredential(plaintext: string): string {
  if (!plaintext) throw new CredentialCryptoError("Cannot encrypt an empty credential.");
  const key = resolveEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION_TAG,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Decrypts a value produced by encryptCredential. Throws
 * CredentialCryptoError — never returns a partial or corrupted result — on
 * any format mismatch, wrong/missing key, or authentication-tag failure
 * (tampering). Never logs the stored ciphertext or the recovered plaintext.
 */
export function decryptCredential(stored: string): string {
  const key = resolveEncryptionKey();
  // VERSION_TAG itself contains a "." ("whatsapp_cred.v1"), so this strips
  // the known prefix first rather than naively splitting the whole string
  // on "." and assuming a fixed part count.
  if (!stored.startsWith(`${VERSION_TAG}.`)) {
    throw new CredentialCryptoError("Unrecognized or corrupt credential ciphertext format.");
  }
  const parts = stored.slice(VERSION_TAG.length + 1).split(".");
  if (parts.length !== 3) {
    throw new CredentialCryptoError("Unrecognized or corrupt credential ciphertext format.");
  }
  const [ivB64, tagB64, ciphertextB64] = parts as [string, string, string];

  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = Buffer.from(ivB64, "base64");
    tag = Buffer.from(tagB64, "base64");
    ciphertext = Buffer.from(ciphertextB64, "base64");
  } catch {
    throw new CredentialCryptoError("Unrecognized or corrupt credential ciphertext format.");
  }
  if (iv.length !== IV_BYTES || tag.length === 0 || ciphertext.length === 0) {
    throw new CredentialCryptoError("Unrecognized or corrupt credential ciphertext format.");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    throw new CredentialCryptoError("Failed to decrypt credential: authentication failed.");
  }
}
