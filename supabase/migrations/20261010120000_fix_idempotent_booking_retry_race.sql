-- Closes a genuine concurrency bug in create_booking_atomic
-- (20261009090000_atomic_booking_creation.sql, redefined by
-- 20261009120000_atomic_schedule_validation_and_locking.sql), found by a
-- real-PostgreSQL concurrency test (supabase/migrations/booking_concurrency.
-- pg.test.ts) added in the previous session: two genuinely concurrent calls
-- with the SAME (organization_id, idempotency_key) could both pass the
-- idempotency pre-check (`SELECT ... WHERE organization_id = ... AND
-- idempotency_key = ...`, which ran with no lock at all), both proceed to
-- the per-business and per-calendar-connection advisory locks, and the
-- loser would then fail the time-range overlap check against the winner's
-- own just-committed row and raise SLOT_NO_LONGER_AVAILABLE — instead of
-- the idempotent "return the existing booking" behavior the pre-check
-- exists to guarantee. A client that legitimately retries a request (e.g.
-- after a dropped response) could get a hard failure instead of its
-- original booking back.
--
-- Fix: acquire a NEW advisory lock scoped to (organization_id,
-- idempotency_key) — salt 2, a lock space distinct from the existing
-- per-business (salt 1) and per-calendar-connection (salt 0) locks, so it
-- never interacts with their fixed acquisition order — BEFORE the
-- idempotency SELECT, and only when an idempotency key was actually given
-- (NULL keys never go through the idempotency path at all, same as
-- before). This makes two concurrent callers with the same key fully
-- serialize: whichever reaches the lock first runs the entire function
-- (idempotency check -> schedule validation -> overlap check -> insert ->
-- commit) to completion before the second is even released to re-run its
-- own idempotency SELECT, which then correctly finds the first caller's
-- committed row and returns it. Different idempotency keys (or no key at
-- all) are completely unaffected — this lock is keyed on the exact
-- (organization_id, idempotency_key) pair, so unrelated concurrent
-- bookings are never serialized against each other by this change.
--
-- No deadlock risk introduced: this lock (salt 2) is always acquired
-- first, held only within this one function call, and never acquired by
-- any other function (apply_business_schedule_override, set_business_
-- weekly_hours, remove_business_schedule_override) — so it can never form
-- a cycle with the existing business-lock-before-connection-lock order.
--
-- Deployment note: this CREATE OR REPLACE is additive and backward
-- compatible — identical signature and return shape, identical behavior
-- for every case except the specific race above, which previously failed
-- a well-formed retry it should have satisfied. Not applied to production
-- by authoring this file.
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
    -- Serializes concurrent callers sharing the same (organization_id,
    -- idempotency_key) BEFORE either one checks for an existing row — see
    -- this migration's own header comment for why this specific ordering
    -- closes the race a later lock (taken only after the check) cannot.
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_organization_id::text || ':' || p_idempotency_key, 2)
    );

    SELECT * INTO v_existing FROM public.bookings
      WHERE organization_id = p_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- Per-business lock + schedule validation, unchanged from
  -- 20261009120000_atomic_schedule_validation_and_locking.sql.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_business_id::text, 1));

  PERFORM public.validate_booking_schedule(p_business_id, p_start_at, p_end_at, p_timezone);

  -- Per-calendar-connection lock + overlap check + insert, unchanged from
  -- 20261009090000_atomic_booking_creation.sql.
  IF p_calendar_connection_id IS NOT NULL THEN
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
