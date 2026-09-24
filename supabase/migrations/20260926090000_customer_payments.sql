-- Phase 4: real customer payment transactions + booking payment-hold state.
--
-- Reuses existing infrastructure rather than duplicating it:
--   - tenant isolation: organizations / businesses / is_org_member() (unchanged)
--   - razorpay_connections (Phase 3) — read-only reference here; this
--     migration NEVER adds transaction columns to it. A connection stays a
--     pure "is this business's Razorpay account usable" record.
--   - bookings (Phase 2) — widened additively exactly as its own header
--     comment anticipated ("bookings.status is deliberately extensible...
--     a later forward-only migration adds PENDING_PAYMENT").
--   - updated_at trigger: the existing update_updated_at_column() function
--
-- Explicitly NOT part of this migration / left untouched:
--   - payment_orders / payments / invoices / webhook_events — ClickAI's own
--     platform billing (organization pays ClickAI for its subscription).
--     Tenant customer payments are structurally separate new tables so they
--     can never be confused with, or accidentally joined against, platform
--     billing data. The customer-payment webhook (a later file) gets its
--     OWN idempotency ledger (payment_webhook_events) rather than sharing
--     webhook_events, specifically to avoid any (provider, event_id)
--     collision risk between the two Razorpay webhook streams.
--   - razorpay_connections — read from, never modified in shape here.
--
-- btree_gist / EXCLUDE-constraint note: Phase 2's own migration comment
-- (20260924090000_google_calendar_and_bookings.sql, "Best-effort DB-level
-- double-booking guard") already recorded that btree_gist was not confirmed
-- available in the target Supabase project and deliberately was not added
-- speculatively. That same caution applies here — no new Postgres extension
-- is added. Instead, full time-range overlap protection for payment holds
-- (see section 5 below, create_booking_payment_hold) is enforced with a
-- pg_advisory_xact_lock inside a single Postgres function call, which needs
-- no extension. The exact-start-time DB-level unique index is also widened
-- to treat expired/failed holds as released, which matters once holds can
-- sit PENDING_PAYMENT for several minutes instead of resolving instantly.

-- ============================================================
-- 1. payment_requests — one row per tenant customer payment attempt,
--    always tied to exactly one booking. Amounts are integer minor units
--    (paise for INR), matching payment_orders' own established convention.
--    `status` is this integration's own server-authoritative truth —
--    nothing but verified webhook processing (or a bounded expiry job)
--    may ever move it to CAPTURED/FAILED/EXPIRED.
-- ============================================================
CREATE TABLE public.payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  razorpay_connection_id UUID NOT NULL REFERENCES public.razorpay_connections(id) ON DELETE RESTRICT,

  provider TEXT NOT NULL DEFAULT 'razorpay',
  -- Exactly one of these is expected to be set depending on which Razorpay
  -- product is used to collect the payment (Orders vs Payment Links) — see
  -- razorpay-payments.server.ts's own doc comment for what is and is not
  -- verified about these API shapes in this environment.
  provider_order_id TEXT UNIQUE,
  provider_payment_link_id TEXT UNIQUE,
  -- Set once Razorpay reports an actual payment attempt against this
  -- request (may still be PENDING, not yet CAPTURED).
  provider_payment_id TEXT UNIQUE,

  amount_minor_units INTEGER NOT NULL CHECK (amount_minor_units > 0),
  currency TEXT NOT NULL DEFAULT 'INR',

  -- CREATED: request row exists, no provider order/link created yet.
  -- PENDING: provider order/link created, awaiting customer payment.
  -- CAPTURED: server-verified via webhook — money has moved.
  -- FAILED: provider reported a failed payment attempt.
  -- EXPIRED: bounded wait elapsed with no successful payment (see the
  --   expiration cron route) — distinct from FAILED (no attempt vs a
  --   failed attempt).
  -- CANCELLED: the underlying booking was cancelled before payment.
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN (
    'CREATED', 'PENDING', 'CAPTURED', 'FAILED', 'EXPIRED', 'CANCELLED'
  )),

  -- The URL to send via WhatsApp (Payment Link short_url, or an Orders-API
  -- checkout URL if that path is used instead — see razorpay-payments.server.ts).
  payment_link_url TEXT,

  -- Retry-safe creation: a repeated createPaymentRequest call (AI tool
  -- retry, double-click, etc.) with the same key hits this unique
  -- constraint instead of creating a second live payment request for the
  -- same booking — mirrors bookings.idempotency_key exactly.
  idempotency_key TEXT NOT NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,

  captured_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX idx_payment_requests_org ON public.payment_requests (organization_id);
CREATE INDEX idx_payment_requests_business ON public.payment_requests (business_id);
CREATE INDEX idx_payment_requests_booking ON public.payment_requests (booking_id);

-- One ACTIVE payment request per booking — a booking should never have two
-- simultaneously-live payment attempts (spec: "prevent duplicate payment
-- creation caused by retries"). A booking may accumulate multiple
-- FAILED/EXPIRED/CANCELLED rows over time (e.g. retry after a failed
-- attempt), but never two rows in CREATED/PENDING/CAPTURED at once.
CREATE UNIQUE INDEX idx_payment_requests_one_active_per_booking
  ON public.payment_requests (booking_id)
  WHERE status IN ('CREATED', 'PENDING', 'CAPTURED');

CREATE TRIGGER set_payment_requests_updated_at
  BEFORE UPDATE ON public.payment_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.payment_requests ENABLE ROW LEVEL SECURITY;

-- Read-only for org members, same rationale as bookings/razorpay_connections
-- above: every write (create, capture, fail, expire) goes through
-- server-side code that re-validates organization/business/booking
-- ownership before writing. No secret/credential columns exist on this
-- table (Razorpay identifiers here are not credentials), so unlike
-- razorpay_connections there is no need for an explicit column-list grant.
CREATE POLICY "tenant payment requests read" ON public.payment_requests
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

-- ============================================================
-- 2. payment_webhook_events — idempotency ledger for the customer-payment
--    Razorpay webhook stream ONLY. Deliberately a separate table from the
--    platform-billing webhook_events table (not a shared (provider,
--    event_id) namespace with a different provider tag) — the cleanest way
--    to guarantee these two independent Razorpay webhook streams can never
--    collide or be confused with each other, matching the instruction that
--    tenant payments must have their own clearly named tables.
-- ============================================================
CREATE TABLE public.payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT,
  payload JSONB NOT NULL,
  payment_request_id UUID REFERENCES public.payment_requests(id) ON DELETE SET NULL,
  processed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (provider, event_id)
);

ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;
-- No policies granted: server-only, exactly like oauth_states — every
-- access goes through supabaseAdmin from the webhook route handler.
REVOKE ALL ON public.payment_webhook_events FROM authenticated, anon;

-- ============================================================
-- 3. payment_domain_events — the PaymentCaptured/Failed/Expired outbox.
--    The webhook route (and the expiration cron) write exactly one row
--    here per state transition, then a single in-process dispatcher fans
--    out to the calendar/WhatsApp/voice consumers, each independently
--    fault-isolated and independently tracked so a failure in one consumer
--    never blocks or duplicates another. This is what keeps "payment
--    truth" (this table + payment_requests.status) structurally separate
--    from "who got notified" (the *_dispatched_at columns below).
-- ============================================================
CREATE TABLE public.payment_domain_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'PAYMENT_CAPTURED', 'PAYMENT_FAILED', 'PAYMENT_EXPIRED',
    -- A payment that captures AFTER its booking hold already expired or was
    -- cancelled. Real money moved, but the booking is NOT silently
    -- confirmed — this event flags it for reconciliation instead (spec:
    -- "a webhook confirming an expired/cancelled booking" must not happen).
    'PAYMENT_CAPTURED_AFTER_EXPIRY'
  )),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  payment_request_id UUID NOT NULL REFERENCES public.payment_requests(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  calendar_dispatched_at TIMESTAMPTZ,
  whatsapp_dispatched_at TIMESTAMPTZ,
  voice_dispatched_at TIMESTAMPTZ,
  calendar_error TEXT,
  whatsapp_error TEXT,
  voice_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_domain_events_booking ON public.payment_domain_events (booking_id);
CREATE INDEX idx_payment_domain_events_payment_request ON public.payment_domain_events (payment_request_id);

ALTER TABLE public.payment_domain_events ENABLE ROW LEVEL SECURITY;
-- Server-only, same rationale as payment_webhook_events above.
REVOKE ALL ON public.payment_domain_events FROM authenticated, anon;

-- ============================================================
-- 4. bookings — additive widening only (no existing column/constraint
--    semantics change, no data touched).
-- ============================================================

-- Widen the status lifecycle. The original CHECK was intentionally written
-- (per its own header comment) so this exact drop-and-re-add is safe:
-- existing rows only ever hold values from the original set, all of which
-- remain valid members of the new, wider set.
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
  'DRAFT', 'PENDING_CONFIRMATION', 'CONFIRMED', 'RESCHEDULED',
  'CANCELLED', 'COMPLETED', 'NO_SHOW', 'CALENDAR_SYNC_FAILED',
  -- New in Phase 4:
  'PENDING_PAYMENT', 'PAYMENT_FAILED', 'PAYMENT_EXPIRED'
));

-- When a PENDING_PAYMENT hold must be released without a successful
-- payment, the expiration cron route (a later file) looks for
-- hold_expires_at < now(). NULL for every booking created before this
-- migration and for any booking that never went through the payment-hold
-- path (staff/manual bookings never set this).
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ;

-- Links a booking back to the live voice call that created it, if any, so
-- a PaymentCaptured domain event can find the right in-progress call to
-- notify. NULL for WhatsApp/website/manual-sourced bookings and for any
-- voice booking that isn't payment-gated.
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS call_id TEXT;

CREATE INDEX IF NOT EXISTS idx_bookings_hold_expiry
  ON public.bookings (hold_expires_at)
  WHERE status = 'PENDING_PAYMENT';

-- Widen the exact-start-time DB-level double-booking guard: a booking
-- whose payment hold expired or failed no longer occupies the slot, so it
-- must drop out of the "taken" set exactly like CANCELLED/NO_SHOW already
-- do. PENDING_PAYMENT itself is NOT added to the exclusion list — a live
-- hold correctly continues to block a second booking at the exact same
-- start time, which is the point of holding the slot at all.
DROP INDEX IF EXISTS idx_bookings_no_exact_start_clash;
CREATE UNIQUE INDEX idx_bookings_no_exact_start_clash
  ON public.bookings (calendar_connection_id, start_at)
  WHERE status NOT IN ('CANCELLED', 'NO_SHOW', 'PAYMENT_EXPIRED', 'PAYMENT_FAILED')
    AND calendar_connection_id IS NOT NULL;

-- ============================================================
-- 5. create_booking_payment_hold — atomic hold creation for the
--    AI/customer payment-required booking path.
--
--    Why a Postgres function and not application-level JS (the pattern
--    createBooking() in booking-service.server.ts already uses): Supabase's
--    REST/PostgREST interface gives each separate .from(...).select()/
--    .insert() call from the JS client its own implicit transaction — an
--    advisory lock (or any other guard) taken in one JS-level call is
--    released before the next JS-level call even starts, so it cannot
--    protect a "check for conflicts, then insert" sequence spanning two
--    separate client calls. Only genuine, real overlap protection for a
--    payment hold (which can sit open for several minutes, unlike a
--    normal booking's near-instant PENDING_CONFIRMATION -> CONFIRMED
--    transition) requires the whole check-then-insert sequence to run
--    inside ONE database transaction — hence one PL/pgSQL function, called
--    once via supabaseAdmin.rpc(), rather than a multi-step promise chain.
--
--    Takes and releases a session-level-scoped-to-this-transaction
--    advisory lock keyed on the calendar connection
--    (pg_advisory_xact_lock — automatically released at the end of this
--    function's transaction, never held longer), which serializes
--    concurrent hold-creation attempts for the same calendar connection
--    long enough for the full time-range overlap check below (not just
--    the exact-start-time DB index) to be race-free. This is genuine
--    overlap protection, unlike the exact-start-only unique index alone.
--
--    Idempotent: a repeated call with the same (organization_id,
--    idempotency_key) returns the already-created row rather than
--    raising or inserting again.
--
--    SECURITY DEFINER + a fixed search_path, matching this codebase's
--    existing convention (is_org_member(), is_platform_admin()) — EXECUTE
--    is granted to service_role only; this is called exclusively from
--    server-side code (booking-service.server.ts) via supabaseAdmin,
--    never directly by an authenticated browser session.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_booking_payment_hold(
  p_organization_id UUID,
  p_business_id UUID,
  p_calendar_connection_id UUID,
  p_service_id UUID,
  p_agent_config_id UUID,
  p_contact_id UUID,
  p_start_at TIMESTAMPTZ,
  p_end_at TIMESTAMPTZ,
  p_timezone TEXT,
  p_customer_name TEXT,
  p_customer_phone TEXT,
  p_customer_email TEXT,
  p_source TEXT,
  p_idempotency_key TEXT,
  p_hold_expires_at TIMESTAMPTZ,
  p_call_id TEXT
)
RETURNS public.bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.bookings;
  v_booking public.bookings;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.bookings
      WHERE organization_id = p_organization_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_existing;
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_calendar_connection_id::text, 0));

  IF EXISTS (
    SELECT 1 FROM public.bookings
    WHERE calendar_connection_id = p_calendar_connection_id
      AND status NOT IN ('CANCELLED', 'NO_SHOW', 'PAYMENT_EXPIRED', 'PAYMENT_FAILED')
      AND start_at < p_end_at
      AND end_at > p_start_at
  ) THEN
    RAISE EXCEPTION 'SLOT_NO_LONGER_AVAILABLE';
  END IF;

  INSERT INTO public.bookings (
    organization_id, business_id, calendar_connection_id, service_id,
    agent_config_id, contact_id, status, start_at, end_at, timezone,
    customer_name, customer_phone, customer_email, source,
    idempotency_key, hold_expires_at, call_id
  ) VALUES (
    p_organization_id, p_business_id, p_calendar_connection_id, p_service_id,
    p_agent_config_id, p_contact_id, 'PENDING_PAYMENT', p_start_at, p_end_at, p_timezone,
    p_customer_name, p_customer_phone, p_customer_email, p_source,
    p_idempotency_key, p_hold_expires_at, p_call_id
  )
  RETURNING * INTO v_booking;

  RETURN v_booking;
END;
$$;

REVOKE ALL ON FUNCTION public.create_booking_payment_hold FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_booking_payment_hold TO service_role;
