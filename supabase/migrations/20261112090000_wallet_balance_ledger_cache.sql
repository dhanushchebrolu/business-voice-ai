-- O(1) wallet balances, an append-only ledger, and a once-per-call debit guard.
--
-- Measured (scripts/loadtest/db-hotpaths.mjs, local PostgreSQL 17): every
-- balance read summed the organization's whole ledger, so
-- wallet_can_afford took 0.22 ms at 100 ledger rows, 1.2 ms at 10,000 and
-- 10.8 ms at 100,000, and settlements for one busy tenant (serialized by
-- the organization row lock) slowed as its ledger grew.
--
-- 1. public.wallet_balances keeps each organization's running balance. It
--    is written only by triggers on wallet_transactions, in the same
--    transaction as the ledger row, so it can never disagree with the
--    ledger: an insert adds the amount, a delete (only ever an organization
--    deletion's cascade) subtracts it.
-- 2. wallet_transactions rows can no longer be updated: corrections are new
--    entries (reversals), never edits.
-- 3. A unique index allows at most one call_usage debit per (organization,
--    call). debit_wallet_for_call already serializes on the organization row
--    and checks first; this is the database-level guarantee behind it, for
--    any other writer. Production had no duplicates when this was written.
-- 4. wallet_balance / wallet_can_afford / debit_wallet_for_call read the
--    running balance instead of summing. Same signatures, grants, locks,
--    idempotency and SECURITY settings as before.
--
-- The ledger is locked against writes for the (short) migration so the
-- backfill and the triggers cannot double-count or miss a concurrent entry.
-- Re-runnable. Not destructive: no ledger row is changed.

LOCK TABLE public.wallet_transactions IN SHARE ROW EXCLUSIVE MODE;

-- ============ 1. running balances ============
CREATE TABLE IF NOT EXISTS public.wallet_balances (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  balance bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wallet_balances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wallet_balances FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.wallet_balances TO service_role;

CREATE OR REPLACE FUNCTION public.wallet_apply_ledger_entry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.wallet_balances AS b (organization_id, balance, updated_at)
    VALUES (NEW.organization_id, NEW.amount, now())
    ON CONFLICT (organization_id)
      DO UPDATE SET balance = b.balance + EXCLUDED.balance, updated_at = now();
  ELSE
    UPDATE public.wallet_balances
       SET balance = balance - OLD.amount, updated_at = now()
     WHERE organization_id = OLD.organization_id;
  END IF;
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION public.wallet_apply_ledger_entry() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_wallet_tx_apply ON public.wallet_transactions;
CREATE TRIGGER trg_wallet_tx_apply
  AFTER INSERT OR DELETE ON public.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION public.wallet_apply_ledger_entry();

-- ============ 2. append-only ledger ============
CREATE OR REPLACE FUNCTION public.wallet_ledger_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WALLET_LEDGER_IMMUTABLE: add a reversing entry instead of editing one'
    USING ERRCODE = '42501';
END; $$;
DROP TRIGGER IF EXISTS trg_wallet_tx_immutable ON public.wallet_transactions;
CREATE TRIGGER trg_wallet_tx_immutable
  BEFORE UPDATE ON public.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION public.wallet_ledger_immutable();

-- ============ 3. once-per-call debit guard ============
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_call_usage_once
  ON public.wallet_transactions (organization_id, reference)
  WHERE kind = 'call_usage' AND reference IS NOT NULL;

-- Backfill (exact, under the lock above).
INSERT INTO public.wallet_balances (organization_id, balance, updated_at)
SELECT organization_id, COALESCE(SUM(amount), 0), now()
  FROM public.wallet_transactions GROUP BY organization_id
ON CONFLICT (organization_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = now();

-- ============ 4. readers ============
CREATE OR REPLACE FUNCTION public.wallet_balance(_org uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN public.is_org_member(_org) OR public.is_platform_admin()
    THEN COALESCE((SELECT balance FROM public.wallet_balances WHERE organization_id = _org), 0)::int
    ELSE NULL
  END;
$$;

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
  IF existing_ref IS NULL AND _amount <> 0 THEN
    INSERT INTO public.wallet_transactions (organization_id, amount, kind, description, reference)
    VALUES (_org, -_amount, 'call_usage', _description, _call_id::text);
  END IF;

  SELECT COALESCE((SELECT b.balance FROM public.wallet_balances b WHERE b.organization_id = _org), 0)::int
    INTO new_balance;
  RETURN QUERY SELECT true, existing_ref IS NOT NULL, new_balance;
END; $$;

CREATE OR REPLACE FUNCTION public.wallet_can_afford(_org uuid, _amount integer)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM public.organizations WHERE id = _org FOR UPDATE;
  RETURN COALESCE((SELECT balance FROM public.wallet_balances WHERE organization_id = _org), 0) >= _amount;
END; $$;

REVOKE ALL ON FUNCTION public.debit_wallet_for_call(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_wallet_for_call(uuid, uuid, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.wallet_can_afford(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_can_afford(uuid, integer) TO service_role;
