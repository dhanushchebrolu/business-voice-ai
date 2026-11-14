-- Rollback for 20261114120000_provisioning_runs_verification.sql
-- (migration history version '20261114120000').
--
-- REVIEW BEFORE RUNNING. Part of the ordered runbook
-- docs/production-rollback-runbook-provisioning.md:
--   Worker -> 130000 -> 120000 (this file) -> 110000 -> 100000 -> 090000
--
-- What it removes: the nullable column public.provisioning_runs.verification
-- (the expected-vs-actual deployment report saved by each provisioning run)
-- and this migration's history row. It does not drop the provisioning_runs
-- table or touch any other table. The column holds operational history only
-- (no customer, payment or call data); its contents are lost.
--
-- Preconditions (checked below; the transaction aborts if any fails):
--   * the Worker no longer reads or writes provisioning_runs.verification
--     (rolled back to fc0b86da) - checked by a person, see the runbook;
--   * 20261114130000 has already been rolled back (it is later in the chain).

-- Precondition queries (read-only, run first to see the current state):
--   SELECT version FROM supabase_migrations.schema_migrations
--    WHERE version IN ('20261114120000', '20261114130000') ORDER BY version;
--      -- expect: only 20261114120000
--   SELECT count(*) AS runs_with_verification FROM public.provisioning_runs
--    WHERE verification IS NOT NULL;   -- informational: rows whose report will be lost

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261114130000') THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED: roll back 20261114130000 first (later in the chain)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261114120000') THEN
    RAISE EXCEPTION 'ROLLBACK_NOT_NEEDED: 20261114120000 is not recorded as applied';
  END IF;
END $$;

ALTER TABLE public.provisioning_runs DROP COLUMN IF EXISTS verification;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261114120000';

COMMIT;

-- Post-rollback verification (read-only):
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'provisioning_runs'
--      AND column_name = 'verification';                                -- 0
--   SELECT count(*) FROM supabase_migrations.schema_migrations
--    WHERE version = '20261114120000';                                  -- 0
--   SELECT count(*) FROM public.provisioning_runs;                      -- unchanged row count
