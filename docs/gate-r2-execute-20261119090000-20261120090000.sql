-- GATE R2 execution script: migrations 20261119090000 and 20261120090000.
-- Target: Supabase project eorazvlmqwunmhwviocn ("Klyro Ai"), database "postgres",
-- PostgreSQL system identifier 7678069749886157684. Generated from the migration files
-- (SHA-256 below); the embedded text is byte-identical (executed and recorded).
--   supabase/migrations/20261119090000_outbound_call_admission.sql  f7d10f0d1076f7787731ff529b1eee17a767bf707f3937bfb88334dd85ce764e
--   supabase/migrations/20261120090000_dual_agent_provisioning.sql  b32b117e2eb9187273311f10a79eb083768caf6e1f663df70b13d47d6d3e5053
--
-- Run ONCE, as ONE request:
--   npx -y supabase@2.120.0 db query --linked --project-ref eorazvlmqwunmhwviocn -f <this file>
-- The request runs as ONE transaction (verified on production 2026-11-20, also
-- for an 85 KB request; SET LOCAL lock_timeout and statement_timeout take
-- effect for later statements). No BEGIN/COMMIT on purpose: any error,
-- including any guard or check below, rolls back EVERYTHING.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ===== Guard: abort before any change unless this is the expected database in the expected state =====
-- Comparisons use IS DISTINCT FROM so a NULL can never pass.
DO $guard$
BEGIN
  IF (SELECT system_identifier::text FROM pg_control_system()) IS DISTINCT FROM '7678069749886157684' THEN
    RAISE EXCEPTION 'GATE_R2_WRONG_DATABASE: system identifier %', (SELECT system_identifier::text FROM pg_control_system());
  END IF;
  IF current_database() IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'GATE_R2_WRONG_DATABASE: database %', current_database();
  END IF;
  IF (SELECT max(version) FROM supabase_migrations.schema_migrations) IS DISTINCT FROM '20261118120000' THEN
    RAISE EXCEPTION 'GATE_R2_UNEXPECTED_HISTORY: latest is %', (SELECT max(version) FROM supabase_migrations.schema_migrations);
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version IN ('20261119090000', '20261120090000')) THEN
    RAISE EXCEPTION 'GATE_R2_ALREADY_APPLIED';
  END IF;
  -- Nothing the migrations create may exist yet (IF NOT EXISTS / OR REPLACE would otherwise keep or replace it silently).
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'call_logs' AND column_name IN ('idempotency_key', 'billing_cap_minutes', 'billing_rate_per_minute')) OR (table_name = 'agent_configs' AND column_name IN ('sarvam_outbound_max_call_seconds', 'sarvam_outbound_app_id', 'sarvam_outbound_app_version', 'sarvam_outbound_registered_at', 'sarvam_outbound_registered_by')) OR (table_name = 'sarvam_agent_integrations' AND column_name IN ('role')))) <> 0 OR (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('idx_call_logs_org_idempotency_key', 'idx_call_logs_single_outbound_recent', 'idx_call_logs_single_outbound_open', 'idx_call_logs_inbound_caller', 'idx_agent_configs_sarvam_outbound_app_id', 'idx_sarvam_agent_integrations_one_active_per_role')) <> 0 OR (SELECT count(*) FROM pg_constraint WHERE conname IN ('agent_configs_outbound_max_call_seconds_range', 'call_logs_idempotency_key_format', 'call_logs_billing_lock_valid', 'agent_configs_outbound_agent_complete', 'sarvam_agent_integrations_role_check')) <> 0 OR (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('admit_single_outbound_call', 'agent_configs_sarvam_role_guard')) <> 0
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_agent_configs_sarvam_role_guard') THEN
    RAISE EXCEPTION 'GATE_R2_OBJECTS_ALREADY_EXIST';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'idx_sarvam_agent_integrations_one_active' AND relkind = 'i') THEN
    RAISE EXCEPTION 'GATE_R2_PRECONDITION: idx_sarvam_agent_integrations_one_active missing';
  END IF;
  -- Production fingerprint (2026-11-20).
  IF NOT EXISTS (SELECT 1 FROM public.agent_configs WHERE id = 'b2972814-d9a1-432a-b5bc-820c4282c34d'
                  AND sarvam_app_id = 'Conversatio-9c6a04cd-3334' AND sarvam_app_version = 5) THEN
    RAISE EXCEPTION 'GATE_R2_FINGERPRINT: Smile Dental agent mapping differs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.phone_numbers WHERE right(e164, 4) = '0061' AND status = 'active'
                  AND provider_deployment_id = 'Smile-Denta-be071be0-703e' AND inbound_enabled AND NOT outbound_enabled) THEN
    RAISE EXCEPTION 'GATE_R2_FINGERPRINT: 0061 mapping differs';
  END IF;
  IF (SELECT count(*) FROM public.phone_numbers WHERE outbound_enabled) <> 0 THEN
    RAISE EXCEPTION 'GATE_R2_PRECONDITION: a number has outbound enabled';
  END IF;
  IF (SELECT count(*) FROM public.campaigns) <> 0 THEN
    RAISE EXCEPTION 'GATE_R2_PRECONDITION: campaigns exist';
  END IF;
  IF (SELECT count(*) FROM public.sarvam_agent_integrations WHERE status = 'active') <> 1 THEN
    RAISE EXCEPTION 'GATE_R2_PRECONDITION: expected exactly one active credential';
  END IF;
  IF (SELECT value -> 'enabled' FROM public.platform_settings WHERE key = 'billing.payment_required') IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'GATE_R2_PRECONDITION: Payment Enforcement is not explicitly disabled';
  END IF;
  -- Data fingerprint, kept in a transaction-local setting (no table is written).
  PERFORM set_config('gate_r2.data_before', md5((SELECT 'organizations:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.organizations x) || ';' || (SELECT 'businesses:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.businesses x) || ';' || (SELECT 'agent_configs:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x) - 'sarvam_outbound_max_call_seconds' - 'sarvam_outbound_app_id' - 'sarvam_outbound_app_version' - 'sarvam_outbound_registered_at' - 'sarvam_outbound_registered_by')::text, '|' ORDER BY (to_jsonb(x) - 'sarvam_outbound_max_call_seconds' - 'sarvam_outbound_app_id' - 'sarvam_outbound_app_version' - 'sarvam_outbound_registered_at' - 'sarvam_outbound_registered_by')::text)), '-') FROM public.agent_configs x) || ';' || (SELECT 'phone_numbers:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.phone_numbers x) || ';' || (SELECT 'sarvam_agent_integrations:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x) - 'role')::text, '|' ORDER BY (to_jsonb(x) - 'role')::text)), '-') FROM public.sarvam_agent_integrations x) || ';' || (SELECT 'telephony_connections:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.telephony_connections x) || ';' || (SELECT 'sarvam_applications:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.sarvam_applications x) || ';' || (SELECT 'wallet_balances:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.wallet_balances x) || ';' || (SELECT 'wallet_transactions:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.wallet_transactions x) || ';' || (SELECT 'campaigns:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.campaigns x) || ';' || (SELECT 'campaign_contacts:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.campaign_contacts x) || ';' || (SELECT 'platform_settings:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.platform_settings x) || ';' || (SELECT 'call_logs:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x) - 'idempotency_key' - 'billing_cap_minutes' - 'billing_rate_per_minute')::text, '|' ORDER BY (to_jsonb(x) - 'idempotency_key' - 'billing_cap_minutes' - 'billing_rate_per_minute')::text)), '-') FROM public.call_logs x)), true);
END $guard$;

-- ===== Migration 20261119090000 (exact file content) =====
-- Atomic admission, call-length limit and capped billing for single
-- (non-campaign) Sarvam outbound calls.
--
-- Before this, the per-customer limits and the wallet check were reads in the
-- application before a plain INSERT, so simultaneous requests could all pass,
-- and a long call could cost more than the wallet held. Now:
--
-- agent_configs.sarvam_outbound_max_call_seconds: the maximum call length set
--   on the agent version in Sarvam ("Max call length"), recorded by the
--   platform admin who confirms the version for outbound. Sarvam's agent ends
--   the call at that length. No outbound call is admitted without it.
--
-- admit_single_outbound_call does every check and the reservation in ONE
-- transaction, holding the organization's row lock (the same lock
-- debit_wallet_for_call and wallet_can_afford take), so admissions for one
-- customer are serialized across every Worker instance:
--
--   1. idempotency: a key already used by this customer returns that call
--      ('duplicate'); nothing new is written or dialled;
--   2. the number must be the customer's, active, with an agent of the same
--      customer whose maximum call length is recorded;
--   3. limits over the customer's SINGLE calls (campaign_id IS NULL):
--      not yet final (24 h window), started in the last hour, started in the
--      last 24 h, and to this destination in the last 24 h;
--   4. the wallet must cover the WORST CASE: this call at its maximum length
--      plus every single call not yet final at its own locked maximum
--      (billing_cap_minutes x billing_rate_per_minute), at any age;
--   5. the call_logs row is inserted as `initiated` with its price and cap
--      locked (billing_rate_per_minute, billing_cap_minutes). The existing
--      idx_call_logs_sarvam_outbound_number_reservation still allows only one
--      unresolved call per destination ('destination_busy').
--
-- Finalization bills min(started minutes, billing_cap_minutes) at the locked
-- rate, so a call's charge can never exceed what admission reserved for it.
-- Nothing here dials or debits. No money is held: the reservation is the
-- worst-case amount every later admission must also leave room for.
--
-- Existing rows: all new columns are NULL on existing calls and agents.
-- NULL billing columns mean the call bills as before (no cap, current rate).
-- An agent already confirmed for outbound with no maximum recorded admits no
-- calls until an admin re-confirms it with one. Production has none confirmed.
--
-- Locks: the CHECK constraints and indexes are built under short exclusive /
-- share locks on call_logs and agent_configs (small tables; the new columns
-- are all NULL, so validation is a scan with no rewrite).
--
-- Rollback: docs/production-rollback-20261119090000-outbound-call-admission.sql

-- ============ 1. columns ============
ALTER TABLE public.agent_configs ADD COLUMN IF NOT EXISTS sarvam_outbound_max_call_seconds integer;
ALTER TABLE public.agent_configs DROP CONSTRAINT IF EXISTS agent_configs_outbound_max_call_seconds_range;
ALTER TABLE public.agent_configs ADD CONSTRAINT agent_configs_outbound_max_call_seconds_range
  CHECK (sarvam_outbound_max_call_seconds IS NULL OR sarvam_outbound_max_call_seconds BETWEEN 60 AND 3600);

ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS billing_cap_minutes integer;
ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS billing_rate_per_minute integer;

ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_idempotency_key_format;
ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_idempotency_key_format
  CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,100}$');
ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_billing_lock_valid;
ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_billing_lock_valid
  CHECK (
    (billing_cap_minutes IS NULL AND billing_rate_per_minute IS NULL)
    -- Explicit NOT NULLs: a CHECK whose result is NULL passes, so half a lock would slip through.
    OR (billing_cap_minutes IS NOT NULL AND billing_rate_per_minute IS NOT NULL
        AND billing_cap_minutes BETWEEN 1 AND 60 AND billing_rate_per_minute >= 0)
  );

-- ============ 2. indexes ============
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_logs_org_idempotency_key
  ON public.call_logs (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The limit counts: one customer's recent single outbound calls.
CREATE INDEX IF NOT EXISTS idx_call_logs_single_outbound_recent
  ON public.call_logs (organization_id, started_at)
  WHERE direction = 'outbound' AND campaign_id IS NULL;

-- The worst-case wallet reservation: one customer's open single calls, any age.
CREATE INDEX IF NOT EXISTS idx_call_logs_single_outbound_open
  ON public.call_logs (organization_id)
  WHERE direction = 'outbound' AND campaign_id IS NULL
    AND status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown');

-- The prior-relationship check (outbound-eligibility.server.ts).
CREATE INDEX IF NOT EXISTS idx_call_logs_inbound_caller
  ON public.call_logs (organization_id, caller_number)
  WHERE direction = 'inbound';

-- ============ 3. admission ============
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

  -- The number's agent (same customer) and its recorded maximum call length.
  SELECT a.sarvam_outbound_max_call_seconds INTO max_seconds
    FROM public.phone_numbers n JOIN public.agent_configs a ON a.id = n.agent_config_id
   WHERE n.id = _phone_number_id AND a.organization_id = _org;
  IF max_seconds IS NULL THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'max_call_length_not_set');
  END IF;
  cap_minutes := ceil(max_seconds / 60.0)::integer;

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

  -- Worst case still owed by open single calls, at their own locked terms
  -- (calls from before this migration: one minute at today's rate).
  SELECT COALESCE(sum(COALESCE(billing_cap_minutes, 1)::bigint * COALESCE(billing_rate_per_minute, rate)), 0)
    INTO open_reserved
    FROM public.call_logs
   WHERE organization_id = _org
     AND direction = 'outbound'
     AND campaign_id IS NULL
     AND status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown');

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
    -- idx_call_logs_sarvam_outbound_number_reservation: an unresolved call to
    -- this number already exists (a campaign call, or a stuck single call).
    RETURN jsonb_build_object('result', 'refused', 'reason', 'destination_busy');
  END;

  RETURN jsonb_build_object('result', 'admitted', 'call_id', new_id,
                            'cap_minutes', cap_minutes, 'rate_per_minute', rate);
END; $$;

REVOKE ALL ON FUNCTION public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer) TO service_role;

INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('20261119090000', 'outbound_call_admission', ARRAY[$gate_m1$-- Atomic admission, call-length limit and capped billing for single
-- (non-campaign) Sarvam outbound calls.
--
-- Before this, the per-customer limits and the wallet check were reads in the
-- application before a plain INSERT, so simultaneous requests could all pass,
-- and a long call could cost more than the wallet held. Now:
--
-- agent_configs.sarvam_outbound_max_call_seconds: the maximum call length set
--   on the agent version in Sarvam ("Max call length"), recorded by the
--   platform admin who confirms the version for outbound. Sarvam's agent ends
--   the call at that length. No outbound call is admitted without it.
--
-- admit_single_outbound_call does every check and the reservation in ONE
-- transaction, holding the organization's row lock (the same lock
-- debit_wallet_for_call and wallet_can_afford take), so admissions for one
-- customer are serialized across every Worker instance:
--
--   1. idempotency: a key already used by this customer returns that call
--      ('duplicate'); nothing new is written or dialled;
--   2. the number must be the customer's, active, with an agent of the same
--      customer whose maximum call length is recorded;
--   3. limits over the customer's SINGLE calls (campaign_id IS NULL):
--      not yet final (24 h window), started in the last hour, started in the
--      last 24 h, and to this destination in the last 24 h;
--   4. the wallet must cover the WORST CASE: this call at its maximum length
--      plus every single call not yet final at its own locked maximum
--      (billing_cap_minutes x billing_rate_per_minute), at any age;
--   5. the call_logs row is inserted as `initiated` with its price and cap
--      locked (billing_rate_per_minute, billing_cap_minutes). The existing
--      idx_call_logs_sarvam_outbound_number_reservation still allows only one
--      unresolved call per destination ('destination_busy').
--
-- Finalization bills min(started minutes, billing_cap_minutes) at the locked
-- rate, so a call's charge can never exceed what admission reserved for it.
-- Nothing here dials or debits. No money is held: the reservation is the
-- worst-case amount every later admission must also leave room for.
--
-- Existing rows: all new columns are NULL on existing calls and agents.
-- NULL billing columns mean the call bills as before (no cap, current rate).
-- An agent already confirmed for outbound with no maximum recorded admits no
-- calls until an admin re-confirms it with one. Production has none confirmed.
--
-- Locks: the CHECK constraints and indexes are built under short exclusive /
-- share locks on call_logs and agent_configs (small tables; the new columns
-- are all NULL, so validation is a scan with no rewrite).
--
-- Rollback: docs/production-rollback-20261119090000-outbound-call-admission.sql

-- ============ 1. columns ============
ALTER TABLE public.agent_configs ADD COLUMN IF NOT EXISTS sarvam_outbound_max_call_seconds integer;
ALTER TABLE public.agent_configs DROP CONSTRAINT IF EXISTS agent_configs_outbound_max_call_seconds_range;
ALTER TABLE public.agent_configs ADD CONSTRAINT agent_configs_outbound_max_call_seconds_range
  CHECK (sarvam_outbound_max_call_seconds IS NULL OR sarvam_outbound_max_call_seconds BETWEEN 60 AND 3600);

ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS billing_cap_minutes integer;
ALTER TABLE public.call_logs ADD COLUMN IF NOT EXISTS billing_rate_per_minute integer;

ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_idempotency_key_format;
ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_idempotency_key_format
  CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{16,100}$');
ALTER TABLE public.call_logs DROP CONSTRAINT IF EXISTS call_logs_billing_lock_valid;
ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_billing_lock_valid
  CHECK (
    (billing_cap_minutes IS NULL AND billing_rate_per_minute IS NULL)
    -- Explicit NOT NULLs: a CHECK whose result is NULL passes, so half a lock would slip through.
    OR (billing_cap_minutes IS NOT NULL AND billing_rate_per_minute IS NOT NULL
        AND billing_cap_minutes BETWEEN 1 AND 60 AND billing_rate_per_minute >= 0)
  );

-- ============ 2. indexes ============
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_logs_org_idempotency_key
  ON public.call_logs (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The limit counts: one customer's recent single outbound calls.
CREATE INDEX IF NOT EXISTS idx_call_logs_single_outbound_recent
  ON public.call_logs (organization_id, started_at)
  WHERE direction = 'outbound' AND campaign_id IS NULL;

-- The worst-case wallet reservation: one customer's open single calls, any age.
CREATE INDEX IF NOT EXISTS idx_call_logs_single_outbound_open
  ON public.call_logs (organization_id)
  WHERE direction = 'outbound' AND campaign_id IS NULL
    AND status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown');

-- The prior-relationship check (outbound-eligibility.server.ts).
CREATE INDEX IF NOT EXISTS idx_call_logs_inbound_caller
  ON public.call_logs (organization_id, caller_number)
  WHERE direction = 'inbound';

-- ============ 3. admission ============
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

  -- The number's agent (same customer) and its recorded maximum call length.
  SELECT a.sarvam_outbound_max_call_seconds INTO max_seconds
    FROM public.phone_numbers n JOIN public.agent_configs a ON a.id = n.agent_config_id
   WHERE n.id = _phone_number_id AND a.organization_id = _org;
  IF max_seconds IS NULL THEN
    RETURN jsonb_build_object('result', 'refused', 'reason', 'max_call_length_not_set');
  END IF;
  cap_minutes := ceil(max_seconds / 60.0)::integer;

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

  -- Worst case still owed by open single calls, at their own locked terms
  -- (calls from before this migration: one minute at today's rate).
  SELECT COALESCE(sum(COALESCE(billing_cap_minutes, 1)::bigint * COALESCE(billing_rate_per_minute, rate)), 0)
    INTO open_reserved
    FROM public.call_logs
   WHERE organization_id = _org
     AND direction = 'outbound'
     AND campaign_id IS NULL
     AND status IN ('initiated', 'ringing', 'answered', 'in_progress', 'outcome_unknown');

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
    -- idx_call_logs_sarvam_outbound_number_reservation: an unresolved call to
    -- this number already exists (a campaign call, or a stuck single call).
    RETURN jsonb_build_object('result', 'refused', 'reason', 'destination_busy');
  END;

  RETURN jsonb_build_object('result', 'admitted', 'call_id', new_id,
                            'cap_minutes', cap_minutes, 'rate_per_minute', rate);
END; $$;

REVOKE ALL ON FUNCTION public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_single_outbound_call(uuid, uuid, text, text, text, integer, integer, integer, integer) TO service_role;
$gate_m1$]);

-- ===== Migration 20261120090000 (exact file content) =====
-- Dual-agent provisioning: every customer gets a second, outbound-only Sarvam
-- agent next to the inbound one (docs/dual-agent-provisioning-audit.md).
--
-- agent_configs
--   sarvam_outbound_app_id / sarvam_outbound_app_version: the customer's own
--   outbound agent, registered by an operator after creating it in Sarvam
--   from the outbound template. Outbound calls dial ONLY this agent; there is
--   no fallback to sarvam_app_id (the inbound agent).
--   sarvam_outbound_ready_app_id/_version (20261117180000) keep their
--   meaning, "confirmed after a supervised call", and must now equal this
--   outbound mapping before ClickAI dials.
--   A trigger keeps the two roles apart across ALL customers: an outbound
--   agent can never be anyone's inbound agent or shared application, and the
--   reverse; a unique index stops two customers sharing an outbound agent.
--
-- sarvam_agent_integrations
--   role: which agent a credential belongs to. Existing credentials are
--   'inbound'. ClickAI's agent API refuses every booking, callback and other
--   write tool for an 'outbound' credential. One active credential per agent
--   config AND role (was: per agent config).
--
-- Additive and backward-compatible: nullable columns, a defaulted column, a
-- CHECK, a unique index, a trigger, and the one-active index widened by role.
-- No existing row changes. Re-runnable. Rollback:
-- docs/production-rollback-20261120090000-dual-agent-provisioning.sql

ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS sarvam_outbound_app_id text,
  ADD COLUMN IF NOT EXISTS sarvam_outbound_app_version integer,
  ADD COLUMN IF NOT EXISTS sarvam_outbound_registered_at timestamptz,
  ADD COLUMN IF NOT EXISTS sarvam_outbound_registered_by uuid;

-- Explicit IS NOT NULL: a CHECK that evaluates to NULL passes.
ALTER TABLE public.agent_configs DROP CONSTRAINT IF EXISTS agent_configs_outbound_agent_complete;
ALTER TABLE public.agent_configs
  ADD CONSTRAINT agent_configs_outbound_agent_complete CHECK (
    (sarvam_outbound_app_id IS NULL AND sarvam_outbound_app_version IS NULL)
    OR (
      sarvam_outbound_app_id IS NOT NULL
      AND sarvam_outbound_app_version IS NOT NULL
      AND length(btrim(sarvam_outbound_app_id)) > 0
      AND sarvam_outbound_app_version > 0
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_configs_sarvam_outbound_app_id
  ON public.agent_configs (sarvam_outbound_app_id)
  WHERE sarvam_outbound_app_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.agent_configs_sarvam_role_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Same lock key as agent_configs_sarvam_application_guard, so mapping an
  -- app as inbound and registering it as outbound cannot race each other.
  IF NEW.sarvam_app_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('agent_configs.sarvam_app_id:' || NEW.sarvam_app_id));
  END IF;
  IF NEW.sarvam_outbound_app_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('agent_configs.sarvam_app_id:' || NEW.sarvam_outbound_app_id));
    IF NEW.sarvam_outbound_app_id = NEW.sarvam_app_id THEN
      RAISE EXCEPTION 'SARVAM_OUTBOUND_AGENT_IS_INBOUND' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.agent_configs a
       WHERE a.id <> NEW.id AND a.sarvam_app_id = NEW.sarvam_outbound_app_id
    ) OR EXISTS (
      SELECT 1 FROM public.sarvam_applications s
       WHERE s.sarvam_app_id = NEW.sarvam_outbound_app_id
    ) THEN
      RAISE EXCEPTION 'SARVAM_OUTBOUND_AGENT_IN_USE_AS_INBOUND' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.sarvam_app_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.agent_configs a
     WHERE a.id <> NEW.id AND a.sarvam_outbound_app_id = NEW.sarvam_app_id
  ) THEN
    RAISE EXCEPTION 'SARVAM_INBOUND_AGENT_IS_AN_OUTBOUND_AGENT' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_agent_configs_sarvam_role_guard ON public.agent_configs;
-- sarvam_application_id too: mapping an agent through a shared application
-- sets sarvam_app_id inside agent_configs_sarvam_application_guard (which
-- fires first, by name), without naming sarvam_app_id in the UPDATE.
CREATE TRIGGER trg_agent_configs_sarvam_role_guard
  BEFORE INSERT OR UPDATE OF sarvam_app_id, sarvam_application_id, sarvam_outbound_app_id
  ON public.agent_configs
  FOR EACH ROW EXECUTE FUNCTION public.agent_configs_sarvam_role_guard();

ALTER TABLE public.sarvam_agent_integrations
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'inbound';
ALTER TABLE public.sarvam_agent_integrations DROP CONSTRAINT IF EXISTS sarvam_agent_integrations_role_check;
ALTER TABLE public.sarvam_agent_integrations
  ADD CONSTRAINT sarvam_agent_integrations_role_check CHECK (role IN ('inbound', 'outbound'));

-- Create the wider index first, so there is never a moment with neither.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sarvam_agent_integrations_one_active_per_role
  ON public.sarvam_agent_integrations (agent_config_id, role) WHERE status = 'active';
DROP INDEX IF EXISTS public.idx_sarvam_agent_integrations_one_active;

INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES ('20261120090000', 'dual_agent_provisioning', ARRAY[$gate_m2$-- Dual-agent provisioning: every customer gets a second, outbound-only Sarvam
-- agent next to the inbound one (docs/dual-agent-provisioning-audit.md).
--
-- agent_configs
--   sarvam_outbound_app_id / sarvam_outbound_app_version: the customer's own
--   outbound agent, registered by an operator after creating it in Sarvam
--   from the outbound template. Outbound calls dial ONLY this agent; there is
--   no fallback to sarvam_app_id (the inbound agent).
--   sarvam_outbound_ready_app_id/_version (20261117180000) keep their
--   meaning, "confirmed after a supervised call", and must now equal this
--   outbound mapping before ClickAI dials.
--   A trigger keeps the two roles apart across ALL customers: an outbound
--   agent can never be anyone's inbound agent or shared application, and the
--   reverse; a unique index stops two customers sharing an outbound agent.
--
-- sarvam_agent_integrations
--   role: which agent a credential belongs to. Existing credentials are
--   'inbound'. ClickAI's agent API refuses every booking, callback and other
--   write tool for an 'outbound' credential. One active credential per agent
--   config AND role (was: per agent config).
--
-- Additive and backward-compatible: nullable columns, a defaulted column, a
-- CHECK, a unique index, a trigger, and the one-active index widened by role.
-- No existing row changes. Re-runnable. Rollback:
-- docs/production-rollback-20261120090000-dual-agent-provisioning.sql

ALTER TABLE public.agent_configs
  ADD COLUMN IF NOT EXISTS sarvam_outbound_app_id text,
  ADD COLUMN IF NOT EXISTS sarvam_outbound_app_version integer,
  ADD COLUMN IF NOT EXISTS sarvam_outbound_registered_at timestamptz,
  ADD COLUMN IF NOT EXISTS sarvam_outbound_registered_by uuid;

-- Explicit IS NOT NULL: a CHECK that evaluates to NULL passes.
ALTER TABLE public.agent_configs DROP CONSTRAINT IF EXISTS agent_configs_outbound_agent_complete;
ALTER TABLE public.agent_configs
  ADD CONSTRAINT agent_configs_outbound_agent_complete CHECK (
    (sarvam_outbound_app_id IS NULL AND sarvam_outbound_app_version IS NULL)
    OR (
      sarvam_outbound_app_id IS NOT NULL
      AND sarvam_outbound_app_version IS NOT NULL
      AND length(btrim(sarvam_outbound_app_id)) > 0
      AND sarvam_outbound_app_version > 0
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_configs_sarvam_outbound_app_id
  ON public.agent_configs (sarvam_outbound_app_id)
  WHERE sarvam_outbound_app_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.agent_configs_sarvam_role_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Same lock key as agent_configs_sarvam_application_guard, so mapping an
  -- app as inbound and registering it as outbound cannot race each other.
  IF NEW.sarvam_app_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('agent_configs.sarvam_app_id:' || NEW.sarvam_app_id));
  END IF;
  IF NEW.sarvam_outbound_app_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('agent_configs.sarvam_app_id:' || NEW.sarvam_outbound_app_id));
    IF NEW.sarvam_outbound_app_id = NEW.sarvam_app_id THEN
      RAISE EXCEPTION 'SARVAM_OUTBOUND_AGENT_IS_INBOUND' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.agent_configs a
       WHERE a.id <> NEW.id AND a.sarvam_app_id = NEW.sarvam_outbound_app_id
    ) OR EXISTS (
      SELECT 1 FROM public.sarvam_applications s
       WHERE s.sarvam_app_id = NEW.sarvam_outbound_app_id
    ) THEN
      RAISE EXCEPTION 'SARVAM_OUTBOUND_AGENT_IN_USE_AS_INBOUND' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.sarvam_app_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.agent_configs a
     WHERE a.id <> NEW.id AND a.sarvam_outbound_app_id = NEW.sarvam_app_id
  ) THEN
    RAISE EXCEPTION 'SARVAM_INBOUND_AGENT_IS_AN_OUTBOUND_AGENT' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_agent_configs_sarvam_role_guard ON public.agent_configs;
-- sarvam_application_id too: mapping an agent through a shared application
-- sets sarvam_app_id inside agent_configs_sarvam_application_guard (which
-- fires first, by name), without naming sarvam_app_id in the UPDATE.
CREATE TRIGGER trg_agent_configs_sarvam_role_guard
  BEFORE INSERT OR UPDATE OF sarvam_app_id, sarvam_application_id, sarvam_outbound_app_id
  ON public.agent_configs
  FOR EACH ROW EXECUTE FUNCTION public.agent_configs_sarvam_role_guard();

ALTER TABLE public.sarvam_agent_integrations
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'inbound';
ALTER TABLE public.sarvam_agent_integrations DROP CONSTRAINT IF EXISTS sarvam_agent_integrations_role_check;
ALTER TABLE public.sarvam_agent_integrations
  ADD CONSTRAINT sarvam_agent_integrations_role_check CHECK (role IN ('inbound', 'outbound'));

-- Create the wider index first, so there is never a moment with neither.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sarvam_agent_integrations_one_active_per_role
  ON public.sarvam_agent_integrations (agent_config_id, role) WHERE status = 'active';
DROP INDEX IF EXISTS public.idx_sarvam_agent_integrations_one_active;
$gate_m2$]);

-- ===== In-transaction check: anything unexpected raises and rolls back both migrations =====
DO $check$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'call_logs' AND column_name IN ('idempotency_key', 'billing_cap_minutes', 'billing_rate_per_minute')) OR (table_name = 'agent_configs' AND column_name IN ('sarvam_outbound_max_call_seconds', 'sarvam_outbound_app_id', 'sarvam_outbound_app_version', 'sarvam_outbound_registered_at', 'sarvam_outbound_registered_by')) OR (table_name = 'sarvam_agent_integrations' AND column_name IN ('role')))) <> 9 THEN
    RAISE EXCEPTION 'GATE_R2_CHECK: expected 9 new columns';
  END IF;
  IF (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('idx_call_logs_org_idempotency_key', 'idx_call_logs_single_outbound_recent', 'idx_call_logs_single_outbound_open', 'idx_call_logs_inbound_caller', 'idx_agent_configs_sarvam_outbound_app_id', 'idx_sarvam_agent_integrations_one_active_per_role') AND i.indisvalid AND i.indisready) <> 6 THEN
    RAISE EXCEPTION 'GATE_R2_CHECK: expected 6 new valid indexes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'idx_sarvam_agent_integrations_one_active' AND relkind = 'i') THEN
    RAISE EXCEPTION 'GATE_R2_CHECK: old credential index still present';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE (conname = 'agent_configs_outbound_max_call_seconds_range' AND conrelid = 'public.agent_configs'::regclass) OR (conname = 'call_logs_idempotency_key_format' AND conrelid = 'public.call_logs'::regclass) OR (conname = 'call_logs_billing_lock_valid' AND conrelid = 'public.call_logs'::regclass) OR (conname = 'agent_configs_outbound_agent_complete' AND conrelid = 'public.agent_configs'::regclass) OR (conname = 'sarvam_agent_integrations_role_check' AND conrelid = 'public.sarvam_agent_integrations'::regclass)) <> 5 THEN
    RAISE EXCEPTION 'GATE_R2_CHECK: expected 5 new constraints on their tables';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('admit_single_outbound_call', 'agent_configs_sarvam_role_guard')) <> 2 THEN
    RAISE EXCEPTION 'GATE_R2_CHECK: expected 2 new functions';
  END IF;
  IF (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.agent_configs'::regclass AND tgname = 'trg_agent_configs_sarvam_role_guard') IS DISTINCT FROM 'CREATE TRIGGER trg_agent_configs_sarvam_role_guard BEFORE INSERT OR UPDATE OF sarvam_app_id, sarvam_application_id, sarvam_outbound_app_id ON public.agent_configs FOR EACH ROW EXECUTE FUNCTION agent_configs_sarvam_role_guard()' THEN
    RAISE EXCEPTION 'GATE_R2_CHECK: role guard trigger definition: %', (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.agent_configs'::regclass AND tgname = 'trg_agent_configs_sarvam_role_guard');
  END IF;
  IF has_function_privilege('anon', 'public.admit_single_outbound_call(uuid,uuid,text,text,text,integer,integer,integer,integer)', 'execute')
     OR has_function_privilege('authenticated', 'public.admit_single_outbound_call(uuid,uuid,text,text,text,integer,integer,integer,integer)', 'execute')
     OR NOT has_function_privilege('service_role', 'public.admit_single_outbound_call(uuid,uuid,text,text,text,integer,integer,integer,integer)', 'execute') THEN
    RAISE EXCEPTION 'GATE_R2_CHECK: admission function grants';
  END IF;
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version IN ('20261119090000', '20261120090000')) <> 2 THEN
    RAISE EXCEPTION 'GATE_R2_CHECK: history';
  END IF;
  -- Every existing row of every customer-relevant table is unchanged (new columns excluded).
  IF md5((SELECT 'organizations:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.organizations x) || ';' || (SELECT 'businesses:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.businesses x) || ';' || (SELECT 'agent_configs:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x) - 'sarvam_outbound_max_call_seconds' - 'sarvam_outbound_app_id' - 'sarvam_outbound_app_version' - 'sarvam_outbound_registered_at' - 'sarvam_outbound_registered_by')::text, '|' ORDER BY (to_jsonb(x) - 'sarvam_outbound_max_call_seconds' - 'sarvam_outbound_app_id' - 'sarvam_outbound_app_version' - 'sarvam_outbound_registered_at' - 'sarvam_outbound_registered_by')::text)), '-') FROM public.agent_configs x) || ';' || (SELECT 'phone_numbers:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.phone_numbers x) || ';' || (SELECT 'sarvam_agent_integrations:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x) - 'role')::text, '|' ORDER BY (to_jsonb(x) - 'role')::text)), '-') FROM public.sarvam_agent_integrations x) || ';' || (SELECT 'telephony_connections:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.telephony_connections x) || ';' || (SELECT 'sarvam_applications:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.sarvam_applications x) || ';' || (SELECT 'wallet_balances:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.wallet_balances x) || ';' || (SELECT 'wallet_transactions:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.wallet_transactions x) || ';' || (SELECT 'campaigns:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.campaigns x) || ';' || (SELECT 'campaign_contacts:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.campaign_contacts x) || ';' || (SELECT 'platform_settings:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.platform_settings x) || ';' || (SELECT 'call_logs:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x) - 'idempotency_key' - 'billing_cap_minutes' - 'billing_rate_per_minute')::text, '|' ORDER BY (to_jsonb(x) - 'idempotency_key' - 'billing_cap_minutes' - 'billing_rate_per_minute')::text)), '-') FROM public.call_logs x)) IS DISTINCT FROM current_setting('gate_r2.data_before', true) THEN
    RAISE EXCEPTION 'GATE_R2_CHECK: existing data changed';
  END IF;
  -- New columns on existing rows: all empty, every credential inbound.
  IF EXISTS (SELECT 1 FROM public.agent_configs WHERE sarvam_outbound_app_id IS NOT NULL OR sarvam_outbound_app_version IS NOT NULL
              OR sarvam_outbound_registered_at IS NOT NULL OR sarvam_outbound_registered_by IS NOT NULL
              OR sarvam_outbound_max_call_seconds IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.call_logs WHERE idempotency_key IS NOT NULL OR billing_cap_minutes IS NOT NULL
              OR billing_rate_per_minute IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.sarvam_agent_integrations WHERE role IS DISTINCT FROM 'inbound') THEN
    RAISE EXCEPTION 'GATE_R2_CHECK: new columns not empty / credential role';
  END IF;
END $check$;

-- Returned only if every statement above succeeded; the whole request then commits.
SELECT json_build_object(
  'applied', (SELECT json_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations WHERE version >= '20261119090000'),
  'system_identifier', (SELECT system_identifier::text FROM pg_control_system()),
  'database', current_database(),
  'new_columns', (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'call_logs' AND column_name IN ('idempotency_key', 'billing_cap_minutes', 'billing_rate_per_minute')) OR (table_name = 'agent_configs' AND column_name IN ('sarvam_outbound_max_call_seconds', 'sarvam_outbound_app_id', 'sarvam_outbound_app_version', 'sarvam_outbound_registered_at', 'sarvam_outbound_registered_by')) OR (table_name = 'sarvam_agent_integrations' AND column_name IN ('role')))),
  'new_valid_indexes', (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('idx_call_logs_org_idempotency_key', 'idx_call_logs_single_outbound_recent', 'idx_call_logs_single_outbound_open', 'idx_call_logs_inbound_caller', 'idx_agent_configs_sarvam_outbound_app_id', 'idx_sarvam_agent_integrations_one_active_per_role') AND i.indisvalid AND i.indisready),
  'new_constraints', (SELECT count(*) FROM pg_constraint WHERE (conname = 'agent_configs_outbound_max_call_seconds_range' AND conrelid = 'public.agent_configs'::regclass) OR (conname = 'call_logs_idempotency_key_format' AND conrelid = 'public.call_logs'::regclass) OR (conname = 'call_logs_billing_lock_valid' AND conrelid = 'public.call_logs'::regclass) OR (conname = 'agent_configs_outbound_agent_complete' AND conrelid = 'public.agent_configs'::regclass) OR (conname = 'sarvam_agent_integrations_role_check' AND conrelid = 'public.sarvam_agent_integrations'::regclass)),
  'new_functions', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('admit_single_outbound_call', 'agent_configs_sarvam_role_guard')),
  'role_guard_trigger', (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.agent_configs'::regclass AND tgname = 'trg_agent_configs_sarvam_role_guard'),
  'old_credential_index_present', EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'idx_sarvam_agent_integrations_one_active' AND relkind = 'i'),
  'admission_executable_by_anon', has_function_privilege('anon', 'public.admit_single_outbound_call(uuid,uuid,text,text,text,integer,integer,integer,integer)', 'execute'),
  'existing_data_unchanged', md5((SELECT 'organizations:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.organizations x) || ';' || (SELECT 'businesses:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.businesses x) || ';' || (SELECT 'agent_configs:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x) - 'sarvam_outbound_max_call_seconds' - 'sarvam_outbound_app_id' - 'sarvam_outbound_app_version' - 'sarvam_outbound_registered_at' - 'sarvam_outbound_registered_by')::text, '|' ORDER BY (to_jsonb(x) - 'sarvam_outbound_max_call_seconds' - 'sarvam_outbound_app_id' - 'sarvam_outbound_app_version' - 'sarvam_outbound_registered_at' - 'sarvam_outbound_registered_by')::text)), '-') FROM public.agent_configs x) || ';' || (SELECT 'phone_numbers:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.phone_numbers x) || ';' || (SELECT 'sarvam_agent_integrations:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x) - 'role')::text, '|' ORDER BY (to_jsonb(x) - 'role')::text)), '-') FROM public.sarvam_agent_integrations x) || ';' || (SELECT 'telephony_connections:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.telephony_connections x) || ';' || (SELECT 'sarvam_applications:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.sarvam_applications x) || ';' || (SELECT 'wallet_balances:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.wallet_balances x) || ';' || (SELECT 'wallet_transactions:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.wallet_transactions x) || ';' || (SELECT 'campaigns:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.campaigns x) || ';' || (SELECT 'campaign_contacts:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.campaign_contacts x) || ';' || (SELECT 'platform_settings:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x))::text, '|' ORDER BY (to_jsonb(x))::text)), '-') FROM public.platform_settings x) || ';' || (SELECT 'call_logs:' || count(*) || ':' || coalesce(md5(string_agg((to_jsonb(x) - 'idempotency_key' - 'billing_cap_minutes' - 'billing_rate_per_minute')::text, '|' ORDER BY (to_jsonb(x) - 'idempotency_key' - 'billing_cap_minutes' - 'billing_rate_per_minute')::text)), '-') FROM public.call_logs x)) = current_setting('gate_r2.data_before', true),
  'lock_timeout', current_setting('lock_timeout'),
  'statement_timeout', current_setting('statement_timeout')
) AS gate_r2_result;
