import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * Phone number pool: the inventory of numbers purchased/imported ahead of
 * demand (organization_id IS NULL, status 'available') that payment-
 * triggered automatic provisioning claims from instead of buying a number
 * live inside a webhook request. See the phone_number_pool migration
 * (20260912160000) for the schema this depends on, and
 * telephony-admin.functions.ts's importPhoneNumberToPool for how numbers
 * enter the pool.
 *
 * Deliberately not a createServerFn: the automatic orchestrator (Task #93)
 * calls this from inside the Razorpay webhook route, which has no
 * authenticated user context to satisfy requireSupabaseAuth. Both the
 * webhook route and the admin-only manual claim path (if one is ever added)
 * call this same function so the race-safety logic exists exactly once.
 */

type PhoneNumberRow = Database["public"]["Tables"]["phone_numbers"]["Row"];

const MAX_CLAIM_ATTEMPTS = 5;

/**
 * Atomically claims one available pool number for `organizationId`, or
 * returns null if no number is available for this provider/country.
 *
 * Race-safe by construction, not by locking: mirrors the
 * select-candidate-then-conditional-update pattern already proven correct
 * for campaign_contacts in campaign-dispatch.server.ts (see its "Atomic
 * claim" comment). The UPDATE's own WHERE clause re-checks
 * status = 'available' AND organization_id IS NULL at write time — if a
 * concurrent claim already took this exact row between the SELECT and this
 * UPDATE, zero rows match, and the loop below tries the next candidate
 * instead of two organizations ever being handed the same number.
 */
export async function claimAvailablePhoneNumber(
  supabaseAdmin: SupabaseClient<Database>,
  params: { organizationId: string; provider: string; country?: string },
): Promise<PhoneNumberRow | null> {
  const { organizationId, provider, country } = params;

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    let candidateQuery = supabaseAdmin
      .from("phone_numbers")
      .select("id")
      .is("organization_id", null)
      .eq("status", "available")
      .eq("provider", provider)
      .order("created_at", { ascending: true })
      .limit(1);
    if (country) candidateQuery = candidateQuery.eq("country", country);

    const { data: candidates, error: selectError } = await candidateQuery;
    if (selectError) throw selectError;
    const candidate = candidates?.[0];
    if (!candidate) return null; // pool is empty for this provider/country

    const { data: claimed, error: updateError } = await supabaseAdmin
      .from("phone_numbers")
      .update({
        organization_id: organizationId,
        status: "reserved",
        reserved_at: new Date().toISOString(),
      })
      .eq("id", candidate.id)
      .eq("status", "available")
      .is("organization_id", null)
      .select("*");
    if (updateError) throw updateError;
    if (claimed && claimed.length > 0) return claimed[0]!;
    // Lost the race for this candidate — another claim took it between the
    // SELECT and this UPDATE. Try again with the next-oldest candidate.
  }

  return null;
}
