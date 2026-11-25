-- Rollback for 20261203090000_voice_provisioning_job.sql. Drops only objects
-- that migration added. Refuses to run while the new columns hold data you
-- would lose, unless you set  SET LOCAL rollback.discard_job_data = 'yes';
DO $$
BEGIN
  IF coalesce(current_setting('rollback.discard_job_data', true), '') <> 'yes'
     AND (SELECT count(*) FROM public.provisioning_run_events) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: provisioning_run_events has rows (set rollback.discard_job_data = yes to drop them)';
  END IF;
END $$;
DROP TABLE IF EXISTS public.provisioning_run_events;
DROP INDEX IF EXISTS public.idx_provisioning_runs_due;
DROP INDEX IF EXISTS public.idx_provisioning_runs_one_active_number;
ALTER TABLE public.provisioning_runs
  DROP COLUMN IF EXISTS step_states,
  DROP COLUMN IF EXISTS current_job_step,
  DROP COLUMN IF EXISTS last_checkpoint,
  DROP COLUMN IF EXISTS failure_code,
  DROP COLUMN IF EXISTS retryable,
  DROP COLUMN IF EXISTS next_attempt_at,
  DROP COLUMN IF EXISTS max_attempts,
  DROP COLUMN IF EXISTS diagnostics,
  DROP COLUMN IF EXISTS customer_message,
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS sarvam_agent_id;
DROP TABLE IF EXISTS public.operator_bridge_tokens;
