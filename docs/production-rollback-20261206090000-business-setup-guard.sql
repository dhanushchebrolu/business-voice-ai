-- Rollback of 20261206090000_business_setup_guard.sql.
-- NOT run automatically. Safe with either version of the code: it only removes the guard, so the
-- older wizard behaves as it did before and the newer one is unaffected. Run it BEFORE rolling
-- the Worker back to the older wizard. No row changes. Re-runnable.

DROP TRIGGER IF EXISTS trg_businesses_one_per_customer ON public.businesses;
DROP TRIGGER IF EXISTS trg_agent_configs_one_per_customer ON public.agent_configs;
DROP FUNCTION IF EXISTS public.one_setup_per_customer();
