-- Rollback for 20261119090000_outbound_call_admission.sql. Run only with approval,
-- after the Worker is back on a version that does not call
-- admit_single_outbound_call (single outbound calls then use the earlier
-- application-level checks). Removes only what the migration added; call rows
-- are kept, only their idempotency keys are dropped.
--
-- Pre-check (read-only): how many calls carry an idempotency key.
--   SELECT count(*) FROM public.call_logs WHERE idempotency_key IS NOT NULL;

BEGIN;
DROP FUNCTION IF EXISTS public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer);
DROP INDEX IF EXISTS public.idx_call_logs_single_outbound_recent;
DROP INDEX IF EXISTS public.idx_call_logs_org_idempotency_key;
ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_idempotency_key_format;
ALTER TABLE public.call_logs DROP COLUMN IF EXISTS idempotency_key;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261119090000';
COMMIT;
