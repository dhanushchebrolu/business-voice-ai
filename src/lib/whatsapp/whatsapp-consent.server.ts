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
 * parseConsentKeyword); staff record attested consent through the
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

/** Latest consent action per wa_id for one business and scope (absent = never recorded). */
export async function latestConsent(
  supabaseAdmin: Client,
  businessId: string,
  scope: ConsentScope,
  waIds: string[],
): Promise<Map<string, "opt_in" | "opt_out">> {
  const result = new Map<string, "opt_in" | "opt_out">();
  for (let i = 0; i < waIds.length; i += 200) {
    const chunk = waIds.slice(i, i + 200);
    const { data, error } = await supabaseAdmin
      .from("whatsapp_consent_events")
      .select("wa_id, action, created_at")
      .eq("business_id", businessId)
      .eq("scope", scope)
      .in("wa_id", chunk)
      .order("created_at", { ascending: false });
    if (error) throw error;
    for (const row of data ?? []) {
      // Rows arrive newest first: the first one seen per number wins.
      if (!result.has(row.wa_id)) result.set(row.wa_id, row.action as "opt_in" | "opt_out");
    }
  }
  return result;
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

export const OPT_OUT_ACKNOWLEDGEMENT =
  "You've been unsubscribed and won't receive further messages from us here. Reply START to subscribe again.";
export const OPT_IN_ACKNOWLEDGEMENT =
  "You're subscribed again. Reply STOP at any time to unsubscribe.";

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
