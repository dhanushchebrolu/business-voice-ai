-- Crash-safe, fenced claims for telephony webhook events (outbound audit F1).
--
-- Before: the telephony route inserted the webhook_events row (unique per
-- provider + event_id) and only an event whose processing RECORDED an error
-- could be claimed again. A Worker that died mid-processing left processed_at
-- and error both NULL, so every redelivery was a "duplicate" and the
-- reconciler / operator resolution (same key) failed with "already
-- recorded": the call stayed `initiated` forever, holding its number and
-- wallet reservations.
--
-- Now an event is claimed with a lease and a token:
--
--   claim_webhook_event   inserts the row as claimed, or takes over an
--                         unfinished one whose claim expired (or that recorded
--                         an error), with a NEW token; one winner under
--                         concurrency. Returns claimed / processed /
--                         in_progress / exhausted. _max_attempts caps
--                         automatic retries (NULL = no cap, for operators).
--   apply_call_event_fenced  the call-status write of a claimed event, done
--                         only while the caller's token still holds the event
--                         (share lock on the event row, so a takeover waits
--                         for this write), and never over a final status.
--                         A processor that lost its claim applies nothing.
--   completion / failure  plain updates matching the token (application code).
--
-- Billing stays fenced by the finalization lease (claim_call_finalization /
-- apply_call_billing) and debit_wallet_for_call's per-call check.
--
-- Shared table: WhatsApp (vobiz_whatsapp), Instagram, Razorpay, LiveKit and
-- voice-agent rows never call these functions; their new columns stay at the
-- defaults (NULL / 0) and their behaviour is unchanged. Rows stuck before this
-- migration (claimed_at NULL) count as claimed at created_at, so they become
-- recoverable once older than the lease. Payloads are unchanged: the caller
-- passes the same identifiers-only payload as before.
--
-- Additive: two nullable columns, one defaulted column (no rewrite), two
-- functions. Rollback:
-- docs/production-rollback-20261126090000-webhook-event-claim-lease.sql

ALTER TABLE public.webhook_events
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.claim_webhook_event(
  _provider text,
  _event_id text,
  _event_type text,
  _payload jsonb,
  _lease_seconds integer,
  _max_attempts integer
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  token uuid := gen_random_uuid();
  inserted integer;
  attempt integer;
  r record;
BEGIN
  IF _provider IS NULL OR _event_id IS NULL OR _event_id = '' THEN
    RAISE EXCEPTION 'provider and event id are required';
  END IF;
  IF _lease_seconds IS NULL OR _lease_seconds < 10 OR _lease_seconds > 900 THEN
    RAISE EXCEPTION 'lease must be between 10 and 900 seconds';
  END IF;

  INSERT INTO public.webhook_events (provider, event_id, event_type, payload, claim_token, claimed_at, attempts)
  VALUES (_provider, _event_id, _event_type, COALESCE(_payload, '{}'::jsonb), token, clock_timestamp(), 1)
  ON CONFLICT (provider, event_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 1 THEN
    RETURN jsonb_build_object('result', 'claimed', 'token', token, 'attempt', 1, 'reclaimed', false);
  END IF;

  -- Take over an unfinished event: its processing recorded an error, or its
  -- claim is older than the lease (the processor died or is far too slow).
  -- The row lock makes concurrent takeovers serial; the loser re-checks the
  -- condition against the winner's fresh claimed_at and gets nothing.
  UPDATE public.webhook_events
     SET claim_token = token,
         claimed_at = clock_timestamp(),
         attempts = attempts + 1,
         error = NULL
   WHERE provider = _provider
     AND event_id = _event_id
     AND processed_at IS NULL
     AND (error IS NOT NULL
          OR COALESCE(claimed_at, created_at) < clock_timestamp() - make_interval(secs => _lease_seconds))
     AND (_max_attempts IS NULL OR attempts < _max_attempts)
  RETURNING attempts INTO attempt;
  IF FOUND THEN
    RETURN jsonb_build_object('result', 'claimed', 'token', token, 'attempt', attempt, 'reclaimed', true);
  END IF;

  SELECT processed_at, error, attempts INTO r FROM public.webhook_events
   WHERE provider = _provider AND event_id = _event_id;
  IF r.processed_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'processed');
  END IF;
  IF _max_attempts IS NOT NULL AND r.attempts >= _max_attempts THEN
    RETURN jsonb_build_object('result', 'exhausted', 'attempts', r.attempts, 'error', r.error);
  END IF;
  RETURN jsonb_build_object('result', 'in_progress', 'attempts', r.attempts);
END; $$;

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

REVOKE ALL ON FUNCTION public.claim_webhook_event(text, text, text, jsonb, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_webhook_event(text, text, text, jsonb, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.apply_call_event_fenced(text, text, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_call_event_fenced(text, text, uuid, uuid, jsonb) TO service_role;
