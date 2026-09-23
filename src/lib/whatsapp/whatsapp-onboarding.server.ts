import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { MetaWhatsAppClient } from "./meta-client.server.ts";
import { MetaApiError } from "./meta-client.server.ts";

/**
 * Orchestrates the WhatsApp Embedded Signup v4 onboarding sequence for one
 * tenant, after the browser has already completed Meta's hosted flow and
 * handed ClickAI a short-lived authorization code. Callers own
 * authentication and tenant derivation (whatsapp-onboarding.functions.ts's
 * createServerFn wrapper resolves organizationId from the authenticated
 * user's own organization_members row — never from client input — before
 * calling this function). This function itself performs no auth check; it
 * takes organizationId as an already-trusted parameter, matching the same
 * separation sarvam-inbound-deployment.server.ts already established
 * (a pure, supabaseAdmin-taking core, testable without an HTTP auth
 * context).
 *
 * Sequence (verified against current Meta documentation — see
 * meta-client.server.ts's own doc comment for exactly what was and was not
 * independently confirmed):
 *   1. Validate businessId (if given) belongs to this exact organization.
 *   2. Exchange the authorization code for a Business Integration System
 *      User access token, scoped to whatever assets the customer granted.
 *   3. Read the phone number back through Meta's API using that token —
 *      this is what actually proves the client-supplied phoneNumberId is
 *      real and covered by the token, not just an unverified client claim.
 *   4. Reject if this Meta phone_number_id is already live on a
 *      DIFFERENT organization (defense-in-depth alongside Phase 1's own
 *      unique index — see idx_whatsapp_connections_phone_number_id_live).
 *   5. Upsert a whatsapp_connections row (status: 'connecting') as soon as
 *      the identifiers are verified, BEFORE attempting registration or
 *      webhook subscription — so a mid-sequence failure always leaves a
 *      diagnosable, retryable row instead of nothing.
 *   6. Register the phone number with a freshly-generated 6-digit PIN.
 *      On failure: mark the row 'error' and return that state (does not
 *      throw — the row itself carries the outcome).
 *   7. Subscribe ClickAI's app to the WABA's webhook events. On failure:
 *      mark the row 'needs_attention' (the token and registration ARE
 *      valid and persisted — only the webhook subscription needs a retry,
 *      not a full re-signup) rather than discarding a partially-successful
 *      onboarding.
 *   8. Only once both 6 and 7 succeed: encrypt and persist the access
 *      token and PIN, mark the row 'connected'.
 *
 * Never throws once step 5's row exists — from that point on, every
 * outcome (including a failure) is communicated through the returned
 * result's `status`/`lastError`, so a caller always has a row to show/
 * retry rather than a bare exception. Steps 1-4 (nothing persisted yet)
 * DO throw — there is no row to attach a failure state to.
 */

export class WhatsAppOnboardingError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export interface CompleteWhatsAppOnboardingInput {
  organizationId: string;
  businessId: string | null;
  code: string;
  wabaId: string;
  phoneNumberId: string;
}

export interface CompleteWhatsAppOnboardingResult {
  connectionId: string;
  status: "connected" | "needs_attention" | "error";
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  webhookSubscribed: boolean;
  lastError: string | null;
}

export interface WhatsAppOnboardingDeps {
  metaClient: Pick<
    MetaWhatsAppClient,
    "exchangeAuthorizationCode" | "getPhoneNumber" | "registerPhoneNumber" | "subscribeApp"
  >;
  encryptCredential: (plaintext: string) => string;
  /** Injectable so tests never depend on real randomness; production always passes a fresh cryptographically-random 6-digit PIN generator. */
  generatePin: () => string;
}

type Client = SupabaseClient<Database>;

/** Never leaks a raw Meta/DB error to the returned row or the caller — every persisted last_error is one of these fixed, safe strings. */
function safeErrorMessage(err: unknown): string {
  if (err instanceof MetaApiError) return err.message;
  if (err instanceof WhatsAppOnboardingError) return err.message;
  return "An unexpected error occurred while contacting Meta.";
}

export async function completeWhatsAppOnboarding(
  supabaseAdmin: Client,
  input: CompleteWhatsAppOnboardingInput,
  deps: WhatsAppOnboardingDeps,
): Promise<CompleteWhatsAppOnboardingResult> {
  const { organizationId, businessId, code, wabaId, phoneNumberId } = input;

  // 1. businessId, if supplied, must genuinely belong to this organization
  // — never trust it just because the (already-authenticated) caller sent
  // it; a compromised or buggy frontend must not be able to attach a
  // connection to another tenant's business by id guess.
  if (businessId) {
    const { data: business, error: businessError } = await supabaseAdmin
      .from("businesses")
      .select("id, organization_id")
      .eq("id", businessId)
      .maybeSingle();
    if (businessError) throw businessError;
    if (!business || business.organization_id !== organizationId) {
      throw new WhatsAppOnboardingError(
        "That business does not belong to your workspace.",
        "invalid_business",
      );
    }
  }

  // 2. Code exchange — no row exists yet, so a failure here throws.
  let accessToken: string;
  try {
    ({ accessToken } = await deps.metaClient.exchangeAuthorizationCode(code));
  } catch (err) {
    throw new WhatsAppOnboardingError(safeErrorMessage(err), "exchange_failed");
  }

  // 3. Verify the phone number through Meta's own API using the fresh
  // token — the token, not the client-supplied id, is what proves
  // ownership (see this function's module doc).
  let verified: {
    id: string;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
  };
  try {
    verified = await deps.metaClient.getPhoneNumber(phoneNumberId, accessToken);
  } catch (err) {
    throw new WhatsAppOnboardingError(safeErrorMessage(err), "phone_lookup_failed");
  }

  // 4. Cross-tenant duplicate check, before any write — mirrors Phase 1's
  // idx_whatsapp_connections_phone_number_id_live unique index as an
  // explicit, better-worded pre-check rather than relying solely on a
  // 23505 from the database.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("whatsapp_connections")
    .select("id, organization_id, status")
    .eq("phone_number_id", verified.id)
    .neq("status", "disconnected")
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing && existing.organization_id !== organizationId) {
    throw new WhatsAppOnboardingError(
      "This WhatsApp number is already connected to a different ClickAI account.",
      "duplicate_phone_number",
    );
  }

  // 5. Persist identifiers immediately (insert or update the existing
  // same-org row) — from here on, every outcome is recorded on this row
  // rather than thrown.
  const connectingPatch = {
    organization_id: organizationId,
    business_id: businessId,
    waba_id: wabaId,
    phone_number_id: verified.id,
    display_phone_number: verified.displayPhoneNumber,
    verified_name: verified.verifiedName,
    status: "connecting" as const,
    last_error: null,
  };

  let connectionId: string;
  if (existing) {
    const { error: updateError } = await supabaseAdmin
      .from("whatsapp_connections")
      .update(connectingPatch)
      .eq("id", existing.id);
    if (updateError) throw updateError;
    connectionId = existing.id;
  } else {
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from("whatsapp_connections")
      .insert(connectingPatch)
      .select("id")
      .single();
    if (insertError) {
      // Defense-in-depth: a concurrent request won the unique-index race
      // between this function's own pre-check above and this insert.
      if ((insertError as { code?: string }).code === "23505") {
        throw new WhatsAppOnboardingError(
          "This WhatsApp number is already connected to a different ClickAI account.",
          "duplicate_phone_number",
        );
      }
      throw insertError;
    }
    connectionId = inserted.id;
  }

  const baseResult = {
    connectionId,
    wabaId,
    phoneNumberId: verified.id,
    displayPhoneNumber: verified.displayPhoneNumber,
    verifiedName: verified.verifiedName,
  };

  // 6. Register the phone number.
  const pin = deps.generatePin();
  try {
    await deps.metaClient.registerPhoneNumber(verified.id, pin, accessToken);
  } catch (err) {
    const lastError = safeErrorMessage(err);
    await supabaseAdmin
      .from("whatsapp_connections")
      .update({ status: "error", last_error: lastError })
      .eq("id", connectionId);
    return { ...baseResult, status: "error", webhookSubscribed: false, lastError };
  }

  // 7. Subscribe to webhooks. Registration already succeeded, so the
  // token/PIN are genuinely usable even if this step fails — persist them
  // either way rather than discarding a partially-successful onboarding.
  const accessTokenCiphertext = deps.encryptCredential(accessToken);
  const twoStepPinCiphertext = deps.encryptCredential(pin);

  let webhookSubscribed = false;
  let lastError: string | null = null;
  try {
    const subscribed = await deps.metaClient.subscribeApp(wabaId, accessToken);
    webhookSubscribed = subscribed.success;
    if (!webhookSubscribed) lastError = "Meta did not confirm the webhook subscription.";
  } catch (err) {
    lastError = safeErrorMessage(err);
  }

  const finalStatus: CompleteWhatsAppOnboardingResult["status"] = webhookSubscribed
    ? "connected"
    : "needs_attention";

  const { error: finalUpdateError } = await supabaseAdmin
    .from("whatsapp_connections")
    .update({
      status: finalStatus,
      access_token_ciphertext: accessTokenCiphertext,
      two_step_pin_ciphertext: twoStepPinCiphertext,
      webhook_subscribed: webhookSubscribed,
      last_connected_at: finalStatus === "connected" ? new Date().toISOString() : null,
      last_error: lastError,
    })
    .eq("id", connectionId);
  if (finalUpdateError) throw finalUpdateError;

  return { ...baseResult, status: finalStatus, webhookSubscribed, lastError };
}
