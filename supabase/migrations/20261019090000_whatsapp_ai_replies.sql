-- WhatsApp: AI replies, human handoff and safe outbound sending.
--
-- Builds on 20260923090000_whatsapp_business_integration.sql (connections,
-- conversations, messages, RLS). Adds only what the reply pipeline needs:
--
-- 1. whatsapp_conversations
--    - ai_enabled: false once a person has taken over the conversation
--      (human handoff) — the AI never replies while it is false.
--    - handoff_requested_at: when the customer asked for a person (or staff
--      took over), so the dashboard can surface it.
--    - last_inbound_at: the customer's latest inbound message — the start
--      of Meta's 24-hour customer-service window, kept on the row so every
--      send can check the window without scanning messages.
--    Customers stay read-only on this table (all writes are server-side).
--
-- 2. whatsapp_messages
--    - reply_to_message_id: on an AI reply, the inbound message it answers.
--      UNIQUE (partial), so two workers / a webhook retry can never send two
--      replies to the same inbound message: the reply row is inserted
--      ('queued') BEFORE the AI or Meta is called, and the insert itself is
--      the claim.
--    - attempts: send attempts made for an outbound row (bounded in code).
--
-- 3. (Consent for business-initiated messages is recorded in the
--    append-only whatsapp_consent_events ledger —
--    20261020090000_whatsapp_notifications_and_campaigns.sql — not here.)
--
-- 4. whatsapp_connections.agent_config_id must belong to the connection's
--    own organization. The dashboard's server function already checks this,
--    but the existing RLS policy lets an authenticated member UPDATE that
--    column directly; this trigger enforces it for every writer.
--
-- Additive and idempotent: new nullable/defaulted columns, IF NOT EXISTS
-- guards, CREATE OR REPLACE for the trigger function. No data rewrite.

ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS handoff_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;

ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID
    REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_one_reply_per_inbound
  ON public.whatsapp_messages (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

-- Status updates and reply lookups are always scoped to one connection.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_connection_status
  ON public.whatsapp_messages (whatsapp_connection_id, status);

CREATE OR REPLACE FUNCTION public.whatsapp_connection_agent_same_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.agent_config_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.agent_configs a
    WHERE a.id = NEW.agent_config_id AND a.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'WHATSAPP_AGENT_NOT_IN_ORGANIZATION'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.whatsapp_connection_agent_same_org() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_whatsapp_connection_agent_same_org ON public.whatsapp_connections;
CREATE TRIGGER trg_whatsapp_connection_agent_same_org
  BEFORE INSERT OR UPDATE OF agent_config_id, organization_id ON public.whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_connection_agent_same_org();
