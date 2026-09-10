-- SECURITY FIX: close the pre-activation feature-default leak in
-- feature_locked() found during live Klyro Ai database verification.
--
-- feature_locked()'s precedence (from 20260902080000_phase_b_entitlements_
-- and_payment_control.sql) is: customer-level lock (suspended/cancelled/
-- archived) -> explicit per-feature admin lock -> active entitlement ->
-- explicit per-feature admin unlock -> payment not enforced / org override
-- -> platform default (features.defaults). That last fallback step never
-- checked lifecycle_status at all. features.defaults currently has phone,
-- voice, chatbot, whatsapp, campaigns and appointments all set to
-- UNLOCKED (false = not locked). So an organization that has never paid —
-- not_provisioned, setup_payment_pending, setup_paid, provisioning, or
-- ready — and has no explicit lock, no entitlement, and no payment
-- override, currently falls through every check and reaches the platform
-- default, which unlocks phone/voice/chatbot/whatsapp/campaigns/
-- appointments anyway. Authentication, provisioning, setup payment,
-- entitlement and activation are supposed to be independent gates; this
-- collapses all of them once payment enforcement's other checks are
-- exhausted.
--
-- Fix: the platform-default fallback now only ever applies once the
-- organization's lifecycle_status is 'active'. Every pre-active state is
-- locked by default at that final step — the only ways through remain the
-- explicit, admin-only mechanisms already checked earlier in the same
-- function: an active organization_entitlements row (admin/subscription/
-- trial/system-granted, never customer-writable), an explicit
-- organization_feature_locks unlock, payment_override (customer cannot
-- write this column — see 20260902090000_restrict_organizations_customer_
-- update_columns.sql), or the global payment-enforcement switch being off.
-- No customer can self-unlock: nothing here changes who may write
-- organization_entitlements, organization_feature_locks, payment_override
-- or lifecycle_status.
--
-- Exception: 'dashboard' is deliberately excluded from the new gate. Per
-- the Phase B design (same migration, section 5) and the app layer
-- (src/routes/app.tsx), dashboard REACHABILITY and SERVICE entitlement are
-- different concepts — a customer must be able to see their setup/payment
-- status once a workspace exists for them, for every pre-active lifecycle
-- state, not just the ones the frontend currently branches on. Gating
-- 'dashboard' here would turn /app (and by extension the account/setup
-- experience it renders for a locked org) into a full lockout for
-- setup_paid/provisioning/ready organizations, which is not the intended
-- behavior and is not part of this fix's scope. 'dashboard' keeps
-- following the exact same rule it already did (platform default, which is
-- 'false' / not locked, overridable only by an explicit admin
-- organization_feature_locks entry) — this migration does not change
-- 'dashboard' behavior at all.
--
-- This migration only replaces the function body (CREATE OR REPLACE); it
-- does not edit 20260902080000_phase_b_entitlements_and_payment_control.sql
-- or any other prior migration, and reuses the existing
-- organization_entitlements / organization_feature_locks / payment_override
-- / platform_settings mechanisms rather than introducing a second
-- authorization system.

CREATE OR REPLACE FUNCTION public.feature_locked(_org uuid, _feature text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  org_lifecycle public.lifecycle_status;
  customer_locked boolean;
  explicit_lock boolean;
  has_entitlement boolean;
  enforced boolean;
  org_override boolean;
  def boolean;
BEGIN
  SELECT lifecycle_status INTO org_lifecycle FROM public.organizations WHERE id = _org;

  customer_locked := org_lifecycle IN ('suspended', 'cancelled', 'archived');
  IF customer_locked THEN RETURN true; END IF;

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

  -- Lifecycle gate: below this point, only 'active' organizations may reach
  -- the platform-default fallback. Every other lifecycle state (including
  -- not_provisioned, which the original code never explicitly locked
  -- either) is locked by default here — except 'dashboard', which keeps
  -- its pre-existing, lifecycle-independent behavior (see header comment).
  IF _feature <> 'dashboard' AND org_lifecycle IS DISTINCT FROM 'active' THEN
    RETURN true;
  END IF;

  SELECT COALESCE((value->_feature)::text::boolean, true) INTO def
    FROM public.platform_settings WHERE key = 'features.defaults';
  RETURN COALESCE(def, true);
END; $$;

REVOKE ALL ON FUNCTION public.feature_locked(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feature_locked(uuid, text) TO authenticated;
