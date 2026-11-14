-- Rollback for 20261114130000_inbound_admission_and_customer_activation.sql.
-- Run only after rolling the Worker back to a version that does not read or
-- write these columns (the admission gate, number confirmation, customer
-- activation). Dropping the columns discards verification and confirmation
-- history only; no customer or payment data lives in them.

BEGIN;

DO $$
BEGIN
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
