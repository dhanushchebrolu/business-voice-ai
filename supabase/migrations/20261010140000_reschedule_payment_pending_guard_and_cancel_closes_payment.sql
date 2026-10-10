-- Closes two real gaps found by an adversarial review of
-- 20261010130000_atomic_reschedule_and_cancel.sql:
--
-- 1. reschedule_booking_atomic had no guard against rescheduling a
--    PENDING_PAYMENT booking (a payment hold awaiting capture). Its
--    exclusion list (CANCELLED, NO_SHOW, COMPLETED, PAYMENT_EXPIRED,
--    PAYMENT_FAILED) did not include PENDING_PAYMENT, so a reschedule
--    call would silently overwrite status to RESCHEDULED while leaving
--    hold_expires_at untouched. Consequences, both confirmed by reading
--    the actual consumers rather than assumed:
--      - src/lib/payments/payment-expiration.server.ts's sweep only ever
--        finds candidates via `.eq("status", "PENDING_PAYMENT")` — a
--        RESCHEDULED booking becomes permanently invisible to it, so an
--        unpaid hold that got rescheduled would occupy its slot forever
--        with no payment ever required.
--      - src/lib/payments/payment-calendar-consumer.server.ts's
--        PaymentCaptured consumer only confirms a booking and creates its
--        Google event when `booking.status === "PENDING_PAYMENT"`
--        (handlePaymentCapturedForCalendar's own duplicate-webhook
--        guard). If the customer then actually pays after the booking
--        was rescheduled, payment_requests.status still flips to
--        CAPTURED (that write is unconditional on booking status — see
--        payment-webhook.server.ts), but this consumer silently no-ops:
--        money is captured, the booking is stuck in RESCHEDULED forever,
--        and no calendar event is ever created.
--
--    There is no existing product flow that relies on rescheduling a
--    payment hold — the deferred-calendar-event design assumes a
--    PENDING_PAYMENT booking transitions only to CONFIRMED (captured) or
--    PAYMENT_EXPIRED (swept) — so the correct rule, per the task's own
--    instruction to prefer explicit rejection absent a clear supporting
--    flow, is: reject outright, with a distinct, stable error code so
--    the caller (and the end user, through it) can tell this apart from
--    "not reschedulable at all" (RAISE 'BOOKING_PAYMENT_PENDING', mapped
--    in booking-service.server.ts to BookingError code
--    "PAYMENT_PENDING"). The booking's original status, slot, and
--    hold_expires_at are left completely untouched on rejection — the
--    whole function is one transaction, and RAISE EXCEPTION rolls back
--    everything before any UPDATE runs.
--
-- 2. cancel_booking_atomic cancelled the booking but never touched its
--    payment_requests row(s). The payment_requests.status CHECK
--    constraint itself (20260926090000_customer_payments.sql) documents
--    a CANCELLED value specifically for this: "the underlying booking
--    was cancelled before payment" — but no code anywhere ever actually
--    wrote it (confirmed: no `.update({status: "CANCELLED"})` on
--    payment_requests exists in this codebase before this migration).
--    Left as-is, a cancelled booking's payment_requests row stays
--    CREATED/PENDING — still payable on Razorpay's side — and
--    payment-webhook.server.ts's CAPTURED-transition guard
--    (`.neq("status", "CAPTURED")`, not `.in("status", ["CREATED",
--    "PENDING"])` the way its own EXPIRED/CANCELLED branch does) would
--    still let a late capture flip it straight to CAPTURED even though
--    the booking is dead. Fixed in both places: cancel_booking_atomic
--    now closes any CREATED/PENDING payment_requests row for the booking
--    it cancels (same transaction — atomic with the booking cancel, no
--    separate round trip, no window where one is done and the other
--    isn't), and payment-webhook.server.ts's CAPTURED guard (a plain TS
--    change, not SQL) is tightened to match its own EXPIRED/CANCELLED
--    branch's `.in("status", ["CREATED", "PENDING"])`, so a request this
--    migration (or the expiration sweep) has already closed can never be
--    captured after the fact.
--
-- 3. cancel_booking_atomic's only idempotent short-circuit was for
--    status = 'CANCELLED'. A booking the expiration sweep
--    (payment-expiration.server.ts) has already moved to PAYMENT_EXPIRED —
--    concurrently, or simply before a stale dashboard view's cancel button
--    is clicked — would fall through that check and get silently
--    overwritten back to CANCELLED, even though its payment_requests row
--    is already correctly EXPIRED (no payment-side inconsistency, but the
--    booking record loses the distinction between "the hold timed out
--    unpaid" and "staff cancelled it"). Fixed by widening the short-circuit
--    to the same CANCELLED/PAYMENT_EXPIRED/PAYMENT_FAILED grouping already
--    used three times elsewhere in this exact file (reschedule's own
--    exclusion list, and both overlap checks) — cancelling an
--    already-PAYMENT_EXPIRED (or, for consistency, PAYMENT_FAILED) booking
--    is now a no-op that returns the booking unchanged, exactly like
--    cancelling an already-CANCELLED one. Safe for every caller:
--    cancelBooking() in booking-service.server.ts only ever acts on the
--    returned row's google_event_id, which is null for a booking that was
--    never confirmed (the deferred-calendar-event design never creates an
--    event for a PENDING_PAYMENT/PAYMENT_EXPIRED booking), so returning it
--    unchanged triggers no calendar deletion attempt either way.
--
-- Deployment note: all three changes are CREATE OR REPLACE on functions
-- that have never been applied to any real database (20261010130000
-- itself was never deployed) — not a rewrite of deployed behavior. Not
-- applied to production by authoring this file.

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

  -- NEW: a payment hold must be paid or explicitly cancelled before it
  -- can move — see this migration's header comment for exactly why
  -- silently allowing this breaks both the expiration sweep and the
  -- payment-capture consumer. Checked separately from, and before, the
  -- generic terminal-status list below so the caller gets a distinct,
  -- actionable error rather than a generic "not reschedulable".
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

  -- NEW: PAYMENT_EXPIRED/PAYMENT_FAILED are also terminal, already-dead
  -- states (same grouping used three times elsewhere in this file, e.g.
  -- reschedule's own exclusion list and the overlap check) — not just
  -- CANCELLED. Without this, a booking the expiration sweep concurrently
  -- moved to PAYMENT_EXPIRED (payment-expiration.server.ts) falls through
  -- to the UPDATE below and gets silently overwritten to CANCELLED, even
  -- though its payment_requests row is already correctly EXPIRED — losing
  -- the distinction between "the hold timed out" and "staff cancelled it"
  -- with no payment-side inconsistency to show for it. Reachable any time
  -- staff cancels a booking whose hold expired moments earlier (the sweep
  -- runs periodically; the dashboard view can be stale by that long).
  IF v_booking.status IN ('CANCELLED', 'PAYMENT_EXPIRED', 'PAYMENT_FAILED') THEN
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

  -- NEW: close any still-open payment request for this booking in the
  -- SAME transaction as the cancellation — atomic, no window where the
  -- booking is cancelled but its payment request is still payable. Only
  -- ever narrows CREATED/PENDING to CANCELLED; a request that already
  -- reached CAPTURED/FAILED/EXPIRED (or was already CANCELLED) is never
  -- touched. Matches payment_requests.status's own CHECK-constraint
  -- comment ("CANCELLED: the underlying booking was cancelled before
  -- payment") — a value that existed in the schema but no code path ever
  -- actually wrote before this migration.
  UPDATE public.payment_requests
  SET status = 'CANCELLED'
  WHERE booking_id = v_booking.id
    AND status IN ('CREATED', 'PENDING');

  RETURN v_booking;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_booking_atomic FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking_atomic TO service_role;
