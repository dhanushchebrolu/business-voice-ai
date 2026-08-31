import { useCallback, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createCheckoutOrder, type CheckoutPurpose } from "@/lib/billing.functions";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

const CHECKOUT_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";

function loadCheckoutScript(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SCRIPT}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(true));
      existing.addEventListener("error", () => resolve(false));
      return;
    }
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT;
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

/**
 * Opens the hosted payment sheet for a platform charge. The account is only
 * unlocked once the provider webhook confirms the payment server-side.
 */
export function useCheckout(context?: { email?: string | null | undefined; name?: string | null | undefined }) {
  const startOrder = useServerFn(createCheckoutOrder);
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<CheckoutPurpose | null>(null);

  const pay = useCallback(
    async (purpose: CheckoutPurpose) => {
      setPending(purpose);
      try {
        const order = await startOrder({ data: { purpose } });
        if (!order.configured) {
          toast.error("Payments are not connected yet", {
            description: "The platform's payment provider credentials have not been configured.",
          });
          return;
        }

        const ready = await loadCheckoutScript();
        if (!ready || !window.Razorpay) {
          toast.error("Could not open the payment window", { description: "Check your connection and try again." });
          return;
        }

        const checkout = new window.Razorpay({
          key: order.keyId,
          order_id: order.orderId,
          amount: order.amount,
          currency: order.currency,
          name: "Vaani",
          description: order.label,
          prefill: { email: context?.email ?? undefined, name: context?.name ?? undefined },
          theme: { color: "#000000" },
          modal: {
            ondismiss: () => setPending(null),
          },
          handler: () => {
            toast.success("Payment received", {
              description: "We're confirming it with the payment provider — your account unlocks automatically.",
            });
            setTimeout(() => {
              void queryClient.invalidateQueries();
            }, 4000);
          },
        });
        checkout.open();
      } catch (error) {
        toast.error("Payment could not be started", { description: (error as Error).message });
      } finally {
        setPending((p) => (p === purpose ? null : p));
      }
    },
    [startOrder, queryClient, context?.email, context?.name],
  );

  return { pay, pending };
}
