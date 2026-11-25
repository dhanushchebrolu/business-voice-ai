-- Automated Voice AI provisioning job (customer "Activate Number").
--
-- Extends the existing provisioning_runs (one active run per organization,
-- partial unique index idx_provisioning_runs_one_active) into a per-step job
-- record, and adds an append-only event trail. Nothing is deleted or
-- rewritten: nullable/defaulted columns, one new table, two indexes.
-- Re-runnable. Rollback: docs/production-rollback-20261203090000-voice-provisioning-job.sql
--
--   step_states        per-step state, e.g. {"creating_deployment":{"status":"done",...}}
--   current_job_step   the step the job is on / stopped at (exact failing step)
--   failure_code       machine code of the latest failure (admin + customer mapping)
--   retryable          true: auto-retry with backoff or admin retry may help; false: permanent
--   next_attempt_at    earliest automatic retry (pending + next_attempt_at = "retrying")
--   max_attempts       bound for automatic retries
--   diagnostics        sanitized internal diagnostics (never secrets or raw provider payloads)
--   customer_message   customer-safe text
--   idempotency_key    what the job was started for, e.g. activate:<org>:<number>
--   sarvam_agent_id    the customer's Sarvam agent id once created/registered
--   last_checkpoint    last step that fully completed (resume point)
--
-- provisioning_run_events: one row per notable job event (start, step change,
-- retry scheduled, failure, completion). Service-role only; customers only
-- ever see their own organization's job through an owner-checked server function.

ALTER TABLE public.provisioning_runs
  ADD COLUMN IF NOT EXISTS step_states jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS current_job_step text,
  ADD COLUMN IF NOT EXISTS last_checkpoint text,
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS retryable boolean,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS diagnostics jsonb,
  ADD COLUMN IF NOT EXISTS customer_message text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS sarvam_agent_id text;

-- Never two active jobs for the same number (the per-organization index
-- already allows only one per customer; this also protects a number).
CREATE UNIQUE INDEX IF NOT EXISTS idx_provisioning_runs_one_active_number
  ON public.provisioning_runs (phone_number_id)
  WHERE phone_number_id IS NOT NULL AND status IN ('pending', 'running', 'waiting');

-- Automatic retries: due pending jobs.
CREATE INDEX IF NOT EXISTS idx_provisioning_runs_due
  ON public.provisioning_runs (next_attempt_at)
  WHERE status = 'pending' AND next_attempt_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.provisioning_run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.provisioning_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  step text,
  event text NOT NULL CHECK (length(event) BETWEEN 1 AND 80),
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provisioning_run_events_run
  ON public.provisioning_run_events (run_id, created_at);

ALTER TABLE public.provisioning_run_events ENABLE ROW LEVEL SECURITY;
-- service_role too: default privileges would otherwise leave it UPDATE/DELETE (the trail is append-only).
REVOKE ALL ON public.provisioning_run_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.provisioning_run_events TO service_role;

-- Operator bridge: short-lived, revocable tokens that let a platform admin's own
-- MCP client (signed in to Sarvam by that person) pull agent work orders from
-- ClickAI and report the agent it built. Only a SHA-256 hash is stored; the raw
-- token is shown once. No Sarvam credential is ever stored here.
CREATE TABLE IF NOT EXISTS public.operator_bridge_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_bridge_tokens_short_lived CHECK (expires_at <= created_at + interval '24 hours')
);
ALTER TABLE public.operator_bridge_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.operator_bridge_tokens FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.operator_bridge_tokens TO service_role;
