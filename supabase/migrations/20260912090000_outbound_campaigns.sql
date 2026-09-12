-- Outbound campaigns (V1)
--
-- Klyro-owned CRM contacts + campaign orchestration layer on top of the
-- already-existing, already-working single-call outbound path
-- (telephony-outbound.functions.ts / sarvam-outbound.functions.ts,
-- checkTelephonyAccess, walletCanAffordOutbound, finalizeCallBilling, and
-- the outbound branch already present in the telephony webhook route). No
-- second calling/billing/authorization system is introduced — a campaign is
-- Klyro's own pacing/retry loop that calls the existing per-call path once
-- per contact.
--
-- Per the prior Sarvam API verification audit: Sarvam has no verified
-- public API for creating a provider-side "campaign" or streaming a cohort
-- of contacts to it. This schema therefore does NOT store a
-- provider-side campaign id as the source of truth — Klyro's own
-- `campaigns`/`campaign_contacts` rows are that source of truth, and
-- dispatch happens as a sequence of the already-verified-as-far-as-possible
-- single-call `createInstantOutbound` requests, one per contact. See
-- campaign-dispatch.server.ts for the dispatcher this schema supports.

-- ============================================================
-- 1. contacts — Klyro's own CRM, independent of any one campaign
-- ============================================================
CREATE TABLE public.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  name TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'manual',
  opted_out BOOLEAN NOT NULL DEFAULT false,
  opted_out_at TIMESTAMPTZ,
  opted_out_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contacts_phone_e164 CHECK (phone ~ '^\+[1-9]\d{6,14}$'),
  UNIQUE (organization_id, phone)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO authenticated;
GRANT ALL ON public.contacts TO service_role;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant contacts" ON public.contacts FOR ALL TO authenticated
  USING (public.is_org_member(organization_id)) WITH CHECK (public.is_org_member(organization_id));
CREATE TRIGGER trg_contacts_updated BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX idx_contacts_org ON public.contacts (organization_id);
CREATE INDEX idx_contacts_opted_out ON public.contacts (organization_id) WHERE opted_out = true;

-- ============================================================
-- 2. campaigns — Klyro's own outbound-calling campaign definition
-- ============================================================
CREATE TABLE public.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  agent_config_id UUID REFERENCES public.agent_configs(id) ON DELETE SET NULL,
  phone_number_id UUID REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  objective TEXT,
  call_instructions TEXT,
  -- {csvColumn: variableName} template applied on every contact upload into this campaign.
  variable_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- User-defined result fields the campaign creator expects the agent to report,
  -- e.g. [{"key":"appointment_confirmed","label":"Appointment confirmed","values":["yes","no"]}].
  -- Purely descriptive/for-display — extraction is opportunistic (see the
  -- webhook extension), matched by key against whatever the provider's
  -- agentVariables actually contain, never guaranteed.
  output_variable_defs JSONB NOT NULL DEFAULT '[]'::jsonb,
  language TEXT,
  voice_id TEXT,
  -- {startDate,endDate,windowStart,windowEnd,days:[0-6],timezone}
  schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  retry_after_minutes INTEGER NOT NULL DEFAULT 120,
  retry_statuses TEXT[] NOT NULL DEFAULT ARRAY['no_answer','busy','failed']::text[],
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  launched_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  CONSTRAINT campaigns_status_check CHECK (
    status IN ('draft','scheduled','queued','running','paused','completed','failed','cancelled')
  ),
  CONSTRAINT campaigns_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 10)
);
GRANT SELECT ON public.campaigns TO authenticated;
GRANT ALL ON public.campaigns TO service_role;
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant campaigns read" ON public.campaigns FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id));

-- Customers configure a campaign's own settings directly (same pattern as
-- agent_configs) but can never set status/launched_at/paused_at/
-- completed_at/cancelled_at themselves — every status transition goes
-- through the audited server functions in campaigns.functions.ts, which
-- re-run the full authorization/billing/readiness gate before writing it
-- (mirrors the sarvam_provider_mapping migration's rationale exactly).
GRANT INSERT (
  organization_id, business_id, agent_config_id, phone_number_id, name,
  objective, call_instructions, variable_mapping, output_variable_defs,
  language, voice_id, schedule, max_attempts, retry_after_minutes,
  retry_statuses, created_by
) ON public.campaigns TO authenticated;
CREATE POLICY "members create campaign" ON public.campaigns FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(organization_id));

GRANT UPDATE (
  business_id, agent_config_id, phone_number_id, name, objective,
  call_instructions, variable_mapping, output_variable_defs, language,
  voice_id, schedule, max_attempts, retry_after_minutes, retry_statuses
) ON public.campaigns TO authenticated;
CREATE POLICY "members update draft campaign" ON public.campaigns FOR UPDATE TO authenticated
  USING (public.is_org_member(organization_id) AND status IN ('draft','scheduled'))
  WITH CHECK (public.is_org_member(organization_id));

CREATE TRIGGER trg_campaigns_updated BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX idx_campaigns_org_status ON public.campaigns (organization_id, status);

-- ============================================================
-- 3. campaign_contacts — one row per contact enrolled in a campaign
-- ============================================================
CREATE TABLE public.campaign_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  call_id UUID REFERENCES public.call_logs(id) ON DELETE SET NULL,
  -- Per-contact variables resolved at enrollment time (campaign.variable_mapping
  -- applied to the contact's custom_fields + name/phone), sent verbatim as
  -- agent_variables on each dial attempt for this contact.
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  outcome TEXT,
  output_variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT campaign_contacts_status_check CHECK (status IN (
    'pending','queued','calling','connected','no_answer','busy','failed',
    'completed','retry_scheduled','opted_out','wrong_number','cancelled'
  )),
  UNIQUE (campaign_id, contact_id)
);
GRANT SELECT ON public.campaign_contacts TO authenticated;
GRANT ALL ON public.campaign_contacts TO service_role;
ALTER TABLE public.campaign_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant campaign contacts read" ON public.campaign_contacts FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id));
-- INSERT/UPDATE deliberately service_role-only: enrollment goes through the
-- CSV-import/add-existing-contacts server functions (so variable_mapping is
-- applied consistently and opted-out contacts are never enrolled), and every
-- status/attempts/outcome change is driven by the dispatcher or the webhook,
-- never a direct customer write (same discipline as call_logs/phone_numbers).

CREATE TRIGGER trg_campaign_contacts_updated BEFORE UPDATE ON public.campaign_contacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE INDEX idx_campaign_contacts_campaign_status ON public.campaign_contacts (campaign_id, status);
-- The dispatcher's core query: "give me due contacts across all running campaigns".
CREATE INDEX idx_campaign_contacts_due ON public.campaign_contacts (status, next_attempt_at)
  WHERE status IN ('pending','retry_scheduled');
CREATE INDEX idx_campaign_contacts_call ON public.campaign_contacts (call_id) WHERE call_id IS NOT NULL;

-- ============================================================
-- 4. campaign_uploads — audit trail for each CSV import into a campaign
-- ============================================================
CREATE TABLE public.campaign_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  filename TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  valid_rows INTEGER NOT NULL DEFAULT 0,
  invalid_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.campaign_uploads TO authenticated;
GRANT ALL ON public.campaign_uploads TO service_role;
ALTER TABLE public.campaign_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant campaign uploads read" ON public.campaign_uploads FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id));

-- ============================================================
-- 5. call_logs — link a call back to the campaign/contact that caused it
-- ============================================================
ALTER TABLE public.call_logs
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign_contact_id UUID REFERENCES public.campaign_contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retry_attempt INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_call_logs_campaign ON public.call_logs (campaign_id) WHERE campaign_id IS NOT NULL;

-- Extend the customer-safe column grant (Phase D restricted call_logs SELECT
-- to an explicit list) to include the new, non-sensitive campaign linkage
-- columns. Still excludes provider_cost/gross_profit/provider_metadata.
GRANT SELECT (campaign_id, campaign_contact_id, contact_id, retry_attempt) ON public.call_logs TO authenticated;

-- ============================================================
-- 6. leads — link a campaign-sourced lead back to its campaign/contact
-- ============================================================
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES public.campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON public.leads (campaign_id) WHERE campaign_id IS NOT NULL;
