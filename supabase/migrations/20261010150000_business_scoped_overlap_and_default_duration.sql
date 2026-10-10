-- Part of the date-wise Appointment Slots feature: makes Google Calendar
-- optional for booking concurrency safety, and adds an owner-configurable
-- default appointment duration for the dashboard's slot preview.
--
-- 1. Overlap-check gap closed in create_booking_atomic, create_booking_
--    payment_hold, and reschedule_booking_atomic: every overlap/double-
--    booking check in these three functions was scoped to
--    `calendar_connection_id = <this booking's connection>`, guarded by
--    `IF p_calendar_connection_id IS NOT NULL THEN ... END IF` (or, in
--    create_booking_payment_hold's case, not even guarded — the lock and
--    WHERE clause both silently no-op on a NULL connection id, since
--    `pg_advisory_xact_lock` and `=` are both STRICT and NULL propagates
--    straight through). Either way, a booking with no Google Calendar
--    connection got ZERO double-booking protection: two concurrent
--    NULL-connection bookings for the same business/time-slot would both
--    succeed, because `calendar_connection_id = NULL` is never true in
--    SQL regardless of how many other NULL-connection bookings already
--    exist. This was always reachable for any business that uses the
--    AI/voice path without ever connecting Google Calendar; it becomes
--    the NORMAL case once Google Calendar is optional.
--
--    Fixed by rescoping every overlap check from calendar_connection_id to
--    business_id. This is not a weaker substitute — the rest of this
--    codebase already assumes at most one active Google Calendar
--    connection per business (resolveCalendarContext in calendar-tools.
--    server.ts reads google_calendar_connections with .maybeSingle(),
--    which itself assumes/enforces at most one row per business), so
--    calendar_connection_id has only ever been a round-about proxy for
--    "this business's schedule." business_id is the correct, strictly
--    safer generalization: it also catches a genuine but obscure gap the
--    old code had even WITH Google Calendar — a business that
--    reconnected a different Google account over time, leaving some
--    bookings pointing at an old, orphaned connection id and new ones at
--    a new connection id, would never have had those cross-checked for
--    overlap either. The existing per-connection advisory lock (salt 0)
--    is left in place and still acquired whenever a connection id is
--    present (it may still be useful for serializing Google Calendar API
--    calls), but the overlap check itself no longer depends on it —
--    serialization instead comes from the per-business advisory lock
--    (salt 1), which create_booking_atomic and reschedule_booking_atomic
--    already acquire earlier in the same transaction. create_booking_
--    payment_hold never acquired a business-level lock at all before this
--    migration; it now does, for the same reason.
--
-- 2. businesses.default_appointment_duration_minutes: an owner-configurable
--    fallback duration (minutes) used only by the dashboard's Appointment
--    Slots preview when no specific treatment/service is selected — e.g.
--    when the owner is just looking at "what slots exist today" rather
--    than availability for one particular service. The REAL booking path
--    (voice agent and dashboard booking creation) always uses the
--    selected service's own services.duration_minutes when one is
--    chosen, and this column is never consulted there — it exists solely
--    so the dashboard preview has a sensible default without duplicating
--    per-service duration configuration. Defaults to 30 (this repo's
--    existing implicit assumption elsewhere, e.g. DEFAULT_HOLD_DURATION_
--    MINUTES-adjacent booking flows), nullable-free so every business has
--    a well-defined preview duration from the moment this migration runs.
--
-- Deployment note: both changes are additive/backward compatible —
-- identical function signatures, identical behavior for every existing
-- case except the NULL-connection gap above (which never worked
-- correctly regardless), and a new column with a DEFAULT so no existing
-- row needs backfilling. Not applied to production by authoring this
-- file.

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

  PERFORM public.validate_booking_schedule(p_business_id, p_start_at, p_end_at, p_timezone);

  -- Per-connection lock kept for any Google Calendar API serialization
  -- value it may still have; no longer load-bearing for the overlap check
  -- below, which is scoped to business_id (see this migration's header).
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
    SELECT * INTO v_existing FROM public.bookings
      WHERE organization_id = p_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  -- NEW: this function never acquired a business-level lock before —
  -- only the per-connection one below, which (per this migration's header)
  -- silently did nothing for a NULL connection id. Added so the
  -- business_id-scoped overlap check below is actually serialized against
  -- concurrent callers, matching create_booking_atomic's own lock order.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_business_id::text, 1));

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

CREATE OR REPLACE FUNCTION public.reschedule_booking_atomic(
  p_organization_id UUID,
  p_booking_id UUID,
  p_new_start_at TIMESTAMPTZ,
  p_new_end_at TIMESTAMPTZ
)
RETURNS public.bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id UUID;
  v_booking public.bookings;
  v_timezone TEXT;
BEGIN
  SELECT business_id INTO v_business_id FROM public.bookings
    WHERE id = p_booking_id AND organization_id = p_organization_id;
  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'BOOKING_NOT_FOUND';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_business_id::text, 1));

  SELECT * INTO v_booking FROM public.bookings
    WHERE id = p_booking_id AND organization_id = p_organization_id
    FOR UPDATE;
  IF v_booking IS NULL THEN
    RAISE EXCEPTION 'BOOKING_NOT_FOUND';
  END IF;

  IF v_booking.status = 'PENDING_PAYMENT' THEN
    RAISE EXCEPTION 'BOOKING_PAYMENT_PENDING';
  END IF;
  IF v_booking.status IN ('CANCELLED', 'NO_SHOW', 'COMPLETED', 'PAYMENT_EXPIRED', 'PAYMENT_FAILED') THEN
    RAISE EXCEPTION 'BOOKING_NOT_RESCHEDULABLE';
  END IF;
  IF v_booking.business_id IS DISTINCT FROM v_business_id THEN
    RAISE EXCEPTION 'BOOKING_NOT_FOUND';
  END IF;

  SELECT timezone INTO v_timezone FROM public.businesses WHERE id = v_booking.business_id;

  PERFORM public.validate_booking_schedule(v_booking.business_id, p_new_start_at, p_new_end_at, v_timezone);

  IF v_booking.calendar_connection_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_booking.calendar_connection_id::text, 0));
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bookings
    WHERE business_id = v_booking.business_id
      AND id != v_booking.id
      AND status NOT IN ('CANCELLED', 'NO_SHOW', 'PAYMENT_EXPIRED', 'PAYMENT_FAILED')
      AND start_at < p_new_end_at
      AND end_at > p_new_start_at
  ) THEN
    RAISE EXCEPTION 'SLOT_NO_LONGER_AVAILABLE';
  END IF;

  UPDATE public.bookings
  SET start_at = p_new_start_at, end_at = p_new_end_at, status = 'RESCHEDULED'
  WHERE id = v_booking.id
  RETURNING * INTO v_booking;

  RETURN v_booking;
END;
$$;

REVOKE ALL ON FUNCTION public.reschedule_booking_atomic FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_booking_atomic TO service_role;

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS default_appointment_duration_minutes INTEGER NOT NULL DEFAULT 30
  CHECK (default_appointment_duration_minutes > 0);
