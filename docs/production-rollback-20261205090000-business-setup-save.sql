-- Rollback of 20261205090000_business_setup_save.sql.
-- NOT run automatically, and NOT needed to roll the Worker back: the older wizard never calls
-- these functions, so leaving them is harmless. Run only after the Worker no longer serves the
-- newer wizard (which cannot save without them) and after the 20261206090000 guard is rolled
-- back. Drops only functions; every row saved through them stays. Re-runnable.

DO $$
BEGIN
  -- The guard calls lock_business_setup: dropping it underneath would break those inserts.
  IF to_regprocedure('public.one_setup_per_customer()') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: roll back 20261206090000 (the guard) first';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.save_business_setup(uuid, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.lock_business_setup(uuid);
