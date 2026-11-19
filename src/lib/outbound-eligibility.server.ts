import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * Pre-dial eligibility for every outbound call, enforced inside
 * sendSarvamInstantOutboundCall (the one function that dials a single Sarvam
 * call) and the LiveKit path (voice-agent/outbound.server.ts), so no endpoint
 * or UI can skip it. Each rule fails closed and returns the
 * reason shown to whoever asked. These are ClickAI's own safety controls;
 * see docs/outbound-calling.md for what they do and do not cover legally.
 *
 *   kill switch      OUTBOUND_CALLING_DISABLED=true stops every new outbound
 *                    call (single and campaign); calls in progress are untouched
 *   destination      only countries in OUTBOUND_ALLOWED_COUNTRY_CODES (default 91)
 *   calling hours    09:00–21:00 India time by default (OUTBOUND_CALLING_HOURS,
 *                    "HH-HH" in whole hours, can only narrow it), the window
 *                    TRAI's TCCCPR 2018 sets for commercial calls
 *   relationship     the person already dealt with this business: a contact,
 *                    an inbound call, a lead or a booking from that number.
 *                    ClickAI does not place cold calls.
 *
 * Do-not-call (contacts.opted_out), the test allowlist and the atomic limits
 * (admit_single_outbound_call) are separate checks in the same path.
 */

type Admin = SupabaseClient<Database>;

export const OUTBOUND_DISABLED_MESSAGE =
  "Outbound calling is paused on ClickAI right now. Calls already in progress are not affected.";
export const DESTINATION_COUNTRY_MESSAGE = "Calls can only be placed to Indian (+91) numbers.";
export const CALLING_HOURS_MESSAGE =
  "Calls can only be placed between 9:00 AM and 9:00 PM India time.";
export const NO_RELATIONSHIP_MESSAGE =
  "Your assistant only calls people who already know your business: a saved contact, someone who called you, a lead or a booking. This number has none of these. If this person is your customer and expects your call, add them as a contact first.";

export const CALLING_HOURS = { startHour: 9, endHour: 21, timeZone: "Asia/Kolkata" } as const;

/**
 * The configured window, "HH-HH" (start inclusive, end exclusive). It may only
 * narrow the 09–21 default; anything wider, malformed or empty falls back to
 * the default, so a bad setting never allows calls at night.
 */
export function callingWindow(): { startHour: number; endHour: number } {
  const fallback = { startHour: CALLING_HOURS.startHour, endHour: CALLING_HOURS.endHour };
  const m = process.env["OUTBOUND_CALLING_HOURS"]?.trim().match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return fallback;
  const startHour = Number(m[1]);
  const endHour = Number(m[2]);
  if (
    startHour < CALLING_HOURS.startHour ||
    endHour > CALLING_HOURS.endHour ||
    startHour >= endHour
  )
    return fallback;
  return { startHour, endHour };
}

/** The global kill switch. Only an explicit "true" stops calls, so a typo never blocks them silently. */
export function outboundCallingDisabled(): boolean {
  return process.env["OUTBOUND_CALLING_DISABLED"]?.trim().toLowerCase() === "true";
}

function allowedCountryCodes(): string[] {
  const raw = process.env["OUTBOUND_ALLOWED_COUNTRY_CODES"]?.trim();
  const codes = (raw ? raw.split(",") : ["91"])
    .map((c) => c.trim().replace(/^\+/, ""))
    .filter((c) => /^\d{1,3}$/.test(c));
  return codes;
}

/** A canonical E.164 number whose country code is allowed. Set but empty allows nothing. */
export function isDestinationCountryAllowed(e164: string): boolean {
  return allowedCountryCodes().some((code) => e164.startsWith(`+${code}`));
}

/** Whether `now` is inside the calling window, in India time (DST-free, so the hour is exact). */
export function withinCallingHours(now: Date): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: CALLING_HOURS.timeZone,
    }).format(now),
  );
  const window = callingWindow();
  return hour >= window.startHour && hour < window.endHour;
}

/**
 * PRODUCT POLICY, not a temporary flag: ClickAI's assistant calls only people
 * who already have a relationship with the business. There is deliberately no
 * setting that turns this off; ClickAI does not offer cold calling. Each source
 * is something the person or the business did first:
 *
 *   contacts   the business saved the person in its own customer list (manual
 *              entry or import), stating they are its customer
 *   call_logs  the person called the business's number (inbound only; ClickAI's
 *              own outbound calls never create a relationship)
 *   leads      the person asked for follow-up or left details while enquiring
 *   bookings   the person has or had an appointment with the business
 *
 * Opted-out contacts are refused before this (do-not-call). Same organization
 * only. A read error throws, so the call is refused rather than placed
 * unchecked. This is a business-relationship rule, not proof of legal consent:
 * see docs/outbound-calling.md §3 for the open legal questions.
 */
export async function hasPriorRelationship(
  admin: Admin,
  organizationId: string,
  e164: string,
): Promise<boolean> {
  const checks = await Promise.all([
    admin
      .from("contacts")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("phone", e164)
      .limit(1),
    admin
      .from("call_logs")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("direction", "inbound")
      .eq("caller_number", e164)
      .limit(1),
    admin
      .from("leads")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("phone", e164)
      .limit(1),
    admin
      .from("bookings")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("customer_phone", e164)
      .limit(1),
  ]);
  for (const { error } of checks) if (error) throw error;
  return checks.some(({ data }) => (data?.length ?? 0) > 0);
}

/**
 * The eligibility rules that need no database, in order. Returns the first
 * reason the call may not be placed, or null.
 */
export function staticEligibilityBlocker(toE164: string, now: Date): string | null {
  if (outboundCallingDisabled()) return OUTBOUND_DISABLED_MESSAGE;
  if (!isDestinationCountryAllowed(toE164)) return DESTINATION_COUNTRY_MESSAGE;
  if (!withinCallingHours(now)) return CALLING_HOURS_MESSAGE;
  return null;
}
