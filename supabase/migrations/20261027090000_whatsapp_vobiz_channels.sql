-- WhatsApp through Vobiz (ClickAI's BSP) instead of a direct Meta app.
--
-- Vobiz holds the Meta credentials for every number; ClickAI keeps only the
-- Vobiz channel id (used to send, and to route webhooks) next to the Meta
-- identifiers it already stores. Three onboarding modes, as Vobiz names
-- them: 'bring_your_own' (BYON), 'buy_from_vobiz', 'embedded_signup'.
--
-- 1. whatsapp_connections
--    - provider: 'meta_direct' (rows written by the old direct-Meta
--      onboarding) or 'vobiz'. Existing rows keep 'meta_direct'.
--    - vobiz_channel_id: Vobiz's channel UUID. Required for 'vobiz' rows and
--      unique among connections that aren't disconnected, so one Vobiz
--      channel is never live for two tenants (same rule as phone_number_id).
--    - number_onboarding_mode / vobiz_number_order_id: how the number was
--      connected (and, for a bought number, Vobiz's order id).
--    Browsers can read provider and number_onboarding_mode (column grant);
--    every write stays server-side.
--
-- 2. whatsapp_number_orders: numbers bought through Vobiz. A row is written
--    ('requested') BEFORE Vobiz is asked to buy, and at most one live order
--    per organization and number may exist, so a double click, a retry or
--    two admins can never buy the same number twice. 'unknown' records a
--    request whose outcome was never confirmed (timeout); it is never
--    retried automatically. 'connected' links the order to the connection
--    created from it.
--
-- Additive and idempotent: new defaulted/nullable columns (no table
-- rewrite), a new table, IF NOT EXISTS guards. Works with the code before
-- and after this change. Depends on 20260923090000 (whatsapp_connections),
-- 20260829120932 (organizations, businesses, is_org_member,
-- update_updated_at_column).
--
-- Rollback (code first, since the Vobiz code writes these columns):
--   DROP TABLE IF EXISTS public.whatsapp_number_orders;
--   DROP INDEX IF EXISTS public.idx_whatsapp_connections_vobiz_channel_live;
--   ALTER TABLE public.whatsapp_connections
--     DROP CONSTRAINT IF EXISTS whatsapp_connections_provider_check,
--     DROP CONSTRAINT IF EXISTS whatsapp_connections_vobiz_channel_check,
--     DROP CONSTRAINT IF EXISTS whatsapp_connections_onboarding_mode_check,
--     DROP COLUMN IF EXISTS provider, DROP COLUMN IF EXISTS vobiz_channel_id,
--     DROP COLUMN IF EXISTS number_onboarding_mode, DROP COLUMN IF EXISTS vobiz_number_order_id;
-- Dropping whatsapp_number_orders loses the purchase history; export it first.

ALTER TABLE public.whatsapp_connections
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta_direct',
  ADD COLUMN IF NOT EXISTS vobiz_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS number_onboarding_mode TEXT,
  ADD COLUMN IF NOT EXISTS vobiz_number_order_id TEXT;

DO $$ BEGIN
  ALTER TABLE public.whatsapp_connections ADD CONSTRAINT whatsapp_connections_provider_check
    CHECK (provider IN ('meta_direct', 'vobiz'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.whatsapp_connections ADD CONSTRAINT whatsapp_connections_vobiz_channel_check
    CHECK (provider <> 'vobiz' OR vobiz_channel_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.whatsapp_connections ADD CONSTRAINT whatsapp_connections_onboarding_mode_check
    CHECK (number_onboarding_mode IS NULL
      OR number_onboarding_mode IN ('bring_your_own', 'buy_from_vobiz', 'embedded_signup'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_connections_vobiz_channel_live
  ON public.whatsapp_connections (vobiz_channel_id)
  WHERE vobiz_channel_id IS NOT NULL AND status <> 'disconnected';

GRANT SELECT (provider, number_onboarding_mode) ON public.whatsapp_connections TO authenticated;

CREATE TABLE IF NOT EXISTS public.whatsapp_number_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  requested_by UUID,
  phone_number TEXT NOT NULL CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$'),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'pending', 'completed', 'failed', 'cancelled', 'unknown', 'connected'
  )),
  vobiz_order_id TEXT UNIQUE,
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) <= 500),
  whatsapp_connection_id UUID REFERENCES public.whatsapp_connections(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live order per organization and number: the row is the purchase lock.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_number_orders_one_live
  ON public.whatsapp_number_orders (organization_id, phone_number)
  WHERE status IN ('requested', 'pending', 'completed', 'unknown');
CREATE INDEX IF NOT EXISTS idx_whatsapp_number_orders_org
  ON public.whatsapp_number_orders (organization_id, created_at DESC);

GRANT SELECT ON public.whatsapp_number_orders TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.whatsapp_number_orders TO service_role;
ALTER TABLE public.whatsapp_number_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant whatsapp number orders read" ON public.whatsapp_number_orders;
CREATE POLICY "tenant whatsapp number orders read" ON public.whatsapp_number_orders
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
DROP TRIGGER IF EXISTS trg_whatsapp_number_orders_updated ON public.whatsapp_number_orders;
CREATE TRIGGER trg_whatsapp_number_orders_updated BEFORE UPDATE ON public.whatsapp_number_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
