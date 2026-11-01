-- WhatsApp (Vobiz) reliability: BYON verification attempts, recoverable
-- webhook events, and Vobiz's own message id on sent messages.
--
-- 1. whatsapp_byon_verifications: one row per BYON code request
--    (POST /numbers/whatsapp/bring-your-own/verify). It records what Vobiz
--    answered — its verification id, its status, its expiry — never the
--    code, credentials or tokens. A 'pending' row means Vobiz ACCEPTED the
--    request; nothing here (or anywhere) records delivery, because Vobiz
--    documents no delivery confirmation for these codes.
--    claim_whatsapp_byon_verification() is the per-organization hourly
--    limit: it serializes requests of one organization with an advisory
--    lock, so two concurrent requests can't both pass a count of 4 out of 5,
--    and inserts the 'requested' row before Vobiz is called. Rows Vobiz
--    refused ('rejected', a 4xx: no code was sent) don't count; every other
--    row does, including requests whose outcome is unknown (a timeout or
--    5xx may still have sent a code).
--    Server role only: RLS on, no browser policies or grants.
-- 2. webhook_events.attempts / next_attempt_at: a Vobiz WhatsApp event that
--    can't be applied yet (no live connection for its phone number id yet,
--    or a status for a message whose WhatsApp id isn't known yet) is kept
--    instead of being marked processed and lost. States, on existing
--    columns where possible:
--      processed_at set                                     processed
--      error NULL, next_attempt_at = lease end              received / in progress
--      error set,  next_attempt_at set                      pending retry (due when <= now)
--      error set,  next_attempt_at NULL                     terminal (kept for operators)
--    attempts counts tries (bounded in code). Signed deliveries without the
--    documented envelope are kept under provider 'vobiz_whatsapp_unrecognized'
--    keyed by the SHA-256 of their exact bytes (never a made-up event id).
--    Other providers' rows are untouched (attempts 0, next_attempt_at NULL).
-- 3. whatsapp_messages.provider_message_id: Vobiz's own message id from the
--    send response (until now only in metadata.vobiz_message_id), unique per
--    connection. Backfilled from metadata where unambiguous.
--
-- Additive: one new table and function, new nullable/defaulted columns (no
-- rewrite), new indexes. Works with the code before and after this change.
-- Requires only 20260831120435 (webhook_events), 20260923090000 (WhatsApp
-- tables) and organizations.
--
-- Rollback (code first, then):
--   DROP FUNCTION IF EXISTS public.claim_whatsapp_byon_verification(uuid, text, text, integer, integer);
--   DROP TABLE IF EXISTS public.whatsapp_byon_verifications;
--   DROP INDEX IF EXISTS public.idx_webhook_events_retry_due,
--     public.idx_whatsapp_messages_connection_provider_id;
--   ALTER TABLE public.webhook_events DROP COLUMN IF EXISTS attempts,
--     DROP COLUMN IF EXISTS next_attempt_at;
--   ALTER TABLE public.whatsapp_messages DROP COLUMN IF EXISTS provider_message_id;
--   (metadata.vobiz_message_id is still written, so nothing is lost.)

-- ============================================================
-- 1. BYON verification attempts
-- ============================================================
CREATE TABLE IF NOT EXISTS public.whatsapp_byon_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$'),
  method TEXT NOT NULL CHECK (method IN ('sms', 'voice')),
  state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN (
    'requested',    -- claimed; Vobiz not answered yet (or the answer was lost)
    'pending',      -- Vobiz accepted the request (status "pending"); delivery unconfirmed
    'unrecognized', -- 2xx, but not a response ClickAI recognizes; outcome unknown
    'unavailable',  -- timeout / network / 5xx / 429: outcome unknown
    'rejected',     -- Vobiz refused (4xx): no code was sent
    'confirmed'     -- the code was confirmed (bring-your-own/confirm succeeded)
  )),
  provider_verification_id TEXT CHECK (provider_verification_id IS NULL OR length(provider_verification_id) <= 100),
  provider_status TEXT CHECK (provider_status IS NULL OR length(provider_status) <= 40),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_byon_verifications_org_recent
  ON public.whatsapp_byon_verifications (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_byon_verifications_number
  ON public.whatsapp_byon_verifications (organization_id, phone_number, created_at DESC);

ALTER TABLE public.whatsapp_byon_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_byon_verifications FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_byon_verifications TO service_role;

DO $$ BEGIN
  CREATE TRIGGER trg_whatsapp_byon_verifications_updated
    BEFORE UPDATE ON public.whatsapp_byon_verifications
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Returns the new 'requested' row's id, or NULL when the organization has
-- already made _limit counted requests within the last _window_seconds.
CREATE OR REPLACE FUNCTION public.claim_whatsapp_byon_verification(
  _organization_id UUID,
  _phone_number TEXT,
  _method TEXT,
  _limit INTEGER,
  _window_seconds INTEGER
) RETURNS UUID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  used INTEGER;
  new_id UUID;
BEGIN
  -- One organization's requests run one at a time (transaction-scoped lock).
  PERFORM pg_advisory_xact_lock(hashtextextended('whatsapp_byon_verification:' || _organization_id::text, 0));
  SELECT count(*) INTO used
    FROM public.whatsapp_byon_verifications
   WHERE organization_id = _organization_id
     AND state <> 'rejected'
     AND created_at > now() - make_interval(secs => _window_seconds);
  IF used >= _limit THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.whatsapp_byon_verifications (organization_id, phone_number, method)
  VALUES (_organization_id, _phone_number, _method)
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_whatsapp_byon_verification(UUID, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_byon_verification(UUID, TEXT, TEXT, INTEGER, INTEGER) TO service_role;

-- ============================================================
-- 2. Recoverable webhook events
-- ============================================================
ALTER TABLE public.webhook_events
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_webhook_events_retry_due
  ON public.webhook_events (provider, next_attempt_at)
  WHERE processed_at IS NULL AND next_attempt_at IS NOT NULL;

-- ============================================================
-- 3. Vobiz's message id on sent messages
-- ============================================================
ALTER TABLE public.whatsapp_messages
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

-- Backfill only ids that are unique within their connection (a duplicate
-- would be a data problem to look at, not something to guess about).
UPDATE public.whatsapp_messages m
   SET provider_message_id = m.metadata ->> 'vobiz_message_id'
 WHERE m.provider_message_id IS NULL
   AND m.metadata ? 'vobiz_message_id'
   AND NOT EXISTS (
     SELECT 1 FROM public.whatsapp_messages o
      WHERE o.whatsapp_connection_id = m.whatsapp_connection_id
        AND o.id <> m.id
        AND o.metadata ->> 'vobiz_message_id' = m.metadata ->> 'vobiz_message_id'
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_connection_provider_id
  ON public.whatsapp_messages (whatsapp_connection_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
