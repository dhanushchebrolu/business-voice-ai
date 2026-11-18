import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { normalizeCustomerPhone } from "./phone-number.ts";

/**
 * Persistent contact-level do-not-call (contacts.opted_out).
 *
 * - Set only for a contact ClickAI itself resolved (a contacts.id from its own
 *   campaign_contacts / call_logs rows, or a member's explicit action) — never
 *   from a phone number or Sarvam's user_identifier.
 * - Monotonic: nothing here clears it. Clearing goes only through
 *   reverseContactOptOut (owner/admin, reason, audit log), and the database
 *   refuses any other clear (migration 20261118120000_contact_opt_out_guard).
 * - Idempotent: a repeated opt-out (retry, duplicate webhook) changes nothing,
 *   so the first time and reason are kept.
 */

type Admin = SupabaseClient<Database>;

export const OPT_OUT_REVERSAL_MIN_REASON = 5;

export async function suppressContact(
  admin: Admin,
  input: { organizationId: string; contactId: string; reason: string; now?: Date },
): Promise<{ newlySuppressed: boolean }> {
  const { data: updated, error } = await admin
    .from("contacts")
    .update({
      opted_out: true,
      opted_out_at: (input.now ?? new Date()).toISOString(),
      opted_out_reason: input.reason,
    })
    .eq("id", input.contactId)
    .eq("organization_id", input.organizationId)
    .eq("opted_out", false)
    .select("id");
  if (error) throw error;
  // Stop every not-yet-dialled enrolment of this contact, in any campaign. Runs
  // on repeats too, so an enrolment added in between is still stopped.
  const { error: ccError } = await admin
    .from("campaign_contacts")
    .update({ status: "opted_out", next_attempt_at: null })
    .eq("contact_id", input.contactId)
    .eq("organization_id", input.organizationId)
    .in("status", ["pending", "retry_scheduled"]);
  if (ccError) throw ccError;
  return { newlySuppressed: (updated?.length ?? 0) > 0 };
}

/** True when this contact is on do-not-call (or no longer exists). Fails closed on a read error. */
export async function isContactSuppressed(admin: Admin, contactId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("contacts")
    .select("opted_out")
    .eq("id", contactId)
    .maybeSingle();
  if (error) throw error;
  return !data || data.opted_out === true;
}

/**
 * True when the organization holds an opted-out contact with exactly this
 * number. Only ever used to REFUSE a dial (contacts are unique per
 * organization + E.164 number), never to mark anyone as opted out.
 */
export async function isNumberSuppressed(
  admin: Admin,
  organizationId: string,
  phone: string,
): Promise<boolean> {
  // Same canonical form contacts are stored in (phone-number.ts); a number that
  // cannot be normalized is never dialled, so it counts as suppressed.
  const e164 = normalizeCustomerPhone(phone, null);
  if (!e164) return true;
  const { data, error } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("phone", e164)
    .eq("opted_out", true)
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export const OPT_OUT_NUMBER_MESSAGE =
  "This number is on the do-not-call list for this workspace and cannot be called.";

export const OPT_OUT_REVERSAL_ROLES: readonly string[] = ["owner", "admin"];

/**
 * A member's manual do-not-call change. Marking is open to any member of the
 * contact's organization (written with the service-role client). Clearing goes
 * through `userClient` — the signed-in user's own Supabase client, carrying
 * their JWT — so the database identifies the actor itself (auth.uid()) and
 * re-checks owner/admin; `actorRole` only gives a clear early refusal.
 */
export async function changeContactOptOut(
  admin: Admin,
  userClient: Admin,
  input: {
    organizationId: string;
    contactId: string;
    actorRole: string;
    optedOut: boolean;
    reason?: string | undefined;
  },
): Promise<{ changed: boolean }> {
  if (input.optedOut) {
    const { newlySuppressed } = await suppressContact(admin, {
      organizationId: input.organizationId,
      contactId: input.contactId,
      reason: input.reason?.trim() || "Manually marked do-not-call",
    });
    return { changed: newlySuppressed };
  }
  if (!OPT_OUT_REVERSAL_ROLES.includes(input.actorRole))
    throw new Error("Only a workspace owner or admin can remove a contact from do-not-call.");
  await reverseContactOptOut(userClient, {
    organizationId: input.organizationId,
    contactId: input.contactId,
    reason: input.reason ?? "",
  });
  return { changed: true };
}

/**
 * Clears a contact's do-not-call through reverse_contact_opt_out, which only a
 * signed-in user can call: the actor is the JWT's user (never a parameter), it
 * must be an owner/admin of the contact's organization, and the change and its
 * audit_logs row commit together. Never call this with the service-role client:
 * the database refuses it.
 */
export async function reverseContactOptOut(
  userClient: Admin,
  input: { organizationId: string; contactId: string; reason: string },
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < OPT_OUT_REVERSAL_MIN_REASON)
    throw new Error("A reason is required to remove a contact from the do-not-call list.");
  const { error } = await userClient.rpc("reverse_contact_opt_out", {
    p_contact_id: input.contactId,
    p_organization_id: input.organizationId,
    p_reason: reason,
  });
  if (error) throw new Error(error.message);
}
