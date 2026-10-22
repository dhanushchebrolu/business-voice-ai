/**
 * WhatsApp consent and suppression — the one place every business-initiated
 * send asks "may we message this number?".
 *
 * Consent lives in the append-only whatsapp_consent_events ledger, per
 * business, customer number (wa_id: E.164 digits, no '+') and scope:
 *   - 'transactional': booking and payment notifications. A business can
 *     only turn notifications on after recording the basis on which its
 *     customers agree to them (whatsapp_connections.
 *     transactional_consent_basis); an explicit opt-out still wins.
 *   - 'marketing': campaigns. Requires an explicit opt-in as the latest
 *     marketing event — never implied.
 * The latest event per (business, wa_id, scope) wins. A number in
 * whatsapp_suppressions never gets a business-initiated message.
 *
 * Customers manage it themselves by replying STOP / START (see
 * parseConsentKeyword; START restores transactional messages only, see
 * consentScopesForKeyword); staff record attested consent through the
 * dashboard; Meta's own "user stopped marketing messages" signal is
 * recorded as a marketing opt-out.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { normalizeCustomerPhone } from "../phone-number.ts";

type Client = SupabaseClient<Database>;

export type ConsentScope = "transactional" | "marketing";
export type ConsentSource =
  "staff_attested" | "customer_keyword" | "customer_form" | "import" | "meta_signal";

/** E.164 digits without '+', as Meta's wa_id — or null for anything that isn't a valid number. */
export function toWaId(
  phone: string | null | undefined,
  country: string | null | undefined,
): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (/^\+[1-9]\d{6,14}$/.test(trimmed)) return trimmed.slice(1);
  const e164 = normalizeCustomerPhone(trimmed, country);
  return e164 && /^\+[1-9]\d{6,14}$/.test(e164) ? e164.slice(1) : null;
}

/** A wa_id exactly as Meta sends it (international digits, no '+'). */
export function isWaId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[1-9]\d{6,14}$/.test(value);
}

export async function recordConsentEvent(
  supabaseAdmin: Client,
  input: {
    organizationId: string;
    businessId: string;
    waId: string;
    scope: ConsentScope;
    action: "opt_in" | "opt_out";
    source: ConsentSource;
    evidence?: string | null | undefined;
    contactId?: string | null | undefined;
    actorUserId?: string | null | undefined;
  },
): Promise<void> {
  const { error } = await supabaseAdmin.from("whatsapp_consent_events").insert({
    organization_id: input.organizationId,
    business_id: input.businessId,
    wa_id: input.waId,
    scope: input.scope,
    action: input.action,
    source: input.source,
    evidence: input.evidence ? input.evidence.slice(0, 1000) : null,
    contact_id: input.contactId ?? null,
    actor_user_id: input.actorUserId ?? null,
  });
  if (error) throw error;
}

/** Rows read per request: at or below PostgREST's default max-rows, so a page is never silently cut short. */
export const CONSENT_PAGE_SIZE = 1000;
const WA_ID_CHUNK = 100;

type ConsentAction = "opt_in" | "opt_out";
interface ConsentRow {
  wa_id: string;
  action: string;
  created_at: string;
  source?: string | null;
  contact_id?: string | null;
}

/** Opt-outs that come from the customer (or Meta, on their behalf): only the customer can lift them. */
const CUSTOMER_OPT_OUT_SOURCES = new Set(["customer_keyword", "customer_form", "meta_signal"]);
/** Opt-ins the customer gave themselves (START, their own form). */
const CUSTOMER_OPT_IN_SOURCES = new Set(["customer_keyword", "customer_form"]);

export interface ConsentState {
  action: ConsentAction;
  at: number;
  contactId: string | null;
  /** The opt-out is the customer's own (or Meta's) and staff can't reverse it. */
  authoritative: boolean;
  latest: { action: ConsentAction; at: number };
  customerOptOutAt: number | null;
  customerOptInAt: number | null;
}

/**
 * Folds consent rows into the current action per number. The newest
 * created_at wins; on an exact tie an opt-out wins, so the answer never
 * depends on row order and an opt-out can't be lost to a same-instant
 * opt-in. One exception: an opt-out the customer gave (STOP, their form,
 * or Meta's "stopped marketing" signal) stands until the customer opts in
 * again themselves (START, their form) strictly later — a staff-attested
 * or imported opt-in doesn't reverse it.
 */
export function foldLatestConsent(
  rows: Iterable<ConsentRow>,
  into = new Map<string, ConsentState>(),
) {
  for (const row of rows) {
    const at = new Date(row.created_at).getTime();
    const action: ConsentAction = row.action === "opt_out" ? "opt_out" : "opt_in";
    const source = row.source ?? "";
    const current = into.get(row.wa_id);
    let latest = current?.latest;
    let contactId = current?.contactId ?? null;
    if (
      !latest ||
      at > latest.at ||
      (at === latest.at && action === "opt_out" && latest.action !== "opt_out")
    ) {
      latest = { action, at };
      contactId = row.contact_id ?? contactId;
    }
    let customerOptOutAt = current?.customerOptOutAt ?? null;
    let customerOptInAt = current?.customerOptInAt ?? null;
    if (action === "opt_out" && CUSTOMER_OPT_OUT_SOURCES.has(source)) {
      customerOptOutAt = Math.max(customerOptOutAt ?? at, at);
    }
    if (action === "opt_in" && CUSTOMER_OPT_IN_SOURCES.has(source)) {
      customerOptInAt = Math.max(customerOptInAt ?? at, at);
    }
    const customerOptOutStands =
      customerOptOutAt !== null &&
      !(customerOptInAt !== null && customerOptInAt > customerOptOutAt);
    const resolved: ConsentAction = customerOptOutStands ? "opt_out" : latest.action;
    into.set(row.wa_id, {
      action: resolved,
      at: latest.at,
      contactId,
      authoritative: resolved === "opt_out" && customerOptOutStands,
      latest,
      customerOptOutAt,
      customerOptInAt,
    });
  }
  return into;
}

/**
 * Reads every consent row matching `filter`, page by page in a stable order
 * (newest first, then id), so no row is skipped however many there are.
 * Rows inserted while paging only push others down a page, so at worst a
 * row is read twice, which folding tolerates.
 */
async function readAllConsentRows(
  supabaseAdmin: Client,
  businessId: string,
  scope: ConsentScope,
  waIds: string[] | null,
): Promise<ConsentRow[]> {
  const rows: ConsentRow[] = [];
  for (let offset = 0; ; offset += CONSENT_PAGE_SIZE) {
    let query = supabaseAdmin
      .from("whatsapp_consent_events")
      .select("wa_id, action, created_at, source, contact_id")
      .eq("business_id", businessId)
      .eq("scope", scope);
    if (waIds) query = query.in("wa_id", waIds);
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + CONSENT_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < CONSENT_PAGE_SIZE) return rows;
  }
}

/** Latest consent action per wa_id for one business and scope (absent = never recorded). */
export async function latestConsent(
  supabaseAdmin: Client,
  businessId: string,
  scope: ConsentScope,
  waIds: string[],
): Promise<Map<string, ConsentAction>> {
  const folded = new Map<string, ConsentState>();
  for (let i = 0; i < waIds.length; i += WA_ID_CHUNK) {
    foldLatestConsent(
      await readAllConsentRows(supabaseAdmin, businessId, scope, waIds.slice(i, i + WA_ID_CHUNK)),
      folded,
    );
  }
  return new Map([...folded].map(([waId, v]) => [waId, v.action]));
}

/** Latest consent per number for every number this business has a record for (campaign audiences). */
export async function latestConsentForBusiness(
  supabaseAdmin: Client,
  businessId: string,
  scope: ConsentScope,
): Promise<Map<string, { action: ConsentAction; contactId: string | null }>> {
  const folded = foldLatestConsent(
    await readAllConsentRows(supabaseAdmin, businessId, scope, null),
  );
  return new Map(
    [...folded].map(([waId, v]) => [waId, { action: v.action, contactId: v.contactId }]),
  );
}

export async function suppressedWaIds(
  supabaseAdmin: Client,
  businessId: string,
  waIds: string[],
): Promise<Set<string>> {
  const result = new Set<string>();
  for (let i = 0; i < waIds.length; i += 200) {
    const { data, error } = await supabaseAdmin
      .from("whatsapp_suppressions")
      .select("wa_id")
      .eq("business_id", businessId)
      .in("wa_id", waIds.slice(i, i + 200));
    if (error) throw error;
    for (const row of data ?? []) result.add(row.wa_id);
  }
  return result;
}

/**
 * True while the customer's own opt-out (STOP, their form) or Meta's
 * opt-out signal stands for this number and scope: a staff-attested opt-in
 * can't reverse it, so the dashboard refuses to record one.
 */
export async function customerOptOutBlocksStaffOptIn(
  supabaseAdmin: Client,
  businessId: string,
  scope: ConsentScope,
  waId: string,
): Promise<boolean> {
  const rows = await readAllConsentRows(supabaseAdmin, businessId, scope, [waId]);
  const state = foldLatestConsent(rows).get(waId);
  return Boolean(state && state.action === "opt_out" && state.authoritative);
}

export type SendPermission =
  { allowed: true } | { allowed: false; reason: "suppressed" | "opted_out" | "no_consent" };

/**
 * May the business initiate a message of this scope to this number?
 * transactional: allowed unless opted out or suppressed (the business has
 * attested its consent basis to enable notifications at all).
 * marketing: only with an explicit opt-in as the latest marketing event.
 */
export async function checkSendPermission(
  supabaseAdmin: Client,
  businessId: string,
  waId: string,
  scope: ConsentScope,
): Promise<SendPermission> {
  if ((await suppressedWaIds(supabaseAdmin, businessId, [waId])).has(waId)) {
    return { allowed: false, reason: "suppressed" };
  }
  const latest = (await latestConsent(supabaseAdmin, businessId, scope, [waId])).get(waId);
  if (latest === "opt_out") return { allowed: false, reason: "opted_out" };
  if (scope === "marketing" && latest !== "opt_in") return { allowed: false, reason: "no_consent" };
  return { allowed: true };
}

/**
 * STOP / START keywords (the conventional opt-out words customers use, in
 * English and common Hindi transliterations). Only a message that is just
 * the keyword counts — "stop by tomorrow?" is not an opt-out.
 */
const STOP_WORDS = new Set([
  "stop",
  "unsubscribe",
  "opt out",
  "optout",
  "stop all",
  "cancel subscription",
  "band karo",
  "bandh karo",
]);
const START_WORDS = new Set(["start", "subscribe", "opt in", "optin", "unstop"]);

export function parseConsentKeyword(text: string): "opt_out" | "opt_in" | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!\s]+$/u, "")
    .replace(/\s+/g, " ");
  if (STOP_WORDS.has(normalized)) return "opt_out";
  if (START_WORDS.has(normalized)) return "opt_in";
  return null;
}

/**
 * The scopes a STOP / START keyword changes. STOP opts out of everything.
 * START only restores booking and payment messages: a bare "start" (often
 * just how someone opens a chat) is not the explicit marketing opt-in that
 * campaigns require.
 */
export function consentScopesForKeyword(keyword: "opt_out" | "opt_in"): ConsentScope[] {
  return keyword === "opt_out" ? ["transactional", "marketing"] : ["transactional"];
}

export const OPT_OUT_ACKNOWLEDGEMENT =
  "You've been unsubscribed and won't receive further messages from us here. Reply START to subscribe again.";
export const OPT_IN_ACKNOWLEDGEMENT =
  "You'll receive booking and payment updates from us here again. Reply STOP at any time to unsubscribe.";

export async function writeAuditLog(
  supabaseAdmin: Client,
  entry: {
    organizationId: string;
    businessId?: string | null | undefined;
    actorType: "user" | "system" | "customer";
    actorUserId?: string | null | undefined;
    action: string;
    subjectType: string;
    subjectId?: string | null | undefined;
    details?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  const { error } = await supabaseAdmin.from("whatsapp_audit_log").insert({
    organization_id: entry.organizationId,
    business_id: entry.businessId ?? null,
    actor_type: entry.actorType,
    actor_user_id: entry.actorUserId ?? null,
    action: entry.action,
    subject_type: entry.subjectType,
    subject_id: entry.subjectId ?? null,
    details: (entry.details ?? {}) as never,
  });
  // An audit write failing must not undo the action it describes, but it
  // must be visible.
  if (error)
    console.error("whatsapp_audit:write_failed", { action: entry.action, code: error.code });
}
