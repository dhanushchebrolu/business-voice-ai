import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { providerStatus, anyProviderConfigured } from "./telephony.server";

export const listTelephonyProviders = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({ providers: providerStatus(), anyConfigured: anyProviderConfigured() }));

export const searchAvailableNumbers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        provider: z.string().min(1),
        country: z.string().min(2).max(2),
        prefix: z.string().max(8).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const provider = providerStatus().find((p) => p.id === data.provider);
    if (!provider) return { ok: false as const, reason: "unknown_provider" as const, results: [] };
    if (!provider.configured)
      return {
        ok: false as const,
        reason: "not_connected" as const,
        provider: provider.label,
        missing: provider.missing,
        results: [],
      };
    // A configured provider would be queried here for live inventory.
    return { ok: true as const, results: [] as { e164: string; monthlyPrice: number; setupFee: number; capabilities: string[] }[] };
  });

export const testTelephonyConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ provider: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    const provider = providerStatus().find((p) => p.id === data.provider);
    if (!provider) return { ok: false as const, message: "Unknown provider." };
    if (!provider.configured)
      return {
        ok: false as const,
        message: `${provider.label} is not connected yet. The platform still needs: ${provider.missing.join(", ")}.`,
      };
    return { ok: true as const, message: `${provider.label} credentials are present.` };
  });
