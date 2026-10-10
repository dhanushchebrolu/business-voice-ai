-- Gives rescheduleBooking() and cancelBooking() (booking-service.server.ts)
-- the same atomic, lock-protected treatment create_booking_atomic already
-- has for creation — closing the documented residual gap from
-- 20261009120000_atomic_schedule_validation_and_locking.sql's own header
-- comment ("rescheduleBooking() ... updates an existing row via its own
-- direct conflict check ... reschedule-vs-closure races are a known,
-- documented, OUT-OF-SCOPE residual gap").
--
-- Prior state: rescheduleBooking() did a plain SELECT (no lock) to read
-- the booking, a separate JS-level schedule check (assertSlotWithinSchedule,
-- itself another DB round-trip), a separate JS-level overlap SELECT (no
-- lock), then a final UPDATE — four separate statements/round-trips, none
-- holding any lock across the others. That left multiple real races open:
--   1. Two concurrent reschedules of DIFFERENT bookings into the same
--      destination slot could both pass their own overlap SELECT before
--      either UPDATE committed, and both succeed (true double-booking).
--   2. A reschedule and a business-hours closure (apply_business_schedule_
--      override / set_business_weekly_hours) racing could both succeed,
--      leaving a confirmed booking inside a now-closed period.
--   3. cancelBooking()'s own plain SELECT-then-UPDATE could delete (or
--      fail to delete) the right Google Calendar event based on a stale
--      google_event_id read if a concurrent operation changed the row
--      in between.
--
-- Fix: two new SECURITY DEFINER functions, reschedule_booking_atomic and
-- cancel_booking_atomic, each wrapping the read-check-write sequence in
-- ONE transaction with the SAME lock order create_booking_atomic already
-- established (per-business advisory lock, salt 1, before per-calendar-
-- connection advisory lock, salt 0) plus a `SELECT ... FOR UPDATE` row
-- lock on the booking itself. Using the identical salts and identical
-- "business lock before connection lock" order as create_booking_atomic
-- means reschedule can never interleave with booking creation or with a
-- staff schedule mutation, and can never deadlock against them (the two
-- functions never acquire the same two locks in reverse order).
--
-- cancel_booking_atomic does NOT take the business advisory lock — it
-- never reads or depends on the effective schedule, only the booking row
-- itself, and Postgres's own row-level locking (SELECT ... FOR UPDATE)
-- already serializes it against reschedule_booking_atomic's FOR UPDATE on
-- the same row with no risk of deadlocking against the business lock,
-- since cancel never waits on that lock at all.
--
-- Booking invariants preserved regardless of which concurrent operation
-- wins, by construction:
--   - A cancelled booking is never "resurrected" by reschedule: reschedule
--     re-reads status AFTER acquiring the row lock and rejects anything
--     not in an active, reschedulable state.
--   - A reschedule never partially applies: the whole function is one
--     transaction, so any RAISE EXCEPTION rolls back the entire attempt,
--     leaving the booking's original valid slot completely untouched.
--   - Cancelling an already-cancelled booking is a no-op (idempotent),
--     not an error — matching the existing idempotent-retry philosophy
--     elsewhere in this schema.
--   - Organization ownership is re-checked against the authoritative row
--     under lock, not trusted from an earlier, unlocked read.
--
-- Deployment note: purely additive (two new functions); does not alter or
-- replace anything create_booking_atomic itself does. Not applied to
-- production by authoring this file.

-- ============================================================
-- reschedule_booking_atomic
-- ============================================================
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
  -- Cheap lookup (no lock) of just the business_id, purely to know which
  -- advisory lock to acquire next. Re-verified in full immediately below
  -- once the lock is actually held — this value is never trusted past
  -- this point.
  SELECT business_id INTO v_business_id FROM public.bookings
    WHERE id = p_booking_id AND organization_id = p_organization_id;
  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'BOOKING_NOT_FOUND';
  END IF;

  -- Same salt/order as create_booking_atomic: business lock (1) before
  -- connection lock (0) — see this migration's header comment.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_business_id::text, 1));

  -- Re-read the authoritative row now that the business lock is held, AND
  -- take a row lock on it — the row's business_id, status, or calendar_
  -- connection_id may have changed between the lookup above and acquiring
  -- the lock, and this is also what serializes against a concurrent
  -- cancel_booking_atomic on the exact same row.
  SELECT * INTO v_booking FROM public.bookings
    WHERE id = p_booking_id AND organization_id = p_organization_id
    FOR UPDATE;
  IF v_booking IS NULL THEN
    RAISE EXCEPTION 'BOOKING_NOT_FOUND';
  END IF;
  IF v_booking.status IN ('CANCELLED', 'NO_SHOW', 'COMPLETED', 'PAYMENT_EXPIRED', 'PAYMENT_FAILED') THEN
    RAISE EXCEPTION 'BOOKING_NOT_RESCHEDULABLE';
  END IF;
  -- The business_id this lock was taken for must still match the
  -- currently-locked row's business_id — guards against the vanishingly
  -- unlikely case where it changed between the unlocked lookup and here
  -- (no code path does this today, but the check is free and exact).
  IF v_booking.business_id IS DISTINCT FROM v_business_id THEN
    RAISE EXCEPTION 'BOOKING_NOT_FOUND';
  END IF;

  SELECT timezone INTO v_timezone FROM public.businesses WHERE id = v_booking.business_id;

  -- Authoritative schedule validation, inside the same lock/transaction —
  -- identical call create_booking_atomic makes, so a staff closure racing
  -- this reschedule can never both succeed.
  PERFORM public.validate_booking_schedule(v_booking.business_id, p_new_start_at, p_new_end_at, v_timezone);

  IF v_booking.calendar_connection_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_booking.calendar_connection_id::text, 0));

    IF EXISTS (
      SELECT 1 FROM public.bookings
      WHERE calendar_connection_id = v_booking.calendar_connection_id
        AND id != v_booking.id
        AND status NOT IN ('CANCELLED', 'NO_SHOW', 'PAYMENT_EXPIRED', 'PAYMENT_FAILED')
        AND start_at < p_new_end_at
        AND end_at > p_new_start_at
    ) THEN
      RAISE EXCEPTION 'SLOT_NO_LONGER_AVAILABLE';
    END IF;
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

-- ============================================================
-- cancel_booking_atomic
-- ============================================================
CREATE OR REPLACE FUNCTION public.cancel_booking_atomic(
  p_organization_id UUID,
  p_booking_id UUID,
  p_reason TEXT
)
RETURNS public.bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_booking public.bookings;
  v_notes TEXT;
BEGIN
  SELECT * INTO v_booking FROM public.bookings
    WHERE id = p_booking_id AND organization_id = p_organization_id
    FOR UPDATE;
  IF v_booking IS NULL THEN
    RAISE EXCEPTION 'BOOKING_NOT_FOUND';
  END IF;

  -- Idempotent: cancelling an already-cancelled booking is a no-op, not
  -- an error — matches the idempotent-retry philosophy used elsewhere in
  -- this schema (create_booking_atomic's own idempotency-key handling).
  IF v_booking.status = 'CANCELLED' THEN
    RETURN v_booking;
  END IF;

  v_notes := CASE
    WHEN p_reason IS NOT NULL THEN
      trim(both E'\n' FROM COALESCE(v_booking.notes || E'\n', '') || 'Cancelled: ' || p_reason)
    ELSE v_booking.notes
  END;

  UPDATE public.bookings
  SET status = 'CANCELLED', notes = v_notes
  WHERE id = v_booking.id
  RETURNING * INTO v_booking;

  RETURN v_booking;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_booking_atomic FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking_atomic TO service_role;
