-- SECURITY FIX: close the direct self-provisioning path left open after
-- 20260902091500_signup_no_longer_auto_provisions_workspace.sql.
--
-- That migration correctly stopped handle_new_user() from auto-creating an
-- organization/membership/subscription on signup, but it did not touch the
-- table-level GRANTs or RLS policies from the original schema migration
-- (20260829120932_c8cdfc97-92e1-4fd0-b400-793aaddbbbc1.sql), which still let
-- ANY authenticated user, directly from the browser client:
--   - INSERT into public.organizations (policy "owner creates org",
--     WITH CHECK owner_id = auth.uid()) — i.e. self-create a workspace
--   - INSERT into public.organization_members (policy "self join own org",
--     WITH CHECK user_id = auth.uid() OR has_org_role(...)) — i.e.
--     self-join any organization_id they can guess/construct as a member
--   - UPDATE any organization_members row for an org they have
--     'owner'/'admin' on (policy "admins manage members") — including
--     promoting themselves or another row to 'owner'
--   - DELETE any organization_members row for an org they have
--     'owner'/'admin' on (policy "admins remove members")
--
-- None of this is used by any legitimate workflow: every INSERT into
-- organizations, and every INSERT/UPDATE/DELETE into organization_members,
-- in the current application code goes through the `supabaseAdmin`
-- (service_role) client — which is not subject to these grants/policies —
-- gated by assertPlatformAdmin() (see admin-clients.functions.ts). The
-- customer-facing client only ever SELECTs organization_members, and only
-- UPDATEs organizations through the already-narrow column grant added by
-- 20260902090000_restrict_organizations_customer_update_columns.sql (that
-- grant, and the "admins update org" / "members read own orgs" /
-- "members read membership" policies, are untouched by this migration —
-- legitimate self-edit and read access keep working exactly as before).
--
-- This migration is forward-only: it does not edit the two migrations named
-- above. It only revokes privileges and drops the now-unnecessary policies
-- that granted them.

REVOKE INSERT ON public.organizations FROM authenticated;
DROP POLICY IF EXISTS "owner creates org" ON public.organizations;

REVOKE INSERT, UPDATE, DELETE ON public.organization_members FROM authenticated;
DROP POLICY IF EXISTS "self join own org" ON public.organization_members;
DROP POLICY IF EXISTS "admins manage members" ON public.organization_members;
DROP POLICY IF EXISTS "admins remove members" ON public.organization_members;

-- Unaffected / still intact after this migration:
--   organizations:        SELECT (all authenticated members of the org),
--                          UPDATE (narrow customer-editable column list only)
--   organization_members: SELECT (all authenticated members of the org)
--   service_role:          GRANT ALL on both tables (admin/server-side
--                          provisioning and membership management continue
--                          to work exactly as before, through the existing
--                          audited admin server functions)
