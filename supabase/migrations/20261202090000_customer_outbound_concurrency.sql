-- Customer-selectable outbound concurrency, on top of the shared Sarvam call slots
-- (20261201090000).
--
-- The platform has one limit L on simultaneous Sarvam calls (outbound_concurrency()). A
-- customer now chooses how many of those their OUTBOUND calls may use; the rest stays free for
-- incoming calls.
--
--   organizations.outbound_concurrency   the customer's choice; NULL means the default (2).
--   cap          = LEAST(GREATEST(COALESCE(choice, 2), 1), L)   so it follows L if L changes
--   reserved for inbound = L - cap
--
-- Enforced where the call row is written, inside the trigger that already serializes every
-- outbound Sarvam insert under one global lock (so overlapping dispatch runs, several campaigns
-- of one customer, single calls and other customers all see the same counts):
--
--   a new outbound call is refused when the customer's own unfinished outbound calls
--   (every campaign and every single call, last 15 minutes) have reached its cap
--   -> SQLSTATE PC002, message ORG_CONCURRENCY_LIMIT. The global limit still applies as before
--   (PC001), and live inbound calls still count toward it, so outbound can neither take the
--   slots held back for inbound nor push the account over L.
--
-- Lowering the choice below the calls already running never ends a call: new calls simply wait
-- until the running ones drop under the new cap.
--
--   outbound_org_concurrency(org)     what the customer's page shows.
--   outbound_concurrency_overview()   what the admin page shows (one row per customer with a
--                                      choice or calls running).
--
-- Additive: one nullable column with a range check, two read-only functions, and one function
-- replaced (enforce_outbound_concurrency). No existing row changes; every customer starts on the
-- default of 2 (a customer running 3 at once today will be held to 2 until they choose more).
-- Rollback:
--   CREATE OR REPLACE FUNCTION public.enforce_outbound_concurrency() ... as in
--     20261201090000_shared_outbound_concurrency.sql (global check only);
--   DROP FUNCTION IF EXISTS public.outbound_concurrency_overview();
--   DROP FUNCTION IF EXISTS public.outbound_org_concurrency(uuid);
--   ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_outbound_concurrency_range;
--   ALTER TABLE public.organizations DROP COLUMN IF EXISTS outbound_concurrency;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS outbound_concurrency integer;

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_outbound_concurrency_range;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_outbound_concurrency_range
  CHECK (outbound_concurrency IS NULL OR outbound_concurrency BETWEEN 1 AND 50);

CREATE OR REPLACE FUNCTION public.outbound_org_concurrency(_org uuid)
RETURNS TABLE (
  selected integer,
  cap integer,
  slot_limit integer,
  global_in_use integer,
  active_outbound integer,
  remaining integer,
  reserved_inbound integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH g AS (SELECT c.slot_limit AS lim, c.in_use AS used FROM public.outbound_concurrency() c),
       o AS (SELECT og.outbound_concurrency AS sel FROM public.organizations og WHERE og.id = _org),
       mine AS (
         SELECT count(*)::integer AS n
           FROM public.call_logs l
          WHERE l.organization_id = _org
            AND l.provider = 'sarvam'
            AND l.direction = 'outbound'
            AND l.status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown')
            AND l.started_at > now() - interval '15 minutes'
       ),
       c AS (
         SELECT o.sel, g.lim, g.used, mine.n,
                LEAST(GREATEST(COALESCE(o.sel, 2), 1), g.lim) AS cap
           FROM o, g, mine
       )
  SELECT c.sel,
         c.cap,
         c.lim,
         c.used,
         c.n,
         GREATEST(LEAST(c.cap - c.n, c.lim - c.used), 0),
         c.lim - c.cap
    FROM c;
$$;

CREATE OR REPLACE FUNCTION public.outbound_concurrency_overview()
RETURNS TABLE (
  organization_id uuid,
  selected integer,
  cap integer,
  active_outbound integer,
  limited_by text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT o.id,
         x.selected,
         x.cap,
         x.active_outbound,
         CASE
           WHEN x.global_in_use >= x.slot_limit THEN 'platform'
           WHEN x.active_outbound >= x.cap THEN 'customer_setting'
         END
    FROM public.organizations o
   CROSS JOIN LATERAL public.outbound_org_concurrency(o.id) x
   WHERE o.outbound_concurrency IS NOT NULL OR x.active_outbound > 0;
$$;

CREATE OR REPLACE FUNCTION public.enforce_outbound_concurrency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  slots record;
  mine record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('clickai.outbound_concurrency', 0));
  -- The platform limit first: when it is what is full, that is the true reason whatever the
  -- customer's own cap. Both are checked under the same global lock, so two runs cannot both
  -- take the last slot.
  SELECT * INTO slots FROM public.outbound_concurrency();
  IF slots.in_use >= slots.slot_limit THEN
    RAISE EXCEPTION 'PROVIDER_CONCURRENCY_LIMIT: % of % call slots are in use', slots.in_use, slots.slot_limit
      USING ERRCODE = 'PC001';
  END IF;
  SELECT * INTO mine FROM public.outbound_org_concurrency(NEW.organization_id);
  IF FOUND AND mine.active_outbound >= mine.cap THEN
    RAISE EXCEPTION 'ORG_CONCURRENCY_LIMIT: % of % outbound calls are running', mine.active_outbound, mine.cap
      USING ERRCODE = 'PC002';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.outbound_org_concurrency(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbound_org_concurrency(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.outbound_concurrency_overview() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outbound_concurrency_overview() TO service_role;
REVOKE ALL ON FUNCTION public.enforce_outbound_concurrency() FROM PUBLIC, anon, authenticated;
