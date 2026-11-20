-- Dual-agent provisioning: every customer gets a second, outbound-only Sarvam
-- agent next to the inbound one (docs/dual-agent-provisioning-audit.md).
--
-- agent_configs
--   sarvam_outbound_app_id / sarvam_outbound_app_version: the customer's own
--   outbound agent, registered by an operator after creating it in Sarvam
--   from the outbound template. Outbound calls dial ONLY this agent; there is
--   no fallback to sarvam_app_id (the inbound agent).
--   sarvam_outbound_ready_app_id/_version (20261117180000) keep their
--   meaning, "confirmed after a supervised call", and must now equal this
--   outbound mapping before ClickAI dials.
--   A trigger keeps the two roles apart across ALL customers: an outbound
--   agent can never be anyone's inbound agent or shared application, and the
--   reverse; a unique index stops two customers sharing an outbound agent.
--
-- sarvam_agent_integrations
--   role: which agent a credential belongs to. Existing credentials are
--   'inbound'. ClickAI's agent API refuses every booking, callback and other
--   write tool for an 'outbound' credential. One active credential per agent
--   config AND role (was: per agent config).
--
-- Additive and backward-compatible: nullable columns, a defaulted column, a
-- CHECK, a unique index, a trigger, and the one-active index widened by role.
-- No existing row changes. Re-runnable. Rollback:
-- docs/production-rollback-20261120090000-dual-agent-provisioning.sql

ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS sarvam_outbound_app_id text,
  ADD COLUMN IF NOT EXISTS sarvam_outbound_app_version integer,
  ADD COLUMN IF NOT EXISTS sarvam_outbound_registered_at timestamptz,
  ADD COLUMN IF NOT EXISTS sarvam_outbound_registered_by uuid;

-- Explicit IS NOT NULL: a CHECK that evaluates to NULL passes.
ALTER TABLE public.agent_configs DROP CONSTRAINT IF EXISTS agent_configs_outbound_agent_complete;
ALTER TABLE public.agent_configs
  ADD CONSTRAINT agent_configs_outbound_agent_complete CHECK (
    (sarvam_outbound_app_id IS NULL AND sarvam_outbound_app_version IS NULL)
    OR (
      sarvam_outbound_app_id IS NOT NULL
      AND sarvam_outbound_app_version IS NOT NULL
      AND length(btrim(sarvam_outbound_app_id)) > 0
      AND sarvam_outbound_app_version > 0
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_configs_sarvam_outbound_app_id
  ON public.agent_configs (sarvam_outbound_app_id)
  WHERE sarvam_outbound_app_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.agent_configs_sarvam_role_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Same lock key as agent_configs_sarvam_application_guard, so mapping an
  -- app as inbound and registering it as outbound cannot race each other.
  IF NEW.sarvam_app_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('agent_configs.sarvam_app_id:' || NEW.sarvam_app_id));
  END IF;
  IF NEW.sarvam_outbound_app_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('agent_configs.sarvam_app_id:' || NEW.sarvam_outbound_app_id));
    IF NEW.sarvam_outbound_app_id = NEW.sarvam_app_id THEN
      RAISE EXCEPTION 'SARVAM_OUTBOUND_AGENT_IS_INBOUND' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.agent_configs a
       WHERE a.id <> NEW.id AND a.sarvam_app_id = NEW.sarvam_outbound_app_id
    ) OR EXISTS (
      SELECT 1 FROM public.sarvam_applications s
       WHERE s.sarvam_app_id = NEW.sarvam_outbound_app_id
    ) THEN
      RAISE EXCEPTION 'SARVAM_OUTBOUND_AGENT_IN_USE_AS_INBOUND' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.sarvam_app_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.agent_configs a
     WHERE a.id <> NEW.id AND a.sarvam_outbound_app_id = NEW.sarvam_app_id
  ) THEN
    RAISE EXCEPTION 'SARVAM_INBOUND_AGENT_IS_AN_OUTBOUND_AGENT' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_agent_configs_sarvam_role_guard ON public.agent_configs;
-- sarvam_application_id too: mapping an agent through a shared application
-- sets sarvam_app_id inside agent_configs_sarvam_application_guard (which
-- fires first, by name), without naming sarvam_app_id in the UPDATE.
CREATE TRIGGER trg_agent_configs_sarvam_role_guard
  BEFORE INSERT OR UPDATE OF sarvam_app_id, sarvam_application_id, sarvam_outbound_app_id
  ON public.agent_configs
  FOR EACH ROW EXECUTE FUNCTION public.agent_configs_sarvam_role_guard();

ALTER TABLE public.sarvam_agent_integrations
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'inbound';
ALTER TABLE public.sarvam_agent_integrations DROP CONSTRAINT IF EXISTS sarvam_agent_integrations_role_check;
ALTER TABLE public.sarvam_agent_integrations
  ADD CONSTRAINT sarvam_agent_integrations_role_check CHECK (role IN ('inbound', 'outbound'));

-- Create the wider index first, so there is never a moment with neither.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sarvam_agent_integrations_one_active_per_role
  ON public.sarvam_agent_integrations (agent_config_id, role) WHERE status = 'active';
DROP INDEX IF EXISTS public.idx_sarvam_agent_integrations_one_active;
