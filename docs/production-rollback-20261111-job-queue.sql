-- ROLLBACK for production migration 20261111090200_durable_job_queue.
-- The migration only adds objects (no existing table or function changes),
-- so this removes them. Pending/dead jobs are discarded with the table:
-- run it only after disabling the scheduler (JOBS_SCHEDULER_ENABLED=false
-- or redeploying the previous Worker version) and noting any dead letters.
-- Run as one transaction.
BEGIN;
DROP FUNCTION IF EXISTS public.enqueue_job(text, jsonb, text, uuid, timestamptz, integer);
DROP FUNCTION IF EXISTS public.claim_jobs(text, integer, integer);
DROP FUNCTION IF EXISTS public.complete_job(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.fail_job(uuid, text, text, boolean);
DROP FUNCTION IF EXISTS public.requeue_dead_job(uuid);
DROP FUNCTION IF EXISTS public.job_queue_stats();
DROP FUNCTION IF EXISTS public.prune_jobs(interval);
DROP TABLE IF EXISTS public.jobs;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261111090200';
COMMIT;
