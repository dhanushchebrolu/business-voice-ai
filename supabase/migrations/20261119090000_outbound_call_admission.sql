-- Atomic admission for single (non-campaign) Sarvam outbound calls.
--
-- Before this, the per-customer limits and the wallet check were reads in the
-- application before a plain INSERT, so simultaneous requests could all pass.
-- admit_single_outbound_call does every check and the reservation in ONE
-- transaction, holding the organization's row lock (the same lock
-- debit_wallet_for_call and wallet_can_afford take), so admissions for one
-- customer are serialized across every Worker instance:
--
--   1. idempotency: a key already used by this customer returns that call
--      ('duplicate'); nothing new is written or dialled;
--   2. the number must belong to the customer;
--   3. limits over the customer's SINGLE calls (campaign_id IS NULL):
--      not yet final (24 h window), started in the last hour, started in the
--      last 24 h, and to this destination in the last 24 h;
--   4. the wallet must hold one minute for this call plus one per call not
--      yet final (the existing "first minute must be covered" rule, extended
--      to calls still in progress, which are billed only when they end);
--   5. the call_logs row is inserted as `initiated` (the reservation). The
--      existing idx_call_logs_sarvam_outbound_number_reservation still allows
--      only one unresolved call per destination ('destination_busy').
--
-- The reservation is released by the call's own lifecycle: a definite start
-- failure marks it `failed` (no charge); an ambiguous one `outcome_unknown`
-- (held, never retried); the result webhook or reconciliation makes it final.
-- Nothing here dials or debits.
--
-- Rollback: docs/production-rollback-20261119090000-outbound-call-admission.sql

ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS idempotency_key text;

ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_idempotency_key_format;
ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_idempotency_key_format
  CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,100}$');

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_logs_org_idempotency_key
  ON public.call_logs (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The limit counts: one customer's recent single outbound calls.
CREATE INDEX IF NOT EXISTS idx_call_logs_single_outbound_recent
  ON public.call_logs (organization_id, started_at)
  WHERE direction = 'outbound' AND campaign_id IS NULL;

CREATE OR REPLACE FUNCTION public.admit_single_outbound_call(
  _org uuid,
  _phone_number_id uuid,
  _destination text,
  _caller_number text,
  _idempotency_key text,
  _max_in_flight integer,
  _max_per_hour integer,
  _max_per_day integer,
  _max_per_destination_day integer
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  existing record;
  in_flight integer;
  last_hour integer;
  last_day integer;
  to_destination integer;
  balance integer;
  rate integer;
  new_id uuid;
BEGIN
  IF _destination IS NULL OR _destination !~ '^\+[1-9]\d{6,14}$' THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'invalid_destination');
  END IF;
  IF _idempotency_key IS NULL OR _idempotency_key !~ '^[A-Za-z0-9_-]{16,100}$' THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'invalid_idempotency_key');
  END IF;

  -- Serializes this customer's admissions and wallet debits.
  PERFORM 1 FROM public.organizations WHERE id = _org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'organization_not_found');
  END IF;

  SELECT id, status, destination_number INTO existing FROM public.call_logs
   WHERE organization_id = _org AND idempotency_key = _idempotency_key;
  IF FOUND THEN
    -- The same key for a different number is a client bug, never a second call.
    IF existing.destination_number IS DISTINCT FROM _destination THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'idempotency_key_reused');
    END IF;
    RETURN jsonb_build_object('result', 'duplicate', 'call_id', existing.id, 'status', existing.status);
  END IF;

  PERFORM 1 FROM public.phone_numbers
   WHERE id = _phone_number_id AND organization_id = _org AND status = 'active';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'number_not_owned');
  END IF;

  SELECT
    count(*) FILTER (WHERE status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown')),
    count(*) FILTER (WHERE started_at > now() - interval '1 hour'),
    count(*),
    count(*) FILTER (WHERE destination_number = _destination)
  INTO in_flight, last_hour, last_day, to_destination
  FROM public.call_logs
  WHERE organization_id = _org
    AND direction = 'outbound'
    AND campaign_id IS NULL
    AND started_at > now() - interval '24 hours'
    -- A start that failed before dialling reached nobody and costs nothing.
    AND resolution_source IS DISTINCT FROM 'start_failure';

  IF in_flight >= _max_in_flight THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'in_flight_limit', 'in_flight', in_flight);
  END IF;
  IF last_hour >= _max_per_hour THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'hourly_limit');
  END IF;
  IF last_day >= _max_per_day THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'daily_limit');
  END IF;
  IF to_destination >= _max_per_destination_day THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'destination_daily_limit');
  END IF;

  -- The customer's outbound price, exactly as billing reads it (getCallRate):
  -- the customer's override, else the platform rule, else free.
  SELECT COALESCE(
           (SELECT o.customer_amount FROM public.organization_pricing_overrides o
             WHERE o.organization_id = _org AND o.key = 'outbound_minute'),
           (SELECT r.customer_amount FROM public.pricing_rules r WHERE r.key = 'outbound_minute'),
           0)
    INTO rate;
  IF rate > 0 THEN
    SELECT COALESCE((SELECT b.balance FROM public.wallet_balances b WHERE b.organization_id = _org), 0)::int
      INTO balance;
    IF balance < rate * (in_flight + 1) THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'insufficient_balance');
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.call_logs (
      organization_id, phone_number_id, provider, direction, caller_number,
      destination_number, status, started_at, idempotency_key
    ) VALUES (
      _org, _phone_number_id, 'sarvam', 'outbound', _caller_number,
      _destination, 'initiated', now(), _idempotency_key
    ) RETURNING id INTO new_id;
  EXCEPTION WHEN unique_violation THEN
    -- idx_call_logs_sarvam_outbound_number_reservation: an unresolved call to
    -- this number already exists (a campaign call, or a stuck single call).
    RETURN jsonb_build_object('result', 'refused', 'reason', 'destination_busy');
  END;

  RETURN jsonb_build_object('result', 'admitted', 'call_id', new_id);
END; $$;

REVOKE ALL ON FUNCTION public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer) TO service_role;
