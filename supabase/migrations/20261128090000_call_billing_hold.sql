-- Billing hold for a connected Sarvam outbound call whose duration is unknown
-- (outbound audit F3; policy approved 2026-11-22).
--
-- Before: a `connected` result with a missing or invalid duration was billed
-- as 0 minutes and the call was marked done.
-- Now:
--   call_logs.billing_hold = 'duration_unknown' is written with the final
--   status. While it is set, nothing bills the call: apply_call_billing
--   refuses (a safety net under the application, which never asks), so
--   finalization stays `failed` with a clear error, is not retried by the
--   sweep, and is listed in Calls -> Needs review. Its wallet reservation
--   stays in force: admission already reserves for every outbound call whose
--   billing is not applied and whose finalization is pending or failed
--   (20261121090000), at any age.
--   verify_call_duration records a duration verified from Sarvam's analytics
--   or by an operator, clears the hold once (a conditional update, so
--   concurrent verifiers cannot both win) and sets finalization back to
--   pending; finalization then bills it exactly once, at most the admission
--   reservation (billing_cap_minutes x billing_rate_per_minute).
--   apply_call_event_fenced (20261126090000) may now write billing_hold.
--
-- Nothing invents a duration; a call that cannot be verified stays held for
-- manual review. Existing rows: the column is NULL (no hold), nothing changes.
--
-- Rollback: docs/production-rollback-20261128090000-call-billing-hold.sql
-- (resolve held calls first: the precheck there counts them).

ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS billing_hold text;
ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_billing_hold_check;
ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_billing_hold_check
  CHECK (billing_hold IS NULL OR billing_hold = 'duration_unknown');

CREATE INDEX IF NOT EXISTS idx_call_logs_billing_hold
  ON public.call_logs (started_at) WHERE billing_hold IS NOT NULL;

-- Customers see "charge pending" for their own held calls (call_logs is read
-- through column grants; this column carries no provider data).
GRANT SELECT (billing_hold) ON public.call_logs TO authenticated;

-- The billing step, unchanged except that a held call is never billed.
CREATE OR REPLACE FUNCTION public.apply_call_billing(
  _call uuid,
  _token uuid,
  _amount integer,
  _provider_cost integer,
  _currency text,
  _minutes integer,
  _description text
)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  c record;
BEGIN
  IF _amount IS NULL OR _amount < 0 OR _provider_cost IS NULL OR _provider_cost < 0
     OR _minutes IS NULL OR _minutes < 0 THEN
    RAISE EXCEPTION 'billing amounts must be non-negative';
  END IF;
  SELECT id, organization_id, finalization_lease_token, finalization_lease_expires_at,
         billing_applied_at, billing_hold
    INTO c FROM public.call_logs WHERE id = _call FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'call % not found', _call;
  END IF;
  IF c.finalization_lease_token IS DISTINCT FROM _token
     OR c.finalization_lease_expires_at IS NULL
     OR c.finalization_lease_expires_at <= clock_timestamp() THEN
    RETURN 'lease_lost';
  END IF;
  IF c.billing_applied_at IS NOT NULL THEN
    RETURN 'already';
  END IF;
  IF c.billing_hold IS NOT NULL THEN
    RAISE EXCEPTION 'BILLING_ON_HOLD: call % (%): verify the duration before billing', _call, c.billing_hold;
  END IF;

  PERFORM public.debit_wallet_for_call(c.organization_id, _call, _amount, _description);
  IF _minutes > 0 THEN
    PERFORM public.record_call_usage(
      c.organization_id, _call, 'call', 'telephony', _minutes, 'minute', _provider_cost, _amount
    );
  END IF;
  UPDATE public.call_logs
  SET customer_charge = _amount,
      provider_cost = _provider_cost,
      currency = _currency,
      billing_applied_at = clock_timestamp()
  WHERE id = _call;
  RETURN 'applied';
END;
$$;

-- Records a verified duration for a held call and releases the hold, once.
-- Returns 'verified', or 'not_on_hold' (already verified / billed / not held).
CREATE OR REPLACE FUNCTION public.verify_call_duration(_call uuid, _seconds integer)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF _seconds IS NULL OR _seconds < 1 OR _seconds > 86400 THEN
    RAISE EXCEPTION 'a verified duration must be between 1 and 86400 seconds';
  END IF;
  UPDATE public.call_logs
  SET duration_seconds = _seconds,
      billing_hold = NULL,
      finalization_state = 'pending',
      finalization_error = NULL,
      finalization_next_at = clock_timestamp()
  WHERE id = _call
    AND billing_hold = 'duration_unknown'
    AND billing_applied_at IS NULL
    AND status = 'completed';
  RETURN CASE WHEN FOUND THEN 'verified' ELSE 'not_on_hold' END;
END;
$$;

-- The fenced status write (20261126090000), now also writing billing_hold.
CREATE OR REPLACE FUNCTION public.apply_call_event_fenced(
  _provider text,
  _event_id text,
  _token uuid,
  _call uuid,
  _patch jsonb
) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  cur public.call_logs;
  nxt public.call_logs;
  extra text;
BEGIN
  SELECT string_agg(k, ', ') INTO extra FROM jsonb_object_keys(_patch) k
   WHERE k NOT IN ('status', 'provider_metadata', 'final_agent_variables', 'resolution_source',
                   'answered_at', 'recording_url', 'failure_reason', 'transcript',
                   'ended_at', 'duration_seconds', 'billing_hold');
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'apply_call_event_fenced: unsupported column(s) %', extra;
  END IF;

  PERFORM 1 FROM public.webhook_events
   WHERE provider = _provider AND event_id = _event_id
     AND claim_token = _token AND processed_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN 'claim_lost';
  END IF;

  SELECT * INTO cur FROM public.call_logs WHERE id = _call FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'call % not found', _call;
  END IF;
  IF cur.status IN ('completed', 'failed', 'busy', 'no_answer', 'cancelled') THEN
    RETURN 'already_final';
  END IF;

  nxt := jsonb_populate_record(cur, _patch);
  UPDATE public.call_logs
     SET status = nxt.status,
         provider_metadata = nxt.provider_metadata,
         final_agent_variables = nxt.final_agent_variables,
         resolution_source = nxt.resolution_source,
         answered_at = nxt.answered_at,
         recording_url = nxt.recording_url,
         failure_reason = nxt.failure_reason,
         transcript = nxt.transcript,
         ended_at = nxt.ended_at,
         duration_seconds = nxt.duration_seconds,
         billing_hold = nxt.billing_hold
   WHERE id = _call;
  RETURN 'applied';
END; $$;

REVOKE ALL ON FUNCTION public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.verify_call_duration(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_call_duration(uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.apply_call_event_fenced(text, text, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_call_event_fenced(text, text, uuid, uuid, jsonb) TO service_role;
