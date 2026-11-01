-- ============================================================
-- Remediation (NOT a migration — run manually after review):
-- let the server role evaluate the billing / feature gate.
--
-- Production evidence (2026-10-27):
--   has_function_privilege('service_role', 'public.feature_locked(uuid,text)', 'EXECUTE') = false
--
-- Why it matters: every server-side gate check goes through
-- feature-gate.server.ts's default RPC, made with the service-role client
-- (supabaseAdmin). Without EXECUTE that RPC fails, and checkFeatureAccess
-- fails closed ("Could not evaluate … entitlement"). Affected paths:
--   - checkTelephonyAccess("phone") — every inbound voice call
--     (webhooks/vobiz-answer.ts, webhooks/telephony.ts, the media-session
--     authorization and telephony-runtime), outbound calls and campaigns;
--   - agent.functions.ts ("voice": save/publish/rollback agent);
--   - provisioning-health.server.ts ("phone", "dashboard").
-- They only work today while BYPASS_BILLING_GATES=true skips the check.
-- (Customer-initiated checks — WhatsApp onboarding, the voice number
-- request — already run as the signed-in user and are unaffected.)
--
-- Same failure class as the production incident fixed by 20261007100000
-- (service_role denied on wallet_balance): feature_locked's grants
-- (20260901051419, 20260902080000, 20260907090000) are REVOKE … FROM
-- PUBLIC, anon + GRANT EXECUTE … TO authenticated only, and this project has
-- no default function privileges for service_role. No migration in this
-- repository grants it.
--
-- Minimum privilege: EXECUTE on this one function signature, to
-- service_role only. Nothing else is needed because feature_locked is
-- SECURITY DEFINER (SET search_path = public): its reads of organizations,
-- organization_feature_locks, organization_entitlements and
-- platform_settings run as the function owner. It ignores the caller, so
-- service_role gets exactly the answers authenticated already gets —
-- billing enforcement is unchanged, not bypassed. service_role already
-- bypasses RLS and holds table grants, so no new data becomes reachable.
-- anon and PUBLIC stay revoked. BYPASS_BILLING_GATES is unrelated and
-- untouched (checkFeatureAccess still checks it first).
--
-- Operational effect: while BYPASS_BILLING_GATES=true nothing changes.
-- Once it is turned off, gates are enforced for real — organizations that
-- feature_locked() reports as locked (unpaid, suspended, lifecycle not
-- active, explicit admin lock) will be refused, as designed. Review that
-- list first (verification query 3 below).
--
-- Relationship to 20261024090000_grant_feature_locked_to_service_role:
-- that file exists only on the owner's machine, is not applied in
-- production and has not been reviewed here. Compare it with this script
-- before deciding; do not apply both blindly.
--
-- Idempotent: preflight is read-only; GRANT of a held privilege is a no-op.
-- Rollback: REVOKE EXECUTE ON FUNCTION public.feature_locked(uuid, text) FROM service_role;
-- ============================================================

BEGIN;

-- Preflight: the exact function, still SECURITY DEFINER with a pinned
-- search_path and a boolean result. Anything else aborts with no change.
DO $$
DECLARE
  f record;
BEGIN
  SELECT p.prosecdef AS security_definer,
         pg_get_function_result(p.oid) AS result,
         coalesce(array_to_string(p.proconfig, ','), '') AS config
    INTO f
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'feature_locked'
     AND pg_get_function_identity_arguments(p.oid) = '_org uuid, _feature text';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public.feature_locked(_org uuid, _feature text) not found — no change made';
  END IF;
  IF NOT f.security_definer THEN
    RAISE EXCEPTION 'public.feature_locked is not SECURITY DEFINER — EXECUTE alone would not be enough; no change made';
  END IF;
  IF f.result <> 'boolean' THEN
    RAISE EXCEPTION 'public.feature_locked returns %, expected boolean — no change made', f.result;
  END IF;
  IF f.config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'public.feature_locked has no pinned search_path (%) — no change made', f.config;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'role service_role not found — no change made';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.feature_locked(uuid, text) TO service_role;

COMMIT;

-- ------------------------------------------------------------
-- Verification (read-only; run before and after)
-- ------------------------------------------------------------
-- 1. Privileges (expect after: service_role t, authenticated t, anon f):
--    SELECT r AS role, has_function_privilege(r, 'public.feature_locked(uuid,text)', 'EXECUTE')
--      FROM unnest(ARRAY['service_role','authenticated','anon']) AS r;
-- 2. The full ACL (expect only service_role added):
--    SELECT proacl FROM pg_proc WHERE oid = 'public.feature_locked(uuid,text)'::regprocedure;
-- 3. Which organizations the gate will refuse once BYPASS_BILLING_GATES is off:
--    SELECT id, name, lifecycle_status,
--           public.feature_locked(id, 'phone') AS phone_locked,
--           public.feature_locked(id, 'whatsapp') AS whatsapp_locked
--      FROM public.organizations ORDER BY name;
