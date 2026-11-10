-- wallet_can_afford / debit_wallet_for_call read a NULL balance for service_role.
--
-- Both are SECURITY INVOKER functions granted only to service_role (the
-- server's supabaseAdmin client), and both read the balance through
-- public.wallet_balance(_org). wallet_balance deliberately returns NULL unless
-- auth.uid() is an org member or platform admin, and a service_role request
-- has no auth.uid(). So for the only role allowed to call them:
--   * wallet_can_afford returns NULL >= amount = NULL, which the server
--     (walletCanAffordOutbound) treats as "cannot afford": every outbound call
--     with a non-zero outbound_minute price is refused as "Insufficient wallet
--     balance", whatever the real balance;
--   * debit_wallet_for_call still inserts the debit correctly (idempotency is
--     unaffected) but reports balance NULL.
-- Found during local end-to-end verification (2026-11-10); reproduced by
-- calling both as service_role. 20261007100000 fixed the permission error
-- but not this.
--
-- Fix: these two server-only functions sum the ledger directly. wallet_balance
-- itself is unchanged (it is the customer/admin dashboard's read, and its
-- membership check stays). Same signatures, same SECURITY INVOKER, same
-- grants, same row lock and idempotency. Re-runnable (CREATE OR REPLACE).
--
-- Revert: re-run the two function bodies from
-- 20260904120000_phase_d_telephony_infrastructure.sql.

CREATE OR REPLACE FUNCTION public.debit_wallet_for_call(
  _org uuid, _call_id uuid, _amount integer, _description text
) RETURNS TABLE(applied boolean, already_applied boolean, balance integer)
LANGUAGE plpgsql AS $$
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
END; $$;

REVOKE ALL ON FUNCTION public.debit_wallet_for_call(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_wallet_for_call(uuid, uuid, integer, text) TO service_role;

CREATE OR REPLACE FUNCTION public.wallet_can_afford(_org uuid, _amount integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE bal integer;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id = _org FOR UPDATE;
  SELECT COALESCE(SUM(amount), 0)::int INTO bal
    FROM public.wallet_transactions WHERE organization_id = _org;
  RETURN bal >= _amount;
END; $$;

REVOKE ALL ON FUNCTION public.wallet_can_afford(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_can_afford(uuid, integer) TO service_role;
