-- Restores opening-hours validation on the payment-hold booking path.
--
-- 20261010150000_business_scoped_overlap_and_default_duration.sql rewrote
-- create_booking_payment_hold as a standalone plpgsql body (it had been a
-- thin wrapper over create_booking_atomic) and, in doing so, dropped the
-- validate_booking_schedule call create_booking_atomic makes. A payment
-- hold could therefore be created on a closed day or outside business
-- hours, while booking-service.server.ts's createPaymentRequiredBooking
-- still expects this RPC to raise SLOT_OUTSIDE_SCHEDULE.
--
-- Identical to the 20261010150000 body except for the one PERFORM below,
-- placed exactly where create_booking_atomic has it: after the per-business
-- lock (salt 1), before the per-connection lock (salt 0). Lock order is
-- unchanged (2, 1, 0).
CREATE OR REPLACE FUNCTION public.create_booking_payment_hold(
  p_organization_id UUID,
  p_business_id UUID,
  p_calendar_connection_id UUID,
  p_service_id UUID,
  p_agent_config_id UUID,
  p_contact_id UUID,
  p_start_at TIMESTAMPTZ,
  p_end_at TIMESTAMPTZ,
  p_timezone TEXT,
  p_customer_name TEXT,
  p_customer_phone TEXT,
  p_customer_email TEXT,
  p_source TEXT,
  p_idempotency_key TEXT,
  p_hold_expires_at TIMESTAMPTZ,
  p_call_id TEXT
)
RETURNS public.bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.bookings;
  v_booking public.bookings;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_organization_id::text || ':' || p_idempotency_key, 2)
    );

    SELECT * INTO v_existing FROM public.bookings
      WHERE organization_id = p_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_business_id::text, 1));

  -- Restored: authoritative schedule validation inside the same lock and
  -- transaction as the insert, matching create_booking_atomic.
  PERFORM public.validate_booking_schedule(p_business_id, p_start_at, p_end_at, p_timezone);

  IF p_calendar_connection_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_calendar_connection_id::text, 0));
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bookings
    WHERE business_id = p_business_id
      AND status NOT IN ('CANCELLED', 'NO_SHOW', 'PAYMENT_EXPIRED', 'PAYMENT_FAILED')
      AND start_at < p_end_at
      AND end_at > p_start_at
  ) THEN
    RAISE EXCEPTION 'SLOT_NO_LONGER_AVAILABLE';
  END IF;

  INSERT INTO public.bookings (
    organization_id, business_id, calendar_connection_id, service_id,
    agent_config_id, contact_id, status, start_at, end_at, timezone,
    customer_name, customer_phone, customer_email, source,
    idempotency_key, hold_expires_at, call_id
  ) VALUES (
    p_organization_id, p_business_id, p_calendar_connection_id, p_service_id,
    p_agent_config_id, p_contact_id, 'PENDING_PAYMENT', p_start_at, p_end_at, p_timezone,
    p_customer_name, p_customer_phone, p_customer_email, p_source,
    p_idempotency_key, p_hold_expires_at, p_call_id
  )
  RETURNING * INTO v_booking;

  RETURN v_booking;
END;
$$;

REVOKE ALL ON FUNCTION public.create_booking_payment_hold FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_booking_payment_hold TO service_role;
