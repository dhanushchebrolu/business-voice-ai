import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type PricingKey =
  | "pricing.setup_fee"
  | "pricing.monthly_plan"
  | "pricing.phone_service_fee"
  | "pricing.voice_minute"
  | "pricing.outbound_call"
  | "pricing.whatsapp_message";

export interface PriceValue {
  amount: number; // in the smallest currency unit (paise)
  currency: string;
  label: string;
}

export type PriceMap = Partial<Record<PricingKey, PriceValue>>;

/** Formats a paise amount as Indian rupees, without decimals when whole. */
export function formatMoney(amount: number | undefined, currency = "INR") {
  if (amount === undefined) return "—";
  const value = amount / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: value % 1 === 0 ? 0 : 2,
  }).format(value);
}

export const pricingQuery = () =>
  queryOptions({
    queryKey: ["platform-pricing"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<PriceMap> => {
      const { data, error } = await supabase.from("platform_settings").select("key, value").like("key", "pricing.%");
      if (error) throw error;
      const map: PriceMap = {};
      for (const row of data ?? []) {
        map[row.key as PricingKey] = row.value as unknown as PriceValue;
      }
      return map;
    },
  });
