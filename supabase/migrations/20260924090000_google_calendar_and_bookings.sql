-- Phase 2: Google Calendar integration + booking foundation.
--
-- Reuses existing infrastructure rather than duplicating it:
--   - tenant isolation: organizations / is_org_member() (unchanged)
--   - businesses / business_hours / services (unchanged) — availability is
--     computed from these plus Google Calendar, not a new schema
--   - contacts: the existing tenant-scoped `contacts` table — bookings link
--     to it, no new customer/contact model
--   - agent_configs: the existing 1-agent-per-business model — a booking
--     may reference the business's one agent, no second "bot" concept
--   - updated_at trigger: the existing update_updated_at_column() function
--
-- Explicitly NOT part of this phase (see the Phase 2 report):
--   - Razorpay / payment_orders / payments / webhook_events are untouched.
--     bookings.status is deliberately extensible (a later forward-only
--     migration adds PENDING_PAYMENT) but does not include it yet.
--   - No new payment_connections/payment_transactions/payment_requests/
--     payment_events tables are created here.
--
-- Google OAuth credentials are stored as AES-256-GCM ciphertext produced by
-- application code (google-calendar-crypto.server.ts) using a server-only
-- encryption key (GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY, a Worker
-- secret) — the database never sees the plaintext refresh token or the key,
-- mirroring whatsapp_connections' access_token_ciphertext convention.

-- ============================================================
-- 1. oauth_states — short-lived, server-generated CSRF state for OAuth
--    flows. Provider-generic so a future non-Google OAuth integration can
--    reuse it without a new table. Never readable by authenticated clients
--    — only server-side code (supabaseAdmin) creates and consumes rows,
--    which is how tenant identity in the OAuth callback is derived
--    (never from a browser-supplied organization_id query parameter).
-- ============================================================
CREATE TABLE public.oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  redirect_to TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX idx_oauth_states_expires_at ON public.oauth_states (expires_at);

ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
-- No policies granted: this table has no authenticated-readable or
-- authenticated-writable surface at all. Every access goes through
-- supabaseAdmin (service role, bypasses RLS) from oauth-state.server.ts.
REVOKE ALL ON public.oauth_states FROM authenticated, anon;

-- ============================================================
-- 2. google_calendar_connections — one row per Google Calendar connected
--    to a tenant's business. `provider` is included now (default 'google')
--    so the same table/unique-constraint shape can hold a future
--    Microsoft/Apple calendar connection without a schema change.
-- ============================================================
CREATE TABLE public.google_calendar_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'google',

  google_account_id TEXT,
  google_email TEXT,
  -- The calendar the client selected (spec: "prefer a connection record
  -- plus selected calendar rather than hard-coding primary calendar").
  -- NULL until the client picks one after OAuth completes.
  calendar_id TEXT,
  calendar_name TEXT,

  -- DISCONNECTED | CONNECTING | NEEDS_CALENDAR_SELECTION | CONNECTED |
  -- NEEDS_REAUTH | ERROR (see google-calendar-connection-status.ts for the
  -- single source of truth on valid values/transitions).
  status TEXT NOT NULL DEFAULT 'DISCONNECTED',
  scopes TEXT[] NOT NULL DEFAULT '{}',

  -- AES-256-GCM ciphertext of a JSON blob holding the refresh token (see
  -- google-calendar-crypto.server.ts). Access tokens are minted on demand
  -- from the refresh token and never persisted — they're short-lived
  -- (~1 hour) and persisting them would be pure risk for no benefit.
  encrypted_credentials TEXT,
  -- Observability only (when the last successful token refresh reported
  -- expiry) — the actual decision to refresh is always "mint on demand",
  -- never "trust this column and skip a refresh".
  token_expires_at TIMESTAMPTZ,

  last_connected_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One active connection per (business, provider) — matches the spec's
  -- suggested uniqueness. A business reconnecting after disconnect updates
  -- this same row rather than creating a second one.
  UNIQUE (organization_id, business_id, provider)
);

CREATE INDEX idx_google_calendar_connections_org ON public.google_calendar_connections (organization_id);
CREATE INDEX idx_google_calendar_connections_business ON public.google_calendar_connections (business_id);

CREATE TRIGGER set_google_calendar_connections_updated_at
  BEFORE UPDATE ON public.google_calendar_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.google_calendar_connections ENABLE ROW LEVEL SECURITY;

-- Customers may read their own connection's status/metadata. Every write
-- (connect, calendar selection, disconnect, token refresh, status
-- transitions) goes through server-side code using supabaseAdmin, which
-- explicitly re-validates organization/business ownership in application
-- code before writing — mirroring whatsapp_connections' pattern exactly.
CREATE POLICY "tenant google calendar connections read" ON public.google_calendar_connections
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

-- Column-level protection: even though there is no authenticated UPDATE
-- policy at all (every write is server-only), this explicit column grant
-- means a future `select("*")` from customer-facing code still cannot leak
-- encrypted_credentials — same belt-and-suspenders pattern as
-- whatsapp_connections' access_token_ciphertext exclusion.
REVOKE SELECT ON public.google_calendar_connections FROM authenticated;
GRANT SELECT (
  id, organization_id, business_id, provider, google_account_id, google_email,
  calendar_id, calendar_name, status, scopes, token_expires_at,
  last_connected_at, last_sync_at, last_error, metadata, created_at, updated_at
) ON public.google_calendar_connections TO authenticated;

-- ============================================================
-- 3. bookings — the minimal booking model the spec asks for. No existing
--    booking/appointment table exists in this schema (confirmed by
--    inspection before this migration was written), so this is new, not a
--    duplicate.
-- ============================================================
CREATE TABLE public.bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  agent_config_id UUID REFERENCES public.agent_configs(id) ON DELETE SET NULL,
  calendar_connection_id UUID REFERENCES public.google_calendar_connections(id) ON DELETE SET NULL,
  service_id UUID REFERENCES public.services(id) ON DELETE SET NULL,

  -- DRAFT | PENDING_CONFIRMATION | CONFIRMED | RESCHEDULED | CANCELLED |
  -- COMPLETED | NO_SHOW | CALENDAR_SYNC_FAILED. Deliberately does NOT
  -- include PENDING_PAYMENT yet — see the header comment. The CHECK below
  -- is written so a future forward-only migration can widen it (DROP +
  -- re-ADD the constraint) without touching existing rows' values.
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'PENDING_CONFIRMATION', 'CONFIRMED', 'RESCHEDULED',
    'CANCELLED', 'COMPLETED', 'NO_SHOW', 'CALENDAR_SYNC_FAILED'
  )),

  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL CHECK (end_at > start_at),
  timezone TEXT NOT NULL,

  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,

  -- Set once the Google Calendar event is created; NULL while
  -- status = CALENDAR_SYNC_FAILED (booking exists, calendar event doesn't
  -- — see the Phase 2 report's reconciliation notes).
  google_event_id TEXT,

  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('voice', 'whatsapp', 'website', 'manual')),
  -- Retry-safe creation (spec: creating an appointment must not create a
  -- duplicate Google event on retry). A repeated createBooking call with
  -- the same key hits this unique constraint instead of inserting again;
  -- the caller looks up and returns the existing row.
  idempotency_key TEXT,

  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX idx_bookings_org ON public.bookings (organization_id);
CREATE INDEX idx_bookings_business ON public.bookings (business_id);
CREATE INDEX idx_bookings_contact ON public.bookings (contact_id);
CREATE INDEX idx_bookings_calendar_connection ON public.bookings (calendar_connection_id);
-- Powers the availability query's "existing ClickAI bookings" check and the
-- application-level double-booking re-check immediately before insert.
CREATE INDEX idx_bookings_connection_window ON public.bookings (calendar_connection_id, start_at, end_at)
  WHERE status NOT IN ('CANCELLED', 'NO_SHOW');

-- Best-effort DB-level double-booking guard: rejects two active bookings on
-- the same calendar connection starting at the exact same instant. This is
-- weaker than a full time-range overlap exclusion (which would need the
-- btree_gist extension — not confirmed available in the target Supabase
-- project, so not added speculatively in this migration; see the Phase 2
-- report for the recommended hardening follow-up). The real overlap
-- protection is the application-level re-check-before-insert in
-- booking-service.server.ts; this constraint is a backstop for the exact-
-- start-time race specifically.
CREATE UNIQUE INDEX idx_bookings_no_exact_start_clash
  ON public.bookings (calendar_connection_id, start_at)
  WHERE status NOT IN ('CANCELLED', 'NO_SHOW') AND calendar_connection_id IS NOT NULL;

CREATE TRIGGER set_bookings_updated_at
  BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

-- Read-only for customers, same rationale as whatsapp_connections/
-- google_calendar_connections above: every write (create, reschedule,
-- cancel, calendar sync) goes through server-side code that explicitly
-- validates organization/business/contact ownership before writing.
CREATE POLICY "tenant bookings read" ON public.bookings
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
