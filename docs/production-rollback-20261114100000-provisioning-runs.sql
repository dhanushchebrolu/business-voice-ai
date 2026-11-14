-- Rollback for 20261114100000_provisioning_runs_and_payment_idempotency.sql.
-- Run only after rolling the Worker back to a version that does not call
-- record_razorpay_capture or write provisioning_runs.
--
-- Step 3 (shared connection) can only be reverted while no Sarvam
-- connection id is registered for more than one organization; the guard
-- below stops the whole rollback instead of failing halfway.

-- Part of the ordered runbook docs/production-rollback-runbook-provisioning.md:
--   Worker -> 130000 -> 120000 -> 110000 -> 100000 (this file) -> 090000
--
-- Precondition queries (read-only, run first):
--   SELECT version FROM supabase_migrations.schema_migrations
--    WHERE version IN ('20261114100000','20261114110000','20261114120000','20261114130000')
--    ORDER BY version;                                   -- expect: only 20261114100000
--   SELECT provider, provider_connection_id, count(*) FROM public.telephony_connections
--    WHERE provider_connection_id IS NOT NULL
--    GROUP BY 1, 2 HAVING count(*) > 1;                   -- expect: no rows

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE version IN ('20261114110000', '20261114120000', '20261114130000')
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED: roll back 20261114130000, 20261114120000 and 20261114110000 first (later in the chain)';
  END IF;
  -- Already rolled back (or never applied): stop with a clear message, change nothing.
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261114100000') THEN
    RAISE EXCEPTION 'ROLLBACK_NOT_NEEDED: 20261114100000 is not recorded as applied';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.telephony_connections
     WHERE provider_connection_id IS NOT NULL
     GROUP BY provider, provider_connection_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED: a Sarvam connection is shared by several organizations; unregister the extra rows first';
  END IF;
END $$;

DROP INDEX IF EXISTS public.idx_telephony_connections_org_provider_connection;
CREATE UNIQUE INDEX IF NOT EXISTS idx_telephony_connections_provider_connection_id
  ON public.telephony_connections (provider, provider_connection_id)
  WHERE provider_connection_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.record_razorpay_capture(text, text, integer, text, text, timestamptz);

-- provisioning_runs holds operational history only (no payments or customer
-- data). Keep it unless a full revert is required:
-- DROP TABLE IF EXISTS public.provisioning_runs;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261114100000';

COMMIT;

-- Post-rollback verification (read-only):
--   SELECT indexname FROM pg_indexes WHERE tablename = 'telephony_connections'
--    AND indexname IN ('idx_telephony_connections_provider_connection_id',
--                      'idx_telephony_connections_org_provider_connection');
--      -- expect: only idx_telephony_connections_provider_connection_id
--   SELECT count(*) FROM pg_proc WHERE proname = 'record_razorpay_capture';  -- 0
--   SELECT count(*) FROM supabase_migrations.schema_migrations
--    WHERE version = '20261114100000';                                      -- 0
--   SELECT count(*) FROM public.telephony_connections;                      -- unchanged
--   (provisioning_runs is kept on purpose; its rows stay readable.)
