import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * Idempotent admin wallet adjustments (outbound audit F5). The admin's dialog
 * sends one request id per adjustment it means to post, reused on retry. The
 * ledger's unique idx_wallet_tx_idempotency_key (migration 20261127090000)
 * makes a second row for that id impossible, even for concurrent requests; a
 * repeat with the same parameters returns the first result, and the same id
 * with different parameters is refused.
 */

import { ADJUSTMENT_KEY_REUSED_MESSAGE, type WalletAdjustmentInput } from "./wallet-adjustment.ts";

export * from "./wallet-adjustment.ts";

/**
 * Posts the adjustment once. `applied: false` means this request id was
 * already posted with the same parameters (a retry): nothing new was written.
 */
export async function postWalletAdjustment(
  admin: SupabaseClient<Database>,
  input: WalletAdjustmentInput,
): Promise<{ applied: boolean }> {
  const { error } = await admin.from("wallet_transactions").insert({
    organization_id: input.orgId,
    amount: input.amount,
    kind: input.kind,
    description: input.reason,
    created_by: input.createdBy,
    idempotency_key: input.idempotencyKey,
  });
  if (!error) return { applied: true };
  if ((error as { code?: string }).code !== "23505") throw error;

  // Same request id already in the ledger (committed: the unique index waits for it).
  const { data: existing, error: readError } = await admin
    .from("wallet_transactions")
    .select("organization_id, amount, kind, description")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (readError) throw readError;
  if (
    !existing ||
    existing.organization_id !== input.orgId ||
    existing.amount !== input.amount ||
    existing.kind !== input.kind ||
    existing.description !== input.reason
  )
    throw new Error(ADJUSTMENT_KEY_REUSED_MESSAGE);
  return { applied: false };
}
