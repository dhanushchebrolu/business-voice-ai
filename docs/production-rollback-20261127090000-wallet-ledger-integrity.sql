-- Rollback for 20261127090000_wallet_ledger_integrity.sql.
-- Deploy the previous Worker FIRST (the new adjustWallet writes idempotency_key).
-- Drops the CHECKs, the index and the column. Ledger rows are not changed
-- (the keys stored on adjustment rows are dropped with the column).
-- idx_wallet_tx_call_usage_ref (20260904120000) is not touched and stays.
BEGIN;
ALTER TABLE public.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_tx_call_usage_has_reference;
DROP INDEX IF EXISTS public.idx_wallet_tx_idempotency_key;
ALTER TABLE public.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_tx_idempotency_key_format;
ALTER TABLE public.wallet_transactions DROP COLUMN IF EXISTS idempotency_key;
COMMIT;
