
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_org_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_org_role(uuid, public.member_role[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_org_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_org_role(uuid, public.member_role[]) TO authenticated;
