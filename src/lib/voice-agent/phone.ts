/**
 * Normalizes phone numbers as they arrive on inbound SIP calls (LiveKit's
 * `sip.trunkPhoneNumber` / `sip.phoneNumber` attributes, which carry what
 * the carrier sent: Vobiz may send E.164, the national form, or the number
 * with a leading trunk 0 / country code but no "+").
 *
 * Supported Indian forms (the only ones transformed), all to +91XXXXXXXXXX:
 *   +91XXXXXXXXXX   E.164
 *   91XXXXXXXXXX    country code without "+" (12 digits)
 *   0XXXXXXXXXX     national with trunk prefix 0 (11 digits)
 *   XXXXXXXXXX      national (10 digits)
 * where XXXXXXXXXX is a 10-digit subscriber number starting 2-9 (mobile
 * 6-9, geographic 2-8). Separators (spaces, dashes, dots, parentheses) and
 * a "tel:" / "sip:" URI wrapper are tolerated.
 *
 * Deliberately NOT transformed (returned as null): anything that does not
 * match those shapes exactly, e.g. 11 digits starting "91" (is it 91 + 9
 * digits, or 0-less national?), "0091..." international prefix, toll-free /
 * service codes (1800, 1860, 1900: start with 1), short codes, withheld
 * caller IDs ("anonymous", "restricted"). An already valid E.164 number of
 * another country is returned unchanged (never re-prefixed); a bare digit
 * string is never assumed to be foreign.
 */
const E164 = /^\+[1-9]\d{6,14}$/;
const INDIAN_NATIONAL = /^[2-9]\d{9}$/;

export function normalizeInboundNumber(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || s.length > 64) return null;
  // sip:+919876543210@host / tel:+919876543210
  const uri = s.match(/^(?:sips?|tel):([^@;]+)/i);
  if (uri) s = uri[1]!;
  s = s.replace(/[\s\-().]/g, "");
  if (s.startsWith("+")) {
    if (!E164.test(s)) return null;
    if (s.startsWith("+91")) return INDIAN_NATIONAL.test(s.slice(3)) ? s : null;
    return s; // valid E.164 of another country: unchanged
  }
  if (!/^\d+$/.test(s)) return null;
  if (s.length === 12 && s.startsWith("91") && INDIAN_NATIONAL.test(s.slice(2))) return `+${s}`;
  if (s.length === 11 && s.startsWith("0") && INDIAN_NATIONAL.test(s.slice(1)))
    return `+91${s.slice(1)}`;
  if (s.length === 10 && INDIAN_NATIONAL.test(s)) return `+91${s}`;
  return null;
}
