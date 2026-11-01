-- ClickAI-provided WhatsApp numbers: bought by a platform admin, held in the
-- existing phone-number inventory, assigned to one organization.
--
-- Customers can no longer buy numbers through ClickAI's Vobiz account
-- (the customer "buy" path is removed in code). A platform admin buys a
-- number for an organization; the purchase lands in public.phone_numbers —
-- the same inventory, assignment, activate/suspend/release lifecycle and
-- admin audit trail voice numbers already use — and the customer then
-- connects it to their WhatsApp Business Account. Customer-owned numbers
-- (BYON, Embedded Signup) are unchanged and never enter the inventory.
--
-- 1. phone_numbers.voice_capable / whatsapp_capable: what each inventory
--    number can be used for, independently. Every existing row is a voice
--    number (true / false), so voice behaviour is unchanged; voice code
--    only considers voice_capable rows. A ClickAI WhatsApp number is
--    (false / true) until someone confirms it also carries voice, and is
--    never unassigned (so it can't enter the voice pool).
--    A WhatsApp-capable number is held (not released/failed) by at most one
--    row, platform-wide.
-- 2. whatsapp_number_orders: admin purchases have no organization (they are
--    platform records, never tenant data — so a later reassignment never
--    shows one customer's order to another), link to the inventory row they
--    produced, and are locked per number platform-wide: at most one live
--    order for a number, whoever places it.
-- 3. whatsapp_connections.inventory_number_id: the inventory number a
--    connection was made from; at most one live connection per number.
-- 4. Ownership triggers (both tables, serialized per number with an
--    advisory lock so concurrent writers can't both pass):
--    - a live WhatsApp connection for a number another organization holds
--      in the inventory (or that sits unassigned) is refused, and one made
--      from an inventory number requires that number to be assigned to the
--      connection's organization, WhatsApp-capable and active;
--    - an inventory number can't be assigned to an organization while
--      another organization has that number live on WhatsApp (a customer-
--      owned number can't be claimed), can't move to another organization,
--      be released or lose WhatsApp while a connection made from it is
--      live (disconnect first, so no previous customer's traffic follows
--      the number), and a WhatsApp-capable number can't be held by two
--      organizations.
-- 5. record_whatsapp_number_purchase(): after Vobiz accepts an order,
--    records it and creates the inventory row in one transaction (server
--    role only).
--
-- Additive: new defaulted columns (no rewrite), new nullable columns, new
-- indexes, triggers and a function. Works with the code before and after
-- this change. Requires 20261027090000 (whatsapp_number_orders, Vobiz
-- connection columns) and 20260912160000 (phone_numbers pool states).
--
-- Rollback (code first). Before dropping the capability columns, release
-- (or delete) every WhatsApp-only number: without the columns, voice code
-- treats every phone_numbers row as a voice number again. Find them with
--   SELECT id, organization_id, e164, status FROM public.phone_numbers
--    WHERE NOT voice_capable AND status NOT IN ('released', 'failed');
--   DROP FUNCTION IF EXISTS public.record_whatsapp_number_purchase(uuid, uuid, text, text, text, uuid);
--   DROP TRIGGER IF EXISTS trg_whatsapp_connections_number_owner ON public.whatsapp_connections;
--   DROP TRIGGER IF EXISTS trg_phone_numbers_whatsapp_owner ON public.phone_numbers;
--   DROP FUNCTION IF EXISTS public.enforce_whatsapp_connection_number_owner();
--   DROP FUNCTION IF EXISTS public.enforce_phone_number_whatsapp_owner();
--   DROP INDEX IF EXISTS public.idx_whatsapp_connections_inventory_live,
--     public.idx_whatsapp_connections_number_key_live, public.idx_phone_numbers_number_key,
--     public.idx_phone_numbers_whatsapp_e164_held, public.idx_whatsapp_number_orders_one_live_number,
--     public.idx_whatsapp_number_orders_inventory;
--   ALTER TABLE public.whatsapp_connections DROP COLUMN IF EXISTS inventory_number_id;
--   ALTER TABLE public.whatsapp_number_orders DROP COLUMN IF EXISTS phone_number_inventory_id;
--   ALTER TABLE public.phone_numbers DROP CONSTRAINT IF EXISTS phone_numbers_capability_check,
--     DROP CONSTRAINT IF EXISTS phone_numbers_whatsapp_only_assigned_check,
--     DROP COLUMN IF EXISTS voice_capable, DROP COLUMN IF EXISTS whatsapp_capable;
--   DROP FUNCTION IF EXISTS public.phone_number_key(text);
--   (whatsapp_number_orders.organization_id stays nullable; re-adding NOT
--   NULL needs admin orders deleted or attributed first.)

-- ============================================================
-- 1. Inventory capabilities
-- ============================================================
ALTER TABLE public.phone_numbers
  ADD COLUMN IF NOT EXISTS voice_capable BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS whatsapp_capable BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  ALTER TABLE public.phone_numbers ADD CONSTRAINT phone_numbers_capability_check
    CHECK (voice_capable OR whatsapp_capable);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A WhatsApp-only number is always assigned to an organization: it never
-- sits in the unassigned pool, so the voice pool claim
-- (claimAvailablePhoneNumber) can never hand one out for calls.
DO $$ BEGIN
  ALTER TABLE public.phone_numbers ADD CONSTRAINT phone_numbers_whatsapp_only_assigned_check
    CHECK (voice_capable OR organization_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_numbers_whatsapp_e164_held
  ON public.phone_numbers (e164)
  WHERE whatsapp_capable AND status NOT IN ('released', 'failed');

-- Digits only, so '+91 98765 43210' (Meta's display form) and
-- '+919876543210' (E.164) are the same number.
CREATE OR REPLACE FUNCTION public.phone_number_key(_number text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT nullif(regexp_replace(coalesce(_number, ''), '[^0-9]', '', 'g'), '') $$;

CREATE INDEX IF NOT EXISTS idx_phone_numbers_number_key
  ON public.phone_numbers (public.phone_number_key(e164))
  WHERE status NOT IN ('released', 'failed');

-- ============================================================
-- 2. Admin purchases
-- ============================================================
ALTER TABLE public.whatsapp_number_orders ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE public.whatsapp_number_orders
  ADD COLUMN IF NOT EXISTS phone_number_inventory_id UUID
    REFERENCES public.phone_numbers(id) ON DELETE SET NULL;

-- One live order per number, platform-wide: two admins (or a double click)
-- can never buy the same number twice. The 20261027090000 per-organization
-- index stays; this one is strictly stronger.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_number_orders_one_live_number
  ON public.whatsapp_number_orders (phone_number)
  WHERE status IN ('requested', 'pending', 'completed', 'unknown');
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_number_orders_inventory
  ON public.whatsapp_number_orders (phone_number_inventory_id)
  WHERE phone_number_inventory_id IS NOT NULL;

-- ============================================================
-- 3. Connection <-> inventory number
-- ============================================================
ALTER TABLE public.whatsapp_connections
  ADD COLUMN IF NOT EXISTS inventory_number_id UUID
    REFERENCES public.phone_numbers(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_connections_inventory_live
  ON public.whatsapp_connections (inventory_number_id)
  WHERE inventory_number_id IS NOT NULL AND status <> 'disconnected';
CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_number_key_live
  ON public.whatsapp_connections (public.phone_number_key(display_phone_number))
  WHERE status <> 'disconnected';

-- Lets the customer's page show which assigned number is connected.
GRANT SELECT (inventory_number_id) ON public.whatsapp_connections TO authenticated;

-- ============================================================
-- 4. Ownership triggers
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_whatsapp_connection_number_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _keys text[];
  _key text;
  _inv_e164 text;
  _inv_org uuid;
  _inv_status text;
  _inv_whatsapp boolean;
BEGIN
  IF NEW.status = 'disconnected' THEN
    RETURN NEW;
  END IF;
  -- Rows that were already live and keep their organization and number are
  -- not re-checked (status changes from the webhook, bot assignment, ...).
  IF TG_OP = 'UPDATE'
     AND OLD.status <> 'disconnected'
     AND NEW.organization_id = OLD.organization_id
     AND NEW.display_phone_number IS NOT DISTINCT FROM OLD.display_phone_number
     AND NEW.inventory_number_id IS NOT DISTINCT FROM OLD.inventory_number_id THEN
    RETURN NEW;
  END IF;

  IF NEW.inventory_number_id IS NOT NULL THEN
    SELECT e164 INTO _inv_e164 FROM public.phone_numbers WHERE id = NEW.inventory_number_id;
  END IF;

  SELECT array_agg(DISTINCT k ORDER BY k) INTO _keys
    FROM unnest(ARRAY[public.phone_number_key(NEW.display_phone_number),
                      public.phone_number_key(_inv_e164)]) AS k
   WHERE k IS NOT NULL;
  FOREACH _key IN ARRAY coalesce(_keys, ARRAY[]::text[]) LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('whatsapp_number:' || _key, 0));
  END LOOP;

  IF NEW.inventory_number_id IS NOT NULL THEN
    -- Re-read after the lock: a concurrent reassignment has committed by now.
    SELECT organization_id, status, whatsapp_capable INTO _inv_org, _inv_status, _inv_whatsapp
      FROM public.phone_numbers WHERE id = NEW.inventory_number_id;
    IF _inv_status IS NULL
       OR _inv_org IS DISTINCT FROM NEW.organization_id
       OR NOT _inv_whatsapp
       OR _inv_status <> 'active' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'whatsapp_number_not_assigned: this number is not an active WhatsApp number of this organization';
    END IF;
  END IF;

  FOREACH _key IN ARRAY coalesce(_keys, ARRAY[]::text[]) LOOP
    IF EXISTS (
      SELECT 1 FROM public.phone_numbers p
       WHERE public.phone_number_key(p.e164) = _key
         AND p.status NOT IN ('released', 'failed')
         AND p.organization_id IS DISTINCT FROM NEW.organization_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'whatsapp_number_owned_elsewhere: this number belongs to another ClickAI account';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_phone_number_whatsapp_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _key text := public.phone_number_key(NEW.e164);
  _held boolean := NEW.status NOT IN ('released', 'failed');
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.e164 = OLD.e164
     AND NEW.whatsapp_capable = OLD.whatsapp_capable
     AND _held = (OLD.status NOT IN ('released', 'failed')) THEN
    RETURN NEW;
  END IF;
  IF _key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('whatsapp_number:' || _key, 0));
  END IF;

  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM public.whatsapp_connections c
     WHERE c.inventory_number_id = NEW.id
       AND c.status <> 'disconnected'
       AND (c.organization_id IS DISTINCT FROM NEW.organization_id
            OR NOT _held OR NOT NEW.whatsapp_capable)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'whatsapp_number_connected: disconnect this number from WhatsApp before reassigning or releasing it';
  END IF;

  IF _held AND _key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.whatsapp_connections c
       WHERE public.phone_number_key(c.display_phone_number) = _key
         AND c.status <> 'disconnected'
         AND c.organization_id IS DISTINCT FROM NEW.organization_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'whatsapp_number_owned_elsewhere: this number is connected to WhatsApp by another ClickAI account';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.phone_numbers p
       WHERE p.id <> NEW.id
         AND public.phone_number_key(p.e164) = _key
         AND p.status NOT IN ('released', 'failed')
         AND p.organization_id IS DISTINCT FROM NEW.organization_id
         AND (p.whatsapp_capable OR NEW.whatsapp_capable)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'whatsapp_number_owned_elsewhere: this number is already held by another ClickAI account';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_whatsapp_connection_number_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_phone_number_whatsapp_owner() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_whatsapp_connections_number_owner ON public.whatsapp_connections;
CREATE TRIGGER trg_whatsapp_connections_number_owner
  BEFORE INSERT OR UPDATE OF organization_id, status, display_phone_number, inventory_number_id
  ON public.whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_whatsapp_connection_number_owner();

DROP TRIGGER IF EXISTS trg_phone_numbers_whatsapp_owner ON public.phone_numbers;
CREATE TRIGGER trg_phone_numbers_whatsapp_owner
  BEFORE INSERT OR UPDATE OF organization_id, status, e164, whatsapp_capable
  ON public.phone_numbers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_phone_number_whatsapp_owner();

-- ============================================================
-- 5. Recording an accepted purchase
-- ============================================================
-- Called only after Vobiz accepted the order. Moves the 'requested' lock to
-- the order's status with Vobiz's id and creates the organization's
-- inventory row ('provisioning', WhatsApp only) in one transaction, so an
-- accepted order is never recorded without its number or vice versa. Fails
-- (and changes nothing) if the order isn't an un-recorded 'requested' lock.
CREATE OR REPLACE FUNCTION public.record_whatsapp_number_purchase(
  _order_id uuid,
  _organization_id uuid,
  _vobiz_order_id text,
  _order_status text,
  _country text,
  _provisioned_by uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  _phone text;
  _number_id uuid;
BEGIN
  IF _order_status NOT IN ('pending', 'completed') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'order status must be pending or completed';
  END IF;
  IF _organization_id IS NULL OR coalesce(_vobiz_order_id, '') = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'organization and Vobiz order id are required';
  END IF;

  UPDATE public.whatsapp_number_orders
     SET status = _order_status, vobiz_order_id = _vobiz_order_id, failure_reason = NULL
   WHERE id = _order_id AND status = 'requested' AND vobiz_order_id IS NULL
  RETURNING phone_number INTO _phone;
  IF _phone IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'whatsapp_number_order_not_requested';
  END IF;

  INSERT INTO public.phone_numbers (
    organization_id, e164, display_number, country, provider, status,
    voice_capable, whatsapp_capable, inbound_enabled, outbound_enabled,
    purchased_at, provisioned_by, metadata
  ) VALUES (
    _organization_id, _phone, _phone, coalesce(nullif(_country, ''), 'IN'), 'vobiz', 'provisioning',
    false, true, false, false,
    now(), _provisioned_by,
    jsonb_build_object('whatsapp_number_order_id', _order_id, 'vobiz_order_id', _vobiz_order_id)
  )
  RETURNING id INTO _number_id;

  UPDATE public.whatsapp_number_orders
     SET phone_number_inventory_id = _number_id
   WHERE id = _order_id;
  RETURN _number_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_whatsapp_number_purchase(uuid, uuid, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_number_purchase(uuid, uuid, text, text, text, uuid)
  TO service_role;
