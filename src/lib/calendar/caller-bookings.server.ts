/**
 * Who a caller is, from the number they are calling from — used to find
 * the caller's own upcoming appointments (rescheduling) and their name
 * (greeting a returning customer).
 *
 * IDENTITY RULE: the only proof that a booking belongs to a caller is the
 * caller ID from the telephony provider's signed webhook (normalized to
 * E.164), or the booking having been made on this very call. A phone
 * number the caller SPEAKS is never accepted as proof — anyone can say
 * any number. A booking matches when, in the same organization and
 * business:
 *   - its customer_phone normalizes to the caller's E.164 number, or
 *   - its contact's phone (contacts.phone, strict E.164) is that number, or
 *   - it was booked on this call (idempotency key "voice:<callId>:…").
 *
 * Everything is tenant-scoped (organization AND business) and read with
 * the service-role client. Nothing here writes, and nothing logs a phone
 * number or a name.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { normalizeCustomerPhone } from "../phone-number.ts";

type Client = SupabaseClient<Database>;

/** Statuses of a booking that still holds its slot and can be moved by the caller. */
export const CALLER_RESCHEDULABLE_STATUSES = [
  "CONFIRMED",
  "RESCHEDULED",
  "PENDING_CONFIRMATION",
  "CALENDAR_SYNC_FAILED",
] as const;

/** At most this many upcoming bookings are considered for one caller. */
const MAX_CALLER_BOOKINGS = 10;

export interface CallerBooking {
  id: string;
  startAt: string;
  endAt: string;
  timezone: string;
  status: string;
  serviceId: string | null;
  serviceName: string | null;
  customerName: string | null;
}

/**
 * The forms an E.164 number may have been stored in by older or manual
 * booking paths (customer_phone has no format constraint) — queried with
 * `in`, then every row is re-checked by normalization, so a variant can
 * only ever widen the query, never produce a false match.
 */
export function storedPhoneVariants(e164: string): string[] {
  const variants = new Set<string>([e164, e164.slice(1)]);
  if (e164.startsWith("+91") && e164.length === 13) {
    const national = e164.slice(3);
    variants.add(national);
    variants.add(`0${national}`);
  }
  return [...variants];
}

/** Whether `stored` (a customer_phone or contacts.phone value) is the caller's number. */
export function phoneMatchesCaller(
  stored: string | null | undefined,
  callerE164: string,
  country: string | null | undefined,
): boolean {
  if (!stored) return false;
  return normalizeCustomerPhone(stored, country) === callerE164;
}

function voiceCallKeyPrefix(callId: string): string {
  return `voice:${callId}:`;
}

interface BookingRow {
  id: string;
  business_id: string;
  organization_id: string;
  start_at: string;
  end_at: string;
  timezone: string;
  status: string;
  service_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  contact_id: string | null;
  idempotency_key: string | null;
}

const BOOKING_COLUMNS =
  "id, business_id, organization_id, start_at, end_at, timezone, status, service_id, customer_name, customer_phone, contact_id, idempotency_key";

async function loadCallerContactIds(
  supabaseAdmin: Client,
  organizationId: string,
  callerE164: string,
): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("contacts")
    .select("id, phone")
    .eq("organization_id", organizationId)
    .eq("phone", callerE164);
  if (error) throw error;
  return ((data ?? []) as { id: string; phone: string }[])
    .filter((c) => c.phone === callerE164)
    .map((c) => c.id);
}

export interface FindCallerBookingsInput {
  organizationId: string;
  businessId: string;
  /** Trusted caller ID (E.164). Null means the caller can't be identified — nothing is returned. */
  callerE164: string | null;
  /** The live call — bookings made on it count as the caller's own. */
  callId?: string | null | undefined;
  /** businesses.country — how a stored national-format customer_phone is read. */
  country?: string | null | undefined;
  now?: Date | undefined;
}

/**
 * The caller's upcoming, still-movable bookings at this business, soonest
 * first. Empty when the caller ID is unknown — never a guess.
 */
export async function findCallerUpcomingBookings(
  supabaseAdmin: Client,
  input: FindCallerBookingsInput,
): Promise<CallerBooking[]> {
  const callerE164 = input.callerE164;
  if (!callerE164) return [];
  const nowMs = (input.now ?? new Date()).getTime();
  const nowIso = new Date(nowMs).toISOString();

  const base = () =>
    supabaseAdmin
      .from("bookings")
      .select(BOOKING_COLUMNS)
      .eq("organization_id", input.organizationId)
      .eq("business_id", input.businessId)
      .in("status", [...CALLER_RESCHEDULABLE_STATUSES])
      .gt("start_at", nowIso);

  const contactIds = await loadCallerContactIds(supabaseAdmin, input.organizationId, callerE164);
  const queries = [
    base().in("customer_phone", storedPhoneVariants(callerE164)).limit(MAX_CALLER_BOOKINGS),
    contactIds.length > 0
      ? base().in("contact_id", contactIds).limit(MAX_CALLER_BOOKINGS)
      : Promise.resolve({ data: [], error: null }),
    input.callId
      ? base()
          .like("idempotency_key", `${voiceCallKeyPrefix(input.callId)}%`)
          .limit(MAX_CALLER_BOOKINGS)
      : Promise.resolve({ data: [], error: null }),
  ];
  const results = await Promise.all(queries);
  const rows = new Map<string, BookingRow>();
  for (const result of results) {
    if (result.error) throw result.error;
    for (const row of (result.data ?? []) as BookingRow[]) rows.set(row.id, row);
  }

  // Re-check every row in code: the query filters are a superset by design.
  const owned = [...rows.values()].filter(
    (row) =>
      row.organization_id === input.organizationId &&
      row.business_id === input.businessId &&
      (CALLER_RESCHEDULABLE_STATUSES as readonly string[]).includes(row.status) &&
      new Date(row.start_at).getTime() > nowMs &&
      (phoneMatchesCaller(row.customer_phone, callerE164, input.country) ||
        (row.contact_id !== null && contactIds.includes(row.contact_id)) ||
        Boolean(input.callId && row.idempotency_key?.startsWith(voiceCallKeyPrefix(input.callId)))),
  );
  owned.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
  const limited = owned.slice(0, MAX_CALLER_BOOKINGS);

  const serviceIds = [
    ...new Set(limited.map((r) => r.service_id).filter((id): id is string => !!id)),
  ];
  const serviceNames = new Map<string, string>();
  if (serviceIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("services")
      .select("id, name, business_id")
      .in("id", serviceIds);
    if (error) throw error;
    for (const s of (data ?? []) as { id: string; name: string; business_id: string }[]) {
      if (s.business_id === input.businessId) serviceNames.set(s.id, s.name);
    }
  }

  return limited.map((row) => ({
    id: row.id,
    startAt: row.start_at,
    endAt: row.end_at,
    timezone: row.timezone,
    status: row.status,
    serviceId: row.service_id,
    serviceName: row.service_id ? (serviceNames.get(row.service_id) ?? null) : null,
    customerName: row.customer_name?.trim() || null,
  }));
}

export interface CallerOwnsBookingInput {
  organizationId: string;
  businessId: string;
  bookingId: string;
  callerE164: string | null | undefined;
  callId?: string | null | undefined;
  country?: string | null | undefined;
}

/**
 * Whether this booking belongs to the caller (see the identity rule at the
 * top of this file). False — never an error that reveals anything — when
 * the booking doesn't exist, belongs to another tenant or business, or the
 * caller can't be identified.
 */
export async function callerOwnsBooking(
  supabaseAdmin: Client,
  input: CallerOwnsBookingInput,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("bookings")
    .select(BOOKING_COLUMNS)
    .eq("id", input.bookingId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (error) throw error;
  const row = data as BookingRow | null;
  if (!row || row.organization_id !== input.organizationId) return false;
  if (row.business_id !== input.businessId) return false;
  if (input.callId && row.idempotency_key?.startsWith(voiceCallKeyPrefix(input.callId))) {
    return true;
  }
  const callerE164 = input.callerE164;
  if (!callerE164) return false;
  if (phoneMatchesCaller(row.customer_phone, callerE164, input.country)) return true;
  if (!row.contact_id) return false;
  const { data: contact, error: contactError } = await supabaseAdmin
    .from("contacts")
    .select("phone, organization_id")
    .eq("id", row.contact_id)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (contactError) throw contactError;
  return Boolean(
    contact && contact.organization_id === input.organizationId && contact.phone === callerE164,
  );
}

/** Lower-cased first word of a name, for comparing names that differ only in case or surname. */
function firstNameKey(name: string): string {
  return name.trim().split(/\s+/)[0]!.toLowerCase();
}

/** A name safe to say in a greeting: letters (any script), spaces, apostrophes, dots and hyphens only. */
function speakableName(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > 60) return null;
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(trimmed)) return null;
  return trimmed;
}

/**
 * The returning caller's first name, when exactly one person is known for
 * this number in this organization — from the organization's contact
 * record for the number and the names on this business's recent bookings
 * from it. Null for an unknown number, a withheld caller ID, or a number
 * shared by more than one name (a family phone): the greeting then stays
 * generic rather than risk greeting the wrong person.
 */
export async function findReturningCallerFirstName(
  supabaseAdmin: Client,
  input: {
    organizationId: string;
    businessId: string;
    callerE164: string | null;
    country?: string | null | undefined;
  },
): Promise<string | null> {
  const callerE164 = input.callerE164;
  if (!callerE164) return null;
  const [contactRes, bookingRes] = await Promise.all([
    supabaseAdmin
      .from("contacts")
      .select("name, phone")
      .eq("organization_id", input.organizationId)
      .eq("phone", callerE164)
      .limit(2),
    supabaseAdmin
      .from("bookings")
      .select("customer_name, customer_phone, organization_id, business_id")
      .eq("organization_id", input.organizationId)
      .eq("business_id", input.businessId)
      .in("customer_phone", storedPhoneVariants(callerE164))
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  if (contactRes.error) throw contactRes.error;
  if (bookingRes.error) throw bookingRes.error;

  const names: string[] = [];
  for (const c of (contactRes.data ?? []) as { name: string | null; phone: string }[]) {
    if (c.phone !== callerE164) continue;
    const name = speakableName(c.name);
    if (name) names.push(name);
  }
  for (const b of (bookingRes.data ?? []) as {
    customer_name: string | null;
    customer_phone: string | null;
    organization_id: string;
    business_id: string;
  }[]) {
    if (b.organization_id !== input.organizationId || b.business_id !== input.businessId) continue;
    if (!phoneMatchesCaller(b.customer_phone, callerE164, input.country)) continue;
    const name = speakableName(b.customer_name);
    if (name) names.push(name);
  }
  if (names.length === 0) return null;
  const keys = new Set(names.map(firstNameKey));
  if (keys.size !== 1) return null;
  const first = names[0]!.split(" ")[0]!;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Tools that change an existing booking — never run without proof the customer owns it. */
export const OWNERSHIP_GUARDED_TOOLS: ReadonlySet<string> = new Set(["reschedule_appointment"]);

export interface OwnershipGuardContext {
  organizationId: string;
  businessId: string;
  /** Set for voice calls — a booking made on this call is the caller's own. */
  callId?: string | null | undefined;
  /** Trusted caller ID (E.164) from the channel's signed metadata; absent when the customer isn't identified. */
  callerE164?: string | null | undefined;
  phoneCountry?: string | null | undefined;
}

/**
 * Runs before a tool call is dispatched to ai-tools.server.ts. For a tool
 * that changes an existing booking, the booking id in the tool input is
 * model/runtime-chosen and never trusted on its own: unless the booking
 * belongs to the identified customer (see the identity rule at the top of
 * this file), the call is refused with the same NOT_FOUND result a missing
 * booking gets — a mismatch reveals nothing about the booking. Returns null
 * when the call may proceed.
 */
export async function guardBookingOwnership(
  supabaseAdmin: Client,
  ctx: OwnershipGuardContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean } | null> {
  if (!OWNERSHIP_GUARDED_TOOLS.has(toolName)) return null;
  const bookingId = typeof input["bookingId"] === "string" ? input["bookingId"].trim() : "";
  // Missing input is left to the tool's own validation (INVALID_TOOL_INPUT).
  if (!bookingId) return null;
  const owned = await callerOwnsBooking(supabaseAdmin, {
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    bookingId,
    callerE164: ctx.callerE164 ?? null,
    callId: ctx.callId ?? null,
    country: ctx.phoneCountry ?? null,
  });
  if (owned) return null;
  return {
    content: JSON.stringify({
      success: false,
      error: { code: "NOT_FOUND", message: "No booking was found for this customer." },
    }),
    isError: true,
  };
}
