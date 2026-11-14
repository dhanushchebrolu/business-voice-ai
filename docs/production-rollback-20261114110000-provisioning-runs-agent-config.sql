-- Rollback for 20261114110000_provisioning_runs_agent_config.sql
-- (migration history version '20261114110000').
--
-- REVIEW BEFORE RUNNING. Part of the ordered runbook
-- docs/production-rollback-runbook-provisioning.md:
--   Worker -> 130000 -> 120000 -> 110000 (this file) -> 100000 -> 090000
--
-- What it removes: three nullable columns on public.provisioning_runs that
-- this migration added (generated_agent_config, agent_config_fingerprint with
-- its CHECK, and provisioning_runs.deployment_verified_at), and this
-- migration's history row. It does not drop the provisioning_runs table or
-- touch any other table. Note: phone_numbers.deployment_verified_at is a
-- DIFFERENT column (added by 20261114130000) and is not touched here.
-- The columns hold operational history only; their contents are lost.
--
-- Preconditions (checked below; the transaction aborts if any fails):
--   * the Worker no longer reads or writes these columns (rolled back to
--     fc0b86da) - checked by a person, see the runbook;
--   * 20261114120000 and 20261114130000 have already been rolled back.

-- Precondition queries (read-only, run first to see the current state):
--   SELECT version FROM supabase_migrations.schema_migrations
--    WHERE version IN ('20261114110000', '20261114120000', '20261114130000')
--    ORDER BY version;                          -- expect: only 20261114110000
--   SELECT count(*) FILTER (WHERE generated_agent_config IS NOT NULL) AS with_config,
--          count(*) FILTER (WHERE deployment_verified_at IS NOT NULL) AS with_verified_at
--     FROM public.provisioning_runs;           -- informational: values that will be lost

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE version IN ('20261114120000', '20261114130000')
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED: roll back 20261114130000 and 20261114120000 first (later in the chain)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'provisioning_runs' AND column_name = 'verification'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED: provisioning_runs.verification still exists; run the 20261114120000 rollback first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261114110000') THEN
    RAISE EXCEPTION 'ROLLBACK_NOT_NEEDED: 20261114110000 is not recorded as applied';
  END IF;
END $$;

ALTER TABLE public.provisioning_runs
  DROP COLUMN IF EXISTS generated_agent_config,
  DROP COLUMN IF EXISTS agent_config_fingerprint,
  DROP COLUMN IF EXISTS deployment_verified_at;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261114110000';

COMMIT;

-- Post-rollback verification (read-only):
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'provisioning_runs'
--      AND column_name IN ('generated_agent_config', 'agent_config_fingerprint', 'deployment_verified_at');  -- 0
--   SELECT count(*) FROM supabase_migrations.schema_migrations
--    WHERE version = '20261114110000';                                  -- 0
--   SELECT count(*) FROM public.provisioning_runs;                      -- unchanged row count
--   SELECT count(*) FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'phone_numbers'
--      AND column_name = 'deployment_verified_at';                      -- 0 (already removed by 130000's rollback)
