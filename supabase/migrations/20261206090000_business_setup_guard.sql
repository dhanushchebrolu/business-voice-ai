-- PHASE 2 of 2 of the setup wizard change: a browser session cannot INSERT a second business or
-- receptionist (agent_configs) for a customer who already has one, whatever code it runs. Rows
-- that already exist are left alone, and server-side writes are not restricted (a customer may
-- hold several businesses by other means).
--
-- ENFORCING, and NOT compatible with the older wizard, which saves with direct inserts: after a
-- failed first save its retry inserts a second business and would be refused here. Apply only
-- AFTER the Worker that calls save_business_setup serves all traffic, and roll this back BEFORE
-- ever rolling the Worker back to the older wizard.
-- Needs 20261205090000. Re-runnable. No existing row changes.
-- Rollback: docs/production-rollback-20261206090000-business-setup-guard.sql

-- SECURITY DEFINER so the check sees every row of that customer, whatever the caller may read.
CREATE OR REPLACE FUNCTION public.one_setup_per_customer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_taken boolean;
BEGIN
  PERFORM public.lock_business_setup(NEW.organization_id);
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE organization_id = $1)', TG_TABLE_NAME)
    INTO v_taken USING NEW.organization_id;
  IF v_taken THEN
    RAISE EXCEPTION 'BUSINESS_SETUP_EXISTS: this customer already has a record in %', TG_TABLE_NAME
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.one_setup_per_customer() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_businesses_one_per_customer ON public.businesses;
CREATE TRIGGER trg_businesses_one_per_customer
  BEFORE INSERT ON public.businesses
  FOR EACH ROW WHEN (current_user = 'authenticated')
  EXECUTE FUNCTION public.one_setup_per_customer();

DROP TRIGGER IF EXISTS trg_agent_configs_one_per_customer ON public.agent_configs;
CREATE TRIGGER trg_agent_configs_one_per_customer
  BEFORE INSERT ON public.agent_configs
  FOR EACH ROW WHEN (current_user = 'authenticated')
  EXECUTE FUNCTION public.one_setup_per_customer();
