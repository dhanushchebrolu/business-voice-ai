-- WhatsApp: only owners/admins may change which bot answers a connection.
--
-- 20260923090000 lets authenticated users UPDATE whatsapp_connections'
-- agent_config_id column directly (PostgREST) under a policy that only
-- checks membership (is_org_member), so any member — staff or a read-only
-- viewer — could repoint the AI that replies to customers by calling the
-- REST API from the browser, bypassing the dashboard's server function.
-- 20261019090000's trigger already keeps the bot inside the connection's
-- organization; this narrows WHO may change it to owners/admins, the same
-- rule the server functions apply (src/lib/whatsapp/whatsapp-access.server.ts)
-- and the one used for organization settings ("admins update org").
--
-- Only the policy's predicate changes: the column grant (agent_config_id
-- only), the read policy and every other table are untouched. Compatible
-- with both the code before this change (which updates through the
-- caller's RLS-scoped client) and after it (service role with an explicit
-- owner/admin check). Idempotent; no data rewrite; takes a brief lock on
-- whatsapp_connections to replace the policy.
--
-- Depends on: 20260829120932 (has_org_role, member_role),
-- 20260923090000 (whatsapp_connections and the policy being replaced).
--
-- Rollback (restores the previous, broader policy):
--   DROP POLICY IF EXISTS "tenant whatsapp connections assign bot" ON public.whatsapp_connections;
--   CREATE POLICY "tenant whatsapp connections assign bot" ON public.whatsapp_connections
--     FOR UPDATE TO authenticated
--     USING (public.is_org_member(organization_id))
--     WITH CHECK (public.is_org_member(organization_id));

DROP POLICY IF EXISTS "tenant whatsapp connections assign bot" ON public.whatsapp_connections;
CREATE POLICY "tenant whatsapp connections assign bot" ON public.whatsapp_connections
  FOR UPDATE TO authenticated
  USING (public.has_org_role(organization_id, ARRAY['owner', 'admin']::public.member_role[]))
  WITH CHECK (public.has_org_role(organization_id, ARRAY['owner', 'admin']::public.member_role[]));
