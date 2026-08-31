import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type CheckoutPurpose = "setup_fee" | "monthly_plan" | "phone_service_fee";

const PRICING_KEY: Record<CheckoutPurpose, string> = {
  setup_fee: "pricing.setup_fee",
  monthly_plan: "pricing.monthly_plan",
  phone_service_fee: "pricing.phone_service_fee",
};

/** Reports whether the platform's payment provider is configured (no secrets leak). */
export const getPaymentProviderStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { razorpayConfigured, getRazorpayCredentials } = await import("@/lib/razorpay.server");
  const configured = razorpayConfigured();
  return {
    configured,
    keyId: configured ? getRazorpayCredentials()!.keyId : null,
    webhookConfigured: Boolean(process.env["RAZORPAY_WEBHOOK_SECRET"]),
  };
});

/**
 * Creates a Razorpay order for one of the configured platform charges.
 * The amount always comes from platform_settings — never from the client.
 */
export const createCheckoutOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { purpose: CheckoutPurpose }) => {
    if (!input || !(input.purpose in PRICING_KEY)) throw new Error("Invalid purpose");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: membership, error: memberError } = await supabase
      .from("organization_members")
      .select("organization_id, role")
      .eq("user_id", userId)
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!membership) throw new Error("No workspace found");
    if (!["owner", "admin"].includes(membership.role)) throw new Error("Only owners and admins can make payments");

    const { data: setting } = await supabase
      .from("platform_settings")
      .select("value")
      .eq("key", PRICING_KEY[data.purpose])
      .maybeSingle();
    const price = setting?.value as { amount: number; currency: string; label: string } | undefined;
    if (!price) throw new Error("Pricing is not configured yet");

    const { razorpayConfigured, createRazorpayOrder, getRazorpayCredentials } = await import("@/lib/razorpay.server");
    if (!razorpayConfigured()) {
      return { configured: false as const };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const receipt = `${data.purpose}-${membership.organization_id.slice(0, 8)}-${Date.now()}`;

    const order = await createRazorpayOrder({
      amount: price.amount,
      currency: price.currency,
      receipt,
      notes: { organization_id: membership.organization_id, purpose: data.purpose },
    });

    const { error: insertError } = await supabaseAdmin.from("payment_orders").insert({
      organization_id: membership.organization_id,
      purpose: data.purpose,
      provider: "razorpay",
      provider_order_id: order.id,
      amount: price.amount,
      currency: price.currency,
      status: "created",
      notes: { receipt },
      created_by: userId,
    });
    if (insertError) throw insertError;

    return {
      configured: true as const,
      keyId: getRazorpayCredentials()!.keyId,
      orderId: order.id,
      amount: price.amount,
      currency: price.currency,
      label: price.label,
    };
  });
