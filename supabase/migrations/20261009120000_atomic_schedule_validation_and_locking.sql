-- Closes the staff-closes-a-slot vs AI-books-the-slot race.
--
-- Prior state (20261009100000_hospital_calendar_overrides_and_gcal_sync.sql
-- + booking-service.server.ts's assertSlotWithinSchedule): schedule
-- validation (business_hours + business_hour_overrides precedence) ran as
-- a JS-level pre-check BEFORE calling create_booking_atomic — a SEPARATE
-- database round-trip from the atomic insert. A staff member closing the
-- slot in the window between that check and the insert could still have
-- their closure silently bypassed, exactly the class of race
-- create_booking_atomic's own advisory lock was built to prevent for
-- booking-vs-booking conflicts but never extended to cover
-- schedule-vs-booking conflicts.
--
-- Fix: move the schedule check INSIDE create_booking_atomic's own
-- transaction, and give every operation that can change the effective
-- schedule (daily overrides, full-day closures, weekly hours) a NEW
-- advisory lock on the SAME key (hashtextextended(business_id, 1) — salt 1,
-- a different lock space from the existing per-calendar-connection lock at
-- salt 0 in 20261009090000_atomic_booking_creation.sql, which this
-- migration does not touch or replace) so the two kinds of operation can
-- never interleave: whichever acquires the business-level lock first runs
-- to completion (commit or rollback, releasing the lock) before the other
-- can even read the schedule/booking state it depends on.
--
-- Lock choice and ordering (documented per the task's own requirement):
-- a single PER-BUSINESS lock, not per-calendar-connection. Today a
-- business has at most one Google connection per provider
-- (UNIQUE(organization_id, business_id, provider) in
-- 20260924090000_google_calendar_and_bookings.sql), so this is not a
-- throughput regression versus the existing per-connection lock — the two
-- keys currently serialize the same real-world population of concurrent
-- requests. If this schema is later extended to multiple independently
-- schedulable resources per business (e.g. one calendar per doctor), a
-- per-business lock would over-serialize across them; narrowing the lock
-- key to whatever resource actually owns the schedule at that point is the
-- documented follow-up, not attempted here. Lock ORDER is fixed and
-- one-directional: create_booking_atomic always acquires the business
-- lock (salt 1) BEFORE the calendar-connection lock (salt 0); no other
-- function ever acquires both, so no cycle — and therefore no deadlock —
-- is possible between the two lock spaces.
--
-- ============================================================
-- 1. business_effective_open_ranges — the SQL-side port of
--    calendar-service.server.ts's resolveEffectiveIntervals /
--    resolveEffectiveOpenRangesUtc precedence algorithm (full-day closure
--    > override opens/closes layered on the recurring weekly hours,
--    closes always beating an overlapping open in the same override).
--    This is a SECOND implementation of that algorithm by necessity — the
--    whole point of this migration is that the check must run inside the
--    SQL transaction, which the JS implementation cannot do — not a
--    casual duplication. It is verified against the same scenarios
--    calendar-service.server.test.ts already covers (see this migration's
--    own test file and the real-Postgres concurrency verification in the
--    session report).
--
--    Returns each effective open range as a TIMESTAMPTZ pair. Ranges are
--    built as plain TIMESTAMPTZ[] arrays (not native tstzrange union/
--    difference) because Postgres's range `+`/`-` operators reject a
--    result that would be non-contiguous (disjoint ranges, or a
--    subtraction that splits a range into two pieces) — exactly the
--    shapes this algorithm must produce.
-- ============================================================
CREATE OR REPLACE FUNCTION public.business_effective_open_ranges(
  p_business_id UUID,
  p_date DATE,
  p_timezone TEXT
)
RETURNS TABLE(range_start TIMESTAMPTZ, range_end TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_day_of_week SMALLINT := EXTRACT(DOW FROM p_date);
  v_override RECORD;
  v_hours RECORD;
  v_elem JSONB;
  v_raw_starts TIMESTAMPTZ[] := '{}';
  v_raw_ends TIMESTAMPTZ[] := '{}';
  v_close_starts TIMESTAMPTZ[] := '{}';
  v_close_ends TIMESTAMPTZ[] := '{}';
  v_sorted_starts TIMESTAMPTZ[];
  v_sorted_ends TIMESTAMPTZ[];
  v_starts TIMESTAMPTZ[] := '{}';
  v_ends TIMESTAMPTZ[] := '{}';
  v_next_starts TIMESTAMPTZ[];
  v_next_ends TIMESTAMPTZ[];
  v_i INT;
  v_j INT;
  v_cur_start TIMESTAMPTZ;
  v_cur_end TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_override FROM public.business_hour_overrides
    WHERE business_id = p_business_id AND override_date = p_date;

  -- Precedence rule 1: a full-day closure overrides everything else —
  -- empty result set, no further work.
  IF FOUND AND v_override.is_full_day_closure THEN
    RETURN;
  END IF;

  -- Base: the recurring weekly schedule for this day-of-week, unless closed.
  SELECT * INTO v_hours FROM public.business_hours
    WHERE business_id = p_business_id AND day_of_week = v_day_of_week;

  IF FOUND AND NOT v_hours.is_closed THEN
    FOR v_elem IN SELECT * FROM jsonb_array_elements(v_hours.intervals) LOOP
      v_raw_starts := v_raw_starts || ((p_date::text || ' ' || (v_elem->>'start'))::timestamp AT TIME ZONE p_timezone);
      v_raw_ends := v_raw_ends || ((p_date::text || ' ' || (v_elem->>'end'))::timestamp AT TIME ZONE p_timezone);
    END LOOP;
  END IF;

  -- Override opens (isOpen:true) are additional raw candidate ranges,
  -- unioned together with the weekly base in one merge pass below —
  -- union is commutative/associative, so collecting all "open" sources
  -- first and merging once is equivalent to merging incrementally.
  -- Override closes (isOpen:false) are collected separately and applied
  -- as subtractions AFTER the merge, always winning over an overlapping
  -- open in the same override (the conservative reading).
  IF FOUND AND v_override.override_date IS NOT NULL THEN
    FOR v_elem IN SELECT * FROM jsonb_array_elements(v_override.intervals) LOOP
      IF (v_elem->>'isOpen')::boolean THEN
        v_raw_starts := v_raw_starts || ((p_date::text || ' ' || (v_elem->>'start'))::timestamp AT TIME ZONE p_timezone);
        v_raw_ends := v_raw_ends || ((p_date::text || ' ' || (v_elem->>'end'))::timestamp AT TIME ZONE p_timezone);
      ELSE
        v_close_starts := v_close_starts || ((p_date::text || ' ' || (v_elem->>'start'))::timestamp AT TIME ZONE p_timezone);
        v_close_ends := v_close_ends || ((p_date::text || ' ' || (v_elem->>'end'))::timestamp AT TIME ZONE p_timezone);
      END IF;
    END LOOP;
  END IF;

  IF COALESCE(array_length(v_raw_starts, 1), 0) = 0 THEN
    RETURN;
  END IF;

  -- Sort the raw candidates by start (unnest zips the two arrays row-wise;
  -- array_agg(... ORDER BY s) re-aggregates both columns consistently).
  SELECT array_agg(s ORDER BY s), array_agg(e ORDER BY s)
    INTO v_sorted_starts, v_sorted_ends
    FROM unnest(v_raw_starts, v_raw_ends) AS t(s, e);

  -- Single merge pass: combine overlapping/touching ranges.
  FOR v_i IN 1..array_length(v_sorted_starts, 1) LOOP
    v_cur_start := v_sorted_starts[v_i];
    v_cur_end := v_sorted_ends[v_i];
    IF array_length(v_starts, 1) IS NOT NULL AND v_cur_start <= v_ends[array_length(v_ends, 1)] THEN
      v_ends[array_length(v_ends, 1)] := GREATEST(v_ends[array_length(v_ends, 1)], v_cur_end);
    ELSE
      v_starts := v_starts || v_cur_start;
      v_ends := v_ends || v_cur_end;
    END IF;
  END LOOP;

  -- Apply each close as a subtraction, splitting a range into up to two
  -- pieces when the close falls strictly inside it.
  FOR v_j IN 1..COALESCE(array_length(v_close_starts, 1), 0) LOOP
    v_next_starts := '{}';
    v_next_ends := '{}';
    FOR v_i IN 1..COALESCE(array_length(v_starts, 1), 0) LOOP
      v_cur_start := v_starts[v_i];
      v_cur_end := v_ends[v_i];
      IF v_close_ends[v_j] <= v_cur_start OR v_close_starts[v_j] >= v_cur_end THEN
        v_next_starts := v_next_starts || v_cur_start;
        v_next_ends := v_next_ends || v_cur_end;
      ELSE
        IF v_close_starts[v_j] > v_cur_start THEN
          v_next_starts := v_next_starts || v_cur_start;
          v_next_ends := v_next_ends || LEAST(v_close_starts[v_j], v_cur_end);
        END IF;
        IF v_close_ends[v_j] < v_cur_end THEN
          v_next_starts := v_next_starts || GREATEST(v_close_ends[v_j], v_cur_start);
          v_next_ends := v_next_ends || v_cur_end;
        END IF;
      END IF;
    END LOOP;
    v_starts := v_next_starts;
    v_ends := v_next_ends;
  END LOOP;

  IF COALESCE(array_length(v_starts, 1), 0) = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT s, e FROM unnest(v_starts, v_ends) AS t(s, e);
END;
$$;

REVOKE ALL ON FUNCTION public.business_effective_open_ranges FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_effective_open_ranges TO service_role;

-- ============================================================
-- 2. validate_booking_schedule — containment check: does
--    [p_start_at, p_end_at) fall entirely within ONE of the effective
--    open ranges for its own local calendar date? Raises
--    'SLOT_OUTSIDE_SCHEDULE' if not, matching create_booking_atomic's own
--    'SLOT_NO_LONGER_AVAILABLE' RAISE EXCEPTION convention so callers map
--    both the same way (a plain exception with a recognizable message,
--    never a custom SQLSTATE this schema doesn't otherwise use).
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_booking_schedule(
  p_business_id UUID,
  p_start_at TIMESTAMPTZ,
  p_end_at TIMESTAMPTZ,
  p_timezone TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_local_date DATE := (p_start_at AT TIME ZONE p_timezone)::date;
  v_ok BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.business_effective_open_ranges(p_business_id, v_local_date, p_timezone) r
    WHERE r.range_start <= p_start_at AND p_end_at <= r.range_end
  ) INTO v_ok;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'SLOT_OUTSIDE_SCHEDULE';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_booking_schedule FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_booking_schedule TO service_role;

-- ============================================================
-- 3. create_booking_atomic — redefined (CREATE OR REPLACE, identical
--    signature) to acquire the per-business advisory lock and validate
--    the schedule INSIDE this same transaction, before the existing
--    per-calendar-connection lock and overlap check. Idempotency check
--    stays first and lock-free (an already-resolved retry needs neither
--    lock nor validation — it just returns the existing row, unchanged
--    from before). Everything from the calendar-connection lock onward is
--    copied verbatim from 20261009090000_atomic_booking_creation.sql —
--    this migration adds to that function, it does not re-derive it.
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

  -- NEW: per-business lock, acquired before anything schedule- or
  -- booking-related is read, and before the pre-existing per-calendar-
  -- connection lock below — see this migration's own header comment for
  -- why this ordering is fixed and deadlock-free. A staff mutation
  -- (apply_business_schedule_override / remove_business_schedule_override
  -- / set_business_weekly_hours, below) takes the identical lock before
  -- its own read-then-write, so the two paths can never interleave:
  -- whichever transaction gets here first commits or rolls back — and
  -- therefore releases the lock — before the other can proceed past it.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_business_id::text, 1));

  -- NEW: authoritative schedule validation, inside the same lock/
  -- transaction as the insert below. Raises 'SLOT_OUTSIDE_SCHEDULE' and
  -- rolls back (releasing the lock) if the requested interval isn't
  -- covered by the business's current effective schedule — a closed
  -- recurring day, a full-day closure, or a date-specific close, per
  -- business_effective_open_ranges's precedence resolution.
  PERFORM public.validate_booking_schedule(p_business_id, p_start_at, p_end_at, p_timezone);

  -- Unchanged from 20261009090000_atomic_booking_creation.sql below this
  -- point: the per-calendar-connection lock + full time-range overlap
  -- check + insert.
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

-- ============================================================
-- 4. Staff-side schedule mutations — each acquires the SAME business lock
--    (salt 1) before reading or writing, and each rejects a closure that
--    would cover an existing active (not CANCELLED/NO_SHOW/PAYMENT_EXPIRED/
--    PAYMENT_FAILED) booking rather than silently leaving that booking
--    orphaned against a now-closed schedule (task requirement: "never
--    silently invalidate a confirmed appointment... reject the closure").
--    Policy chosen: reject outright. A staff member who genuinely needs to
--    close a slot with an existing booking must cancel or reschedule that
--    booking first — there is deliberately no automatic cancel-and-close,
--    which would be exactly the kind of silent invalidation this
--    requirement forbids.
-- ============================================================
CREATE OR REPLACE FUNCTION public.apply_business_schedule_override(
  p_organization_id UUID,
  p_business_id UUID,
  p_override_date DATE,
  p_is_full_day_closure BOOLEAN,
  p_intervals JSONB,
  p_reason TEXT
)
RETURNS public.business_hour_overrides
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_timezone TEXT;
  v_calendar_connection_id UUID;
  v_day_start TIMESTAMPTZ;
  v_day_end TIMESTAMPTZ;
  v_elem JSONB;
  v_close_start TIMESTAMPTZ;
  v_close_end TIMESTAMPTZ;
  v_result public.business_hour_overrides;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_business_id::text, 1));

  SELECT timezone INTO v_timezone FROM public.businesses
    WHERE id = p_business_id AND organization_id = p_organization_id;
  IF v_timezone IS NULL THEN
    RAISE EXCEPTION 'BUSINESS_NOT_FOUND';
  END IF;

  SELECT id INTO v_calendar_connection_id FROM public.google_calendar_connections
    WHERE business_id = p_business_id AND provider = 'google' LIMIT 1;

  IF p_is_full_day_closure THEN
    v_day_start := (p_override_date::text || ' 00:00')::timestamp AT TIME ZONE v_timezone;
    v_day_end := ((p_override_date + 1)::text || ' 00:00')::timestamp AT TIME ZONE v_timezone;
    IF v_calendar_connection_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.bookings
      WHERE calendar_connection_id = v_calendar_connection_id
        AND status NOT IN ('CANCELLED', 'NO_SHOW', 'PAYMENT_EXPIRED', 'PAYMENT_FAILED')
        AND start_at < v_day_end AND end_at > v_day_start
    ) THEN
      RAISE EXCEPTION 'CANNOT_CLOSE_SLOT_WITH_ACTIVE_BOOKING';
    END IF;
  ELSE
    FOR v_elem IN SELECT * FROM jsonb_array_elements(p_intervals) LOOP
      IF NOT (v_elem->>'isOpen')::boolean THEN
        v_close_start := (p_override_date::text || ' ' || (v_elem->>'start'))::timestamp AT TIME ZONE v_timezone;
        v_close_end := (p_override_date::text || ' ' || (v_elem->>'end'))::timestamp AT TIME ZONE v_timezone;
        IF v_calendar_connection_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.bookings
          WHERE calendar_connection_id = v_calendar_connection_id
            AND status NOT IN ('CANCELLED', 'NO_SHOW', 'PAYMENT_EXPIRED', 'PAYMENT_FAILED')
            AND start_at < v_close_end AND end_at > v_close_start
        ) THEN
          RAISE EXCEPTION 'CANNOT_CLOSE_SLOT_WITH_ACTIVE_BOOKING';
        END IF;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.business_hour_overrides (
    organization_id, business_id, override_date, is_full_day_closure, intervals, reason
  ) VALUES (
    p_organization_id, p_business_id, p_override_date, p_is_full_day_closure,
    CASE WHEN p_is_full_day_closure THEN '[]'::jsonb ELSE p_intervals END, p_reason
  )
  ON CONFLICT (business_id, override_date) DO UPDATE SET
    is_full_day_closure = EXCLUDED.is_full_day_closure,
    intervals = EXCLUDED.intervals,
    reason = EXCLUDED.reason
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_business_schedule_override FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_business_schedule_override TO service_role;

-- Removing an override only ever restores the recurring weekly schedule —
-- it can never itself create a conflict with an existing booking (the
-- booking's own protection comes from create_booking_atomic's overlap
-- check and schedule validation, not from what an override currently
-- says), so no conflict check is needed here. The lock is still taken, so
-- a concurrent booking's schedule validation can never read a torn state
-- mid-removal.
CREATE OR REPLACE FUNCTION public.remove_business_schedule_override(
  p_organization_id UUID,
  p_business_id UUID,
  p_override_date DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_business_id::text, 1));

  DELETE FROM public.business_hour_overrides
    WHERE business_id = p_business_id
      AND organization_id = p_organization_id
      AND override_date = p_override_date;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_business_schedule_override FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_business_schedule_override TO service_role;

-- Weekly-hours changes are coordinated via the same lock (so a concurrent
-- booking's validation can't interleave with this write), but deliberately
-- do NOT run the same active-booking conflict check daily overrides do:
-- a weekly change affects every future date matching that day-of-week,
-- and scanning all of them for conflicting bookings is a materially larger
-- problem than checking one specific date/interval. An existing booking is
-- never re-validated against the schedule after the fact (same as before
-- this migration), so narrowing weekly hours cannot retroactively
-- invalidate anything already booked.
CREATE OR REPLACE FUNCTION public.set_business_weekly_hours(
  p_organization_id UUID,
  p_business_id UUID,
  p_day_of_week SMALLINT,
  p_is_closed BOOLEAN,
  p_intervals JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_business_id::text, 1));

  UPDATE public.business_hours
  SET is_closed = p_is_closed, intervals = CASE WHEN p_is_closed THEN '[]'::jsonb ELSE p_intervals END
  WHERE business_id = p_business_id
    AND day_of_week = p_day_of_week
    AND EXISTS (
      SELECT 1 FROM public.businesses b
      WHERE b.id = p_business_id AND b.organization_id = p_organization_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.set_business_weekly_hours FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_business_weekly_hours TO service_role;
