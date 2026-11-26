-- Operator bridge tokens are limited to ONE customer, ONE provisioning job and ONE agent role.
--
-- Additive on operator_bridge_tokens (20261203090000): three scope columns, constraints and an
-- index. Tokens issued before this migration have no scope, so they are revoked here (they live
-- at most hours). Apply BEFORE deploying the code that reads these columns.
-- Re-runnable. Rollback: docs/production-rollback-20261204090000-operator-bridge-token-scope.sql

ALTER TABLE public.operator_bridge_tokens
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS run_id uuid,
  ADD COLUMN IF NOT EXISTS agent_role text;

UPDATE public.operator_bridge_tokens
   SET revoked_at = now()
 WHERE revoked_at IS NULL
   AND (organization_id IS NULL OR run_id IS NULL OR agent_role IS NULL);

-- A token's job must belong to the token's customer (the database refuses a mismatched pair).
CREATE UNIQUE INDEX IF NOT EXISTS idx_provisioning_runs_id_org
  ON public.provisioning_runs (id, organization_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operator_bridge_tokens_run_of_customer') THEN
    ALTER TABLE public.operator_bridge_tokens
      ADD CONSTRAINT operator_bridge_tokens_run_of_customer
      FOREIGN KEY (run_id, organization_id)
      REFERENCES public.provisioning_runs (id, organization_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operator_bridge_tokens_role') THEN
    ALTER TABLE public.operator_bridge_tokens
      ADD CONSTRAINT operator_bridge_tokens_role CHECK (agent_role IN ('inbound', 'outbound'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'operator_bridge_tokens_scoped') THEN
    ALTER TABLE public.operator_bridge_tokens
      ADD CONSTRAINT operator_bridge_tokens_scoped CHECK (
        revoked_at IS NOT NULL
        OR (organization_id IS NOT NULL AND run_id IS NOT NULL AND agent_role IS NOT NULL)
      );
  END IF;
END $$;

-- One live token per job and role: issuing a new one must revoke the previous one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_bridge_tokens_one_live
  ON public.operator_bridge_tokens (run_id, agent_role) WHERE revoked_at IS NULL;
