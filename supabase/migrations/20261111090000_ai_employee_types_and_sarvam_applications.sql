-- AI employee types and reusable Sarvam application templates.
--
-- 1. agent_configs.employee_type: which AI employee this agent is
--    (receptionist, sales executive, customer care executive). Any
--    business type can use any employee type. Existing rows become
--    receptionists, which is what every agent was before.
--
-- 2. sarvam_applications: a registry of Sarvam Voice Agents apps (app id +
--    published version) that admins author in Sarvam's dashboard. An app
--    marked is_shared may be mapped to many customers' agents; otherwise
--    it maps to at most one agent, which is the old one-app-per-agent rule.
--
--    Only the app is shared. Everything customer-specific stays per
--    organization exactly as before: business data and prompts
--    (businesses/agent_configs), per-call variables, telephony
--    connections, phone numbers, calendars, call_logs and wallet ledger
--    rows. No code resolves a tenant from a Sarvam app id: outbound calls
--    are tied to their own call_logs row (attempt_id + webhook metadata)
--    and the client-context endpoint resolves by deployment, connection or
--    active phone number. Whether shared apps may be used at all is a
--    server setting (SARVAM_SHARED_APPLICATIONS_ENABLED), off unless set.
--
-- 3. agent_configs.sarvam_application_id: the template an agent is mapped
--    to. agent_configs.sarvam_app_id/sarvam_app_version stay the values
--    every call path reads; a trigger copies them from the template so
--    they can never disagree with it.
--
-- The old unique index on agent_configs.sarvam_app_id (20260908110000) is
-- narrowed to agents mapped without a template; the trigger keeps a
-- non-shared app on one agent and stops a directly mapped app from also
-- being mapped through a template.
--
-- Not destructive: two added columns (with defaults), one new table, one
-- index replaced by a narrower one. Existing mappings keep working
-- unchanged (sarvam_application_id NULL). Re-runnable.

-- ============ 1. employee_type ============
ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS employee_type text NOT NULL DEFAULT 'receptionist';

ALTER TABLE public.agent_configs DROP CONSTRAINT IF EXISTS agent_configs_employee_type_check;
ALTER TABLE public.agent_configs ADD CONSTRAINT agent_configs_employee_type_check
  CHECK (employee_type IN ('receptionist', 'sales_executive', 'customer_care_executive'));

-- ============ 2. sarvam_applications ============
CREATE TABLE IF NOT EXISTS public.sarvam_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  employee_type text NOT NULL
    CHECK (employee_type IN ('receptionist', 'sales_executive', 'customer_care_executive')),
  sarvam_app_id text NOT NULL CHECK (length(btrim(sarvam_app_id)) > 0),
  sarvam_app_version integer NOT NULL CHECK (sarvam_app_version > 0),
  is_shared boolean NOT NULL DEFAULT false,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A new published version is a new row; agents move to it explicitly.
  CONSTRAINT sarvam_applications_app_version_key UNIQUE (sarvam_app_id, sarvam_app_version)
);

-- Server-only (admin server functions use the service role); never readable
-- or writable from a browser session.
ALTER TABLE public.sarvam_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sarvam_applications FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sarvam_applications TO service_role;

DROP TRIGGER IF EXISTS trg_sarvam_applications_updated ON public.sarvam_applications;
CREATE TRIGGER trg_sarvam_applications_updated BEFORE UPDATE ON public.sarvam_applications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ 3. agent_configs.sarvam_application_id ============
ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS sarvam_application_id uuid
    REFERENCES public.sarvam_applications(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_agent_configs_sarvam_application
  ON public.agent_configs (sarvam_application_id) WHERE sarvam_application_id IS NOT NULL;

DROP INDEX IF EXISTS public.idx_agent_configs_sarvam_app_id;
CREATE UNIQUE INDEX idx_agent_configs_sarvam_app_id
  ON public.agent_configs (sarvam_app_id)
  WHERE sarvam_app_id IS NOT NULL AND sarvam_application_id IS NULL;

CREATE OR REPLACE FUNCTION public.agent_configs_sarvam_application_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  app public.sarvam_applications%ROWTYPE;
BEGIN
  IF NEW.sarvam_application_id IS NOT NULL THEN
    SELECT * INTO app FROM public.sarvam_applications WHERE id = NEW.sarvam_application_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SARVAM_APPLICATION_NOT_FOUND' USING ERRCODE = '23503';
    END IF;
    NEW.sarvam_app_id := app.sarvam_app_id;
    NEW.sarvam_app_version := app.sarvam_app_version;
  END IF;

  IF NEW.sarvam_app_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Serializes every mapping of this Sarvam app, so the checks below cannot
  -- race a concurrent mapping.
  PERFORM pg_advisory_xact_lock(hashtext('agent_configs.sarvam_app_id:' || NEW.sarvam_app_id));

  IF NEW.sarvam_application_id IS NULL THEN
    -- Direct mapping: the app must not also be mapped through a template.
    IF EXISTS (
      SELECT 1 FROM public.agent_configs
       WHERE sarvam_app_id = NEW.sarvam_app_id AND id <> NEW.id
         AND sarvam_application_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'SARVAM_APP_ALREADY_MAPPED' USING ERRCODE = '23505';
    END IF;
  ELSE
    -- Template mapping: no direct mapping of the same app, and a non-shared
    -- template stays on one agent.
    IF EXISTS (
      SELECT 1 FROM public.agent_configs
       WHERE sarvam_app_id = NEW.sarvam_app_id AND id <> NEW.id
         AND (sarvam_application_id IS NULL
              OR (NOT app.is_shared AND sarvam_application_id = NEW.sarvam_application_id))
    ) THEN
      RAISE EXCEPTION 'SARVAM_APP_ALREADY_MAPPED' USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_agent_configs_sarvam_application_guard ON public.agent_configs;
CREATE TRIGGER trg_agent_configs_sarvam_application_guard
  BEFORE INSERT OR UPDATE OF sarvam_application_id, sarvam_app_id, sarvam_app_version
  ON public.agent_configs
  FOR EACH ROW EXECUTE FUNCTION public.agent_configs_sarvam_application_guard();

-- A template's app id/version cannot change under agents mapped to it, and
-- a shared template cannot be made non-shared while several agents use it.
CREATE OR REPLACE FUNCTION public.sarvam_applications_in_use_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.sarvam_app_id IS DISTINCT FROM OLD.sarvam_app_id
      OR NEW.sarvam_app_version IS DISTINCT FROM OLD.sarvam_app_version)
     AND EXISTS (SELECT 1 FROM public.agent_configs WHERE sarvam_application_id = OLD.id) THEN
    RAISE EXCEPTION 'SARVAM_APPLICATION_IN_USE' USING ERRCODE = '23514';
  END IF;
  IF OLD.is_shared AND NOT NEW.is_shared
     AND (SELECT count(*) FROM public.agent_configs WHERE sarvam_application_id = OLD.id) > 1 THEN
    RAISE EXCEPTION 'SARVAM_APPLICATION_IN_USE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sarvam_applications_in_use_guard ON public.sarvam_applications;
CREATE TRIGGER trg_sarvam_applications_in_use_guard
  BEFORE UPDATE ON public.sarvam_applications
  FOR EACH ROW EXECUTE FUNCTION public.sarvam_applications_in_use_guard();
