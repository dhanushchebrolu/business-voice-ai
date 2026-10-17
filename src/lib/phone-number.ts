/**
 * Phone-number helpers shared by the booking layer and the voice runtime.
 *
 * `contacts.phone` carries a CHECK constraint requiring strict E.164
 * (`^\+[1-9]\d{6,14}$`, 20260912090000_outbound_campaigns.sql). Every
 * booking path resolves its contact by upserting that column, so a
 * caller's number must be normalized BEFORE it reaches the database —
 * a raw spoken "9876543210" (no "+") otherwise fails the constraint and
 * aborts the whole booking.
 *
 * Country context is explicit: a number given WITHOUT a country code is
 * only interpreted when the business's own country (businesses.country)
 * says how — never by blindly prepending +91. Today the only national
 * numbering plan implemented is India's; any other (or unknown) country
 * requires the number in international form.
 */

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export type PhoneNormalizationResult =
  | { ok: true; e164: string }
  | {
      ok: false;
      /**
       * "invalid": not a plausible number at all.
       * "country_code_required": a national-format number, but the
       * business's country isn't one whose national format is understood
       * (or isn't known) — the number must be given with its country code.
       */
      reason: "invalid" | "country_code_required";
    };

/** True when `countryCode` (businesses.country) means India. */
export function isIndiaCountry(countryCode: string | null | undefined): boolean {
  const normalized = (countryCode ?? "").trim().toUpperCase();
  return normalized === "IN" || normalized === "IND" || normalized === "INDIA";
}

const INDIAN_MOBILE = /^[6-9]\d{9}$/;
// An Indian number dialled with its trunk prefix: 0 + area code/mobile.
const INDIAN_TRUNK_PREFIXED = /^0[1-9]\d{9}$/;

/**
 * Normalizes a customer-supplied phone number to E.164 using the
 * business's country for national-format numbers.
 *
 * - "+…" / "00…": international form — validated as E.164 (and, for +91,
 *   exactly 10 national digits not starting with 0).
 * - Otherwise, only when the country is India: a 10-digit mobile
 *   (6–9 first digit), a 0-prefixed 11-digit number, or a 12-digit number
 *   starting 91 followed by a 10-digit mobile.
 * - Anything else is rejected with a reason — never guessed.
 */
export function normalizePhoneNumber(
  raw: string | null | undefined,
  countryCode: string | null | undefined,
): PhoneNormalizationResult {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "invalid" };
  // Separators people and STT put in numbers; anything else (letters,
  // extensions) makes the input invalid rather than silently dropped.
  const compact = trimmed.replace(/[\s\-.()/]/g, "");
  if (!/^(\+|00)?\d+$/.test(compact)) return { ok: false, reason: "invalid" };

  if (compact.startsWith("+") || compact.startsWith("00")) {
    const candidate = `+${compact.replace(/^(\+|00)/, "")}`;
    if (!E164_PATTERN.test(candidate)) return { ok: false, reason: "invalid" };
    if (candidate.startsWith("+91") && !/^\+91[1-9]\d{9}$/.test(candidate)) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, e164: candidate };
  }

  if (!isIndiaCountry(countryCode)) return { ok: false, reason: "country_code_required" };
  if (INDIAN_MOBILE.test(compact)) return { ok: true, e164: `+91${compact}` };
  if (INDIAN_TRUNK_PREFIXED.test(compact)) return { ok: true, e164: `+91${compact.slice(1)}` };
  if (/^91[6-9]\d{9}$/.test(compact)) return { ok: true, e164: `+${compact}` };
  return { ok: false, reason: "invalid" };
}

/** normalizePhoneNumber's E.164 result, or null when it can't be normalized. */
export function normalizeCustomerPhone(
  raw: string | null | undefined,
  countryCode: string | null | undefined,
): string | null {
  const result = normalizePhoneNumber(raw, countryCode);
  return result.ok ? result.e164 : null;
}

// Values telephony providers send in place of a real number when the
// caller has withheld or hidden their caller ID.
const WITHHELD_CALLER_ID_PATTERN =
  /^(anonymous|private|restricted|unknown|unavailable|withheld|blocked|none|null|undefined)$/i;

/**
 * Normalizes the provider-reported inbound caller number (the trusted
 * `From` webhook field) to E.164, or null when it is withheld, malformed,
 * or a placeholder. National-format values are interpreted with the same
 * country rule as normalizePhoneNumber. For a NEW booking, caller ID is
 * only a contact detail the caller can choose to use. It is also the one
 * identity check for changing an EXISTING booking by phone (see
 * calendar/caller-bookings.server.ts) — a number the caller merely speaks
 * never is.
 */
export function normalizeCallerId(
  raw: string | null | undefined,
  countryCode: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || WITHHELD_CALLER_ID_PATTERN.test(trimmed)) return null;
  const e164 = normalizeCustomerPhone(trimmed, countryCode);
  if (!e164) return null;
  // All-zero subscriber digits are a provider placeholder, not a number.
  if (/^0+$/.test(e164.slice(-10))) return null;
  return e164;
}

/** The last four digits only (e.g. "3210") — safe to put in a log line or an LLM prompt; never the full number. */
export function phoneLastFour(e164: string): string {
  return e164.replace(/\D/g, "").slice(-4);
}
