CREATE OR REPLACE FUNCTION public.wallet_balance(_org uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN public.is_org_member(_org) OR public.is_platform_admin()
    THEN (SELECT COALESCE(SUM(amount), 0)::int FROM public.wallet_transactions WHERE organization_id = _org)
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.feature_locked(_org uuid, _feature text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE enforced boolean; override boolean; def boolean;
BEGIN
  IF NOT (public.is_org_member(_org) OR public.is_platform_admin()) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE((value->>'enabled')::boolean, true) INTO enforced
    FROM public.platform_settings WHERE key = 'billing.payment_required';
  IF enforced IS NOT TRUE THEN RETURN false; END IF;

  SELECT locked INTO override FROM public.organization_feature_locks
    WHERE organization_id = _org AND feature = _feature;
  IF override IS NOT NULL THEN RETURN override; END IF;

  SELECT COALESCE((value->_feature)::text::boolean, true) INTO def
    FROM public.platform_settings WHERE key = 'features.defaults';
  RETURN COALESCE(def, true);
END; $$;