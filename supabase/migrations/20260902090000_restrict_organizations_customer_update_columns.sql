-- CRITICAL FIX (found during Phase B acceptance testing, Test P):
--
-- The pre-existing "admins update org" RLS policy allows an org owner/admin
-- to UPDATE their own organizations row. RLS row policies constrain WHICH
-- ROWS can be touched, not WHICH COLUMNS — so with a blanket table-level
-- UPDATE grant, a customer could call
--   supabase.from('organizations').update({ lifecycle_status: 'active',
--     payment_override: true, client_id: '...' })
-- directly from the browser and bypass setup payment, entitlements, admin
-- locks and payment overrides entirely. This predates Phase B but Phase B's
-- new payment_override/lifecycle-driven gating makes it directly exploitable
-- (spec §25/§30, Phase B acceptance Test P).
--
-- The only legitimate customer-initiated direct writes to this table today
-- are: app.settings.tsx (name, timezone) and app.onboarding.tsx
-- (onboarding_completed). Everything else — lifecycle_status, account_status,
-- client_id, payment_override*, locked_*, setup_paid_at, activated_at,
-- archived_at, crm_stage, internal_notes, assigned_admin_id,
-- created_by_admin, next_billing_at, owner_id — must only be writable by
-- service_role (i.e. through the audited, permission-checked admin server
-- functions).

REVOKE UPDATE ON public.organizations FROM authenticated;

GRANT UPDATE (
  name,
  timezone,
  onboarding_completed,
  contact_email,
  contact_name,
  contact_phone,
  address,
  city,
  country,
  industry,
  website,
  business_type,
  currency,
  gst_number,
  pan_number
) ON public.organizations TO authenticated;
