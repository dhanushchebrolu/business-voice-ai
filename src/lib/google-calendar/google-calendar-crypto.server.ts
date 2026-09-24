/**
 * AES-256-GCM authenticated encryption for Google Calendar OAuth
 * credentials (google_calendar_connections.encrypted_credentials — a JSON
 * blob holding the refresh token, see google-calendar-oauth.server.ts).
 * Server-only; never imported by anything that ships to the browser
 * bundle.
 *
 * Same construction as whatsapp-token-crypto.server.ts (Phase "WhatsApp"),
 * deliberately not shared with it: that module's version tag, error
 * messages and env var name are specific to WhatsApp credentials, and
 * mixing key material across two unrelated credential types under one
 * function would make future key rotation of either provider harder to
 * reason about, not easier. The construction — versioned ciphertext,
 * AES-256-GCM, fresh IV per call — is copied intentionally; this is the
 * one non-duplicate use of "follow the existing convention" mentioned in
 * the Phase 2 brief.
 *
 * Ciphertext format (versioned so a future algorithm/parameter change can
 * be migrated without breaking already-stored rows):
 *
 *   google_cal_cred.v1.<ivB64>.<tagB64>.<ciphertextB64>
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION_TAG = "google_cal_cred.v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class CredentialCryptoError extends Error {}

/**
 * Reads and validates GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY (expected:
 * 32 random bytes, base64-encoded — generate with `openssl rand -base64
 * 32`). Fails loudly and immediately on a missing/malformed/wrong-length
 * key, before any encrypt/decrypt is attempted. Read fresh from
 * process.env on every call (not cached in a module-level variable),
 * matching whatsapp-token-crypto.server.ts's own convention — keeps this
 * module testable (set/unset the env var per test).
 */
function resolveEncryptionKey(): Buffer {
  const raw = process.env["GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY"];
  if (!raw) {
    throw new CredentialCryptoError("GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY is not configured.");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new CredentialCryptoError(
      `GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). Generate one with: openssl rand -base64 32`,
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
 * (tampering). Never logs the stored ciphertext or the recovered
 * plaintext.
 */
export function decryptCredential(stored: string): string {
  const key = resolveEncryptionKey();
  // VERSION_TAG itself contains "." ("google_cal_cred.v1"), so this strips
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
