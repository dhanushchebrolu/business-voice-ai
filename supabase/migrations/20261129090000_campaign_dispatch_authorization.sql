-- Per-workspace campaign authorization (campaign launch readiness).
--
-- Before: CAMPAIGN_DISPATCH_ENABLED was the only switch for campaign calling,
-- so turning it on for one pilot would have let every customer's running
-- campaign dial.
--
-- Now organizations.campaign_dispatch_enabled (default false) must also be on
-- for a workspace before its campaigns can launch or be dispatched
-- (campaign-launch-readiness.server.ts, campaign-dispatch.server.ts). The
-- platform switch stays the master switch; this one is per customer, set by
-- ClickAI (service role) only. Customers can create and edit their own
-- organization row (RLS "owner creates org" / "admins update org"), so a
-- trigger refuses any attempt by them to turn it on.
--
-- Additive: one defaulted column (no rewrite, every existing workspace stays
-- off), one trigger function, one trigger. Rollback:
-- docs/production-rollback-20261129090000-campaign-dispatch-authorization.sql

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS campaign_dispatch_enabled boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.guard_campaign_dispatch_enabled()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Only ClickAI (service role, or the database owner in migrations) may turn it on or off.
  IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin')
     AND ((TG_OP = 'INSERT' AND NEW.campaign_dispatch_enabled)
          OR (TG_OP = 'UPDATE' AND NEW.campaign_dispatch_enabled IS DISTINCT FROM OLD.campaign_dispatch_enabled)) THEN
    RAISE EXCEPTION 'Campaign calling for a workspace is enabled by ClickAI support.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_organizations_campaign_dispatch_guard ON public.organizations;
CREATE TRIGGER trg_organizations_campaign_dispatch_guard
  BEFORE INSERT OR UPDATE OF campaign_dispatch_enabled ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.guard_campaign_dispatch_enabled();

REVOKE ALL ON FUNCTION public.guard_campaign_dispatch_enabled() FROM PUBLIC, anon, authenticated;
