-- ROLLBACK for production migration 20261111090100_wallet_balance_ledger_cache.
-- Function bodies captured read-only from production (eorazvlmqwunmhwviocn) on 2026-11-11T04:44:09.783Z, before it was applied.
-- The migration changes no ledger row, so this restores the schema exactly. Run as one transaction.
BEGIN;
DROP TRIGGER IF EXISTS trg_wallet_tx_apply ON public.wallet_transactions;
DROP TRIGGER IF EXISTS trg_wallet_tx_immutable ON public.wallet_transactions;
DROP TRIGGER IF EXISTS trg_wallet_tx_no_truncate ON public.wallet_transactions;
DROP FUNCTION IF EXISTS public.wallet_apply_ledger_entry();
DROP FUNCTION IF EXISTS public.wallet_ledger_immutable();
-- idx_wallet_tx_call_usage_ref (20260904120000) is not touched by the migration and stays.

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
    SELECT COALESCE(SUM(amount), 0)::int INTO new_balance
      FROM public.wallet_transactions WHERE organization_id = _org;
    RETURN QUERY SELECT true, true, new_balance;
    RETURN;
  END IF;

  IF _amount <> 0 THEN
    INSERT INTO public.wallet_transactions (organization_id, amount, kind, description, reference)
    VALUES (_org, -_amount, 'call_usage', _description, _call_id::text);
  END IF;

  SELECT COALESCE(SUM(amount), 0)::int INTO new_balance
    FROM public.wallet_transactions WHERE organization_id = _org;
  RETURN QUERY SELECT true, false, new_balance;
END; $function$;

CREATE OR REPLACE FUNCTION public.wallet_balance(_org uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN public.is_org_member(_org) OR public.is_platform_admin()
    THEN (SELECT COALESCE(SUM(amount), 0)::int FROM public.wallet_transactions WHERE organization_id = _org)
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public.wallet_can_afford(_org uuid, _amount integer)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE bal integer;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id = _org FOR UPDATE;
  SELECT COALESCE(SUM(amount), 0)::int INTO bal
    FROM public.wallet_transactions WHERE organization_id = _org;
  RETURN bal >= _amount;
END; $function$;

DROP TABLE IF EXISTS public.wallet_balances;
REVOKE ALL ON FUNCTION public.debit_wallet_for_call(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_wallet_for_call(uuid, uuid, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.wallet_can_afford(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_can_afford(uuid, integer) TO service_role;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261111090100';
COMMIT;
