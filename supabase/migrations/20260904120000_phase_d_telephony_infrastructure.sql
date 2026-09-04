-- PHASE D — Telephony & phone number infrastructure
--
-- Extends the existing `phone_numbers` and `call_logs` tables (created in
-- the original Phase 0-A schema) rather than creating parallel tables.
-- Billing reuses the existing `wallet_transactions` ledger, `pricing_rules`
-- (voice_minute / outbound_minute already exist), `usage_records`, and the
-- existing `webhook_events` idempotency table. Authorization reuses
-- `feature_locked()`, `organization_entitlements`, `organization_feature_locks`
-- and `assertPlatformAdmin` (capabilities `numbers.write` / `customers.read`
-- already existed before this migration). No second phone-number, call,
-- billing, wallet, entitlement or pricing system is introduced.

-- ============================================================
-- 1. phone_numbers — provisioning metadata + provider linkage
-- ============================================================
ALTER TABLE public.phone_numbers
  ADD COLUMN IF NOT EXISTS provider_number_id text,
  ADD COLUMN IF NOT EXISTS display_number text,
  ADD COLUMN IF NOT EXISTS agent_config_id uuid REFERENCES public.agent_configs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS purchased_at timestamptz,
  ADD COLUMN IF NOT EXISTS released_at timestamptz,
  ADD COLUMN IF NOT EXISTS provisioned_by uuid,
  ADD COLUMN IF NOT EXISTS suspended_reason text;

-- `status` already existed as free text (default 'pending'); constrain it to
-- the canonical provisioning lifecycle now that Phase D depends on it.
DO $$ BEGIN
  ALTER TABLE public.phone_numbers ADD CONSTRAINT phone_numbers_status_check
    CHECK (status IN ('pending', 'provisioning', 'active', 'suspended', 'released', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A number can be provisioned once per provider, and — critically — the same
-- E.164 number can never be `active` for more than one organization at once
-- (spec §3/§23: "the database must prevent the same active phone number
-- from being assigned to multiple customers"). The pre-existing
-- UNIQUE(organization_id, e164) does not cover this cross-organization case.
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_numbers_e164_active_global
  ON public.phone_numbers (e164) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_numbers_provider_number_id
  ON public.phone_numbers (provider, provider_number_id) WHERE provider_number_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_phone_numbers_org_status ON public.phone_numbers (organization_id, status);

DROP TRIGGER IF EXISTS trg_phone_numbers_updated ON public.phone_numbers;
CREATE TRIGGER trg_phone_numbers_updated BEFORE UPDATE ON public.phone_numbers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Numbers remain admin/service-role-writable only — authenticated customers
-- already only had SELECT (never INSERT/UPDATE) on this table; that does not
-- change here. Every provisioning/assignment/suspend/release action goes
-- through the audited admin server functions in telephony-admin.functions.ts.

-- ============================================================
-- 2. call_logs — provider linkage, lifecycle detail, financials
-- ============================================================
ALTER TABLE public.call_logs
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'sarvam',
  ADD COLUMN IF NOT EXISTS provider_call_id text,
  ADD COLUMN IF NOT EXISTS destination_number text,
  ADD COLUMN IF NOT EXISTS answered_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS customer_charge integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_cost integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.call_logs
  ADD COLUMN IF NOT EXISTS gross_profit integer GENERATED ALWAYS AS (customer_charge - provider_cost) STORED;

DO $$ BEGIN
  ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_status_check
    CHECK (status IN ('initiated', 'ringing', 'answered', 'in_progress', 'completed', 'failed', 'busy', 'no_answer', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.call_logs ADD CONSTRAINT call_logs_direction_check
    CHECK (direction IN ('inbound', 'outbound'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Idempotency / uniqueness for provider call IDs (spec §23/§O/§R): a provider
-- webhook retried for the same call must never create a second row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_logs_provider_call_id
  ON public.call_logs (provider, provider_call_id) WHERE provider_call_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_call_logs_phone_number ON public.call_logs (phone_number_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_status ON public.call_logs (status);
CREATE INDEX IF NOT EXISTS idx_call_logs_org_started ON public.call_logs (organization_id, started_at DESC);

DROP TRIGGER IF EXISTS trg_call_logs_updated ON public.call_logs;
CREATE TRIGGER trg_call_logs_updated BEFORE UPDATE ON public.call_logs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Column-level protection for the new financial columns (spec §12/§18/§T):
-- provider_cost and gross_profit must never reach a customer, exactly like
-- the Phase A fix already applied to usage_records. The pre-existing
-- `GRANT SELECT ON public.call_logs TO authenticated` is table-wide, so it
-- would otherwise leak these the moment any customer-facing query does
-- `select("*")`. Replace it with an explicit safe column list. customer_charge
-- (what the customer is actually billed) IS included — customers may see
-- their own charges (spec §16) — provider_cost/gross_profit/provider_metadata
-- are not.
REVOKE SELECT ON public.call_logs FROM authenticated;
GRANT SELECT (
  id, organization_id, business_id, phone_number_id, provider, provider_call_id,
  direction, caller_number, caller_name, destination_number, status, outcome,
  language, duration_seconds, agent_version, recording_url, transcript, summary,
  lead_score, customer_charge, currency, started_at, answered_at, ended_at,
  failure_reason, created_at, updated_at
) ON public.call_logs TO authenticated;
-- provider_cost, gross_profit, provider_metadata intentionally excluded from
-- the authenticated grant above. Only service_role (admin/server-side
-- telephony code) can read them.

-- Defense in depth for wallet idempotency: even though debit_wallet_for_call
-- already serializes concurrent debits under a row lock and checks for an
-- existing reference before inserting, this constraint makes a duplicate
-- call-usage debit for the same call impossible at the storage layer too —
-- independent of any future code path that might touch wallet_transactions
-- directly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_call_usage_ref
  ON public.wallet_transactions (organization_id, reference) WHERE kind = 'call_usage';

-- Belt-and-suspenders idempotency at the storage layer for the usage ledger
-- (in addition to the wallet debit's own idempotency below): a given call can
-- contribute at most one usage_records row per kind, so even a bug that
-- invoked the finalize path twice cannot double-count revenue/cost.
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_records_call_kind
  ON public.usage_records (call_id, kind) WHERE call_id IS NOT NULL;

-- ============================================================
-- 3. Atomic, idempotent wallet debit for call billing (spec §13/§14/§P/§S)
-- ============================================================
-- Locks the organization's wallet for the duration of the balance read +
-- insert, so two calls finalizing concurrently for the same organization
-- cannot both read the same stale balance and both proceed — the second
-- caller blocks on FOR UPDATE until the first transaction commits, then sees
-- the already-applied debit. Idempotent on (organization_id, kind='call_usage',
-- reference=call_id): a webhook retried after the debit already landed is a
-- no-op, never a double charge (spec §O/§P).
CREATE OR REPLACE FUNCTION public.debit_wallet_for_call(
  _org uuid, _call_id uuid, _amount integer, _description text
) RETURNS TABLE(applied boolean, already_applied boolean, balance integer)
LANGUAGE plpgsql AS $$
DECLARE
  existing_ref text;
  new_balance integer;
BEGIN
  -- Serializes concurrent finalizations for this organization.
  PERFORM 1 FROM public.organizations WHERE id = _org FOR UPDATE;

  SELECT reference INTO existing_ref FROM public.wallet_transactions
    WHERE organization_id = _org AND kind = 'call_usage' AND reference = _call_id::text
    LIMIT 1;
  IF existing_ref IS NOT NULL THEN
    SELECT public.wallet_balance(_org) INTO new_balance;
    RETURN QUERY SELECT true, true, new_balance;
    RETURN;
  END IF;

  IF _amount <> 0 THEN
    INSERT INTO public.wallet_transactions (organization_id, amount, kind, description, reference)
    VALUES (_org, -_amount, 'call_usage', _description, _call_id::text);
  END IF;

  SELECT public.wallet_balance(_org) INTO new_balance;
  RETURN QUERY SELECT true, false, new_balance;
END; $$;

REVOKE ALL ON FUNCTION public.debit_wallet_for_call(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_wallet_for_call(uuid, uuid, integer, text) TO service_role;

-- Pre-call affordability gate for outbound dialing. Read-only (no funds move
-- here — the real cost is only known once the call ends and is applied by
-- debit_wallet_for_call above), but still taken under the same row lock so
-- it reflects every debit committed so far, not a stale cached balance.
CREATE OR REPLACE FUNCTION public.wallet_can_afford(_org uuid, _amount integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE bal integer;
BEGIN
  PERFORM 1 FROM public.organizations WHERE id = _org FOR UPDATE;
  SELECT public.wallet_balance(_org) INTO bal;
  RETURN bal >= _amount;
END; $$;

REVOKE ALL ON FUNCTION public.wallet_can_afford(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_can_afford(uuid, integer) TO service_role;

-- ============================================================
-- 4. Audit action vocabulary note (no schema change — writeAudit already
--    accepts a free-form action string; documenting the new ones added by
--    Phase D code: NUMBER_PROVISIONED, NUMBER_ASSIGNED, NUMBER_REASSIGNED,
--    NUMBER_SUSPENDED, NUMBER_RELEASED, NUMBER_INBOUND_SET,
--    NUMBER_OUTBOUND_SET, CALL_OUTBOUND_INITIATED)
-- ============================================================
