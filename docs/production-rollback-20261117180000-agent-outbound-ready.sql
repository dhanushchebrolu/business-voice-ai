-- Rollback for 20261117180000_agent_outbound_ready.sql. Run only with approval,
-- after the Worker is back on a version that does not read these columns.
-- Removes only what the migration added; no customer data is touched.
--
-- Pre-check (read-only): which agents are marked outbound-ready (they lose it).
--   SELECT id, organization_id, sarvam_outbound_ready_app_id, sarvam_outbound_ready_version
--     FROM public.agent_configs WHERE sarvam_outbound_ready_version IS NOT NULL;

BEGIN;
ALTER TABLE public.agent_configs DROP CONSTRAINT IF EXISTS agent_configs_outbound_ready_complete;
ALTER TABLE public.agent_configs
  DROP COLUMN IF EXISTS sarvam_outbound_ready_app_id,
  DROP COLUMN IF EXISTS sarvam_outbound_ready_version;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261117180000';
COMMIT;
