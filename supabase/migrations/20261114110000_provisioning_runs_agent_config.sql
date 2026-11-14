-- Phase 2 of per-customer Sarvam provisioning: each provisioning run keeps
-- the customer-specific configuration of the universal master agent it was
-- built from (src/lib/universal-agent-config.ts), its fingerprint, and when
-- the deployment and number mapping were last verified against Sarvam.
--
-- Not destructive: three nullable columns on a table added in
-- 20261114100000. Re-runnable. Rollback:
--   ALTER TABLE public.provisioning_runs
--     DROP COLUMN IF EXISTS generated_agent_config,
--     DROP COLUMN IF EXISTS agent_config_fingerprint,
--     DROP COLUMN IF EXISTS deployment_verified_at;

ALTER TABLE public.provisioning_runs
  ADD COLUMN IF NOT EXISTS generated_agent_config jsonb,
  ADD COLUMN IF NOT EXISTS agent_config_fingerprint text
    CHECK (agent_config_fingerprint IS NULL OR length(agent_config_fingerprint) BETWEEN 4 AND 64),
  ADD COLUMN IF NOT EXISTS deployment_verified_at timestamptz;
