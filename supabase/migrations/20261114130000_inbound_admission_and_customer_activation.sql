-- Phase 5: inbound admission gate, manual number confirmation, voice
-- settings tied to a Sarvam agent id + version, customer "Activate Number".
--
-- phone_numbers
--   sarvam_number_confirmed_at/_by  an admin confirmed the number already exists in
--                                   Sarvam on this customer's connection (Sarvam has
--                                   no documented number/connection API); provisioning
--                                   never creates a deployment before this is set.
--   verified_deployment_id,
--   verified_sarvam_app_id,
--   verified_sarvam_app_version,
--   deployment_verified_at          what step 8-10 verification last proved against
--                                   Sarvam. The admission gate serves business data
--                                   only when these equal the live mapping.
--   admission_blocked_at/_reason    set when a call result arrives from a deployment
--                                   other than the verified one; cleared by an admin.
-- agent_voice_language_settings
--   applied_sarvam_app_id           the agent the voice settings were applied to
--                                   (version alone could match a different agent).
-- provisioning_runs.trigger         adds 'customer_activate'.
--
-- Not destructive: nullable columns, a widened CHECK, no backfill (existing
-- rows stay unverified until an admin verifies them). Re-runnable. Rollback:
-- docs/production-rollback-20261114130000-inbound-admission.sql

ALTER TABLE public.phone_numbers
  ADD COLUMN IF NOT EXISTS sarvam_number_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS sarvam_number_confirmed_by uuid,
  ADD COLUMN IF NOT EXISTS verified_deployment_id text,
  ADD COLUMN IF NOT EXISTS verified_sarvam_app_id text,
  ADD COLUMN IF NOT EXISTS verified_sarvam_app_version integer,
  ADD COLUMN IF NOT EXISTS deployment_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS admission_blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS admission_blocked_reason text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'phone_numbers_verified_mapping_complete') THEN
    ALTER TABLE public.phone_numbers
      ADD CONSTRAINT phone_numbers_verified_mapping_complete CHECK (
        (verified_deployment_id IS NULL AND verified_sarvam_app_id IS NULL
          AND verified_sarvam_app_version IS NULL AND deployment_verified_at IS NULL)
        OR (verified_deployment_id IS NOT NULL AND verified_sarvam_app_id IS NOT NULL
          AND verified_sarvam_app_version > 0 AND deployment_verified_at IS NOT NULL)
      );
  END IF;
END $$;

ALTER TABLE public.agent_voice_language_settings
  ADD COLUMN IF NOT EXISTS applied_sarvam_app_id text;

ALTER TABLE public.provisioning_runs
  DROP CONSTRAINT IF EXISTS provisioning_runs_trigger_check;
ALTER TABLE public.provisioning_runs
  ADD CONSTRAINT provisioning_runs_trigger_check
  CHECK (trigger IN ('setup_fee', 'phone_service_fee', 'admin_retry', 'customer_activate'));
