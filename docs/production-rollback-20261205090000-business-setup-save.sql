-- Rollback of 20261205090000_business_setup_save.sql.
-- NOT run automatically. Roll the code back FIRST: the setup wizard of the newer build calls
-- save_business_setup and cannot save without it. Drops only functions and triggers; every row
-- saved through them stays. Re-runnable.

DROP TRIGGER IF EXISTS trg_businesses_one_per_customer ON public.businesses;
DROP TRIGGER IF EXISTS trg_agent_configs_one_per_customer ON public.agent_configs;
DROP FUNCTION IF EXISTS public.save_business_setup(uuid, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.one_setup_per_customer();
DROP FUNCTION IF EXISTS public.lock_business_setup(uuid);
