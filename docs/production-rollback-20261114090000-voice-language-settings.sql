-- Rollback for 20261114090000_agent_voice_language_settings.sql.
--
-- REVIEW BEFORE RUNNING. Run only:
--   1. after the Worker has been rolled back to a version that does not read
--      or write agent_voice_language_settings (for example fc0b86da), and
--   2. after 20261114130000 has been rolled back
--      (docs/production-rollback-20261114130000-inbound-admission.sql):
--      that rollback ALTERs this table, so it must run while the table exists.
--
-- Last step of the ordered runbook docs/production-rollback-runbook-provisioning.md:
--   Worker -> 130000 -> 120000 -> 110000 -> 100000 -> 090000 (this file)
--
-- Precondition queries (read-only, run first):
--   SELECT version FROM supabase_migrations.schema_migrations
--    WHERE version LIKE '20261114%' ORDER BY version;   -- expect: only 20261114090000
--   SELECT count(*) FROM public.agent_voice_language_settings;  -- must be 0 (see Data)
--
-- What it removes: the agent_voice_language_settings table (with its index,
-- RLS policy, grants and both triggers, which go with the table), the
-- agent_voice_language_same_org() trigger function, and the migration
-- history row. update_updated_at_column() and is_org_member() are shared and
-- are NOT dropped.
--
-- Data: the table holds only ClickAI-team voice/language choices (no payment
-- or call data). The guard below refuses to drop it while it has rows, so a
-- rollback never silently discards saved settings. To roll back anyway, first
-- export the rows (SELECT * FROM public.agent_voice_language_settings), then
-- delete them deliberately, then run this file.

BEGIN;

DO $$
DECLARE
  has_rows boolean := false;
BEGIN
  -- 1. Every later migration must already be rolled back (strict reverse order).
  IF EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE version IN ('20261114100000', '20261114110000', '20261114120000', '20261114130000')
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED: roll back 20261114130000, 120000, 110000 and 100000 first (this is the last step)';
  END IF;
  -- Already rolled back (or never applied): stop with a clear message, change nothing.
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261114090000') THEN
    RAISE EXCEPTION 'ROLLBACK_NOT_NEEDED: 20261114090000 is not recorded as applied';
  END IF;
  -- 130000 alters this table; never drop it while that column is present.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'agent_voice_language_settings'
       AND column_name = 'applied_sarvam_app_id'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED: roll back 20261114130000 first (it alters this table)';
  END IF;

  -- 2. Never silently discard saved settings. (Dynamic SQL, so this check
  --    cannot fail just because the table is already gone.)
  IF to_regclass('public.agent_voice_language_settings') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.agent_voice_language_settings)' INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'ROLLBACK_BLOCKED: agent_voice_language_settings has rows; export and remove them deliberately first';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS public.agent_voice_language_settings;
DROP FUNCTION IF EXISTS public.agent_voice_language_same_org();

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261114090000';

COMMIT;

-- Post-rollback checks (expect: no table, no function, no history row):
--   SELECT to_regclass('public.agent_voice_language_settings');               -- NULL
--   SELECT count(*) FROM pg_proc WHERE proname = 'agent_voice_language_same_org'; -- 0
--   SELECT count(*) FROM supabase_migrations.schema_migrations
--    WHERE version = '20261114090000';                                          -- 0
