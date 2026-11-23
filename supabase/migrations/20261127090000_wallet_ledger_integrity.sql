-- Wallet ledger integrity (outbound audit F4 and F5).
--
-- F4: one usage charge per call is already enforced in storage by
-- idx_wallet_tx_call_usage_ref, UNIQUE (organization_id, reference) WHERE
-- kind = 'call_usage' (20260904120000). Its one gap: a `call_usage` row with a
-- NULL reference is not covered (NULLs never collide), so a charge that names
-- no call could be written any number of times. Now every `call_usage` row
-- must name its call.
--
-- F5: admin wallet adjustments (adjustWallet) had no idempotency, so a
-- network retry or a second tab could post the same adjustment twice. Each
-- adjustment now carries the request's idempotency key, unique across the
-- ledger: a repeat of the same request can never write a second row, whatever
-- the application does. Every other ledger writer leaves it NULL.
--
-- Existing rows: the CHECK is added NOT VALID, then VALIDATEd; it fails (and
-- the migration rolls back, changing nothing) only if a `call_usage` row with
-- no reference exists. Run docs/wallet-ledger-integrity-precheck.sql
-- (read-only) first. No row is changed: the ledger is append-only and this
-- migration only adds a nullable column, a CHECK and an index.
--
-- Rollback: docs/production-rollback-20261127090000-wallet-ledger-integrity.sql

ALTER TABLE public.wallet_transactions ADD COLUMN IF NOT EXISTS idempotency_key text;

ALTER TABLE public.wallet_transactions DROP CONSTRAINT IF EXISTS wallet_tx_idempotency_key_format;
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_tx_idempotency_key_format
  CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,100}$');

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_idempotency_key
  ON public.wallet_transactions (idempotency_key) WHERE idempotency_key IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_tx_call_usage_has_reference') THEN
    ALTER TABLE public.wallet_transactions
      ADD CONSTRAINT wallet_tx_call_usage_has_reference
      CHECK (kind <> 'call_usage' OR reference IS NOT NULL) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.wallet_transactions VALIDATE CONSTRAINT wallet_tx_call_usage_has_reference;
