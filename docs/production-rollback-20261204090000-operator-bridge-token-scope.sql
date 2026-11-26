-- Rollback of 20261204090000_operator_bridge_token_scope.sql.
-- NOT run automatically. Run only after rolling the code back to a version that does not read
-- the scope columns. Every live token is revoked first: older code would treat a scoped token as
-- valid for every customer.

UPDATE public.operator_bridge_tokens SET revoked_at = now() WHERE revoked_at IS NULL;

DROP INDEX IF EXISTS public.idx_operator_bridge_tokens_one_live;
ALTER TABLE public.operator_bridge_tokens
  DROP CONSTRAINT IF EXISTS operator_bridge_tokens_scoped,
  DROP CONSTRAINT IF EXISTS operator_bridge_tokens_role,
  DROP CONSTRAINT IF EXISTS operator_bridge_tokens_run_of_customer,
  DROP COLUMN IF EXISTS organization_id,
  DROP COLUMN IF EXISTS run_id,
  DROP COLUMN IF EXISTS agent_role;
DROP INDEX IF EXISTS public.idx_provisioning_runs_id_org;
