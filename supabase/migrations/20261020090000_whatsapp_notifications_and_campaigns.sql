-- WhatsApp: booking/payment notifications, consent, templates, campaigns.
--
-- Builds on 20260923090000 (connections/conversations/messages),
-- 20260926090000 (bookings lifecycle, payment_requests,
-- payment_domain_events) and 20261019090000 (AI replies). Additive only:
-- new tables, new nullable/defaulted columns, triggers, one unique index.
--
-- 1. whatsapp_connections: notifications are OFF until a business owner or
--    admin turns them on (notifications_enabled) and records the basis on
--    which its customers agreed to booking/payment messages
--    (transactional_consent_basis). Nothing is ever enqueued for a business
--    that hasn't, so applying this migration sends nothing by itself.
--
-- 2. whatsapp_consent_events: append-only consent ledger per business and
--    customer number (wa_id, E.164 digits without '+'), per scope
--    ('transactional' | 'marketing'). The latest event for a scope wins.
--    Opt-outs come from the customer (STOP), staff, or a Meta signal.
--    whatsapp_suppressions: numbers that must never get a business-initiated
--    message (invalid number, blocked, staff decision, Meta policy).
--
-- 3. whatsapp_templates: the Message Templates of each connected number,
--    synced from Meta (status/category are Meta's), with an optional
--    `purpose` so notifications know which approved template to use.
--
-- 4. whatsapp_notifications: the outbox. Triggers on bookings,
--    payment_requests and payment_domain_events enqueue one row per logical
--    notification (unique dedupe_key), so every writer — voice tools, the
--    dashboard, the atomic RPCs, the payment webhook — is covered without
--    touching their code. A cron worker sends them; every row ends 'sent',
--    'skipped' (with a reason) or 'failed', with bounded retries.
--
-- 5. whatsapp_pending_actions: a booking/reschedule the AI proposed on
--    WhatsApp, executed by the server only after the customer replies YES.
--
-- 6. whatsapp_campaigns / whatsapp_campaign_recipients: template campaigns
--    to consenting, unsuppressed contacts, rate-limited and resumable.
--
-- 7. whatsapp_audit_log: who changed consent, templates, notification
--    settings and campaigns, and when.
--
-- 8. A unique index so one idempotency key can never have two live
--    outbound messages on a connection (concurrent senders lose with 23505).
--
-- Browsers can read their own organization's rows (RLS) and write nothing;
-- every write goes through server code with the service role.

-- ---------------------------------------------------------------------------
-- 1. Notification settings on the connection
ALTER TABLE public.whatsapp_connections
  ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS transactional_consent_basis TEXT,
  ADD COLUMN IF NOT EXISTS notifications_enabled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notifications_enabled_by UUID;

-- The dashboard role has a column grant on whatsapp_connections; make sure
-- the new columns are readable but not writable from the browser.
GRANT SELECT (notifications_enabled, transactional_consent_basis, notifications_enabled_at)
  ON public.whatsapp_connections TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Consent ledger and suppressions
CREATE TABLE IF NOT EXISTS public.whatsapp_consent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  wa_id TEXT NOT NULL CHECK (wa_id ~ '^[1-9][0-9]{6,14}$'),
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK (scope IN ('transactional', 'marketing')),
  action TEXT NOT NULL CHECK (action IN ('opt_in', 'opt_out')),
  source TEXT NOT NULL CHECK (source IN (
    'staff_attested', 'customer_keyword', 'customer_form', 'import', 'meta_signal'
  )),
  evidence TEXT CHECK (evidence IS NULL OR length(evidence) <= 1000),
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_consent_latest
  ON public.whatsapp_consent_events (business_id, scope, wa_id, created_at DESC);
GRANT SELECT ON public.whatsapp_consent_events TO authenticated;
-- Append-only: the server inserts; nobody updates or deletes through the API.
GRANT SELECT, INSERT ON public.whatsapp_consent_events TO service_role;
ALTER TABLE public.whatsapp_consent_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant whatsapp consent read" ON public.whatsapp_consent_events;
CREATE POLICY "tenant whatsapp consent read" ON public.whatsapp_consent_events
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

CREATE TABLE IF NOT EXISTS public.whatsapp_suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  wa_id TEXT NOT NULL CHECK (wa_id ~ '^[1-9][0-9]{6,14}$'),
  reason TEXT NOT NULL CHECK (reason IN ('invalid_number', 'blocked_by_user', 'staff', 'meta_policy')),
  details TEXT CHECK (details IS NULL OR length(details) <= 500),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, wa_id)
);
GRANT SELECT ON public.whatsapp_suppressions TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.whatsapp_suppressions TO service_role;
ALTER TABLE public.whatsapp_suppressions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant whatsapp suppressions read" ON public.whatsapp_suppressions;
CREATE POLICY "tenant whatsapp suppressions read" ON public.whatsapp_suppressions
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- 3. Message Templates (synced from Meta)
CREATE TABLE IF NOT EXISTS public.whatsapp_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  whatsapp_connection_id UUID NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  meta_template_id TEXT,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  body_text TEXT,
  body_param_count INTEGER NOT NULL DEFAULT 0 CHECK (body_param_count >= 0),
  purpose TEXT CHECK (purpose IS NULL OR purpose IN (
    'booking_confirmed', 'booking_rescheduled', 'booking_cancelled', 'booking_reminder',
    'payment_link', 'payment_confirmation', 'payment_failed', 'payment_expired'
  )),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (whatsapp_connection_id, name, language)
);
-- One template per notification purpose per number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_templates_one_per_purpose
  ON public.whatsapp_templates (whatsapp_connection_id, purpose) WHERE purpose IS NOT NULL;
GRANT SELECT ON public.whatsapp_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_templates TO service_role;
ALTER TABLE public.whatsapp_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant whatsapp templates read" ON public.whatsapp_templates;
CREATE POLICY "tenant whatsapp templates read" ON public.whatsapp_templates
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
DROP TRIGGER IF EXISTS trg_whatsapp_templates_updated ON public.whatsapp_templates;
CREATE TRIGGER trg_whatsapp_templates_updated BEFORE UPDATE ON public.whatsapp_templates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 4. Notification outbox
CREATE TABLE IF NOT EXISTS public.whatsapp_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES public.bookings(id) ON DELETE CASCADE,
  payment_request_id UUID REFERENCES public.payment_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'booking_confirmed', 'booking_rescheduled', 'booking_cancelled', 'booking_reminder',
    'payment_link', 'payment_captured', 'payment_captured_after_expiry',
    'payment_failed', 'payment_expired'
  )),
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  skip_reason TEXT,
  last_error TEXT,
  whatsapp_message_id UUID REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_notifications_due
  ON public.whatsapp_notifications (next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS idx_whatsapp_notifications_booking
  ON public.whatsapp_notifications (booking_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_notifications_org
  ON public.whatsapp_notifications (organization_id, created_at DESC);
GRANT SELECT ON public.whatsapp_notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.whatsapp_notifications TO service_role;
ALTER TABLE public.whatsapp_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant whatsapp notifications read" ON public.whatsapp_notifications;
CREATE POLICY "tenant whatsapp notifications read" ON public.whatsapp_notifications
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
DROP TRIGGER IF EXISTS trg_whatsapp_notifications_updated ON public.whatsapp_notifications;
CREATE TRIGGER trg_whatsapp_notifications_updated BEFORE UPDATE ON public.whatsapp_notifications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Whether this business has WhatsApp booking/payment notifications on.
CREATE OR REPLACE FUNCTION public.whatsapp_notifications_enabled_for(p_business_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.whatsapp_connections c
    WHERE c.business_id = p_business_id
      AND c.status = 'connected'
      AND c.notifications_enabled
  );
$$;
REVOKE ALL ON FUNCTION public.whatsapp_notifications_enabled_for(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enqueue_whatsapp_notification(
  p_organization_id UUID,
  p_business_id UUID,
  p_booking_id UUID,
  p_payment_request_id UUID,
  p_kind TEXT,
  p_dedupe_key TEXT,
  p_payload JSONB,
  p_delay INTERVAL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.whatsapp_notifications_enabled_for(p_business_id) THEN
    RETURN;
  END IF;
  INSERT INTO public.whatsapp_notifications
    (organization_id, business_id, booking_id, payment_request_id, kind, dedupe_key, payload, next_attempt_at)
  VALUES
    (p_organization_id, p_business_id, p_booking_id, p_payment_request_id, p_kind, p_dedupe_key,
     coalesce(p_payload, '{}'::jsonb), now() + coalesce(p_delay, interval '0'))
  ON CONFLICT (dedupe_key) DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_whatsapp_notification(UUID, UUID, UUID, UUID, TEXT, TEXT, JSONB, INTERVAL)
  FROM PUBLIC, anon, authenticated;
-- The reminder sweep (server code) enqueues through the same function.
GRANT EXECUTE ON FUNCTION public.enqueue_whatsapp_notification(UUID, UUID, UUID, UUID, TEXT, TEXT, JSONB, INTERVAL)
  TO service_role;

-- Bookings: confirmation, reschedule, cancellation. A booking the customer
-- holds is CONFIRMED, RESCHEDULED or CALENDAR_SYNC_FAILED (saved; the
-- calendar mirror is retried separately). A hold confirmed by payment
-- (PENDING_PAYMENT -> CONFIRMED) is announced by the payment notification
-- instead, so it isn't confirmed twice.
CREATE OR REPLACE FUNCTION public.whatsapp_booking_notification_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active CONSTANT TEXT[] := ARRAY['CONFIRMED', 'RESCHEDULED', 'CALENDAR_SYNC_FAILED'];
  v_payload JSONB;
BEGIN
  IF NEW.customer_phone IS NULL OR btrim(NEW.customer_phone) = '' THEN
    RETURN NEW;
  END IF;
  v_payload := jsonb_build_object('start_at', NEW.start_at, 'end_at', NEW.end_at, 'status', NEW.status);

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = ANY (v_active) THEN
      PERFORM public.enqueue_whatsapp_notification(NEW.organization_id, NEW.business_id, NEW.id, NULL,
        'booking_confirmed', 'booking_confirmed:' || NEW.id, v_payload, interval '0');
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = ANY (v_active) AND OLD.status IN ('DRAFT', 'PENDING_CONFIRMATION') THEN
    PERFORM public.enqueue_whatsapp_notification(NEW.organization_id, NEW.business_id, NEW.id, NULL,
      'booking_confirmed', 'booking_confirmed:' || NEW.id, v_payload, interval '0');
  END IF;

  IF NEW.status = ANY (v_active) AND NEW.start_at IS DISTINCT FROM OLD.start_at
     AND OLD.status = ANY (v_active) THEN
    PERFORM public.enqueue_whatsapp_notification(NEW.organization_id, NEW.business_id, NEW.id, NULL,
      'booking_rescheduled',
      'booking_rescheduled:' || NEW.id || ':' || extract(epoch FROM NEW.start_at)::bigint,
      v_payload || jsonb_build_object('previous_start_at', OLD.start_at), interval '0');
  END IF;

  IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED'
     AND OLD.status IN ('CONFIRMED', 'RESCHEDULED', 'CALENDAR_SYNC_FAILED', 'PENDING_PAYMENT') THEN
    PERFORM public.enqueue_whatsapp_notification(NEW.organization_id, NEW.business_id, NEW.id, NULL,
      'booking_cancelled', 'booking_cancelled:' || NEW.id, v_payload, interval '0');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.whatsapp_booking_notification_trigger() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_whatsapp_booking_notifications ON public.bookings;
CREATE TRIGGER trg_whatsapp_booking_notifications
  AFTER INSERT OR UPDATE OF status, start_at ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_booking_notification_trigger();

-- Payment link: request_payment already sends it inline; this row is the
-- recovery path (delayed, and deduplicated against the inline send by the
-- message idempotency key 'payment_link:<payment_request_id>').
CREATE OR REPLACE FUNCTION public.whatsapp_payment_link_notification_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.payment_link_url IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.payment_link_url IS NULL)
     AND NEW.status IN ('CREATED', 'PENDING') THEN
    PERFORM public.enqueue_whatsapp_notification(NEW.organization_id, NEW.business_id, NEW.booking_id, NEW.id,
      'payment_link', 'payment_link:' || NEW.id, '{}'::jsonb, interval '2 minutes');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.whatsapp_payment_link_notification_trigger() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_whatsapp_payment_link_notifications ON public.payment_requests;
CREATE TRIGGER trg_whatsapp_payment_link_notifications
  AFTER INSERT OR UPDATE OF payment_link_url ON public.payment_requests
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_payment_link_notification_trigger();

-- Payment outcomes: one row per verified-webhook domain event. The webhook's
-- in-process WhatsApp consumer is the fast path; this is the recovery path.
CREATE OR REPLACE FUNCTION public.whatsapp_payment_event_notification_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind TEXT;
BEGIN
  v_kind := CASE NEW.event_type
    WHEN 'PAYMENT_CAPTURED' THEN 'payment_captured'
    WHEN 'PAYMENT_CAPTURED_AFTER_EXPIRY' THEN 'payment_captured_after_expiry'
    WHEN 'PAYMENT_FAILED' THEN 'payment_failed'
    WHEN 'PAYMENT_EXPIRED' THEN 'payment_expired'
  END;
  IF v_kind IS NOT NULL THEN
    PERFORM public.enqueue_whatsapp_notification(NEW.organization_id, NEW.business_id, NEW.booking_id,
      NEW.payment_request_id, v_kind, 'payment_event:' || NEW.id,
      jsonb_build_object('payment_domain_event_id', NEW.id), interval '2 minutes');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.whatsapp_payment_event_notification_trigger() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_whatsapp_payment_event_notifications ON public.payment_domain_events;
CREATE TRIGGER trg_whatsapp_payment_event_notifications
  AFTER INSERT ON public.payment_domain_events
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_payment_event_notification_trigger();

-- ---------------------------------------------------------------------------
-- 5. Actions the AI proposed on WhatsApp, awaiting the customer's YES
CREATE TABLE IF NOT EXISTS public.whatsapp_pending_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  proposed_in_message_id UUID REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL,
  decided_by_message_id UUID REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('book', 'book_with_payment', 'reschedule')),
  params JSONB NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_confirmation' CHECK (status IN (
    'awaiting_confirmation', 'executing', 'completed', 'declined', 'expired', 'failed', 'superseded'
  )),
  result JSONB,
  error TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_pending_actions_one_open
  ON public.whatsapp_pending_actions (conversation_id) WHERE status = 'awaiting_confirmation';
GRANT SELECT ON public.whatsapp_pending_actions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.whatsapp_pending_actions TO service_role;
ALTER TABLE public.whatsapp_pending_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant whatsapp pending actions read" ON public.whatsapp_pending_actions;
CREATE POLICY "tenant whatsapp pending actions read" ON public.whatsapp_pending_actions
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
DROP TRIGGER IF EXISTS trg_whatsapp_pending_actions_updated ON public.whatsapp_pending_actions;
CREATE TRIGGER trg_whatsapp_pending_actions_updated BEFORE UPDATE ON public.whatsapp_pending_actions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- 6. Campaigns
CREATE TABLE IF NOT EXISTS public.whatsapp_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  whatsapp_connection_id UUID NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES public.whatsapp_templates(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  template_params JSONB NOT NULL DEFAULT '[]'::jsonb,
  audience JSONB NOT NULL DEFAULT '{"type":"all_consented"}'::jsonb,
  schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled'
  )),
  paused_reason TEXT,
  max_per_minute INTEGER NOT NULL DEFAULT 20 CHECK (max_per_minute BETWEEN 1 AND 80),
  created_by UUID,
  launched_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_campaigns_org ON public.whatsapp_campaigns (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_campaigns_due ON public.whatsapp_campaigns (status, scheduled_at);
GRANT SELECT ON public.whatsapp_campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.whatsapp_campaigns TO service_role;
ALTER TABLE public.whatsapp_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant whatsapp campaigns read" ON public.whatsapp_campaigns;
CREATE POLICY "tenant whatsapp campaigns read" ON public.whatsapp_campaigns
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
DROP TRIGGER IF EXISTS trg_whatsapp_campaigns_updated ON public.whatsapp_campaigns;
CREATE TRIGGER trg_whatsapp_campaigns_updated BEFORE UPDATE ON public.whatsapp_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.whatsapp_campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES public.whatsapp_campaigns(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  wa_id TEXT NOT NULL CHECK (wa_id ~ '^[1-9][0-9]{6,14}$'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'sending', 'sent', 'failed', 'skipped'
  )),
  skip_reason TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  whatsapp_message_id UUID REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, wa_id)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_campaign_recipients_due
  ON public.whatsapp_campaign_recipients (campaign_id, next_attempt_at) WHERE status IN ('pending', 'sending');
GRANT SELECT ON public.whatsapp_campaign_recipients TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.whatsapp_campaign_recipients TO service_role;
ALTER TABLE public.whatsapp_campaign_recipients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant whatsapp campaign recipients read" ON public.whatsapp_campaign_recipients;
CREATE POLICY "tenant whatsapp campaign recipients read" ON public.whatsapp_campaign_recipients
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
DROP TRIGGER IF EXISTS trg_whatsapp_campaign_recipients_updated ON public.whatsapp_campaign_recipients;
CREATE TRIGGER trg_whatsapp_campaign_recipients_updated BEFORE UPDATE ON public.whatsapp_campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A campaign's template must belong to the campaign's own number, and its
-- number and business must be in the campaign's organization.
CREATE OR REPLACE FUNCTION public.whatsapp_campaign_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.whatsapp_connections c
    JOIN public.whatsapp_templates t ON t.whatsapp_connection_id = c.id
    WHERE c.id = NEW.whatsapp_connection_id
      AND t.id = NEW.template_id
      AND c.organization_id = NEW.organization_id
      AND c.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'WHATSAPP_CAMPAIGN_TENANT_MISMATCH' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.whatsapp_campaign_same_tenant() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_whatsapp_campaign_same_tenant ON public.whatsapp_campaigns;
CREATE TRIGGER trg_whatsapp_campaign_same_tenant
  BEFORE INSERT OR UPDATE OF organization_id, business_id, whatsapp_connection_id, template_id
  ON public.whatsapp_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_campaign_same_tenant();

-- ---------------------------------------------------------------------------
-- 7. Audit log
CREATE TABLE IF NOT EXISTS public.whatsapp_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'customer')),
  actor_user_id UUID,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_audit_log_org ON public.whatsapp_audit_log (organization_id, created_at DESC);
GRANT SELECT ON public.whatsapp_audit_log TO authenticated;
GRANT SELECT, INSERT ON public.whatsapp_audit_log TO service_role;
ALTER TABLE public.whatsapp_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant whatsapp audit read" ON public.whatsapp_audit_log;
CREATE POLICY "tenant whatsapp audit read" ON public.whatsapp_audit_log
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- 8. One live outbound message per idempotency key per connection
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_idempotency_live
  ON public.whatsapp_messages (whatsapp_connection_id, (metadata->>'idempotency_key'))
  WHERE (metadata ? 'idempotency_key') AND status IN ('queued', 'sent', 'delivered', 'read');
