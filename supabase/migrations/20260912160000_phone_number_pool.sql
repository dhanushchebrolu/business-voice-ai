-- Phone number pool: makes automatic provisioning possible
--
-- Every phone_numbers row up to now required organization_id NOT NULL —
-- there was no way to hold a number in inventory before a client existed.
-- That's the gap between the manual admin flow (provisionPhoneNumber always
-- takes an orgId up front) and payment-triggered automatic provisioning,
-- which needs to atomically claim an already-purchased number the instant a
-- client's setup payment clears.
--
-- This migration only adds capacity for that: organization_id becomes
-- nullable, two new lifecycle states are added ('available' = sitting in
-- the pool, unclaimed; 'reserved' = just atomically claimed by an org,
-- provisioning not yet finished), and a reserved_at timestamp mirrors the
-- existing purchased_at/released_at columns. The existing
-- pending/provisioning/active/suspended/released/failed states, and every
-- function that uses them (activatePhoneNumber, reassignPhoneNumber,
-- suspendPhoneNumber, releasePhoneNumber, provisioning-health.server.ts),
-- are unchanged — a pool number's lifecycle after being claimed is exactly
-- the existing provisioning -> active path.
--
-- No parallel table is introduced. Claiming a pool number is done from
-- application code (see telephony-admin.functions.ts's
-- claimAvailablePhoneNumber, added alongside this migration) using the same
-- select-candidate-then-conditional-update pattern already proven race-safe
-- for campaign_contacts in campaign-dispatch.server.ts (20260912090000) —
-- the UPDATE's own WHERE re-checks status='available' AND organization_id
-- IS NULL at write time, so a concurrent claim of the same row always loses
-- the race cleanly (0 rows updated) rather than double-assigning a number.

ALTER TABLE public.phone_numbers
  ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE public.phone_numbers
  ADD COLUMN IF NOT EXISTS reserved_at timestamptz;

-- Widen the existing status CHECK (added in Phase D, 20260904120000) rather
-- than replacing it, so every value it already allowed keeps working.
ALTER TABLE public.phone_numbers DROP CONSTRAINT IF EXISTS phone_numbers_status_check;
ALTER TABLE public.phone_numbers ADD CONSTRAINT phone_numbers_status_check
  CHECK (status IN (
    'available', 'reserved',
    'pending', 'provisioning', 'active', 'suspended', 'released', 'failed'
  ));

-- A pool number (organization_id IS NULL) must never share its e164 with
-- another pool number. The pre-existing UNIQUE(organization_id, e164) does
-- not cover this: Postgres treats every NULL organization_id as distinct,
-- so two unclaimed rows with the same e164 would not violate it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_numbers_e164_unclaimed
  ON public.phone_numbers (e164) WHERE organization_id IS NULL;

-- The claim query's own hot path: "give me one available row for this
-- provider (optionally this country), oldest first".
CREATE INDEX IF NOT EXISTS idx_phone_numbers_pool_available
  ON public.phone_numbers (provider, country, created_at)
  WHERE status = 'available' AND organization_id IS NULL;

-- Nothing in RLS needs to change: the existing "tenant numbers read" policy
-- (USING is_org_member(organization_id)) already evaluates to false for a
-- NULL organization_id (is_org_member(NULL) is never true — see its
-- definition, 20260829120932), so pool numbers stay invisible to every
-- customer automatically, with no new policy required. Numbers remain
-- writable only by service_role, unchanged.
