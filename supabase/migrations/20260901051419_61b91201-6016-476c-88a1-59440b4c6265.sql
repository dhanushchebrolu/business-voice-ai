-- 1. Platform admin roles -------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.platform_role AS ENUM ('super_admin','admin','support','finance','operations');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.platform_admins
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS role public.platform_role NOT NULL DEFAULT 'super_admin',
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

DROP TRIGGER IF EXISTS trg_platform_admins_updated ON public.platform_admins;
CREATE TRIGGER trg_platform_admins_updated BEFORE UPDATE ON public.platform_admins
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- is_platform_admin must honour the active flag
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins a WHERE a.user_id = auth.uid() AND a.is_active);
$$;

CREATE OR REPLACE FUNCTION public.platform_admin_role()
RETURNS public.platform_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.role FROM public.platform_admins a WHERE a.user_id = auth.uid() AND a.is_active LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.platform_admin_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_admin_role() TO authenticated;

DROP POLICY IF EXISTS "platform admins read admins" ON public.platform_admins;
CREATE POLICY "platform admins read admins" ON public.platform_admins
  FOR SELECT TO authenticated USING (public.is_platform_admin() OR user_id = auth.uid());

-- 2. Audit logs --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid,
  admin_email text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  old_value jsonb,
  new_value jsonb,
  reason text,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.audit_logs TO authenticated;
GRANT ALL ON public.audit_logs TO service_role;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "platform admins read audit logs" ON public.audit_logs;
CREATE POLICY "platform admins read audit logs" ON public.audit_logs
  FOR SELECT TO authenticated USING (public.is_platform_admin());
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON public.audit_logs (organization_id);

-- 3. Immutable wallet ledger --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  amount integer NOT NULL, -- paise; positive = credit, negative = debit
  currency text NOT NULL DEFAULT 'INR',
  kind text NOT NULL,      -- payment|credit|debit|refund|manual_adjustment|call_usage|whatsapp_usage|ai_usage|subscription|number_rental
  description text,
  reference text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.wallet_transactions TO authenticated;
GRANT ALL ON public.wallet_transactions TO service_role;
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "members read own wallet" ON public.wallet_transactions;
CREATE POLICY "members read own wallet" ON public.wallet_transactions
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id) OR public.is_platform_admin());
CREATE INDEX IF NOT EXISTS idx_wallet_tx_org ON public.wallet_transactions (organization_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.wallet_balance(_org uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(amount), 0)::int FROM public.wallet_transactions WHERE organization_id = _org;
$$;
REVOKE ALL ON FUNCTION public.wallet_balance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wallet_balance(uuid) TO authenticated;

-- 4. Per-customer feature locks ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.organization_feature_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  feature text NOT NULL,
  locked boolean NOT NULL DEFAULT true,
  note text,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, feature)
);
GRANT SELECT ON public.organization_feature_locks TO authenticated;
GRANT ALL ON public.organization_feature_locks TO service_role;
ALTER TABLE public.organization_feature_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "members read own locks" ON public.organization_feature_locks;
CREATE POLICY "members read own locks" ON public.organization_feature_locks
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id) OR public.is_platform_admin());
DROP TRIGGER IF EXISTS trg_feature_locks_updated ON public.organization_feature_locks;
CREATE TRIGGER trg_feature_locks_updated BEFORE UPDATE ON public.organization_feature_locks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5. Platform settings: enforcement switch, defaults, thresholds --------------
INSERT INTO public.platform_settings (key, value, description, is_public) VALUES
  ('billing.payment_required', '{"enabled": true}'::jsonb, 'Global payment enforcement. When disabled, customers use the product without paying.', true),
  ('billing.grace_period_days', '{"days": 5}'::jsonb, 'Days after an overdue payment before services are suspended.', false),
  ('billing.low_balance_threshold', '{"amount": 50000, "currency": "INR"}'::jsonb, 'Wallet balance that triggers a low balance warning.', false),
  ('billing.critical_balance_threshold', '{"amount": 10000, "currency": "INR"}'::jsonb, 'Wallet balance that triggers a critical warning.', false),
  ('billing.auto_suspend_enabled', '{"enabled": true}'::jsonb, 'Automatically suspend services after the grace period.', false),
  ('features.defaults', '{"dashboard": true, "phone": true, "voice": true, "whatsapp": true, "chatbot": true, "campaigns": true, "appointments": true}'::jsonb, 'Default lock state per feature (true = locked, payment required).', true)
ON CONFLICT (key) DO NOTHING;

-- Feature lock resolution: per-org override, else platform default, and
-- everything is unlocked while global payment enforcement is off.
CREATE OR REPLACE FUNCTION public.feature_locked(_org uuid, _feature text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE enforced boolean; override boolean; def boolean;
BEGIN
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
REVOKE ALL ON FUNCTION public.feature_locked(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.feature_locked(uuid, text) TO authenticated;

-- Platform settings visibility: public settings for everyone signed in,
-- everything for platform admins. Writes stay server-side only.
DROP POLICY IF EXISTS "read public platform settings" ON public.platform_settings;
CREATE POLICY "read public platform settings" ON public.platform_settings
  FOR SELECT TO authenticated USING (is_public OR public.is_platform_admin());