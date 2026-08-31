-- Account lifecycle states
DO $$ BEGIN
  CREATE TYPE public.account_status AS ENUM ('payment_required','setup_in_progress','active','suspended','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS account_status public.account_status NOT NULL DEFAULT 'payment_required',
  ADD COLUMN IF NOT EXISTS setup_paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_billing_at timestamptz;

-- Platform administrators (internal staff only)
CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.platform_admins TO authenticated;
GRANT ALL ON public.platform_admins TO service_role;
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read admin list" ON public.platform_admins FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins a WHERE a.user_id = auth.uid());
$$;
REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;

-- Configurable platform pricing / settings
CREATE TABLE IF NOT EXISTS public.platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text,
  is_public boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.platform_settings TO authenticated, anon;
GRANT ALL ON public.platform_settings TO service_role;
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public settings readable" ON public.platform_settings FOR SELECT TO anon, authenticated USING (is_public);
CREATE POLICY "admins manage settings" ON public.platform_settings FOR ALL TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

INSERT INTO public.platform_settings (key, value, description) VALUES
  ('pricing.setup_fee', '{"amount": 999900, "currency": "INR", "label": "One-time setup & configuration"}', 'One-time setup fee in paise'),
  ('pricing.monthly_plan', '{"amount": 499900, "currency": "INR", "label": "Monthly platform subscription"}', 'Monthly SaaS subscription in paise'),
  ('pricing.phone_service_fee', '{"amount": 150000, "currency": "INR", "label": "Phone & AI Voice Service"}', 'Monthly phone & voice service fee in paise'),
  ('pricing.voice_minute', '{"amount": 400, "currency": "INR", "label": "Voice minute"}', 'Per voice minute in paise'),
  ('pricing.outbound_call', '{"amount": 500, "currency": "INR", "label": "Outbound call"}', 'Per outbound call in paise'),
  ('pricing.whatsapp_message', '{"amount": 100, "currency": "INR", "label": "WhatsApp conversation"}', 'Per WhatsApp conversation in paise')
ON CONFLICT (key) DO NOTHING;

-- Payment orders
CREATE TABLE IF NOT EXISTS public.payment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  provider text NOT NULL DEFAULT 'razorpay',
  provider_order_id text UNIQUE,
  amount integer NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  status text NOT NULL DEFAULT 'created',
  notes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.payment_orders TO authenticated;
GRANT ALL ON public.payment_orders TO service_role;
ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read own orders" ON public.payment_orders FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

-- Payments
CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.payment_orders(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'razorpay',
  provider_payment_id text UNIQUE,
  provider_subscription_id text,
  purpose text NOT NULL,
  amount integer NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  status text NOT NULL,
  method text,
  captured_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read own payments" ON public.payments FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

-- Invoices
CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  number text UNIQUE NOT NULL,
  payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  amount integer NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  status text NOT NULL DEFAULT 'paid',
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  issued_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
GRANT SELECT ON public.invoices TO authenticated;
GRANT ALL ON public.invoices TO service_role;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read own invoices" ON public.invoices FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

-- Webhook events (idempotency ledger) - server only
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
GRANT ALL ON public.webhook_events TO service_role;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins read webhook events" ON public.webhook_events FOR SELECT TO authenticated USING (public.is_platform_admin());

CREATE TRIGGER trg_payment_orders_updated BEFORE UPDATE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_platform_settings_updated BEFORE UPDATE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();