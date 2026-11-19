import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * RETIRED: the generic outbound path for Vobiz/Exotel numbers.
 *
 * It dialled through the provider adapter with only a membership, number and
 * one-minute wallet check: no role check (any staff member could dial), no
 * kill switch, calling hours, prior-relationship rule, test allowlist, atomic
 * limits, request-id dedupe or billing cap. ClickAI voice is Sarvam-only, so
 * every single outbound call now goes through createSarvamInstantOutboundCall
 * (sarvam-outbound.functions.ts) and its central gate, and this server
 * function refuses everything. It stays exported only so an old client gets a
 * clear answer instead of a missing endpoint; it dials nothing and writes
 * nothing.
 */

export const GENERIC_OUTBOUND_RETIRED_MESSAGE =
  "Outbound calls are placed from the Calls page with a Sarvam number. This older calling path is switched off.";

export const initiateOutboundCall = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => input)
  .handler(async (): Promise<never> => {
    throw new Error(GENERIC_OUTBOUND_RETIRED_MESSAGE);
  });
