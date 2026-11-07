/**
 * Greeting a returning caller by first name. Pure and dependency-free:
 * used by the Cloudflare Worker voice runtime (voice-runtime.server.ts) and
 * by the LiveKit voice agent (services/voice-agent), so both greet the same
 * way. The name itself comes from findReturningCallerFirstName
 * (calendar/caller-bookings.server.ts): one name known for the number, or
 * none.
 */

const GREETING_SALUTATION_PATTERN =
  /^\s*(hello|hi|hey|namaste|namaskar|vanakkam|good (?:morning|afternoon|evening))\b[,!.]?\s*/i;

/**
 * Greets a returning caller by first name: inserted after the configured
 * greeting's own salutation ("Hello, thanks for calling…" → "Hello Ravi,
 * thanks for calling…"), or — for an English greeting without one —
 * prefixed ("Hi Ravi! Thank you for calling…"). Nothing else changes: no
 * appointment detail is ever added to a greeting. Unchanged when the name
 * is unknown, or when a non-English greeting has no recognisable salutation.
 */
export function personalizeGreeting(
  greeting: string,
  firstName: string | null,
  language: string,
): string {
  if (!firstName) return greeting;
  const match = GREETING_SALUTATION_PATTERN.exec(greeting);
  if (match) {
    let rest = greeting.slice(match[0].length);
    if (/^[A-Z][a-z]/.test(rest)) rest = rest.charAt(0).toLowerCase() + rest.slice(1);
    return rest ? `${match[1]} ${firstName}, ${rest}` : `${match[1]} ${firstName}!`;
  }
  if (!language.toLowerCase().startsWith("en")) return greeting;
  return `Hi ${firstName}! ${greeting}`;
}
