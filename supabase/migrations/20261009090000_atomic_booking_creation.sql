-- Closes the DB-level double-booking race for the DIRECT (non-payment)
-- booking path — the one the live voice agent actually uses via
-- attemptBooking -> book_appointment -> createBooking().
--
-- Phase 4's own migration (20260926090000_customer_payments.sql,
-- create_booking_payment_hold) already recorded the reason this needs a
-- single Postgres function rather than JS-level code: Supabase's
-- PostgREST interface gives each separate .from(...).select()/.insert()
-- call from the JS client its own implicit transaction, so a "check for
-- conflicts, then insert" sequence spanning two separate client calls can
-- never be made race-free at the application level — two concurrent
-- requests can both pass the SELECT before either INSERTs. Only the
-- payment-hold path got the real fix (pg_advisory_xact_lock + a full
-- time-range overlap check inside ONE transaction); createBooking() in
-- booking-service.server.ts kept its JS-level check-then-insert, backed
-- only by an EXACT-start-time unique index — which does not catch two
-- bookings that overlap but start at different times (e.g. 10:00-10:30
-- vs 10:15-10:45).
--
-- Rather than duplicating that locking/overlap logic in a second
-- function (this codebase's own standing rule: no duplicate competing
-- implementations), create_booking_atomic below is the ONE place that
-- logic lives. create_booking_payment_hold is redefined as a thin SQL
-- wrapper over it, preserving its exact existing signature and behavior
-- (including its own exact-start-time index widening from the Phase 4
-- migration) so nothing that already calls it needs to change.
--
-- btree_gist / EXCLUDE-constraint note unchanged from both prior
-- migrations: still not added speculatively; advisory-lock + in-
-- transaction overlap check remains the chosen mechanism, needing no
-- extension.

-- ============================================================
-- create_booking_atomic — idempotent, lock-protected booking creation for
-- any status/hold combination. SECURITY DEFINER + fixed search_path,
-- EXECUTE granted to service_role only, matching every other privileged
-- RPC in this schema (create_booking_payment_hold, is_org_member, ...) —
-- called exclusively from server-side code via supabaseAdmin.rpc(), never
-- directly by an authenticated browser session.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_booking_atomic(
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
  p_status TEXT,
  p_hold_expires_at TIMESTAMPTZ,
  p_call_id TEXT,
  p_notes TEXT
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
    SELECT * INTO v_existing FROM public.bookings
      WHERE organization_id = p_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- A booking with no calendar connection (should not happen for a real
  -- voice/payment booking today, but the column is nullable — see the
  -- Phase 2 migration) has no shared resource to serialize against, so
  -- the lock/overlap check is skipped rather than locking on a NULL key.
  IF p_calendar_connection_id IS NOT NULL THEN
    -- Session-level-scoped-to-this-transaction advisory lock keyed on the
    -- calendar connection (released automatically at COMMIT/ROLLBACK,
    -- never held longer) — serializes concurrent creation attempts for
    -- the same calendar connection long enough for the full time-range
    -- overlap check below (not just an exact-start-time index) to be
    -- race-free. This is genuine overlap protection: two concurrent
    -- callers requesting 10:00-10:30 and 10:15-10:45 on the same
    -- connection can never both pass this check.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_calendar_connection_id::text, 0));

    IF EXISTS (
      SELECT 1 FROM public.bookings
      WHERE calendar_connection_id = p_calendar_connection_id
        AND status NOT IN ('CANCELLED', 'NO_SHOW', 'PAYMENT_EXPIRED', 'PAYMENT_FAILED')
        AND start_at < p_end_at
        AND end_at > p_start_at
    ) THEN
      RAISE EXCEPTION 'SLOT_NO_LONGER_AVAILABLE';
    END IF;
  END IF;

  INSERT INTO public.bookings (
    organization_id, business_id, calendar_connection_id, service_id,
    agent_config_id, contact_id, status, start_at, end_at, timezone,
    customer_name, customer_phone, customer_email, source,
    idempotency_key, hold_expires_at, call_id, notes
  ) VALUES (
    p_organization_id, p_business_id, p_calendar_connection_id, p_service_id,
    p_agent_config_id, p_contact_id, p_status, p_start_at, p_end_at, p_timezone,
    p_customer_name, p_customer_phone, p_customer_email, p_source,
    p_idempotency_key, p_hold_expires_at, p_call_id, p_notes
  )
  RETURNING * INTO v_booking;

  RETURN v_booking;
END;
$$;

REVOKE ALL ON FUNCTION public.create_booking_atomic FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_booking_atomic TO service_role;

-- create_booking_payment_hold keeps its exact original signature and
-- return shape — booking-service.server.ts's createPaymentRequiredBooking
-- (and its own tests) call it unchanged. It now delegates the actual
-- lock/idempotency/overlap/insert logic to create_booking_atomic instead
-- of duplicating it, fixing it at status = 'PENDING_PAYMENT' exactly as
-- before.
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
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.create_booking_atomic(
    p_organization_id, p_business_id, p_calendar_connection_id, p_service_id,
    p_agent_config_id, p_contact_id, p_start_at, p_end_at, p_timezone,
    p_customer_name, p_customer_phone, p_customer_email, p_source,
    p_idempotency_key, 'PENDING_PAYMENT', p_hold_expires_at, p_call_id, NULL
  );
$$;

REVOKE ALL ON FUNCTION public.create_booking_payment_hold FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_booking_payment_hold TO service_role;
