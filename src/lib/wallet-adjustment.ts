/**
 * Validation for admin wallet adjustments (outbound audit F5), shared by the
 * server function's input validator (which ships to the client bundle) and
 * wallet-adjustment.server.ts, which writes the row.
 */

/** What an admin may post. Never `call_usage`: call charges come only from call finalization. */
export const WALLET_ADJUSTMENT_KINDS = ["manual_adjustment", "refund"] as const;
export type WalletAdjustmentKind = (typeof WALLET_ADJUSTMENT_KINDS)[number];

/** The ledger's own rule for an idempotency key. */
export const WALLET_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;

export const ADJUSTMENT_KEY_REUSED_MESSAGE =
  "This request was already used for a different adjustment. Close the dialog and enter it again.";

export interface WalletAdjustmentInput {
  orgId: string;
  amount: number;
  kind: WalletAdjustmentKind;
  reason: string;
  idempotencyKey: string;
  createdBy: string;
}

/** Validates an admin request; returns the adjustment exactly as it will be stored. */
export function parseWalletAdjustment(input: {
  orgId?: unknown;
  amount?: unknown;
  kind?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
}): Omit<WalletAdjustmentInput, "createdBy"> {
  if (typeof input.orgId !== "string" || !input.orgId) throw new Error("orgId is required");
  if (typeof input.amount !== "number" || !Number.isFinite(input.amount))
    throw new Error("Amount must be a non-zero number");
  const amount = Math.round(input.amount);
  if (amount === 0) throw new Error("Amount must be a non-zero number");
  const kind = input.kind ?? "manual_adjustment";
  if (!WALLET_ADJUSTMENT_KINDS.includes(kind as WalletAdjustmentKind))
    throw new Error(`Adjustment type must be one of: ${WALLET_ADJUSTMENT_KINDS.join(", ")}.`);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new Error("A reason is required");
  if (
    typeof input.idempotencyKey !== "string" ||
    !WALLET_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)
  )
    throw new Error("This request is missing a valid request id. Reload the page and try again.");
  return {
    orgId: input.orgId,
    amount,
    kind: kind as WalletAdjustmentKind,
    reason,
    idempotencyKey: input.idempotencyKey,
  };
}
