CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE new_org UUID;
BEGIN
  INSERT INTO public.profiles (id, full_name, email, phone, country)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name', NEW.email, NEW.raw_user_meta_data->>'phone', COALESCE(NEW.raw_user_meta_data->>'country','IN'))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organizations (name, owner_id, country, account_status)
  VALUES (COALESCE(NULLIF(NEW.raw_user_meta_data->>'business_name',''), COALESCE(NEW.raw_user_meta_data->>'full_name','My') || '''s workspace'), NEW.id, COALESCE(NEW.raw_user_meta_data->>'country','IN'), 'payment_required')
  RETURNING id INTO new_org;

  INSERT INTO public.organization_members (organization_id, user_id, role) VALUES (new_org, NEW.id, 'owner');
  INSERT INTO public.subscriptions (organization_id, plan, status)
  VALUES (new_org, 'starter', 'expired');
  RETURN NEW;
END; $function$;