/**
 * AES-256-GCM authenticated encryption for Instagram connection credentials
 * (instagram_connections.access_token_ciphertext). Byte-for-byte the same
 * scheme as whatsapp-token-crypto.server.ts (Phase 2) — deliberately a
 * separate module with a separate key (INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY)
 * rather than importing/reusing the WhatsApp module directly, matching this
 * codebase's established convention (razorpay-crypto.server.ts /
 * google-calendar-crypto.server.ts are each independent too): rotating one
 * provider's key must never touch another's already-stored ciphertext.
 *
 * Ciphertext format:
 *
 *   instagram_cred.v1.<ivB64>.<tagB64>.<ciphertextB64>
 *
 * v1 = AES-256-GCM, a fresh random 12-byte IV per call, a 16-byte GCM
 * authentication tag. See whatsapp-token-crypto.server.ts's module doc for
 * the full rationale (authenticated encryption, generic failure message,
 * lazy env read) — identical here.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION_TAG = "instagram_cred.v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class CredentialCryptoError extends Error {}

function resolveEncryptionKey(): Buffer {
  const raw = process.env["INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY"];
  if (!raw) {
    throw new CredentialCryptoError("INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY is not configured.");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new CredentialCryptoError(
      `INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). Generate one with: openssl rand -base64 32`,
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
