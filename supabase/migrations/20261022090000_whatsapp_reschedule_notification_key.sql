-- WhatsApp: one reschedule notification per move, including a move back to
-- an earlier time.
--
-- 20261020090000 keyed booking_rescheduled notifications by the NEW start
-- time only ('booking_rescheduled:<booking>:<new start>'), so a booking moved
-- A → B → C → B never got a notification for the last move: its key already
-- existed (ON CONFLICT DO NOTHING) and the customer's latest message said C.
--
-- The key now names the move and the transaction that made it:
--   'booking_rescheduled:<booking>:<old start>:<new start>:<txid>'
-- so every real move is enqueued, while a repeated UPDATE that doesn't change
-- start_at still enqueues nothing (the trigger only fires on a change). The
-- worker sends only the newest reschedule notification for a booking and
-- only while it still matches the booking's current time, so older ones that
-- happen to name the same time again are skipped, not sent twice.
--
-- Only the trigger function body changes (CREATE OR REPLACE; the trigger
-- itself is unchanged and stays bound to it). Additive, idempotent, no data
-- rewrite: existing whatsapp_notifications rows keep their keys. Safe to
-- apply whether or not 20261020090000 has already been applied in an
-- environment, as long as it is applied after it.
--
-- Rollback: re-run the whatsapp_booking_notification_trigger() definition
-- from 20261020090000 (code first, since the worker's newest-only rule works
-- with either key format).

CREATE OR REPLACE FUNCTION public.whatsapp_booking_notification_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active CONSTANT TEXT[] := ARRAY['CONFIRMED', 'RESCHEDULED', 'CALENDAR_SYNC_FAILED'];
  v_payload JSONB;
BEGIN
  IF NEW.customer_phone IS NULL OR btrim(NEW.customer_phone) = '' THEN
    RETURN NEW;
  END IF;
  v_payload := jsonb_build_object('start_at', NEW.start_at, 'end_at', NEW.end_at, 'status', NEW.status);

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = ANY (v_active) THEN
      PERFORM public.enqueue_whatsapp_notification(NEW.organization_id, NEW.business_id, NEW.id, NULL,
        'booking_confirmed', 'booking_confirmed:' || NEW.id, v_payload, interval '0');
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = ANY (v_active) AND OLD.status IN ('DRAFT', 'PENDING_CONFIRMATION') THEN
    PERFORM public.enqueue_whatsapp_notification(NEW.organization_id, NEW.business_id, NEW.id, NULL,
      'booking_confirmed', 'booking_confirmed:' || NEW.id, v_payload, interval '0');
  END IF;

  IF NEW.status = ANY (v_active) AND NEW.start_at IS DISTINCT FROM OLD.start_at
     AND OLD.status = ANY (v_active) THEN
    PERFORM public.enqueue_whatsapp_notification(NEW.organization_id, NEW.business_id, NEW.id, NULL,
      'booking_rescheduled',
      'booking_rescheduled:' || NEW.id
        || ':' || extract(epoch FROM OLD.start_at)::bigint
        || ':' || extract(epoch FROM NEW.start_at)::bigint
        || ':' || txid_current(),
      v_payload || jsonb_build_object('previous_start_at', OLD.start_at), interval '0');
  END IF;

  IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED'
     AND OLD.status IN ('CONFIRMED', 'RESCHEDULED', 'CALENDAR_SYNC_FAILED', 'PENDING_PAYMENT') THEN
    PERFORM public.enqueue_whatsapp_notification(NEW.organization_id, NEW.business_id, NEW.id, NULL,
      'booking_cancelled', 'booking_cancelled:' || NEW.id, v_payload, interval '0');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.whatsapp_booking_notification_trigger() FROM PUBLIC, anon, authenticated;
