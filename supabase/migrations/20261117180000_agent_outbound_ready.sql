-- One Sarvam agent per customer handles both inbound and outbound calls.
-- Outbound calls set call_direction = "outbound" (plus the campaign objective
-- and instructions) as agent variables and override the opening line per
-- call; inbound calls pass nothing, so the agent's declared default
-- ("inbound") applies.
--
-- Only an agent version that declares those variables and carries the
-- outbound section may be dialled. An admin records it here after a
-- supervised test. Outbound dialling requires these two columns to equal the
-- agent's current sarvam_app_id / sarvam_app_version, so mapping the agent
-- to another app or version blocks outbound until that version is confirmed
-- too (fail closed; nothing to reset on remap or rollback).
--
-- Not destructive: two nullable columns and a CHECK that they are set or
-- cleared together. Re-runnable. Rollback:
-- docs/production-rollback-20261117180000-agent-outbound-ready.sql

ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS sarvam_outbound_ready_app_id text,
  ADD COLUMN IF NOT EXISTS sarvam_outbound_ready_version integer;

-- Explicit IS NOT NULL: a CHECK passes when it evaluates to NULL, so
-- length(btrim(NULL)) > 0 alone would let a half-set pair through.
ALTER TABLE public.agent_configs DROP CONSTRAINT IF EXISTS agent_configs_outbound_ready_complete;
ALTER TABLE public.agent_configs
  ADD CONSTRAINT agent_configs_outbound_ready_complete CHECK (
    (sarvam_outbound_ready_app_id IS NULL AND sarvam_outbound_ready_version IS NULL)
    OR (
      sarvam_outbound_ready_app_id IS NOT NULL
      AND sarvam_outbound_ready_version IS NOT NULL
      AND length(btrim(sarvam_outbound_ready_app_id)) > 0
      AND sarvam_outbound_ready_version > 0
    )
  );
