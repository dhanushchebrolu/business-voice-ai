-- Rollback for 20261119090000_outbound_call_admission.sql. Run only with approval,
-- AFTER the Worker is back on a version that does not call
-- admit_single_outbound_call or read the new columns. Removes only what the
-- migration added. Call rows are kept; only their request ids and locked
-- billing terms are dropped (finished calls are already billed, so nothing
-- is re-billed). Agents lose their recorded maximum call length.
--
-- Pre-checks (read-only):
--   SELECT count(*) FROM public.call_logs WHERE idempotency_key IS NOT NULL;
--   -- open calls whose capped billing would be lost if they finish after rollback:
--   SELECT id, status FROM public.call_logs
--    WHERE billing_cap_minutes IS NOT NULL AND finalization_state IS DISTINCT FROM 'done'
--      AND status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown');

BEGIN;
DROP FUNCTION IF EXISTS public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer);
DROP INDEX IF EXISTS public.idx_call_logs_inbound_caller;
DROP INDEX IF EXISTS public.idx_call_logs_single_outbound_open;
DROP INDEX IF EXISTS public.idx_call_logs_single_outbound_recent;
DROP INDEX IF EXISTS public.idx_call_logs_org_idempotency_key;
ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_billing_lock_valid;
ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_idempotency_key_format;
ALTER TABLE public.call_logs
  DROP COLUMN IF EXISTS billing_rate_per_minute,
  DROP COLUMN IF EXISTS billing_cap_minutes,
  DROP COLUMN IF EXISTS idempotency_key;
ALTER TABLE public.agent_configs DROP CONSTRAINT IF EXISTS agent_configs_outbound_max_call_seconds_range;
ALTER TABLE public.agent_configs DROP COLUMN IF EXISTS sarvam_outbound_max_call_seconds;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261119090000';
COMMIT;
