-- Rollback for 20261114100000_provisioning_runs_and_payment_idempotency.sql.
-- Run only after rolling the Worker back to a version that does not call
-- record_razorpay_capture or write provisioning_runs.
--
-- Step 3 (shared connection) can only be reverted while no Sarvam
-- connection id is registered for more than one organization; the guard
-- below stops the whole rollback instead of failing halfway.

BEGIN;

DO $$
BEGIN
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
