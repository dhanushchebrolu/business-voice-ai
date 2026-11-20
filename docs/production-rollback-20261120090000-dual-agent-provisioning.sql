-- Rollback for 20261120090000_dual_agent_provisioning.sql. Run only with approval,
-- after the Worker is back on a version that does not read these columns.
-- Outbound credentials are disabled (their agents stop reaching ClickAI) so the
-- original one-active-per-agent index can be restored; registered outbound
-- agents are forgotten (the Sarvam agents themselves are untouched).
--
-- Pre-check (read-only):
--   SELECT id, organization_id, sarvam_outbound_app_id, sarvam_outbound_app_version
--     FROM public.agent_configs WHERE sarvam_outbound_app_id IS NOT NULL;
--   SELECT id, organization_id, agent_config_id, status
--     FROM public.sarvam_agent_integrations WHERE role = 'outbound';

BEGIN;
UPDATE public.sarvam_agent_integrations
   SET status = 'disabled', disabled_at = now(), disabled_reason = 'dual-agent rollback'
 WHERE role = 'outbound' AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_sarvam_agent_integrations_one_active
  ON public.sarvam_agent_integrations (agent_config_id) WHERE status = 'active';
DROP INDEX IF EXISTS public.idx_sarvam_agent_integrations_one_active_per_role;
ALTER TABLE public.sarvam_agent_integrations DROP CONSTRAINT IF EXISTS sarvam_agent_integrations_role_check;
ALTER TABLE public.sarvam_agent_integrations DROP COLUMN IF EXISTS role;

DROP TRIGGER IF EXISTS trg_agent_configs_sarvam_role_guard ON public.agent_configs;
DROP FUNCTION IF EXISTS public.agent_configs_sarvam_role_guard();
DROP INDEX IF EXISTS public.idx_agent_configs_sarvam_outbound_app_id;
ALTER TABLE public.agent_configs DROP CONSTRAINT IF EXISTS agent_configs_outbound_agent_complete;
ALTER TABLE public.agent_configs
  DROP COLUMN IF EXISTS sarvam_outbound_app_id,
  DROP COLUMN IF EXISTS sarvam_outbound_app_version,
  DROP COLUMN IF EXISTS sarvam_outbound_registered_at,
  DROP COLUMN IF EXISTS sarvam_outbound_registered_by;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261120090000';
COMMIT;
