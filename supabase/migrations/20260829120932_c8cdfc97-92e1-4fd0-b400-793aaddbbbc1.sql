
-- ============ helpers ============
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ============ profiles ============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  country TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile read" ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ organizations ============
CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT,
  country TEXT DEFAULT 'IN',
  currency TEXT NOT NULL DEFAULT 'INR',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  onboarding_completed BOOLEAN NOT NULL DEFAULT false,
  owner_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.organizations TO authenticated;
GRANT ALL ON public.organizations TO service_role;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_orgs_updated BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TYPE public.member_role AS ENUM ('owner','admin','manager','staff','viewer');

CREATE TABLE public.organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role public.member_role NOT NULL DEFAULT 'staff',
  invited_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_members TO authenticated;
GRANT ALL ON public.organization_members TO service_role;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_org_member(_org UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = _org AND m.user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.has_org_role(_org UUID, _roles public.member_role[])
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = _org AND m.user_id = auth.uid() AND m.role = ANY(_roles));
$$;

CREATE POLICY "members read own orgs" ON public.organizations FOR SELECT TO authenticated USING (public.is_org_member(id));
CREATE POLICY "owner creates org" ON public.organizations FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY "admins update org" ON public.organizations FOR UPDATE TO authenticated USING (public.has_org_role(id, ARRAY['owner','admin']::public.member_role[])) WITH CHECK (public.has_org_role(id, ARRAY['owner','admin']::public.member_role[]));

CREATE POLICY "members read membership" ON public.organization_members FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY "self join own org" ON public.organization_members FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid() OR public.has_org_role(organization_id, ARRAY['owner','admin']::public.member_role[]));
CREATE POLICY "admins manage members" ON public.organization_members FOR UPDATE TO authenticated USING (public.has_org_role(organization_id, ARRAY['owner','admin']::public.member_role[])) WITH CHECK (public.has_org_role(organization_id, ARRAY['owner','admin']::public.member_role[]));
CREATE POLICY "admins remove members" ON public.organization_members FOR DELETE TO authenticated USING (public.has_org_role(organization_id, ARRAY['owner','admin']::public.member_role[]));

-- signup: create profile, org, membership
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_org UUID;
BEGIN
  INSERT INTO public.profiles (id, full_name, email, phone, country)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name', NEW.email, NEW.raw_user_meta_data->>'phone', COALESCE(NEW.raw_user_meta_data->>'country','IN'))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organizations (name, owner_id, country)
  VALUES (COALESCE(NULLIF(NEW.raw_user_meta_data->>'business_name',''), COALESCE(NEW.raw_user_meta_data->>'full_name','My') || '''s workspace'), NEW.id, COALESCE(NEW.raw_user_meta_data->>'country','IN'))
  RETURNING id INTO new_org;

  INSERT INTO public.organization_members (organization_id, user_id, role) VALUES (new_org, NEW.id, 'owner');
  INSERT INTO public.subscriptions (organization_id, plan, status, trial_ends_at)
  VALUES (new_org, 'trial', 'trial', now() + interval '14 days');
  RETURN NEW;
END; $$;

-- ============ subscriptions ============
CREATE TYPE public.subscription_status AS ENUM ('trial','active','past_due','cancelled','expired','suspended');
CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'trial',
  status public.subscription_status NOT NULL DEFAULT 'trial',
  provider TEXT,
  provider_subscription_id TEXT,
  current_period_end TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.subscriptions TO authenticated;
GRANT ALL ON public.subscriptions TO service_role;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read subscription" ON public.subscriptions FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE TRIGGER trg_subs_updated BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ businesses ============
CREATE TABLE public.businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  business_type TEXT NOT NULL DEFAULT 'other',
  description TEXT,
  address TEXT, city TEXT, state TEXT, country TEXT DEFAULT 'IN', postal_code TEXT,
  website TEXT, email TEXT, primary_phone TEXT, secondary_phone TEXT, whatsapp TEXT,
  maps_url TEXT, instagram TEXT, facebook TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  currency TEXT NOT NULL DEFAULT 'INR',
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO authenticated;
GRANT ALL ON public.businesses TO service_role;
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant businesses" ON public.businesses FOR ALL TO authenticated USING (public.is_org_member(organization_id)) WITH CHECK (public.is_org_member(organization_id));
CREATE TRIGGER trg_biz_updated BEFORE UPDATE ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.business_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_closed BOOLEAN NOT NULL DEFAULT false,
  intervals JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, day_of_week)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_hours TO authenticated;
GRANT ALL ON public.business_hours TO service_role;
ALTER TABLE public.business_hours ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant hours" ON public.business_hours FOR ALL TO authenticated USING (public.is_org_member(organization_id)) WITH CHECK (public.is_org_member(organization_id));
CREATE TRIGGER trg_hours_updated BEFORE UPDATE ON public.business_hours FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  price NUMERIC(12,2),
  currency TEXT NOT NULL DEFAULT 'INR',
  duration_minutes INTEGER,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.services TO authenticated;
GRANT ALL ON public.services TO service_role;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant services" ON public.services FOR ALL TO authenticated USING (public.is_org_member(organization_id)) WITH CHECK (public.is_org_member(organization_id));
CREATE TRIGGER trg_services_updated BEFORE UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.faqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  category TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.faqs TO authenticated;
GRANT ALL ON public.faqs TO service_role;
ALTER TABLE public.faqs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant faqs" ON public.faqs FOR ALL TO authenticated USING (public.is_org_member(organization_id)) WITH CHECK (public.is_org_member(organization_id));
CREATE TRIGGER trg_faqs_updated BEFORE UPDATE ON public.faqs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.business_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_rules TO authenticated;
GRANT ALL ON public.business_rules TO service_role;
ALTER TABLE public.business_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant rules" ON public.business_rules FOR ALL TO authenticated USING (public.is_org_member(organization_id)) WITH CHECK (public.is_org_member(organization_id));
CREATE TRIGGER trg_rules_updated BEFORE UPDATE ON public.business_rules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ agent ============
CREATE TABLE public.agent_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL UNIQUE REFERENCES public.businesses(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL DEFAULT 'Aria',
  persona TEXT NOT NULL DEFAULT 'professional',
  custom_personality TEXT,
  objectives TEXT[] NOT NULL DEFAULT ARRAY['answer_questions']::text[],
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  primary_language TEXT NOT NULL DEFAULT 'en-IN',
  extra_languages TEXT[] NOT NULL DEFAULT '{}',
  multilingual BOOLEAN NOT NULL DEFAULT false,
  voice_id TEXT NOT NULL DEFAULT 'ritu',
  speaking_pace NUMERIC(3,2) NOT NULL DEFAULT 1.0,
  greetings JSONB NOT NULL DEFAULT '{}'::jsonb,
  transfer_number TEXT,
  after_hours_behavior TEXT NOT NULL DEFAULT 'take_message',
  advanced_mode BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'not_configured',
  active_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_configs TO authenticated;
GRANT ALL ON public.agent_configs TO service_role;
ALTER TABLE public.agent_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant agent config" ON public.agent_configs FOR ALL TO authenticated USING (public.is_org_member(organization_id)) WITH CHECK (public.is_org_member(organization_id));
CREATE TRIGGER trg_agent_updated BEFORE UPDATE ON public.agent_configs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.agent_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  instructions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  change_note TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, version)
);
GRANT SELECT ON public.agent_versions TO authenticated;
GRANT ALL ON public.agent_versions TO service_role;
ALTER TABLE public.agent_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant agent versions" ON public.agent_versions FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

-- ============ telephony ============
CREATE TABLE public.telephony_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'not_connected',
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.telephony_connections TO authenticated;
GRANT ALL ON public.telephony_connections TO service_role;
ALTER TABLE public.telephony_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant telephony read" ON public.telephony_connections FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

CREATE TABLE public.phone_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  e164 TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'IN',
  provider TEXT NOT NULL DEFAULT 'sarvam',
  connection_id UUID REFERENCES public.telephony_connections(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  inbound_enabled BOOLEAN NOT NULL DEFAULT true,
  outbound_enabled BOOLEAN NOT NULL DEFAULT false,
  monthly_price NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, e164)
);
GRANT SELECT ON public.phone_numbers TO authenticated;
GRANT ALL ON public.phone_numbers TO service_role;
ALTER TABLE public.phone_numbers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant numbers read" ON public.phone_numbers FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

-- ============ calls, leads ============
CREATE TABLE public.call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  phone_number_id UUID REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
  direction TEXT NOT NULL DEFAULT 'inbound',
  caller_number TEXT,
  caller_name TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  outcome TEXT,
  language TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  agent_version INTEGER,
  recording_url TEXT,
  transcript JSONB,
  summary TEXT,
  lead_score TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.call_logs TO authenticated;
GRANT ALL ON public.call_logs TO service_role;
ALTER TABLE public.call_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant calls read" ON public.call_logs FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

CREATE TABLE public.leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  call_id UUID REFERENCES public.call_logs(id) ON DELETE SET NULL,
  name TEXT, phone TEXT, email TEXT,
  source TEXT NOT NULL DEFAULT 'phone',
  asked_about TEXT,
  score TEXT NOT NULL DEFAULT 'warm',
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leads TO authenticated;
GRANT ALL ON public.leads TO service_role;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant leads" ON public.leads FOR ALL TO authenticated USING (public.is_org_member(organization_id)) WITH CHECK (public.is_org_member(organization_id));
CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ knowledge ============
CREATE TABLE public.knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'text',
  source_url TEXT,
  storage_path TEXT,
  content TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.knowledge_documents TO authenticated;
GRANT ALL ON public.knowledge_documents TO service_role;
ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant knowledge" ON public.knowledge_documents FOR ALL TO authenticated USING (public.is_org_member(organization_id)) WITH CHECK (public.is_org_member(organization_id));
CREATE TRIGGER trg_knowledge_updated BEFORE UPDATE ON public.knowledge_documents FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ usage & notifications ============
CREATE TABLE public.usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  call_id UUID REFERENCES public.call_logs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'sarvam',
  quantity NUMERIC(14,4) NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'unit',
  provider_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
  billable_cost NUMERIC(14,4) NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.usage_records TO authenticated;
GRANT ALL ON public.usage_records TO service_role;
ALTER TABLE public.usage_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant usage read" ON public.usage_records FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  kind TEXT NOT NULL DEFAULT 'info',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant notifications read" ON public.notifications FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY "tenant notifications update" ON public.notifications FOR UPDATE TO authenticated USING (public.is_org_member(organization_id)) WITH CHECK (public.is_org_member(organization_id));
