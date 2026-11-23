-- Rollback for 20261128090000_call_billing_hold.sql.
-- 1. Deploy the previous Worker FIRST (the new code writes billing_hold and
--    calls verify_call_duration).
-- 2. Held calls lose their hold with the column, after which a finalization
--    retry would bill them at 0 minutes. Resolve them first; this must be 0:
--      SELECT count(*) FROM public.call_logs WHERE billing_hold IS NOT NULL;
-- Restores apply_call_billing (20261110090000) and apply_call_event_fenced
-- (20261126090000) exactly, and drops verify_call_duration and the column.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.call_logs WHERE billing_hold IS NOT NULL) THEN
    RAISE EXCEPTION 'Calls are on billing hold; verify or resolve them before rolling back.';
  END IF;
END $$;

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
  SELECT id, organization_id, finalization_lease_token, finalization_lease_expires_at, billing_applied_at
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
  -- Only the columns applyCallEvent writes; anything else is a programming error, never dropped silently.
  SELECT string_agg(k, ', ') INTO extra FROM jsonb_object_keys(_patch) k
   WHERE k NOT IN ('status', 'provider_metadata', 'final_agent_variables', 'resolution_source',
                   'answered_at', 'recording_url', 'failure_reason', 'transcript',
                   'ended_at', 'duration_seconds');
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'apply_call_event_fenced: unsupported column(s) %', extra;
  END IF;

  -- The fence: this caller's claim must still be the current one. FOR SHARE
  -- holds off a takeover (claim_webhook_event's UPDATE) until this commits.
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
  -- Never overwrite a final status (a webhook, an operator or another claimant won).
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
         duration_seconds = nxt.duration_seconds
   WHERE id = _call;
  RETURN 'applied';
END; $$;

DROP FUNCTION IF EXISTS public.verify_call_duration(uuid, integer);
DROP INDEX IF EXISTS public.idx_call_logs_billing_hold;
ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_billing_hold_check;
ALTER TABLE public.call_logs DROP COLUMN IF EXISTS billing_hold;
COMMIT;
