-- PHASE C — refunds
--
-- One refund record per Razorpay refund attempt against a captured payment.
-- Multiple rows are allowed per payment (partial refunds); the application
-- layer (requestRefund) is responsible for never letting the sum of a
-- payment's refunds exceed the original amount.
--
-- A refund is never marked "processed" just because the create-refund API
-- call returned 2xx — Razorpay's response itself carries the true status
-- ("processed" for instant methods, "pending" otherwise), and pending
-- refunds are only finalized when the refund.processed / refund.failed
-- webhook event arrives. This matches spec §40: "Never mark a refund
-- successful before provider confirmation."

CREATE TABLE IF NOT EXISTS public.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'razorpay',
  provider_refund_id text UNIQUE,
  amount integer NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  status text NOT NULL DEFAULT 'pending', -- pending | processed | failed
  reason text,
  requested_by uuid,
  requested_by_email text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.refunds TO authenticated;
GRANT ALL ON public.refunds TO service_role;
ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read own refunds" ON public.refunds;
CREATE POLICY "members read own refunds" ON public.refunds
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id) OR public.is_platform_admin());

CREATE INDEX IF NOT EXISTS idx_refunds_org ON public.refunds (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON public.refunds (payment_id);

DROP TRIGGER IF EXISTS trg_refunds_updated ON public.refunds;
CREATE TRIGGER trg_refunds_updated BEFORE UPDATE ON public.refunds
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
