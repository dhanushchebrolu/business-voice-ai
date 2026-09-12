-- Sarvam campaign dispatch mode (V2 of outbound campaigns)
--
-- The prior outbound-campaign migration (20260912090000) shipped exactly one
-- dispatch mechanism: Klyro's own pacing loop calling Sarvam's single-call
-- createInstantOutbound once per contact. That mechanism is renamed here,
-- explicitly, to what it actually is — a FALLBACK, not "a Sarvam campaign" —
-- and a second, still-unverified mode is added alongside it so the two can
-- never be silently conflated. See campaign-dispatch.server.ts and
-- campaigns.functions.ts for exactly how each mode is used, and
-- sarvam-api-client.server.ts's uploadCohort() doc comment for the
-- verification status of the cohort-upload endpoint this second mode calls.

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS dispatch_mode text NOT NULL DEFAULT 'instant_outbound_fallback',
  ADD COLUMN IF NOT EXISTS provider_campaign_id text,
  ADD COLUMN IF NOT EXISTS provider_cohort_id text;

DO $$ BEGIN
  ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_dispatch_mode_check
    CHECK (dispatch_mode IN ('instant_outbound_fallback', 'sarvam_campaign'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- provider_campaign_id maps a Klyro campaign to a Sarvam-dashboard-created
-- campaign shell (campaign *creation* has no verified API — see the module
-- doc — so this is always set by an admin after creating it manually in
-- Sarvam's dashboard, the same manual-mapping pattern agent_configs.sarvam_app_id
-- and telephony_connections.provider_connection_id already use).
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_provider_campaign_id
  ON public.campaigns (provider_campaign_id) WHERE provider_campaign_id IS NOT NULL;

-- dispatch_mode/provider_campaign_id/provider_cohort_id are deliberately NOT
-- added to the customer-writable column grant from the prior migration —
-- selecting a dispatch mode and mapping a provider campaign id are
-- operational/provider-integration decisions, not campaign *content*, and
-- must go through the same audited server-function path as launching itself
-- (campaigns.functions.ts). The existing "members update draft campaign"
-- policy's WITH CHECK still passes for these rows (it only checks org
-- membership), but since no UPDATE grant exists for these three columns,
-- Postgres rejects a customer UPDATE statement that touches them before RLS
-- is even evaluated.

-- ============================================================
-- Idempotency / no-duplicate-dispatch (spec "SEVENTH"): a campaign_contact
-- must never have two concurrently-live call attempts. This is enforced at
-- the storage layer, not just in application code, so a race between two
-- overlapping dispatcher ticks (or a retried cron invocation) cannot double
-- -dial the same contact even if the application-level atomic claim
-- (campaign-dispatch.server.ts) had a bug.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_logs_campaign_contact_inflight
  ON public.call_logs (campaign_contact_id)
  WHERE campaign_contact_id IS NOT NULL
    AND status NOT IN ('completed', 'failed', 'busy', 'no_answer', 'cancelled');
