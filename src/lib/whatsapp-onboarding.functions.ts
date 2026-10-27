import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertFeatureUnlocked } from "@/lib/feature-gate.server";
import { requireWhatsAppManager } from "@/lib/whatsapp/whatsapp-access.server";
import {
  VobizWhatsAppClient,
  missingVobizWhatsAppSettings,
  resolveVobizWhatsAppConfig,
} from "@/lib/whatsapp/vobiz-whatsapp-client.server";

/**
 * Customer-facing WhatsApp onboarding through Vobiz (ClickAI's WhatsApp
 * BSP): the three connection options, plus reconnect. The logic lives in
 * whatsapp-vobiz-onboarding.server.ts; these wrappers only authenticate,
 * authorize and wire dependencies:
 *
 *   - requireSupabaseAuth: a signed-in user.
 *   - requireWhatsAppManager: the organization comes from the chosen
 *     business (or the caller's only workspace) / the target connection,
 *     and the caller must be an owner or admin of exactly it. No input
 *     schema has an organization id.
 *   - assertFeatureUnlocked(organizationId, "whatsapp"): the same billing /
 *     feature gate as before.
 *   - Vobiz credentials are read server-side only (VOBIZ_AUTH_ID /
 *     VOBIZ_AUTH_TOKEN); if missing, the names (never values) are logged and
 *     the customer sees "not configured".
 *
 * Nothing returned to the browser contains a credential; the Meta token a
 * BYON customer pastes goes to Vobiz in one request and is never stored,
 * returned or logged.
 */

async function deps() {
  const config = resolveVobizWhatsAppConfig();
  if (!config) {
    console.error("whatsapp_onboarding:not_configured", {
      missing: missingVobizWhatsAppSettings(),
    });
    throw new Error("WhatsApp is not configured on this deployment yet. Please contact support.");
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const vobiz = new VobizWhatsAppClient(config);
  return { supabaseAdmin, vobiz };
}

/** owner/admin scope for an optional target business, feature gate included. */
async function managerScope(
  supabaseAdmin: Awaited<ReturnType<typeof deps>>["supabaseAdmin"],
  userId: string,
  businessId: string | null | undefined,
) {
  const scope = await requireWhatsAppManager(
    supabaseAdmin,
    userId,
    businessId ? { businessId } : { workspace: true },
  );
  await assertFeatureUnlocked(scope.organizationId, "whatsapp");
  return scope;
}

async function timeline(
  supabaseAdmin: Awaited<ReturnType<typeof deps>>["supabaseAdmin"],
  organizationId: string,
  actorEmail: string | null,
  event: { kind: string; title: string; detail: string; metadata: Record<string, string | null> },
) {
  await supabaseAdmin.from("customer_events").insert({
    organization_id: organizationId,
    actor_email: actorEmail,
    ...event,
  });
}

const businessId = z.string().uuid().optional().nullable();
const e164 = z.string().min(7).max(20);
const metaId = z.string().min(1).max(32);

// 1. Bring your own number ---------------------------------------------------

export const startWhatsAppByonVerification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ businessId, phoneNumber: e164, method: z.enum(["sms", "voice"]) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, vobiz } = await deps();
    const scope = await managerScope(supabaseAdmin, context.userId, data.businessId);
    const { startByonVerification } =
      await import("@/lib/whatsapp/whatsapp-vobiz-onboarding.server");
    return startByonVerification(supabaseAdmin, scope, data, { vobiz });
  });

export const connectWhatsAppByon = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        businessId,
        phoneNumber: e164,
        otpCode: z.string().min(4).max(8),
        wabaId: metaId,
        phoneNumberId: metaId,
        accessToken: z.string().min(20).max(1024),
        displayName: z.string().max(120).optional().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, vobiz } = await deps();
    const scope = await managerScope(supabaseAdmin, context.userId, data.businessId);
    const { connectByon } = await import("@/lib/whatsapp/whatsapp-vobiz-onboarding.server");
    const result = await connectByon(supabaseAdmin, scope, data, { vobiz });
    if (!result.alreadyConnected) {
      await timeline(
        supabaseAdmin,
        scope.organizationId,
        (context.claims["email"] as string) ?? null,
        {
          kind: "whatsapp_connected",
          title: "WhatsApp connected (your own number via Vobiz)",
          detail: result.phoneNumber ?? result.connectionId,
          metadata: { connection_id: result.connectionId, mode: "bring_your_own" },
        },
      );
    }
    return result;
  });

// 2. Buy a number through Vobiz ------------------------------------------------

export const searchWhatsAppNumbers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ businessId, country: z.string().length(2) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, vobiz } = await deps();
    await managerScope(supabaseAdmin, context.userId, data.businessId);
    const { searchNumbers } = await import("@/lib/whatsapp/whatsapp-vobiz-onboarding.server");
    return { numbers: await searchNumbers({ country: data.country }, { vobiz }) };
  });

export const orderWhatsAppNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        businessId,
        phoneNumber: e164,
        // Buying spends money on ClickAI's Vobiz account: the browser must
        // send an explicit confirmation from the confirm dialog.
        confirm: z.literal(true),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, vobiz } = await deps();
    const scope = await managerScope(supabaseAdmin, context.userId, data.businessId);
    const { orderNumber } = await import("@/lib/whatsapp/whatsapp-vobiz-onboarding.server");
    const order = await orderNumber(
      supabaseAdmin,
      scope,
      { phoneNumber: data.phoneNumber, requestedBy: context.userId },
      { vobiz },
    );
    if (!order.alreadyOrdered) {
      await timeline(
        supabaseAdmin,
        scope.organizationId,
        (context.claims["email"] as string) ?? null,
        {
          kind: "whatsapp_number_ordered",
          title: "WhatsApp number ordered from Vobiz",
          detail: `${order.phoneNumber} — ${order.status}`,
          metadata: { order_id: order.id },
        },
      );
    }
    return order;
  });

export const listWhatsAppNumberOrders = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const scope = await requireWhatsAppManager(supabaseAdmin, context.userId, { workspace: true });
    const { listNumberOrders } = await import("@/lib/whatsapp/whatsapp-vobiz-onboarding.server");
    return listNumberOrders(supabaseAdmin, scope.organizationId);
  });

export const connectPurchasedWhatsAppNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        businessId,
        orderId: z.string().uuid(),
        wabaId: metaId,
        displayName: z.string().max(120).optional().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, vobiz } = await deps();
    const scope = await managerScope(supabaseAdmin, context.userId, data.businessId);
    const { connectPurchasedNumber } =
      await import("@/lib/whatsapp/whatsapp-vobiz-onboarding.server");
    const result = await connectPurchasedNumber(supabaseAdmin, scope, data, { vobiz });
    if (!result.alreadyConnected) {
      await timeline(
        supabaseAdmin,
        scope.organizationId,
        (context.claims["email"] as string) ?? null,
        {
          kind: "whatsapp_connected",
          title: "WhatsApp connected (number bought through Vobiz)",
          detail: result.phoneNumber ?? result.connectionId,
          metadata: { connection_id: result.connectionId, mode: "buy_from_vobiz" },
        },
      );
    }
    return result;
  });

// 3. Embedded Signup through Vobiz ---------------------------------------------

export const completeWhatsAppEmbeddedSignup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        businessId,
        code: z.string().min(1).max(2048),
        wabaId: metaId,
        phoneNumberId: metaId,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, vobiz } = await deps();
    const scope = await managerScope(supabaseAdmin, context.userId, data.businessId);
    const { completeEmbeddedSignup } =
      await import("@/lib/whatsapp/whatsapp-vobiz-onboarding.server");
    const result = await completeEmbeddedSignup(supabaseAdmin, scope, data, { vobiz });
    if (!result.alreadyConnected) {
      await timeline(
        supabaseAdmin,
        scope.organizationId,
        (context.claims["email"] as string) ?? null,
        {
          kind: "whatsapp_connected",
          title: "WhatsApp connected (Embedded Signup via Vobiz)",
          detail: result.phoneNumber ?? result.connectionId,
          metadata: { connection_id: result.connectionId, mode: "embedded_signup" },
        },
      );
    }
    return result;
  });

// Reconnect ----------------------------------------------------------------

export const reconnectWhatsAppConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ connectionId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, vobiz } = await deps();
    const scope = await requireWhatsAppManager(supabaseAdmin, context.userId, {
      connectionId: data.connectionId,
    });
    await assertFeatureUnlocked(scope.organizationId, "whatsapp");
    const { reconnectConnection } = await import("@/lib/whatsapp/whatsapp-vobiz-onboarding.server");
    const result = await reconnectConnection(
      supabaseAdmin,
      { ...scope, connectionId: data.connectionId },
      { vobiz },
    );
    await timeline(
      supabaseAdmin,
      scope.organizationId,
      (context.claims["email"] as string) ?? null,
      {
        kind: "whatsapp_reconnected",
        title: "WhatsApp reconnected",
        detail: result.connectionId,
        metadata: { connection_id: result.connectionId },
      },
    );
    return result;
  });

/** Disconnected Vobiz numbers this organization can reconnect (no channel id or credential is returned). */
export const listDisconnectedWhatsAppNumbers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const scope = await requireWhatsAppManager(supabaseAdmin, context.userId, { workspace: true });
    const { data, error } = await supabaseAdmin
      .from("whatsapp_connections")
      .select("id, display_phone_number, phone_number_id, number_onboarding_mode, disconnected_at")
      .eq("organization_id", scope.organizationId)
      .eq("status", "disconnected")
      .eq("provider", "vobiz")
      .order("disconnected_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return data ?? [];
  });
