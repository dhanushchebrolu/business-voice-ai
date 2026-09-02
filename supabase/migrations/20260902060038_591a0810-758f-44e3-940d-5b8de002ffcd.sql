-- 1. Lifecycle enum
DO $$ BEGIN
  CREATE TYPE public.lifecycle_status AS ENUM (
    'not_provisioned','setup_payment_pending','setup_paid','provisioning',
    'ready','active','suspended','cancelled','archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Client ID sequence + organization extensions
CREATE SEQUENCE IF NOT EXISTS public.org_client_id_seq START 1;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS client_id text,
  ADD COLUMN IF NOT EXISTS lifecycle_status public.lifecycle_status NOT NULL DEFAULT 'not_provisioned',
  ADD COLUMN IF NOT EXISTS contact_name text,
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS industry text,
  ADD COLUMN IF NOT EXISTS business_type text,
  ADD COLUMN IF NOT EXISTS gst_number text,
  ADD COLUMN IF NOT EXISTS pan_number text,
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS crm_stage text NOT NULL DEFAULT 'lead',
  ADD COLUMN IF NOT EXISTS follow_up_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_contacted_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_admin_id uuid,
  ADD COLUMN IF NOT EXISTS internal_notes text,
  ADD COLUMN IF NOT EXISTS provisioned_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by_admin uuid;

UPDATE public.organizations
SET client_id = 'VAA-' || lpad(nextval('public.org_client_id_seq')::text, 6, '0')
WHERE client_id IS NULL;

ALTER TABLE public.organizations
  ALTER COLUMN client_id SET DEFAULT 'VAA-' || lpad(nextval('public.org_client_id_seq')::text, 6, '0');

ALTER TABLE public.organizations ALTER COLUMN client_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE public.organizations ADD CONSTRAINT organizations_client_id_key UNIQUE (client_id);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;

-- Client ID is immutable
CREATE OR REPLACE FUNCTION public.protect_client_id()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'client_id is immutable';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_orgs_client_id_immutable ON public.organizations;
CREATE TRIGGER trg_orgs_client_id_immutable BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.protect_client_id();

CREATE INDEX IF NOT EXISTS idx_orgs_lifecycle ON public.organizations (lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_orgs_created_at ON public.organizations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orgs_contact_email ON public.organizations (contact_email);

-- New self-signups are not provisioned
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_org UUID;
BEGIN
  INSERT INTO public.profiles (id, full_name, email, phone, country)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name', NEW.email, NEW.raw_user_meta_data->>'phone', COALESCE(NEW.raw_user_meta_data->>'country','IN'))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organizations (name, owner_id, country, account_status, lifecycle_status, contact_email, contact_name)
  VALUES (
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'business_name',''), COALESCE(NEW.raw_user_meta_data->>'full_name','My') || '''s workspace'),
    NEW.id, COALESCE(NEW.raw_user_meta_data->>'country','IN'), 'payment_required', 'not_provisioned',
    NEW.email, NEW.raw_user_meta_data->>'full_name'
  )
  RETURNING id INTO new_org;

  INSERT INTO public.organization_members (organization_id, user_id, role) VALUES (new_org, NEW.id, 'owner');
  INSERT INTO public.subscriptions (organization_id, plan, status) VALUES (new_org, 'starter', 'expired');
  RETURN NEW;
END; $$;

-- 3. Invitations (hashed only)
CREATE TABLE IF NOT EXISTS public.organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL,
  pin_hash text,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_sent_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.organization_invitations TO service_role;
ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Platform admins read invitations" ON public.organization_invitations
  FOR SELECT TO authenticated USING (public.is_platform_admin());
GRANT SELECT ON public.organization_invitations TO authenticated;
CREATE INDEX IF NOT EXISTS idx_invites_org ON public.organization_invitations (organization_id);
CREATE INDEX IF NOT EXISTS idx_invites_email ON public.organization_invitations (email);
CREATE TRIGGER trg_invites_updated BEFORE UPDATE ON public.organization_invitations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. Admin support (impersonation) sessions
CREATE TABLE IF NOT EXISTS public.admin_support_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL,
  admin_email text,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  reason text,
  ip_address text,
  user_agent text,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz
);
GRANT ALL ON public.admin_support_sessions TO service_role;
ALTER TABLE public.admin_support_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Platform admins read support sessions" ON public.admin_support_sessions
  FOR SELECT TO authenticated USING (public.is_platform_admin());
CREATE POLICY "Org members see support sessions on their org" ON public.admin_support_sessions
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
GRANT SELECT ON public.admin_support_sessions TO authenticated;
CREATE INDEX IF NOT EXISTS idx_support_sessions_org ON public.admin_support_sessions (organization_id, started_at DESC);

-- 5. Pricing rules: customer price vs provider cost (provider cost is admin-only)
CREATE TABLE IF NOT EXISTS public.pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  unit text NOT NULL DEFAULT 'unit',
  currency text NOT NULL DEFAULT 'INR',
  customer_amount integer NOT NULL DEFAULT 0,
  provider_cost integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.pricing_rules TO service_role;
ALTER TABLE public.pricing_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Platform admins manage pricing rules" ON public.pricing_rules
  FOR SELECT TO authenticated USING (public.is_platform_admin());
GRANT SELECT ON public.pricing_rules TO authenticated;
CREATE TRIGGER trg_pricing_rules_updated BEFORE UPDATE ON public.pricing_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.pricing_rules (key, label, unit, customer_amount, provider_cost) VALUES
  ('setup_fee','One-time setup fee','one-time',0,0),
  ('monthly_plan','Monthly platform fee','month',0,0),
  ('phone_number','Phone & AI voice service','month',150000,0),
  ('voice_minute','Voice call','minute',400,350),
  ('outbound_minute','Outbound call','minute',400,350),
  ('whatsapp_message','WhatsApp message','message',0,0)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.organization_pricing_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  customer_amount integer,
  provider_cost integer,
  note text,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
GRANT ALL ON public.organization_pricing_overrides TO service_role;
ALTER TABLE public.organization_pricing_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Platform admins read pricing overrides" ON public.organization_pricing_overrides
  FOR SELECT TO authenticated USING (public.is_platform_admin());
GRANT SELECT ON public.organization_pricing_overrides TO authenticated;
CREATE TRIGGER trg_pricing_overrides_updated BEFORE UPDATE ON public.organization_pricing_overrides
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Customer-safe rate lookup: returns only the selling price, never provider cost
CREATE OR REPLACE FUNCTION public.customer_rate(_org uuid, _key text)
RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v integer;
BEGIN
  IF NOT (public.is_org_member(_org) OR public.is_platform_admin()) THEN RETURN NULL; END IF;
  SELECT customer_amount INTO v FROM public.organization_pricing_overrides
    WHERE organization_id = _org AND key = _key AND customer_amount IS NOT NULL;
  IF v IS NOT NULL THEN RETURN v; END IF;
  SELECT customer_amount INTO v FROM public.pricing_rules WHERE key = _key AND is_active;
  RETURN v;
END; $$;

-- 6. CRM notes + customer timeline
CREATE TABLE IF NOT EXISTS public.crm_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  admin_user_id uuid,
  admin_email text,
  body text NOT NULL,
  follow_up_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.crm_notes TO service_role;
ALTER TABLE public.crm_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Platform admins read crm notes" ON public.crm_notes
  FOR SELECT TO authenticated USING (public.is_platform_admin());
GRANT SELECT ON public.crm_notes TO authenticated;
CREATE INDEX IF NOT EXISTS idx_crm_notes_org ON public.crm_notes (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.customer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  detail text,
  actor_email text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.customer_events TO service_role;
ALTER TABLE public.customer_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Platform admins read customer events" ON public.customer_events
  FOR SELECT TO authenticated USING (public.is_platform_admin());
CREATE POLICY "Org members read own events" ON public.customer_events
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
GRANT SELECT ON public.customer_events TO authenticated;
CREATE INDEX IF NOT EXISTS idx_customer_events_org ON public.customer_events (organization_id, created_at DESC);