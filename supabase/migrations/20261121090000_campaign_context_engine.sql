-- Campaign context engine and atomic campaign admission.
--
--   1. campaigns.description: the customer's own words, kept unchanged.
--      campaigns.context: the reviewed, structured campaign context (JSON),
--      written only by the server (no customer grant), with the version and
--      who reviewed it when. The dispatcher dials only a campaign whose context
--      was reviewed, and sends the agent the context compiled from it.
--   2. campaigns.budget_limit: optional spending cap (paise). A call is admitted
--      only while what the campaign has spent plus the worst case of its open
--      calls plus this call's worst case stays within it.
--   3. campaign_contacts: status 'excluded' with excluded_reason, for a contact
--      ClickAI will not call (for example a number outside the allowed
--      countries). Never dialled, never retried.
--   4. admit_campaign_outbound_call: the campaign counterpart of
--      admit_single_outbound_call, under the same customer row lock: campaign
--      still running, caller number still the customer's and outbound-enabled,
--      confirmed maximum call length (60-300 s), in-flight limit across ALL the
--      customer's outbound calls, wallet worst case over ALL open outbound calls,
--      the campaign budget, then the call row (number reservation and
--      one-call-per-contact indexes -> destination_busy).
--   5. admit_single_outbound_call now also counts open campaign calls when it
--      checks the wallet (it previously reserved only for single calls), and
--      its in-flight limit counts every outbound call, single or campaign.
--   6. Both admissions:
--      - refuse while platform_settings 'outbound.calling_paused' is
--        {"enabled": true} (the database emergency stop: no new outbound call
--        is admitted from the next admission on, without a deploy);
--      - count a call as in flight only for 15 minutes after it started (no
--        call outlives its 300 s cap; an unresolved start must not block the
--        customer forever; its wallet and number reservations still hold);
--      - reserve the wallet for calls that ended but are not billed yet
--        (finalization pending or failed), not only for live calls.
--   Campaign admission also takes a share lock on the campaign row, so a pause
--   or cancel cannot commit between the status check and the call row.
--
-- Additive: nullable columns, a widened CHECK, two functions. Rollback:
-- docs/production-rollback-20261121090000-campaign-context-engine.sql

-- ============ 1-2. campaigns ============
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS context jsonb,
  ADD COLUMN IF NOT EXISTS context_version integer,
  ADD COLUMN IF NOT EXISTS context_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS context_reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS budget_limit integer;

ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_description_length;
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_description_length CHECK (description IS NULL OR char_length(description) <= 4000);
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_budget_limit_positive;
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_budget_limit_positive CHECK (budget_limit IS NULL OR budget_limit > 0);
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_context_reviewed;
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_context_reviewed CHECK (
    context_reviewed_at IS NULL OR (context IS NOT NULL AND context_version IS NOT NULL)
  );

-- The customer may write their description and budget; the context and its
-- review are server-only (saveCampaignContext), like status.
GRANT INSERT (description, budget_limit) ON public.campaigns TO authenticated;
GRANT UPDATE (description, budget_limit) ON public.campaigns TO authenticated;

-- ============ 3. campaign_contacts ============
ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS excluded_reason text;
ALTER TABLE public.campaign_contacts DROP CONSTRAINT IF EXISTS campaign_contacts_status_check;
ALTER TABLE public.campaign_contacts
  ADD CONSTRAINT campaign_contacts_status_check CHECK (status IN (
    'pending','queued','calling','connected','no_answer','busy','failed',
    'completed','retry_scheduled','opted_out','wrong_number','cancelled',
    'outcome_unknown','excluded'
  ));

-- ============ 4. campaign admission ============
CREATE OR REPLACE FUNCTION public.admit_campaign_outbound_call(
  _campaign uuid,
  _campaign_contact uuid,
  _call uuid,
  _destination text,
  _retry_attempt integer,
  _max_in_flight integer
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  camp record;
  cc record;
  num record;
  max_seconds integer;
  cap_minutes integer;
  in_flight integer;
  open_reserved bigint;
  committed bigint;
  balance integer;
  rate integer;
BEGIN
  IF _destination IS NULL OR _destination !~ '^\+[1-9]\d{6,14}$' THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'invalid_destination');
  END IF;

  SELECT id, organization_id, status, phone_number_id, agent_config_id, budget_limit,
         context_reviewed_at
    INTO camp FROM public.campaigns WHERE id = _campaign;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'campaign_not_found');
  END IF;

  -- Serializes this customer's admissions (single and campaign) and wallet debits.
  PERFORM 1 FROM public.organizations WHERE id = camp.organization_id FOR UPDATE;

  -- Database emergency stop (platform_settings 'outbound.calling_paused').
  IF EXISTS (SELECT 1 FROM public.platform_settings
              WHERE key = 'outbound.calling_paused'
                AND COALESCE((value ->> 'enabled')::boolean, false)) THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'outbound_paused');
  END IF;

  -- Re-read under a share lock: a pause or cancel that landed since is final,
  -- and one that comes later waits until this admission has committed.
  SELECT status, context_reviewed_at INTO camp.status, camp.context_reviewed_at
    FROM public.campaigns WHERE id = _campaign FOR SHARE;
  IF camp.status <> 'running' THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'campaign_not_running');
  END IF;
  IF camp.context_reviewed_at IS NULL THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'context_not_reviewed');
  END IF;

  -- The contact must belong to this campaign (and so this customer) and be
  -- claimed for exactly this call.
  SELECT id, contact_id, current_call_id, status INTO cc
    FROM public.campaign_contacts
   WHERE id = _campaign_contact AND campaign_id = _campaign AND organization_id = camp.organization_id;
  IF NOT FOUND OR cc.status <> 'calling' OR cc.current_call_id IS DISTINCT FROM _call THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'contact_not_claimed');
  END IF;

  SELECT id, e164 INTO num FROM public.phone_numbers
   WHERE id = camp.phone_number_id AND organization_id = camp.organization_id
     AND status = 'active' AND outbound_enabled;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'number_not_owned');
  END IF;

  SELECT a.sarvam_outbound_max_call_seconds INTO max_seconds
    FROM public.agent_configs a
   WHERE a.id = camp.agent_config_id AND a.organization_id = camp.organization_id;
  IF max_seconds IS NULL OR max_seconds < 60 OR max_seconds > 300 THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'max_call_length_not_set');
  END IF;
  cap_minutes := ceil(max_seconds / 60.0)::integer;

  SELECT count(*) INTO in_flight FROM public.call_logs
   WHERE organization_id = camp.organization_id
     AND direction = 'outbound'
     AND status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown')
     AND started_at > now() - interval '15 minutes';
  IF in_flight >= _max_in_flight THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'in_flight_limit', 'in_flight', in_flight);
  END IF;

  SELECT COALESCE(
           (SELECT o.customer_amount FROM public.organization_pricing_overrides o
             WHERE o.organization_id = camp.organization_id AND o.key = 'outbound_minute'),
           (SELECT r.customer_amount FROM public.pricing_rules r WHERE r.key = 'outbound_minute'),
           0)
    INTO rate;

  -- Worst case still owed by every outbound call not yet billed, single or campaign.
  SELECT COALESCE(sum(COALESCE(billing_cap_minutes, 1)::bigint * COALESCE(billing_rate_per_minute, rate)), 0)
    INTO open_reserved
    FROM public.call_logs
   WHERE organization_id = camp.organization_id
     AND direction = 'outbound'
     AND (status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown')
          OR (billing_applied_at IS NULL AND finalization_state IN ('pending', 'failed')));

  IF rate > 0 OR open_reserved > 0 THEN
    SELECT COALESCE((SELECT b.balance FROM public.wallet_balances b
                      WHERE b.organization_id = camp.organization_id), 0)::int
      INTO balance;
    IF balance < open_reserved + rate::bigint * cap_minutes THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'insufficient_balance',
                                'required', open_reserved + rate::bigint * cap_minutes);
    END IF;
  END IF;

  -- Campaign budget: billed calls at what they cost, unbilled ones at their
  -- worst case; a start that failed before dialling cost nothing.
  IF camp.budget_limit IS NOT NULL THEN
    SELECT COALESCE(sum(
             CASE WHEN billing_applied_at IS NOT NULL THEN COALESCE(customer_charge, 0)
                  ELSE COALESCE(billing_cap_minutes, 1)::bigint * COALESCE(billing_rate_per_minute, rate)
             END), 0)
      INTO committed
      FROM public.call_logs
     WHERE campaign_id = _campaign
       AND resolution_source IS DISTINCT FROM 'start_failure';
    IF committed + rate::bigint * cap_minutes > camp.budget_limit THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'budget_exhausted',
                                'committed', committed, 'budget_limit', camp.budget_limit);
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.call_logs (
      id, organization_id, campaign_id, campaign_contact_id, contact_id, phone_number_id,
      provider, direction, caller_number, destination_number, status, started_at,
      retry_attempt, billing_cap_minutes, billing_rate_per_minute
    ) VALUES (
      _call, camp.organization_id, _campaign, _campaign_contact, cc.contact_id, num.id,
      'sarvam', 'outbound', num.e164, _destination, 'initiated', now(),
      GREATEST(_retry_attempt, 0), cap_minutes, rate
    );
  EXCEPTION WHEN unique_violation THEN
    -- An unresolved call to this number (single or another campaign), or this
    -- contact already has a call in flight.
    RETURN jsonb_build_object('result', 'refused', 'reason', 'destination_busy');
  END;

  RETURN jsonb_build_object('result', 'admitted', 'call_id', _call, 'caller_number', num.e164,
                            'cap_minutes', cap_minutes, 'rate_per_minute', rate);
END; $$;

REVOKE ALL ON FUNCTION public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer) TO service_role;

-- ============ 5. single admission: reserve for open campaign calls too ============
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
  max_seconds integer;
  cap_minutes integer;
  in_flight integer;
  last_hour integer;
  last_day integer;
  to_destination integer;
  open_reserved bigint;
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

  PERFORM 1 FROM public.organizations WHERE id = _org FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'organization_not_found');
  END IF;

  -- Database emergency stop (platform_settings 'outbound.calling_paused').
  IF EXISTS (SELECT 1 FROM public.platform_settings
              WHERE key = 'outbound.calling_paused'
                AND COALESCE((value ->> 'enabled')::boolean, false)) THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'outbound_paused');
  END IF;

  SELECT id, status, destination_number INTO existing FROM public.call_logs
   WHERE organization_id = _org AND idempotency_key = _idempotency_key;
  IF FOUND THEN
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

  SELECT a.sarvam_outbound_max_call_seconds INTO max_seconds
    FROM public.phone_numbers n JOIN public.agent_configs a ON a.id = n.agent_config_id
   WHERE n.id = _phone_number_id AND a.organization_id = _org;
  IF max_seconds IS NULL THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'max_call_length_not_set');
  END IF;
  cap_minutes := ceil(max_seconds / 60.0)::integer;

  -- In flight: every outbound call of this customer, single or campaign.
  SELECT count(*) INTO in_flight FROM public.call_logs
   WHERE organization_id = _org
     AND direction = 'outbound'
     AND status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown')
     AND started_at > now() - interval '15 minutes';

  -- Rate limits: the customer's single calls.
  SELECT
    count(*) FILTER (WHERE started_at > now() - interval '1 hour'),
    count(*),
    count(*) FILTER (WHERE destination_number = _destination)
  INTO last_hour, last_day, to_destination
  FROM public.call_logs
  WHERE organization_id = _org
    AND direction = 'outbound'
    AND campaign_id IS NULL
    AND started_at > now() - interval '24 hours'
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

  SELECT COALESCE(
           (SELECT o.customer_amount FROM public.organization_pricing_overrides o
             WHERE o.organization_id = _org AND o.key = 'outbound_minute'),
           (SELECT r.customer_amount FROM public.pricing_rules r WHERE r.key = 'outbound_minute'),
           0)
    INTO rate;

  -- Worst case still owed by every outbound call not yet billed, single or campaign.
  SELECT COALESCE(sum(COALESCE(billing_cap_minutes, 1)::bigint * COALESCE(billing_rate_per_minute, rate)), 0)
    INTO open_reserved
    FROM public.call_logs
   WHERE organization_id = _org
     AND direction = 'outbound'
     AND (status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown')
          OR (billing_applied_at IS NULL AND finalization_state IN ('pending', 'failed')));

  IF rate > 0 OR open_reserved > 0 THEN
    SELECT COALESCE((SELECT b.balance FROM public.wallet_balances b WHERE b.organization_id = _org), 0)::int
      INTO balance;
    IF balance < open_reserved + rate::bigint * cap_minutes THEN
      RETURN jsonb_build_object('result', 'refused', 'reason', 'insufficient_balance',
                                'required', open_reserved + rate::bigint * cap_minutes);
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.call_logs (
      organization_id, phone_number_id, provider, direction, caller_number,
      destination_number, status, started_at, idempotency_key,
      billing_cap_minutes, billing_rate_per_minute
    ) VALUES (
      _org, _phone_number_id, 'sarvam', 'outbound', _caller_number,
      _destination, 'initiated', now(), _idempotency_key,
      cap_minutes, rate
    ) RETURNING id INTO new_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'destination_busy');
  END;

  RETURN jsonb_build_object('result', 'admitted', 'call_id', new_id,
                            'cap_minutes', cap_minutes, 'rate_per_minute', rate);
END; $$;

REVOKE ALL ON FUNCTION public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer) TO service_role;
