-- PHASE D — acceptance checks, schema/grant/constraint level.
--
-- NOT a migration — nothing in supabase/migrations/ should ever depend on
-- this file, and it must never be applied automatically. Run it by hand
-- against a real Supabase project (psql, or the SQL editor) with a
-- superuser/service role connection, after the Phase D migration has been
-- applied and at least one organization + phone number + call_logs row
-- exist to test against. Each block raises an exception on failure and
-- prints "PASS: ..." on success, so `\set ON_ERROR_STOP on` in psql will
-- stop at the first real failure.
--
-- These checks were written and reviewed but NOT executed against a live
-- database in this environment — there is no live Supabase project
-- connected here (see the Phase D report's "Real provider testing status").
-- Per spec §28, this is stated plainly rather than claiming a green run
-- that did not happen.

\set ON_ERROR_STOP on

-- --------------------------------------------------------------------
-- C/D/E/T: provider_cost / gross_profit / customer_charge column grants
-- --------------------------------------------------------------------
DO $$
DECLARE has_cost boolean; has_profit boolean; has_charge boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'call_logs'
      AND column_name = 'provider_cost' AND grantee = 'authenticated' AND privilege_type = 'SELECT'
  ) INTO has_cost;
  IF has_cost THEN RAISE EXCEPTION 'FAIL: authenticated can SELECT call_logs.provider_cost'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'call_logs'
      AND column_name = 'gross_profit' AND grantee = 'authenticated' AND privilege_type = 'SELECT'
  ) INTO has_profit;
  IF has_profit THEN RAISE EXCEPTION 'FAIL: authenticated can SELECT call_logs.gross_profit'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'call_logs'
      AND column_name = 'customer_charge' AND grantee = 'authenticated' AND privilege_type = 'SELECT'
  ) INTO has_charge;
  IF NOT has_charge THEN RAISE EXCEPTION 'FAIL: authenticated cannot SELECT call_logs.customer_charge (spec §16 expects this visible)'; END IF;

  RAISE NOTICE 'PASS: call_logs column grants (provider_cost/gross_profit hidden, customer_charge visible)';
END $$;

-- --------------------------------------------------------------------
-- C/D/E/F/U/V/W: no UPDATE grant on call_logs or phone_numbers for
-- authenticated at all — a customer cannot modify provider_cost,
-- customer_charge, gross_profit or provider on any row, ever, by
-- construction (not just by RLS row targeting).
-- --------------------------------------------------------------------
DO $$
DECLARE call_logs_update boolean; phone_numbers_update boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'call_logs'
      AND grantee = 'authenticated' AND privilege_type = 'UPDATE'
  ) INTO call_logs_update;
  IF call_logs_update THEN RAISE EXCEPTION 'FAIL: authenticated has UPDATE on call_logs'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'phone_numbers'
      AND grantee = 'authenticated' AND privilege_type = 'UPDATE'
  ) INTO phone_numbers_update;
  IF phone_numbers_update THEN RAISE EXCEPTION 'FAIL: authenticated has UPDATE on phone_numbers'; END IF;

  RAISE NOTICE 'PASS: no authenticated UPDATE grant on call_logs or phone_numbers (blocks C/D/E/F/U/V/W at the grant level)';
END $$;

-- --------------------------------------------------------------------
-- G: customer cannot assign a number to another organization (no INSERT
-- grant either — provisioning is service_role/admin-function only).
-- --------------------------------------------------------------------
DO $$
DECLARE has_insert boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'phone_numbers'
      AND grantee = 'authenticated' AND privilege_type = 'INSERT'
  ) INTO has_insert;
  IF has_insert THEN RAISE EXCEPTION 'FAIL: authenticated has INSERT on phone_numbers'; END IF;
  RAISE NOTICE 'PASS: no authenticated INSERT grant on phone_numbers';
END $$;

-- --------------------------------------------------------------------
-- R: provider_call_id uniqueness is enforced (duplicate insert must fail).
-- --------------------------------------------------------------------
DO $$
DECLARE test_org uuid; first_id uuid; failed boolean := false;
BEGIN
  SELECT id INTO test_org FROM public.organizations LIMIT 1;
  IF test_org IS NULL THEN
    RAISE NOTICE 'SKIP: no organization row to test against — create one first';
    RETURN;
  END IF;

  INSERT INTO public.call_logs (organization_id, provider, provider_call_id, direction, status)
  VALUES (test_org, 'phase_d_test', 'dup_test_' || gen_random_uuid()::text, 'inbound', 'completed')
  RETURNING id INTO first_id;

  BEGIN
    INSERT INTO public.call_logs (organization_id, provider, provider_call_id, direction, status)
    SELECT test_org, provider, provider_call_id, 'inbound', 'completed' FROM public.call_logs WHERE id = first_id;
  EXCEPTION WHEN unique_violation THEN failed := true;
  END;

  DELETE FROM public.call_logs WHERE id = first_id;
  IF NOT failed THEN RAISE EXCEPTION 'FAIL: duplicate provider_call_id was allowed'; END IF;
  RAISE NOTICE 'PASS: provider_call_id uniqueness enforced';
END $$;

-- --------------------------------------------------------------------
-- §3/§23: the same e164 cannot be `active` on two organizations at once.
-- --------------------------------------------------------------------
DO $$
DECLARE org_a uuid; org_b uuid; failed boolean := false; test_e164 text := '+910000' || floor(random()*900000+100000)::text;
BEGIN
  SELECT id INTO org_a FROM public.organizations ORDER BY created_at LIMIT 1;
  SELECT id INTO org_b FROM public.organizations ORDER BY created_at OFFSET 1 LIMIT 1;
  IF org_a IS NULL OR org_b IS NULL THEN
    RAISE NOTICE 'SKIP: need at least two organizations to test cross-org active uniqueness';
    RETURN;
  END IF;

  INSERT INTO public.phone_numbers (organization_id, e164, status) VALUES (org_a, test_e164, 'active');
  BEGIN
    INSERT INTO public.phone_numbers (organization_id, e164, status) VALUES (org_b, test_e164, 'active');
  EXCEPTION WHEN unique_violation THEN failed := true;
  END;

  DELETE FROM public.phone_numbers WHERE e164 = test_e164;
  IF NOT failed THEN RAISE EXCEPTION 'FAIL: the same e164 was active on two organizations at once'; END IF;
  RAISE NOTICE 'PASS: cross-organization active-number uniqueness enforced';
END $$;

-- --------------------------------------------------------------------
-- §14/§S: debit_wallet_for_call is idempotent per call.
-- --------------------------------------------------------------------
DO $$
DECLARE test_org uuid; call_id uuid := gen_random_uuid(); r1 record; r2 record; count_rows int;
BEGIN
  SELECT id INTO test_org FROM public.organizations LIMIT 1;
  IF test_org IS NULL THEN
    RAISE NOTICE 'SKIP: no organization row to test against';
    RETURN;
  END IF;

  SELECT * INTO r1 FROM public.debit_wallet_for_call(test_org, call_id, 500, 'acceptance test debit');
  SELECT * INTO r2 FROM public.debit_wallet_for_call(test_org, call_id, 500, 'acceptance test debit retry');

  SELECT count(*) INTO count_rows FROM public.wallet_transactions
    WHERE organization_id = test_org AND kind = 'call_usage' AND reference = call_id::text;

  DELETE FROM public.wallet_transactions WHERE organization_id = test_org AND kind = 'call_usage' AND reference = call_id::text;

  IF count_rows <> 1 THEN RAISE EXCEPTION 'FAIL: debit_wallet_for_call inserted % rows for one call, expected 1', count_rows; END IF;
  IF r1.already_applied THEN RAISE EXCEPTION 'FAIL: first debit reported already_applied=true'; END IF;
  IF NOT r2.already_applied THEN RAISE EXCEPTION 'FAIL: second (retry) debit did not report already_applied=true'; END IF;

  RAISE NOTICE 'PASS: debit_wallet_for_call is idempotent per call_id (one wallet_transactions row, retry short-circuits)';
END $$;

RAISE NOTICE 'Phase D SQL acceptance checks complete.';
