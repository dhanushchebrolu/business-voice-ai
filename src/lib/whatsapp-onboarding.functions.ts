import { createServerFn } from "@tanstack/react-start";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertFeatureUnlocked } from "@/lib/feature-gate.server";
import { resolveMetaWhatsAppConfig } from "@/lib/whatsapp/meta-config.server";
import { MetaWhatsAppClient } from "@/lib/whatsapp/meta-client.server";
import { encryptCredential } from "@/lib/whatsapp/whatsapp-token-crypto.server";
import { completeWhatsAppOnboarding as completeWhatsAppOnboardingCore } from "@/lib/whatsapp/whatsapp-onboarding.server";

/**
 * The one customer-facing entry point for WhatsApp Embedded Signup v4
 * onboarding (Phase 2's "6. Automated post-signup registration/
 * subscription flow" combined with the server-side code exchange — see
 * whatsapp-onboarding.server.ts for the actual sequence).
 *
 * This wrapper's only job is authentication, tenant derivation, and
 * dependency wiring — never business logic. organizationId is derived
 * exclusively from the authenticated user's own organization_members row
 * via the RLS-scoped client (same pattern as telephony-customer.
 * functions.ts's requestPhoneNumber), never trusted from client input —
 * there is deliberately no organizationId field anywhere in this
 * function's input schema.
 *
 * Frontend/browser boundary (Phase 3+ builds the actual UI component that
 * calls this): the browser completes Meta's hosted Embedded Signup flow
 * and extracts { code, wabaId, phoneNumberId } from it, then calls this
 * function with exactly those three fields plus an optional businessId.
 * The browser never sees META_APP_SECRET, the exchanged access token, the
 * generated two-step PIN, or WHATSAPP_CREDENTIAL_ENCRYPTION_KEY — none of
 * those cross this boundary in either direction. The return value below is
 * the full extent of what the browser gets back.
 */

interface CompleteWhatsAppOnboardingInput {
  code: unknown;
  wabaId: unknown;
  phoneNumberId: unknown;
  businessId?: unknown;
}

const inputSchema = z.object({
  code: z.string().min(1),
  wabaId: z.string().min(1),
  phoneNumberId: z.string().min(1),
  businessId: z.string().uuid().optional().nullable(),
});

export const completeWhatsAppOnboarding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CompleteWhatsAppOnboardingInput) => inputSchema.parse(input))
  .handler(async ({ data, context }) => {
    // Organization resolution: RLS-scoped, keyed by the authenticated
    // user's own id — never a client-supplied organization id.
    const { data: membership } = await context.supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", context.userId)
      .limit(1)
      .maybeSingle();
    if (!membership) throw new Error("No workspace found for your account.");
    const organizationId = membership.organization_id;

    await assertFeatureUnlocked(organizationId, "whatsapp");

    const config = resolveMetaWhatsAppConfig();
    if (!config) {
      throw new Error("WhatsApp is not configured on this deployment yet. Please contact support.");
    }

    const metaClient = new MetaWhatsAppClient({
      appId: config.appId,
      appSecret: config.appSecret,
      graphApiVersion: config.graphApiVersion,
    });

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let result;
    try {
      result = await completeWhatsAppOnboardingCore(
        supabaseAdmin,
        {
          organizationId,
          businessId: data.businessId ?? null,
          code: data.code,
          wabaId: data.wabaId,
          phoneNumberId: data.phoneNumberId,
        },
        {
          metaClient,
          encryptCredential,
          generatePin: generateSixDigitPin,
        },
      );
    } catch (err) {
      // Structured, secret-free log: WhatsAppOnboardingError's own .code
      // and .message are already safe (see whatsapp-onboarding.server.ts's
      // safeErrorMessage) — nothing here logs the request body, the
      // authorization header, or any Meta credential.
      console.error("whatsapp_onboarding:failed", {
        organization_id: organizationId,
        error: (err as Error).message,
      });
      throw err;
    }

    // Customer-visible timeline entry — the same generic per-org table
    // Customer 360 already reads (customer_events), matching
    // telephony-customer.functions.ts's requestPhoneNumber convention.
    // Never includes any credential; `detail` is built only from fields
    // this function's own result already sanitized.
    const actorEmail = (context.claims["email"] as string | undefined) ?? null;
    await supabaseAdmin.from("customer_events").insert({
      organization_id: organizationId,
      kind: result.status === "connected" ? "whatsapp_connected" : "whatsapp_connect_attempted",
      title:
        result.status === "connected"
          ? "WhatsApp connected"
          : "WhatsApp connection needs attention",
      detail: `${result.displayPhoneNumber ?? result.phoneNumberId} — status: ${result.status}`,
      actor_email: actorEmail,
      metadata: { connection_id: result.connectionId, waba_id: result.wabaId },
    });

    // Sanitized result only — connectionId/status/identifiers, never a
    // ciphertext, token, or PIN (completeWhatsAppOnboardingCore's own
    // return type never includes them in the first place).
    return result;
  });

/**
 * Cryptographically-random 6-digit two-step-verification PIN for Meta's
 * phone-number /register call. Matches the existing randomPin() pattern
 * already established in admin-clients.functions.ts (node:crypto's
 * randomInt, zero-padded) rather than introducing a second PIN-generation
 * convention.
 */
function generateSixDigitPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
