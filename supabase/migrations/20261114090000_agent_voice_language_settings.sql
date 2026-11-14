-- Per-customer voice and language settings for the customer's own Sarvam
-- agent (one Sarvam agent per customer, decided 2026-11-14).
--
-- One row per agent_configs row. ClickAI's onboarding team writes it through
-- admin server functions (service role); customers may read their own row so
-- a customer-facing Voice & Language section can be added later without a
-- schema change. Customers cannot write it.
--
-- Sarvam has no unattended API for agent voice or language settings, so the
-- row records both what is wanted and whether it has been applied to the
-- customer's Sarvam agent: status 'pending' until an admin records the
-- committed Sarvam agent version that carries it, then 'applied'. Any later
-- change returns it to 'pending'.
--
-- Language names are Sarvam's spellings. Policy (enforced here and in
-- src/lib/sarvam-voice-catalog.ts): the default language, English and Hindi
-- are always allowed, plus at most two more regional languages.
--
-- Not destructive: one new table. Re-runnable.

CREATE TABLE IF NOT EXISTS public.agent_voice_language_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_config_id uuid NOT NULL UNIQUE REFERENCES public.agent_configs(id) ON DELETE CASCADE,
  default_language text NOT NULL,
  allowed_languages text[] NOT NULL,
  auto_language_switch boolean NOT NULL DEFAULT true,
  sarvam_voice_internal_id text NOT NULL CHECK (length(btrim(sarvam_voice_internal_id)) > 0),
  sarvam_voice_name text NOT NULL CHECK (length(btrim(sarvam_voice_name)) > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied')),
  applied_sarvam_app_version integer CHECK (applied_sarvam_app_version IS NULL OR applied_sarvam_app_version > 0),
  applied_at timestamptz,
  applied_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_voice_language_known_languages CHECK (
    allowed_languages <@ ARRAY['English','Hindi','Bengali','Tamil','Telugu','Gujarati','Kannada',
                               'Malayalam','Marathi','Punjabi','Odia','Assamese']::text[]
  ),
  CONSTRAINT agent_voice_language_policy CHECK (
    default_language = ANY (allowed_languages)
    AND allowed_languages @> ARRAY['English','Hindi']::text[]
    AND cardinality(allowed_languages) <= 5
  ),
  CONSTRAINT agent_voice_language_applied_complete CHECK (
    status = 'pending'
    OR (applied_sarvam_app_version IS NOT NULL AND applied_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_agent_voice_language_settings_org
  ON public.agent_voice_language_settings (organization_id);

ALTER TABLE public.agent_voice_language_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_voice_language_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.agent_voice_language_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_voice_language_settings TO service_role;

DROP POLICY IF EXISTS "tenant voice language settings read" ON public.agent_voice_language_settings;
CREATE POLICY "tenant voice language settings read" ON public.agent_voice_language_settings
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

DROP TRIGGER IF EXISTS trg_agent_voice_language_settings_updated ON public.agent_voice_language_settings;
CREATE TRIGGER trg_agent_voice_language_settings_updated BEFORE UPDATE ON public.agent_voice_language_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- The agent must belong to the same organization as the row.
CREATE OR REPLACE FUNCTION public.agent_voice_language_same_org()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_configs a
     WHERE a.id = NEW.agent_config_id AND a.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'VOICE_LANGUAGE_AGENT_ORG_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_agent_voice_language_same_org ON public.agent_voice_language_settings;
CREATE TRIGGER trg_agent_voice_language_same_org
  BEFORE INSERT OR UPDATE OF organization_id, agent_config_id ON public.agent_voice_language_settings
  FOR EACH ROW EXECUTE FUNCTION public.agent_voice_language_same_org();
