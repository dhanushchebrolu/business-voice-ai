/**
 * AES-256-GCM authenticated encryption for Razorpay OAuth credentials
 * (razorpay_connections.encrypted_credentials — a JSON blob holding the
 * refresh token, see razorpay-oauth.server.ts). Server-only; never
 * imported by anything that ships to the browser bundle.
 *
 * Same construction as google-calendar-crypto.server.ts and
 * whatsapp-token-crypto.server.ts before it, deliberately not shared with
 * either: each credential type gets its own version tag, error messages
 * and env var name, so rotating one provider's key never touches another's
 * already-stored ciphertext.
 *
 * node:crypto (createCipheriv/createDecipheriv/randomBytes) is available
 * in the Cloudflare Workers runtime this app deploys to (Workers ships a
 * Node-compatible crypto polyfill covering exactly this AES-GCM API) —
 * confirmed by this being the identical construction already running in
 * production for WhatsApp and Google Calendar credentials, not a new
 * assumption introduced here.
 *
 * Ciphertext format (versioned so a future algorithm/parameter change can
 * be migrated without breaking already-stored rows):
 *
 *   razorpay_cred.v1.<ivB64>.<tagB64>.<ciphertextB64>
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION_TAG = "razorpay_cred.v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class CredentialCryptoError extends Error {}

/**
 * Reads and validates RAZORPAY_CREDENTIAL_ENCRYPTION_KEY (expected: 32
 * random bytes, base64-encoded — generate with `openssl rand -base64 32`).
 * Fails loudly and immediately on a missing/malformed/wrong-length key,
 * before any encrypt/decrypt is attempted. Read fresh from process.env on
 * every call (not cached in a module-level variable), matching the
 * WhatsApp/Google Calendar crypto modules' own convention — keeps this
 * module testable (set/unset the env var per test).
 */
function resolveEncryptionKey(): Buffer {
  const raw = process.env["RAZORPAY_CREDENTIAL_ENCRYPTION_KEY"];
  if (!raw) {
    throw new CredentialCryptoError("RAZORPAY_CREDENTIAL_ENCRYPTION_KEY is not configured.");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new CredentialCryptoError(
      `RAZORPAY_CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). Generate one with: openssl rand -base64 32`,
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
  // VERSION_TAG itself contains "." ("razorpay_cred.v1"), so this strips
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
