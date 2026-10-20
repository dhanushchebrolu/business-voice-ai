/**
 * Meta webhook payload authentication: Meta signs every webhook POST with
 * the app secret — header `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of
 * the raw request body>`. A payload is trusted only if that signature
 * matches, compared in constant time over the exact raw bytes received
 * (never a re-serialized JSON).
 *
 * Fails closed: no configured secret, no header, a wrong prefix, malformed
 * hex or a length mismatch all mean "not verified". The secret is never
 * logged or returned.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string | null | undefined,
): boolean {
  if (!appSecret || !signatureHeader || !signatureHeader.startsWith(PREFIX)) return false;
  const provided = signatureHeader.slice(PREFIX.length).trim();
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(provided, "hex"));
}

/** The header value Meta would send for `rawBody` — for tests and local tooling only. */
export function signMetaWebhookBody(rawBody: string, appSecret: string): string {
  return PREFIX + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
}
