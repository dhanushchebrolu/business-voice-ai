-- Rollback for 20261129090000_campaign_dispatch_authorization.sql.
-- Deploy a Worker that does not read organizations.campaign_dispatch_enabled
-- FIRST (the new launch check and dispatcher would otherwise treat every
-- workspace as not authorized, which is safe: nothing launches or dials).
-- Drops the trigger, its function and the column; no other row data changes.
BEGIN;
DROP TRIGGER IF EXISTS trg_organizations_campaign_dispatch_guard ON public.organizations;
DROP FUNCTION IF EXISTS public.guard_campaign_dispatch_enabled();
ALTER TABLE public.organizations DROP COLUMN IF EXISTS campaign_dispatch_enabled;
COMMIT;
