-- WhatsApp Business Platform integration (Phase 1 — schema only)
--
-- Adds the multi-tenant connection/conversation/message model for Meta's
-- WhatsApp Business Platform (Embedded Signup). Reuses existing
-- infrastructure rather than duplicating it:
--   - tenant isolation: organizations / is_org_member() (unchanged)
--   - bot assignment: agent_configs (the existing 1-bot-per-business model;
--     no second "bot" concept is introduced)
--   - webhook idempotency: the existing webhook_events table
--     (provider='whatsapp', same as the telephony webhook's own dedupe)
--   - contacts: the existing tenant-scoped `contacts` table
--   - feature gating: the existing feature_locked()/organization_feature_
--     locks machinery, via the "whatsapp" feature key that already exists
--     in src/lib/features.ts (PLATFORM_FEATURES) but has never been wired
--     to a real gate until this integration
--   - usage billing: the existing usage_records/wallet_transactions ledger,
--     via the "pricing.whatsapp_message" pricing key that already exists in
--     src/lib/pricing.ts but has never been read from anywhere until this
--     integration
--
-- No plaintext secret ever lands in a customer-readable column. The two
-- token-shaped columns below (access_token_ciphertext, two_step_pin_
-- ciphertext) hold AES-256-GCM ciphertext produced by application code
-- (see whatsapp-token-crypto.server.ts, Phase 2) using a server-only
-- encryption key (WHATSAPP_TOKEN_ENCRYPTION_KEY, a Worker secret) — the
-- database never sees the plaintext value or the key. This mirrors the
-- "never in a normal authenticated-readable column" rule Phase D already
-- applied to call_logs.provider_cost, taken one step further because these
-- two columns are actual bearer credentials, not just commercially
-- sensitive numbers.

-- ============================================================
-- 1. whatsapp_connections — one row per Meta WABA phone number connected
--    to a tenant. A tenant can have multiple (spec: "support multiple
--    WhatsApp numbers"), each independently assignable to a bot.
-- ============================================================
CREATE TABLE public.whatsapp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  -- The bot handling this number. Mirrors phone_numbers.agent_config_id
  -- exactly (a direct FK to agent_configs, not a derived join through
  -- business_id) — same convention, same reason: a connection can exist
  -- before a bot is chosen, and reassigning the bot must not require
  -- moving the connection to a different business.
  agent_config_id UUID REFERENCES public.agent_configs(id) ON DELETE SET NULL,

  -- Meta-side identifiers. Both are Meta's own opaque IDs, never generated
  -- by Klyro. Kept as text (Meta's IDs are numeric strings, not UUIDs).
  waba_id TEXT NOT NULL,
  phone_number_id TEXT NOT NULL,
  display_phone_number TEXT,
  verified_name TEXT,
  business_name TEXT,

  status TEXT NOT NULL DEFAULT 'not_connected',

  -- AES-256-GCM ciphertext (base64: iv || ciphertext || authTag), produced
  -- and consumed only by server-side code holding
  -- WHATSAPP_TOKEN_ENCRYPTION_KEY. NULL until onboarding completes.
  access_token_ciphertext TEXT,
  -- The 6-digit two-step-verification PIN Klyro generates and submits to
  -- Meta's POST /{phone_number_id}/register call. Stored (encrypted) so a
  -- later re-registration (token rotation, number re-activation after the
  -- 14-day Embedded-Signup-to-registration window, etc.) can reuse the same
  -- PIN without asking the customer for one Klyro itself chose.
  two_step_pin_ciphertext TEXT,

  webhook_subscribed BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  last_connected_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.whatsapp_connections ADD CONSTRAINT whatsapp_connections_status_check
    CHECK (status IN ('not_connected', 'connecting', 'connected', 'error', 'disconnected', 'needs_attention'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A given Meta phone_number_id must never be live for more than one
-- ClickAI tenant at once — same cross-organization uniqueness rule Phase D
-- already applies to phone_numbers.e164 for voice numbers. Disconnected
-- rows are excluded so a number can be reconnected (by the same or a
-- different tenant, e.g. after an account handoff) without the old row
-- blocking it forever.
CREATE UNIQUE INDEX idx_whatsapp_connections_phone_number_id_live
  ON public.whatsapp_connections (phone_number_id) WHERE status <> 'disconnected';

CREATE INDEX idx_whatsapp_connections_org ON public.whatsapp_connections (organization_id);
CREATE INDEX idx_whatsapp_connections_waba ON public.whatsapp_connections (waba_id);

GRANT SELECT, UPDATE (agent_config_id) ON public.whatsapp_connections TO authenticated;
GRANT ALL ON public.whatsapp_connections TO service_role;
ALTER TABLE public.whatsapp_connections ENABLE ROW LEVEL SECURITY;

-- Customers may read their own connections and change which bot handles
-- one (the one self-service mutation the spec asks for — "client selects
-- which ClickAI AI bot should handle WhatsApp"). Every other field
-- (status, tokens, Meta identifiers) is written exclusively by server-side
-- code (the onboarding handler, the webhook, the admin functions), all of
-- which use supabaseAdmin and therefore bypass RLS entirely — matching how
-- phone_numbers/telephony_connections already keep customers read-only.
CREATE POLICY "tenant whatsapp connections read" ON public.whatsapp_connections
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY "tenant whatsapp connections assign bot" ON public.whatsapp_connections
  FOR UPDATE TO authenticated
  USING (public.is_org_member(organization_id))
  WITH CHECK (public.is_org_member(organization_id));

-- Column-level protection: even though the table-wide UPDATE grant above is
-- narrowed to (agent_config_id) only, this is the same belt-and-suspenders
-- pattern Phase D used for call_logs — an explicit SELECT column list so a
-- future `select("*")` on this table from customer-facing code cannot leak
-- the ciphertext columns, even though they're already unreadable
-- plaintext. The ciphertext is genuinely worthless without
-- WHATSAPP_TOKEN_ENCRYPTION_KEY (which never leaves the Worker's server-side
-- env), but there is no reason to hand it to the browser at all.
REVOKE SELECT ON public.whatsapp_connections FROM authenticated;
GRANT SELECT (
  id, organization_id, business_id, agent_config_id, waba_id, phone_number_id,
  display_phone_number, verified_name, business_name, status,
  webhook_subscribed, metadata, last_error, last_connected_at, disconnected_at,
  created_at, updated_at
) ON public.whatsapp_connections TO authenticated;

CREATE TRIGGER trg_whatsapp_connections_updated BEFORE UPDATE ON public.whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 2. whatsapp_conversations — one per (connection, customer WhatsApp id)
-- ============================================================
CREATE TABLE public.whatsapp_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  whatsapp_connection_id UUID NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  -- The customer's WhatsApp identifier (their E.164 number, as Meta sends
  -- it — "wa_id" in Meta's payloads). Kept separate from contact_id: a
  -- contact row may not exist yet on first inbound message.
  wa_id TEXT NOT NULL,
  customer_display_name TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One conversation per customer per connected number. Tenant isolation
  -- falls out of this naturally: whatsapp_connection_id already belongs to
  -- exactly one organization, so the same phone number messaging two
  -- different tenants' WhatsApp numbers correctly produces two separate
  -- conversation rows (spec §14's "same phone number, multiple tenants"
  -- requirement) with no possibility of collision.
  UNIQUE (whatsapp_connection_id, wa_id)
);

DO $$ BEGIN
  ALTER TABLE public.whatsapp_conversations ADD CONSTRAINT whatsapp_conversations_status_check
    CHECK (status IN ('open', 'closed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX idx_whatsapp_conversations_org ON public.whatsapp_conversations (organization_id, last_message_at DESC);
CREATE INDEX idx_whatsapp_conversations_connection ON public.whatsapp_conversations (whatsapp_connection_id);
CREATE INDEX idx_whatsapp_conversations_contact ON public.whatsapp_conversations (contact_id);

GRANT SELECT ON public.whatsapp_conversations TO authenticated;
GRANT ALL ON public.whatsapp_conversations TO service_role;
ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
-- Read-only for customers, same reasoning as call_logs: every write
-- (new conversation on first inbound message, last_message_at/preview/
-- unread_count updates) happens server-side, in the webhook handler and
-- the outbound-send service, both via supabaseAdmin.
CREATE POLICY "tenant whatsapp conversations read" ON public.whatsapp_conversations
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

CREATE TRIGGER trg_whatsapp_conversations_updated BEFORE UPDATE ON public.whatsapp_conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 3. whatsapp_messages
-- ============================================================
CREATE TABLE public.whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  whatsapp_connection_id UUID NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  -- Meta's own message id ("wamid...."). NULL is possible only for the
  -- rare synthetic system row (never for a real inbound/outbound message),
  -- so the uniqueness index below is a partial index rather than NOT NULL
  -- + UNIQUE outright.
  wa_message_id TEXT,
  direction TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  content TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.whatsapp_messages ADD CONSTRAINT whatsapp_messages_direction_check
    CHECK (direction IN ('inbound', 'outbound'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Only the message types the current chatbot/agent core can actually
  -- produce or is required to parse for v1 (spec §13: "only implement
  -- message types actually supported... do not overbuild"). Widen this
  -- constraint in a later migration if/when template or media-send support
  -- is built.
  ALTER TABLE public.whatsapp_messages ADD CONSTRAINT whatsapp_messages_type_check
    CHECK (message_type IN ('text', 'image', 'audio', 'video', 'document', 'interactive', 'template', 'unsupported'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.whatsapp_messages ADD CONSTRAINT whatsapp_messages_status_check
    CHECK (status IN ('received', 'queued', 'sent', 'delivered', 'read', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Idempotency for the webhook path, defense-in-depth alongside the outer
-- webhook_events(provider, event_id) dedupe — exactly the same
-- belt-and-suspenders reasoning Phase D used for
-- idx_call_logs_provider_call_id. Scoped per-connection rather than
-- globally: Meta's message ids are unique within a WABA/phone number, and
-- scoping this way means a duplicate check never has to reason about
-- cross-tenant id collisions.
CREATE UNIQUE INDEX idx_whatsapp_messages_connection_wamid
  ON public.whatsapp_messages (whatsapp_connection_id, wa_message_id) WHERE wa_message_id IS NOT NULL;

CREATE INDEX idx_whatsapp_messages_conversation ON public.whatsapp_messages (conversation_id, occurred_at DESC);
CREATE INDEX idx_whatsapp_messages_org ON public.whatsapp_messages (organization_id);

GRANT SELECT ON public.whatsapp_messages TO authenticated;
GRANT ALL ON public.whatsapp_messages TO service_role;
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
-- Read-only for customers — every message row is written server-side
-- (webhook for inbound, the send service for outbound).
CREATE POLICY "tenant whatsapp messages read" ON public.whatsapp_messages
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

-- ============================================================
-- 4. Audit action vocabulary note (no schema change — writeAudit already
--    accepts a free-form action string; documenting the new ones Phase 2+
--    code will use: WHATSAPP_CONNECTED, WHATSAPP_BOT_ASSIGNED,
--    WHATSAPP_DISCONNECTED, WHATSAPP_RECONNECT_FAILED)
-- ============================================================
