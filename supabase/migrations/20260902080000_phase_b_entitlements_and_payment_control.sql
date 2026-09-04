-- PHASE B — entitlement engine, provisioning, payment override, customer lock/unlock
--
-- Builds on the existing lifecycle_status / organization_feature_locks /
-- platform_settings foundation from Phase 0-A. Nothing here creates a second
-- lifecycle, billing, pricing or entitlement system — this extends the ones
-- that already exist, per CONFLICTS_AND_MIGRATION.md item 1.

-- ============================================================
-- 1. Single source of truth for lifecycle vs account_status
-- ============================================================
-- account_status has historically been written independently in three
-- different places (the Razorpay webhook, setAccountStatus, and manual
-- inserts) and could drift from lifecycle_status. From here on,
-- account_status is a DERIVED, trigger-maintained projection of
-- lifecycle_status — application code should only ever write
-- lifecycle_status. Any direct write to account_status is silently
-- overridden by this trigger to keep the two from disagreeing again.

CREATE OR REPLACE FUNCTION public.sync_account_status_from_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.account_status := CASE NEW.lifecycle_status
    WHEN 'not_provisioned' THEN 'payment_required'
    WHEN 'setup_payment_pending' THEN 'payment_required'
    WHEN 'setup_paid' THEN 'setup_in_progress'
    WHEN 'provisioning' THEN 'setup_in_progress'
    WHEN 'ready' THEN 'setup_in_progress'
    WHEN 'active' THEN 'active'
    WHEN 'suspended' THEN 'suspended'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'archived' THEN 'cancelled'
    ELSE NEW.account_status
  END::public.account_status;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sync_account_status ON public.organizations;
CREATE TRIGGER trg_sync_account_status
  BEFORE INSERT OR UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.sync_account_status_from_lifecycle();

-- Backfill: re-derive account_status for every existing row from its current
-- lifecycle_status, closing any drift that already happened before this fix.
UPDATE public.organizations SET lifecycle_status = lifecycle_status;

-- ============================================================
-- 2. Per-customer payment enforcement override + lock/unlock support
-- ============================================================
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS payment_override boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payment_override_reason text,
  ADD COLUMN IF NOT EXISTS payment_override_by uuid,
  ADD COLUMN IF NOT EXISTS payment_override_at timestamptz,
  ADD COLUMN IF NOT EXISTS pre_suspension_status public.lifecycle_status,
  ADD COLUMN IF NOT EXISTS locked_reason text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by uuid;

-- ============================================================
-- 3. Central entitlement table — source-tracked grants
-- ============================================================
-- Multiple rows per (organization, feature) are allowed, one per source, so
-- an admin grant and a subscription can coexist independently (spec §18-20,
-- §11 of the Phase B brief, acceptance Test H). Revoking one source's row
-- never touches another source's row for the same feature.

DO $$ BEGIN
  CREATE TYPE public.entitlement_source AS ENUM ('admin', 'subscription', 'trial', 'system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.organization_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  feature text NOT NULL,
  source public.entitlement_source NOT NULL,
  active boolean NOT NULL DEFAULT true,
  reason text,
  granted_by uuid,
  granted_by_email text,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid,
  revoked_by_email text,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, feature, source)
);

GRANT SELECT ON public.organization_entitlements TO authenticated;
GRANT ALL ON public.organization_entitlements TO service_role;
ALTER TABLE public.organization_entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read own entitlements" ON public.organization_entitlements;
CREATE POLICY "members read own entitlements" ON public.organization_entitlements
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id) OR public.is_platform_admin());

DROP TRIGGER IF EXISTS trg_entitlements_updated ON public.organization_entitlements;
CREATE TRIGGER trg_entitlements_updated BEFORE UPDATE ON public.organization_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_org_entitlements_org_feature
  ON public.organization_entitlements (organization_id, feature) WHERE active = true;

-- ============================================================
-- 4. Entitlement resolver — rewrite of feature_locked()
-- ============================================================
-- Precedence (highest wins):
--   1. Customer-level lock (lifecycle suspended/cancelled/archived) -> locked
--   2. Explicit per-feature admin lock (organization_feature_locks.locked=true) -> locked
--   3. Any active entitlement, any source (organization_entitlements) -> unlocked
--   4. Explicit per-feature admin unlock override (locked=false, no entitlement row) -> unlocked
--   5. Payment not enforced (global switch off OR this customer's payment_override) -> unlocked
--   6. Platform default for the feature (features.defaults) -> locked/unlocked
--
-- This is still the single authoritative resolver — nothing else in the
-- codebase implements lock/unlock logic independently.

CREATE OR REPLACE FUNCTION public.feature_locked(_org uuid, _feature text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  customer_locked boolean;
  explicit_lock boolean;
  has_entitlement boolean;
  enforced boolean;
  org_override boolean;
  def boolean;
BEGIN
  SELECT lifecycle_status IN ('suspended', 'cancelled', 'archived') INTO customer_locked
    FROM public.organizations WHERE id = _org;
  IF customer_locked IS TRUE THEN RETURN true; END IF;

  SELECT locked INTO explicit_lock FROM public.organization_feature_locks
    WHERE organization_id = _org AND feature = _feature;
  IF explicit_lock IS TRUE THEN RETURN true; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_entitlements
    WHERE organization_id = _org AND feature = _feature AND active = true
  ) INTO has_entitlement;
  IF has_entitlement THEN RETURN false; END IF;

  IF explicit_lock IS FALSE THEN RETURN false; END IF;

  SELECT COALESCE((value->>'enabled')::boolean, true) INTO enforced
    FROM public.platform_settings WHERE key = 'billing.payment_required';
  SELECT payment_override INTO org_override FROM public.organizations WHERE id = _org;
  IF enforced IS NOT TRUE OR org_override IS TRUE THEN RETURN false; END IF;

  SELECT COALESCE((value->_feature)::text::boolean, true) INTO def
    FROM public.platform_settings WHERE key = 'features.defaults';
  RETURN COALESCE(def, true);
END; $$;

REVOKE ALL ON FUNCTION public.feature_locked(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feature_locked(uuid, text) TO authenticated;

-- ============================================================
-- 5. Dashboard reachability is no longer payment-gated by default
-- ============================================================
-- "Dashboard access" and "service entitlement" are different concepts
-- (Phase B brief §1/§3/§20). The dashboard route itself is now gated on
-- lifecycle_status in the application layer (not_provisioned/
-- setup_payment_pending shows the setup screen; suspended/cancelled/archived
-- shows the locked screen; everything else shows the full workspace).
-- 'dashboard' remains in the feature catalog purely as an emergency
-- admin-only override (organization_feature_locks), so it must NOT be
-- locked by the payment-required platform default any more.
UPDATE public.platform_settings
SET value = jsonb_set(value, '{dashboard}', 'false'::jsonb)
WHERE key = 'features.defaults';

-- ============================================================
-- 6. Audit action vocabulary note (no schema change — writeAudit already
--    accepts a free-form action string; documenting the new ones added by
--    Phase B code: ENTITLEMENT_GRANT, ENTITLEMENT_REVOKE, CUSTOMER_LOCK,
--    CUSTOMER_UNLOCK, PAYMENT_OVERRIDE_SET, PAYMENT_OVERRIDE_CLEARED,
--    HANDOVER, HANDOVER_REJECTED)
-- ============================================================
