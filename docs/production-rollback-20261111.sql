-- ROLLBACK for production migrations 20261110100000 and 20261111090000.
-- Captured read-only from production (eorazvlmqwunmhwviocn) on 2026-11-10T18:48:00.789Z before they were applied.
-- Neither migration changes data; this restores the schema exactly. Run as one transaction.
BEGIN;

-- 20261111090000: remove templates and employee types, restore the original index.
DROP TRIGGER IF EXISTS trg_agent_configs_sarvam_application_guard ON public.agent_configs;
DROP FUNCTION IF EXISTS public.agent_configs_sarvam_application_guard();
DROP INDEX IF EXISTS public.idx_agent_configs_sarvam_app_id;
DROP INDEX IF EXISTS public.idx_agent_configs_sarvam_application;
ALTER TABLE public.agent_configs DROP COLUMN IF EXISTS sarvam_application_id;
ALTER TABLE public.agent_configs DROP CONSTRAINT IF EXISTS agent_configs_employee_type_check;
ALTER TABLE public.agent_configs DROP COLUMN IF EXISTS employee_type;
DROP TABLE IF EXISTS public.sarvam_applications;
DROP FUNCTION IF EXISTS public.sarvam_applications_in_use_guard();
CREATE UNIQUE INDEX idx_agent_configs_sarvam_app_id ON public.agent_configs USING btree (sarvam_app_id) WHERE (sarvam_app_id IS NOT NULL);

-- 20261110100000: the wallet functions exactly as they were.
CREATE OR REPLACE FUNCTION public.debit_wallet_for_call(_org uuid, _call_id uuid, _amount integer, _description text)
 RETURNS TABLE(applied boolean, already_applied boolean, balance integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
  existing_ref text;
  new_balance integer;
BEGIN
  -- Serializes concurrent finalizations for this organization.
  PERFORM 1 FROM public.organizations WHERE id = _org FOR UPDATE;

  SELECT reference INTO existing_ref FROM public.wallet_transactions
    WHERE organization_id = _org AND kind = 'call_usage' AND reference = _call_id::text
    LIMIT 1;
  IF existing_ref IS NOT NULL THEN
    SELECT public.wallet_balance(_org) INTO new_balance;
    RETURN QUERY SELECT true, true, new_balance;
    RETURN;
  END IF;

  IF _amount <> 0 THEN
    INSERT INTO public.wallet_transactions (organization_id, amount, kind, description, reference)
    VALUES (_org, -_amount, 'call_usage', _description, _call_id::text);
  END IF;

  SELECT public.wallet_balance(_org) INTO new_balance;
  RETURN QUERY SELECT true, false, new_balance;
END; $function$;

CREATE OR REPLACE FUNCTION public.wallet_can_afford(_org uuid, _amount integer)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE bal integer;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id = _org FOR UPDATE;
  SELECT public.wallet_balance(_org) INTO bal;
  RETURN bal >= _amount;
END; $function$;

REVOKE ALL ON FUNCTION public.debit_wallet_for_call(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_wallet_for_call(uuid, uuid, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.wallet_can_afford(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_can_afford(uuid, integer) TO service_role;

DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('20261110100000', '20261111090000');
COMMIT;
