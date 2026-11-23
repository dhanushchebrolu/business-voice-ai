-- Read-only precheck for 20261127090000_wallet_ledger_integrity.sql.
-- Every count must be 0, and the call-usage index must exist, before applying.
SELECT
  (SELECT count(*) FROM public.wallet_transactions
    WHERE kind = 'call_usage' AND reference IS NULL)                       AS call_usage_without_reference,
  (SELECT count(*) FROM (SELECT organization_id, reference FROM public.wallet_transactions
    WHERE kind = 'call_usage' GROUP BY 1, 2 HAVING count(*) > 1) d)        AS duplicate_call_charges,
  (SELECT count(*) FROM pg_indexes
    WHERE indexname = 'idx_wallet_tx_call_usage_ref' AND indexdef LIKE 'CREATE UNIQUE INDEX%') AS call_usage_unique_index_present;
