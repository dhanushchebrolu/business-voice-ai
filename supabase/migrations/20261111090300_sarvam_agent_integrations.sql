-- Per-customer Sarvam agent integrations: the credential a customer's Sarvam
-- agent uses to call ClickAI's agent API (on-start context, mid-call tools,
-- on-end outcome), and an audit trail of those calls.
--
-- Security model:
--   * One credential per customer agent. Only its SHA-256 hash is stored
--     (token_hash); the raw token is shown to the admin once at issue time
--     and never again. A short non-secret display prefix identifies it.
--   * The tenant is resolved ONLY from the credential: token -> integration
--     -> organization + agent_config (+ that agent's business). Nothing in a
--     request body can choose the organization.
--   * Rotation replaces the hash in place, so the old token stops working
--     immediately. Disabling sets status 'disabled'. Optional expires_at.
--   * At most one active integration per agent; a trigger guarantees the
--     agent belongs to the same organization as the integration.
--   * Both tables are server-only: RLS on, no policies, no grants to anon or
--     authenticated. Admin and API code use the service role.
--
-- Not destructive: two new tables, one trigger function. Re-runnable.

CREATE TABLE IF NOT EXISTS public.sarvam_agent_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_config_id uuid NOT NULL REFERENCES public.agent_configs(id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text NOT NULL CHECK (length(token_prefix) BETWEEN 4 AND 16),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  expires_at timestamptz,
  last_used_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  disabled_at timestamptz,
  disabled_reason text,
  CONSTRAINT sarvam_agent_integrations_token_hash_key UNIQUE (token_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sarvam_agent_integrations_one_active
  ON public.sarvam_agent_integrations (agent_config_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sarvam_agent_integrations_org
  ON public.sarvam_agent_integrations (organization_id);

ALTER TABLE public.sarvam_agent_integrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sarvam_agent_integrations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sarvam_agent_integrations TO service_role;

DROP TRIGGER IF EXISTS trg_sarvam_agent_integrations_updated ON public.sarvam_agent_integrations;
CREATE TRIGGER trg_sarvam_agent_integrations_updated BEFORE UPDATE ON public.sarvam_agent_integrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.sarvam_agent_integration_same_org()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_configs a
     WHERE a.id = NEW.agent_config_id AND a.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'SARVAM_INTEGRATION_AGENT_ORG_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sarvam_agent_integration_same_org ON public.sarvam_agent_integrations;
CREATE TRIGGER trg_sarvam_agent_integration_same_org
  BEFORE INSERT OR UPDATE OF organization_id, agent_config_id ON public.sarvam_agent_integrations
  FOR EACH ROW EXECUTE FUNCTION public.sarvam_agent_integration_same_org();

CREATE TABLE IF NOT EXISTS public.sarvam_agent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES public.sarvam_agent_integrations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z_]{1,39}$'),
  interaction_id text CHECK (interaction_id IS NULL OR length(interaction_id) <= 200),
  status text NOT NULL CHECK (status IN ('ok', 'error', 'rejected')),
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One recorded outcome per Sarvam interaction (on-end hooks may be retried).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sarvam_agent_events_one_outcome
  ON public.sarvam_agent_events (integration_id, interaction_id)
  WHERE kind = 'call_outcome' AND interaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sarvam_agent_events_org_time
  ON public.sarvam_agent_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sarvam_agent_events_integration_time
  ON public.sarvam_agent_events (integration_id, created_at DESC);

ALTER TABLE public.sarvam_agent_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sarvam_agent_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.sarvam_agent_events TO service_role;
