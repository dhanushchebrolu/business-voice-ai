/**
 * Minimal Vobiz Voice XML builder — just the one verb Klyro's answer route
 * actually needs (`<Stream>`, to open the live media bridge). See
 * vobiz-provider.ts's module doc for sourcing/confidence: the `<Response>`
 * root wrapping individual verbs is this codebase's own documented
 * assumption (every sibling XML-call-control dialect in this family —
 * Twilio TwiML, Plivo XML, Exotel's ExoML — uses one), not a directly
 * quoted Vobiz example; the `<Stream>` element's own shape (attributes,
 * body = the wss:// URL) IS directly sourced from a real reference
 * implementation. XML-escaping is applied to every interpolated value even
 * though today's only caller passes a URL Klyro itself constructs, so this
 * stays safe if a future caller ever doesn't.
 */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The XML that opens Klyro's live media bridge for this call. */
export function buildVobizStreamXml(wsUrl: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Stream bidirectional="true" audioTrack="inbound" contentType="audio/x-mulaw;rate=8000" keepCallAlive="true">` +
    escapeXml(wsUrl) +
    `</Stream>` +
    `</Response>`
  );
}

/** The XML for a call Klyro's entitlement gate denied — speaks a short message, then lets Vobiz's own call flow end it (no `<Stream>` is ever returned, so no media bridge opens). */
export function buildVobizDeniedXml(message: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Speak voice="WOMAN" language="en-US">${escapeXml(message)}</Speak>` +
    `</Response>`
  );
}
