import { timingSafeEqual } from "crypto";

/**
 * Constant-time string comparison for a shared secret/token — used
 * wherever a value supplied by an unauthenticated caller must be checked
 * against a server-held secret without leaking timing information about
 * how many leading bytes matched.
 *
 * Matches the exact pattern already established elsewhere in this
 * codebase (exotel-provider.ts's verifyWebhookSignature,
 * media-session-token.ts's verifyMediaSessionToken) — both already use
 * Node's `crypto.timingSafeEqual`, which works in this project's
 * Cloudflare Worker runtime because wrangler.json sets the `nodejs_compat`
 * compatibility flag (verified via `wrangler deploy --dry-run` earlier
 * this session; the Razorpay webhook's `crypto.createHmac`/
 * `timingSafeEqual` usage already depends on the same flag in production).
 * No new dependency introduced — this only factors an existing, proven
 * pattern into one small, directly-testable module (this repo's test
 * runner does not import `createFileRoute`-based route files directly, so
 * the comparison logic needs to live outside exotel.media-token.ts itself
 * to be unit-tested).
 *
 * `timingSafeEqual` throws (rather than returning false) when its two
 * buffers differ in length, so the length is checked explicitly first —
 * a differently-sized input fails safely, never as an unhandled
 * exception. Neither input is ever logged or echoed by this function.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
