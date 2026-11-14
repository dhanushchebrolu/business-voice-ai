-- Phase 1 of per-customer Sarvam provisioning.
--
-- 1. provisioning_runs: a persistent, resumable record of each attempt to
--    provision an organization, with at most ONE active run per
--    organization (partial unique index). Server-only.
--
-- 2. record_razorpay_capture(): applies a captured platform payment in one
--    transaction, keyed by the Razorpay payment id, so duplicate deliveries,
--    payment.captured + order.paid for the same payment, and concurrent
--    deliveries all have exactly one effect: one payments row, one invoice,
--    order marked paid, setup lifecycle advanced forward only, the monthly
--    billing date extended once. Amount/currency must match the order.
--
-- 3. Shared Sarvam connection: one Sarvam connection (for example the
--    workspace's bring-your-own Vobiz connection) may now be registered for
--    several organizations, each with its own telephony_connections row.
--    The global unique index on (provider, provider_connection_id) becomes
--    unique per organization. Tenant identity is never resolved from a
--    connection id (see sarvam-client-context.server.ts); inbound calls
--    resolve by the dialled number cross-checked with the deployment, and
--    agent tools by per-agent token. Existing rows are unchanged.
--
-- Not destructive: one new table, one new function, one index replaced by
-- a narrower one. Re-runnable. Rollback:
-- docs/production-rollback-20261114100000-provisioning-runs.sql

-- ============ 1. provisioning_runs ============
CREATE TABLE IF NOT EXISTS public.provisioning_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('setup_fee', 'phone_service_fee', 'admin_retry')),
  source_payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  -- The orchestrator's machine state (provisioning-state.ts), e.g.
  -- waiting_for_agent; free text so new steps need no migration.
  current_step text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  last_error_at timestamptz,
  phone_number_id uuid REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
  sarvam_deployment_id text,
  note text,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provisioning_runs_finished_when_terminal CHECK (
    (status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provisioning_runs_one_active
  ON public.provisioning_runs (organization_id)
  WHERE status IN ('pending', 'running', 'waiting');
CREATE INDEX IF NOT EXISTS idx_provisioning_runs_org_created
  ON public.provisioning_runs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provisioning_runs_active_status
  ON public.provisioning_runs (status, updated_at)
  WHERE status IN ('pending', 'running', 'waiting');

ALTER TABLE public.provisioning_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.provisioning_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.provisioning_runs TO service_role;

DROP TRIGGER IF EXISTS trg_provisioning_runs_updated ON public.provisioning_runs;
CREATE TRIGGER trg_provisioning_runs_updated BEFORE UPDATE ON public.provisioning_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ 2. record_razorpay_capture ============
CREATE OR REPLACE FUNCTION public.record_razorpay_capture(
  p_provider_order_id text,
  p_provider_payment_id text,
  p_amount integer,
  p_currency text,
  p_method text,
  p_captured_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o public.payment_orders%ROWTYPE;
  v_payment_id uuid;
  v_first boolean := false;
BEGIN
  IF p_provider_order_id IS NULL OR p_provider_payment_id IS NULL THEN
    RAISE EXCEPTION 'RAZORPAY_CAPTURE_MISSING_IDS' USING ERRCODE = '22023';
  END IF;

  -- Serializes every delivery for this order.
  SELECT * INTO o FROM public.payment_orders WHERE provider_order_id = p_provider_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  IF p_amount IS DISTINCT FROM o.amount OR upper(coalesce(p_currency, '')) <> upper(o.currency) THEN
    RETURN jsonb_build_object(
      'found', true, 'mismatch', true, 'order_id', o.id, 'organization_id', o.organization_id,
      'purpose', o.purpose, 'expected_amount', o.amount, 'expected_currency', o.currency
    );
  END IF;

  INSERT INTO public.payments (organization_id, order_id, provider, provider_payment_id, purpose,
                               amount, currency, status, method, captured_at)
  VALUES (o.organization_id, o.id, 'razorpay', p_provider_payment_id, o.purpose,
          p_amount, o.currency, 'captured', p_method, p_captured_at)
  ON CONFLICT (provider_payment_id) DO NOTHING
  RETURNING id INTO v_payment_id;
  v_first := v_payment_id IS NOT NULL;
  IF NOT v_first THEN
    SELECT id INTO v_payment_id FROM public.payments WHERE provider_payment_id = p_provider_payment_id;
  END IF;

  UPDATE public.payment_orders SET status = 'paid', updated_at = now()
   WHERE id = o.id AND status <> 'paid';

  INSERT INTO public.invoices (organization_id, number, payment_id, amount, currency, status, line_items, paid_at)
  VALUES (o.organization_id,
          'INV-' || to_char(p_captured_at AT TIME ZONE 'UTC', 'YYYY') || '-' || p_provider_payment_id,
          v_payment_id, p_amount, o.currency, 'paid',
          jsonb_build_array(jsonb_build_object('purpose', o.purpose, 'amount', p_amount)),
          p_captured_at)
  ON CONFLICT (number) DO NOTHING;

  IF o.purpose = 'setup_fee' THEN
    UPDATE public.organizations
       SET setup_paid_at = coalesce(setup_paid_at, p_captured_at),
           lifecycle_status = CASE
             WHEN lifecycle_status IN ('not_provisioned', 'setup_payment_pending') THEN 'setup_paid'
             ELSE lifecycle_status END
     WHERE id = o.organization_id;
  ELSIF o.purpose = 'monthly_plan' AND v_first THEN
    UPDATE public.organizations
       SET next_billing_at = greatest(coalesce(next_billing_at, p_captured_at), p_captured_at) + interval '1 month'
     WHERE id = o.organization_id;
  END IF;

  RETURN jsonb_build_object(
    'found', true, 'mismatch', false, 'order_id', o.id, 'organization_id', o.organization_id,
    'purpose', o.purpose, 'payment_id', v_payment_id, 'first_capture', v_first
  );
END; $$;

REVOKE ALL ON FUNCTION public.record_razorpay_capture(text, text, integer, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_razorpay_capture(text, text, integer, text, text, timestamptz)
  TO service_role;

-- ============ 3. shared Sarvam connection ============
DROP INDEX IF EXISTS public.idx_telephony_connections_provider_connection_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_telephony_connections_org_provider_connection
  ON public.telephony_connections (organization_id, provider, provider_connection_id)
  WHERE provider_connection_id IS NOT NULL;
