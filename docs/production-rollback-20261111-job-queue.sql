-- ROLLBACK for production migration 20261111090200_durable_job_queue.
--
-- ORDER (each step is independently safe; stop after any step that suffices):
--   1. Disable the cron: PUT /accounts/{account}/workers/scripts/klyro/schedules
--      with [] (Cloudflare API; touches only cron schedules, never the
--      clickai.in / app.clickai.in custom domains). Ticks stop within a minute.
--   2. Revert the Worker: wrangler versions deploy <previous version>@100% --name klyro.
--      The previous code never reads public.jobs, so the table can stay.
--   3. Leave public.jobs in place until its queued, running and dead-lettered
--      jobs have been handled (requeued after a fix, or reviewed). Every job
--      is idempotent, so keeping them costs nothing.
--   4. Only then, and only if the schema itself must go: run this file.
--
-- The migration only adds objects (no existing table or function changed).
-- This script refuses to drop the queue while it still holds queued,
-- running or dead-lettered jobs. Run as one transaction.
BEGIN;
DO $$
DECLARE pending integer;
BEGIN
  IF to_regclass('public.jobs') IS NOT NULL THEN
    SELECT count(*) INTO pending FROM public.jobs WHERE status IN ('queued', 'running', 'dead');
    IF pending > 0 THEN
      RAISE EXCEPTION 'refusing to drop public.jobs: % queued/running/dead job(s) still need handling', pending;
    END IF;
  END IF;
END $$;
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
