-- Rollback for 20261114130000_inbound_admission_and_customer_activation.sql.
-- Run only after rolling the Worker back to a version that does not read or
-- write these columns (the admission gate, number confirmation, customer
-- activation). Dropping the columns discards verification and confirmation
-- history only; no customer or payment data lives in them.
--
-- First step of the ordered runbook docs/production-rollback-runbook-provisioning.md:
--   Worker -> 130000 (this file) -> 120000 -> 110000 -> 100000 -> 090000
--
-- Precondition queries (read-only, run first):
--   SELECT version FROM supabase_migrations.schema_migrations
--    WHERE version = '20261114130000';                       -- expect: 1 row
--   SELECT count(*) FROM public.provisioning_runs
--    WHERE trigger = 'customer_activate';                     -- expect: 0 (else blocked)
--   SELECT count(*) FILTER (WHERE verified_deployment_id IS NOT NULL) AS verified,
--          count(*) FILTER (WHERE admission_blocked_at IS NOT NULL) AS blocked
--     FROM public.phone_numbers;                              -- informational: lost with the columns

BEGIN;

DO $$
BEGIN
  -- Already rolled back (or never applied): stop with a clear message, change nothing.
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261114130000') THEN
    RAISE EXCEPTION 'ROLLBACK_NOT_NEEDED: 20261114130000 is not recorded as applied';
  END IF;
  IF EXISTS (SELECT 1 FROM public.provisioning_runs WHERE trigger = 'customer_activate') THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED: customer_activate runs exist; keep the widened trigger check or relabel those rows first';
  END IF;
END $$;

ALTER TABLE public.provisioning_runs DROP CONSTRAINT IF EXISTS provisioning_runs_trigger_check;
ALTER TABLE public.provisioning_runs
  ADD CONSTRAINT provisioning_runs_trigger_check
  CHECK (trigger IN ('setup_fee', 'phone_service_fee', 'admin_retry'));

ALTER TABLE public.agent_voice_language_settings DROP COLUMN IF EXISTS applied_sarvam_app_id;

ALTER TABLE public.phone_numbers
  DROP CONSTRAINT IF EXISTS phone_numbers_verified_mapping_complete,
  DROP COLUMN IF EXISTS sarvam_number_confirmed_at,
  DROP COLUMN IF EXISTS sarvam_number_confirmed_by,
  DROP COLUMN IF EXISTS verified_deployment_id,
  DROP COLUMN IF EXISTS verified_sarvam_app_id,
  DROP COLUMN IF EXISTS verified_sarvam_app_version,
  DROP COLUMN IF EXISTS deployment_verified_at,
  DROP COLUMN IF EXISTS admission_blocked_at,
  DROP COLUMN IF EXISTS admission_blocked_reason;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261114130000';

COMMIT;

-- Post-rollback verification (read-only):
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'phone_numbers'
--      AND column_name IN ('verified_deployment_id','sarvam_number_confirmed_at','admission_blocked_at');  -- 0
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'provisioning_runs_trigger_check';      -- no customer_activate
--   SELECT count(*) FROM supabase_migrations.schema_migrations
--    WHERE version = '20261114130000';                        -- 0
--   SELECT count(*) FROM public.phone_numbers;                -- unchanged row count
