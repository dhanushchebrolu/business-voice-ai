-- Re-runnable, exactly-once finalization for SARVAM OUTBOUND calls only.
--
-- Once a Sarvam outbound call reaches a final status, two things must happen
-- exactly once: billing (wallet debit + usage record + charge on the call) and
-- the campaign effect (contact outcome, opt-out, lead, campaign completion).
-- Before this migration both ran inline after the status write, so a failure
-- in between left the call final but unbilled and its contact stuck, with no
-- way to run them again (a replay stopped at "status unchanged").
--
-- Mechanism (database-level, not application checks):
--   * A trigger marks a Sarvam outbound call `finalization_state = 'pending'`
--     the moment it first reaches a final status, whichever code path wrote
--     it — no path can skip finalization.
--   * claim_call_finalization hands out a lease token on the call row (one
--     holder at a time; an expired lease can be taken over).
--   * apply_call_billing and apply_call_campaign_outcome each lock the call
--     row (FOR UPDATE), refuse a stale or missing lease, skip work whose
--     checkpoint is already set, and write their effects and their checkpoint
--     in the same transaction — an effect without its checkpoint (or the
--     reverse) cannot exist.
--   * complete_call_finalization marks the call `done` only when both
--     checkpoints are set (also enforced by a CHECK constraint).
--
-- Scope: provider = 'sarvam' AND direction = 'outbound'. Sarvam inbound,
-- Exotel, Vobiz and LiveKit (livekit_sip) calls are untouched and keep their
-- existing inline billing. Existing wallet idempotency is unchanged and reused
-- (debit_wallet_for_call, idx_wallet_tx_call_usage_ref, record_call_usage,
-- idx_usage_records_call_kind); no wallet index is added.
--
-- Lock order inside the functions: call_logs row, then (inside
-- debit_wallet_for_call) the organizations row; campaign_contacts, contacts,
-- leads and campaigns rows after the call row. No existing code locks any of
-- these and then a call_logs row in the same transaction.

-- 1. Finalization state on call_logs ------------------------------------------

ALTER TABLE public.call_logs
  ADD COLUMN IF NOT EXISTS finalization_state text,
  ADD COLUMN IF NOT EXISTS finalization_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS finalization_error text,
  ADD COLUMN IF NOT EXISTS finalization_next_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalization_lease_token uuid,
  ADD COLUMN IF NOT EXISTS finalization_lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS campaign_applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS final_agent_variables jsonb,
  ADD COLUMN IF NOT EXISTS resolution_source text,
  ADD COLUMN IF NOT EXISTS resolved_by uuid,
  ADD COLUMN IF NOT EXISTS resolution_conflict boolean NOT NULL DEFAULT false;

ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_finalization_state_check;
ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_finalization_state_check
  CHECK (finalization_state IS NULL OR finalization_state IN ('pending', 'done', 'failed'));

-- `done` is only possible once BOTH steps have their checkpoint.
ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_finalization_done_check;
ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_finalization_done_check
  CHECK (
    finalization_state IS DISTINCT FROM 'done'
    OR (billing_applied_at IS NOT NULL AND campaign_applied_at IS NOT NULL)
  );

-- Who decided the final status: the provider's webhook, an operator, the
-- start request itself (a definite rejection), or a call finished before
-- this migration.
ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_resolution_source_check;
ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_resolution_source_check
  CHECK (
    resolution_source IS NULL
    OR resolution_source IN ('provider', 'operator', 'start_failure', 'legacy')
  );

-- Calls already final before this migration were finalized by the old inline
-- code; mark them done so nothing is ever re-billed or re-applied for them.
UPDATE public.call_logs
SET finalization_state = 'done',
    billing_applied_at = coalesce(ended_at, updated_at, created_at),
    campaign_applied_at = coalesce(ended_at, updated_at, created_at),
    resolution_source = coalesce(resolution_source, 'legacy')
WHERE provider = 'sarvam'
  AND direction = 'outbound'
  AND status IN ('completed', 'failed', 'busy', 'no_answer', 'cancelled')
  AND finalization_state IS NULL;

CREATE INDEX IF NOT EXISTS idx_call_logs_finalization_due
  ON public.call_logs (finalization_next_at)
  WHERE finalization_state IN ('pending', 'failed');

-- 2. The call a campaign contact is currently on --------------------------------

-- Set by the dispatcher's claim (the call id is generated before the claim, so
-- this has no foreign key: the call row is inserted just after). The campaign
-- outcome of a call is applied only while the contact still points at THAT
-- call, so a stale or late outcome can never move a contact that has since
-- been claimed for another attempt. (campaign_contacts.call_id is an older,
-- unused column with a foreign key; it is left as it is.)
ALTER TABLE public.campaign_contacts ADD COLUMN IF NOT EXISTS current_call_id uuid;

-- Contacts in flight right now: point them at their single in-flight call
-- (idx_call_logs_campaign_contact_inflight allows at most one).
UPDATE public.campaign_contacts cc
SET current_call_id = cl.id
FROM public.call_logs cl
WHERE cl.campaign_contact_id = cc.id
  AND cl.status NOT IN ('completed', 'failed', 'busy', 'no_answer', 'cancelled')
  AND cc.status IN ('calling', 'outcome_unknown')
  AND cc.current_call_id IS NULL;

-- 3. One campaign lead per call -----------------------------------------------

-- The only lead-creating path (campaign calls) now records call_id. Existing
-- campaign leads have call_id NULL and fall outside this index. Stop with an
-- actionable message (and change nothing) if duplicates already exist.
DO $$
DECLARE
  duplicate_calls integer;
BEGIN
  SELECT count(*) INTO duplicate_calls FROM (
    SELECT 1 FROM public.leads
    WHERE source = 'campaign' AND call_id IS NOT NULL
    GROUP BY call_id
    HAVING count(*) > 1
  ) d;
  IF duplicate_calls > 0 THEN
    RAISE EXCEPTION 'Cannot add idx_leads_campaign_call: % call(s) already have more than one campaign lead.', duplicate_calls
      USING HINT = 'Remove the duplicate campaign leads first, then re-run this migration. Nothing from this migration was applied.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_campaign_call
  ON public.leads (call_id)
  WHERE source = 'campaign' AND call_id IS NOT NULL;

-- 4. No Sarvam outbound final status can skip finalization -------------------

CREATE OR REPLACE FUNCTION public.mark_sarvam_outbound_finalization_pending()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.provider = 'sarvam'
     AND NEW.direction = 'outbound'
     AND NEW.status IN ('completed', 'failed', 'busy', 'no_answer', 'cancelled')
     AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('completed', 'failed', 'busy', 'no_answer', 'cancelled'))
     AND NEW.finalization_state IS NULL THEN
    NEW.finalization_state := 'pending';
    NEW.finalization_next_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_call_logs_sarvam_outbound_finalization ON public.call_logs;
CREATE TRIGGER trg_call_logs_sarvam_outbound_finalization
  BEFORE INSERT OR UPDATE OF status ON public.call_logs
  FOR EACH ROW EXECUTE FUNCTION public.mark_sarvam_outbound_finalization_pending();

-- 5. Finalization functions (service_role only) --------------------------------

-- Hands out the finalization lease for one call, or NULL when the call needs
-- no finalization or another holder's lease is still live. Concurrent callers
-- queue on the row lock; the loser re-checks the condition after the winner
-- commits and gets NULL.
CREATE OR REPLACE FUNCTION public.claim_call_finalization(_call uuid, _lease_seconds integer DEFAULT 120)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  token uuid;
BEGIN
  IF _lease_seconds IS NULL OR _lease_seconds < 10 OR _lease_seconds > 900 THEN
    RAISE EXCEPTION 'lease must be between 10 and 900 seconds';
  END IF;
  UPDATE public.call_logs
  SET finalization_lease_token = gen_random_uuid(),
      finalization_lease_expires_at = clock_timestamp() + make_interval(secs => _lease_seconds),
      finalization_attempts = finalization_attempts + 1
  WHERE id = _call
    AND finalization_state IN ('pending', 'failed')
    AND (finalization_lease_expires_at IS NULL OR finalization_lease_expires_at < clock_timestamp())
  RETURNING finalization_lease_token INTO token;
  RETURN token;
END;
$$;

-- Billing step: wallet debit (debit_wallet_for_call, idempotent per call),
-- usage record (record_call_usage, ON CONFLICT per call), the charge on the
-- call, and billing_applied_at — all in this one transaction.
-- Returns 'applied', 'already' or 'lease_lost'.
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

-- Campaign step: the contact's outcome (only while the contact is still on
-- THIS call and in flight), the contact opt-out it implies, one campaign lead
-- per call, campaign completion, and campaign_applied_at — all in this one
-- transaction. A call with no campaign contact just sets the checkpoint.
-- The retry decision itself (_contact_status/_next_attempt_at) is computed by
-- the caller (decideCampaignContactOutcome); finalization never changes
-- `attempts`, so the decision's input cannot move underneath it.
CREATE OR REPLACE FUNCTION public.apply_call_campaign_outcome(
  _call uuid,
  _token uuid,
  _contact_status text,
  _next_attempt_at timestamptz,
  _output_variables jsonb,
  _create_lead boolean,
  _lead_score text,
  _lead_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  c record;
  updated_contacts integer := 0;
  lead_rows integer := 0;
  completed_rows integer := 0;
BEGIN
  SELECT id, organization_id, status, campaign_id, campaign_contact_id, contact_id,
         finalization_lease_token, finalization_lease_expires_at, campaign_applied_at
    INTO c FROM public.call_logs WHERE id = _call FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'call % not found', _call;
  END IF;
  IF c.finalization_lease_token IS DISTINCT FROM _token
     OR c.finalization_lease_expires_at IS NULL
     OR c.finalization_lease_expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('result', 'lease_lost');
  END IF;
  IF c.campaign_applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'already');
  END IF;

  IF c.campaign_id IS NOT NULL AND c.campaign_contact_id IS NOT NULL THEN
    IF _contact_status IS NULL THEN
      RAISE EXCEPTION 'a campaign call needs the contact outcome';
    END IF;
    IF _create_lead AND _lead_score NOT IN ('hot', 'warm', 'cold') THEN
      RAISE EXCEPTION 'invalid lead score %', _lead_score;
    END IF;

    UPDATE public.campaign_contacts
    SET status = _contact_status,
        next_attempt_at = _next_attempt_at,
        outcome = c.status,
        output_variables = coalesce(_output_variables, '{}'::jsonb)
    WHERE id = c.campaign_contact_id
      AND current_call_id = _call
      AND status IN ('calling', 'outcome_unknown');
    GET DIAGNOSTICS updated_contacts = ROW_COUNT;

    IF updated_contacts > 0 AND _contact_status = 'opted_out' THEN
      UPDATE public.contacts
      SET opted_out = true,
          opted_out_at = now(),
          opted_out_reason = 'Requested during an outbound call'
      WHERE id = (SELECT contact_id FROM public.campaign_contacts WHERE id = c.campaign_contact_id);
    END IF;

    IF _create_lead AND c.status = 'completed' AND c.contact_id IS NOT NULL THEN
      INSERT INTO public.leads (
        organization_id, business_id, campaign_id, contact_id, call_id,
        name, phone, email, source, asked_about, score, notes
      )
      SELECT c.organization_id, camp.business_id, camp.id, ct.id, _call,
             ct.name, ct.phone, ct.email, 'campaign', camp.name, _lead_score, _lead_notes
      FROM public.campaigns camp, public.contacts ct
      WHERE camp.id = c.campaign_id AND ct.id = c.contact_id
      ON CONFLICT (call_id) WHERE source = 'campaign' AND call_id IS NOT NULL DO NOTHING;
      GET DIAGNOSTICS lead_rows = ROW_COUNT;
    END IF;

    -- Same rule as maybeCompleteCampaign (campaign-dispatch.server.ts).
    IF NOT EXISTS (
         SELECT 1 FROM public.campaign_contacts
         WHERE campaign_id = c.campaign_id
           AND status IN ('pending', 'retry_scheduled', 'queued', 'calling', 'outcome_unknown')
       )
       AND EXISTS (SELECT 1 FROM public.campaign_contacts WHERE campaign_id = c.campaign_id) THEN
      UPDATE public.campaigns
      SET status = 'completed', completed_at = now()
      WHERE id = c.campaign_id AND status = 'running';
      GET DIAGNOSTICS completed_rows = ROW_COUNT;
    END IF;
  END IF;

  UPDATE public.call_logs SET campaign_applied_at = clock_timestamp() WHERE id = _call;
  RETURN jsonb_build_object(
    'result', 'applied',
    'contact_updated', updated_contacts > 0,
    'lead_created', lead_rows > 0,
    'campaign_completed', completed_rows > 0
  );
END;
$$;

-- Marks the call done — only for the current lease holder, and only once both
-- checkpoints are set.
CREATE OR REPLACE FUNCTION public.complete_call_finalization(_call uuid, _token uuid)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.call_logs
  SET finalization_state = 'done',
      finalization_error = NULL,
      finalization_next_at = NULL,
      finalization_lease_token = NULL,
      finalization_lease_expires_at = NULL
  WHERE id = _call
    AND finalization_lease_token = _token
    AND billing_applied_at IS NOT NULL
    AND campaign_applied_at IS NOT NULL;
  RETURN FOUND;
END;
$$;

-- Records a failed pass (current lease holder only) and releases the lease.
-- Nothing retries automatically in this phase; finalization_next_at is when
-- a retry would be due.
CREATE OR REPLACE FUNCTION public.fail_call_finalization(_call uuid, _token uuid, _error text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.call_logs
  SET finalization_state = 'failed',
      finalization_error = left(coalesce(_error, 'unknown error'), 500),
      finalization_next_at = clock_timestamp()
        + least(make_interval(mins => power(2, least(finalization_attempts, 9))::integer), interval '6 hours'),
      finalization_lease_token = NULL,
      finalization_lease_expires_at = NULL
  WHERE id = _call AND finalization_lease_token = _token;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_sarvam_outbound_finalization_pending() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_call_finalization(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_call_campaign_outcome(uuid, uuid, text, timestamptz, jsonb, boolean, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_call_finalization(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_call_finalization(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_call_finalization(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_call_billing(uuid, uuid, integer, integer, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_call_campaign_outcome(uuid, uuid, text, timestamptz, jsonb, boolean, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_call_finalization(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_call_finalization(uuid, uuid, text) TO service_role;
