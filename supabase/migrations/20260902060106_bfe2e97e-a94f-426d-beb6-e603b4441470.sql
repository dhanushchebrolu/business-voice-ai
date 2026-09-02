REVOKE ALL ON FUNCTION public.customer_rate(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_rate(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.protect_client_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protect_client_id() TO service_role;