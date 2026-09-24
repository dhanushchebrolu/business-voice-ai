-- Phase 3: Razorpay merchant connection foundation.
--
-- Reuses existing infrastructure rather than duplicating it:
--   - tenant isolation: organizations / is_org_member() (unchanged)
--   - OAuth state: the existing oauth_states table (Phase 2, already
--     provider-generic — provider='razorpay' rows live alongside
--     provider='google_calendar' rows with zero schema change needed)
--   - businesses (unchanged) — a connection belongs to one business
--   - updated_at trigger: the existing update_updated_at_column() function
--
-- Explicitly NOT part of this phase (see the Phase 3 report):
--   - No payment_requests/payment_transactions/payment_events tables —
--     those are Phase 4. This migration only establishes the merchant
--     CONNECTION, not the payment-transaction system.
--   - payment_orders/payments/webhook_events (ClickAI's own platform
--     billing — organization pays ClickAI) are untouched. This is a
--     structurally separate concern: a razorpay_connections row
--     represents a CLIENT BUSINESS's own Razorpay account, which their
--     OWN customers will eventually pay into (Phase 4) — never ClickAI's
--     platform billing.
--
-- Razorpay credentials are stored as AES-256-GCM ciphertext produced by
-- application code (razorpay-crypto.server.ts) using a server-only
-- encryption key (RAZORPAY_CREDENTIAL_ENCRYPTION_KEY, a Worker secret) —
-- the database never sees the plaintext token or the key, mirroring
-- google_calendar_connections.encrypted_credentials' convention exactly.

-- ============================================================
-- razorpay_connections — one row per Razorpay merchant account
-- connected to a tenant's business. `provider` is included (default
-- 'razorpay') so the same table/unique-constraint shape can hold a future
-- Stripe/Cashfree connection without a schema change (spec: "Business /
-- Razorpay / Stripe / other provider should remain possible").
--
-- connection_status (this integration's own health: DISCONNECTED /
-- CONNECTING / CONNECTED / REAUTH_REQUIRED / ERROR) is kept deliberately
-- separate from merchant_status (whatever account-activation/KYC concept
-- Razorpay itself reports, if any — nullable, opaque text, ClickAI does
-- not interpret it) — spec section 10's explicit instruction not to
-- overload one field with unrelated concepts.
-- ============================================================
CREATE TABLE public.razorpay_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'razorpay',

  connection_status TEXT NOT NULL DEFAULT 'DISCONNECTED' CHECK (connection_status IN (
    'DISCONNECTED', 'CONNECTING', 'CONNECTED', 'REAUTH_REQUIRED', 'ERROR'
  )),
  -- Whatever account-activation/KYC state Razorpay itself reports for this
  -- merchant, if the connected API surface exposes one. Nullable and
  -- opaque (not a CHECK-constrained enum) — ClickAI does not gate any of
  -- its own behavior on this value in Phase 3, it is informational only.
  merchant_status TEXT,

  -- Razorpay's own identifier for the connected merchant account. The
  -- sole external identifier stored (spec listed both "razorpay_account_id"
  -- and "merchant_id" as candidates — kept as one column since, per
  -- Razorpay's OAuth-for-Partners model, the connected account IS the
  -- merchant; a second column would just duplicate this value).
  razorpay_account_id TEXT,

  business_name TEXT,
  display_name TEXT,
  email TEXT,
  phone TEXT,

  -- AES-256-GCM ciphertext of a JSON blob holding the refresh token (see
  -- razorpay-crypto.server.ts). Access tokens are minted on demand from
  -- the refresh token and never persisted, exactly like
  -- google_calendar_connections.
  encrypted_credentials TEXT,
  token_expires_at TIMESTAMPTZ,
  scopes TEXT[] NOT NULL DEFAULT '{}',

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,

  connected_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One active connection per (business, provider) — matches
  -- google_calendar_connections' own uniqueness exactly, and the spec's
  -- explicit "one active Razorpay connection per business" invariant. A
  -- business reconnecting after disconnect updates this same row rather
  -- than creating a second one, which also closes the "double-click
  -- Connect" concurrency/idempotency concern (spec sections 66-67) at the
  -- database level: a second concurrent completeRazorpayOAuth for the
  -- same business upserts onto the same row instead of racing to insert
  -- two.
  UNIQUE (organization_id, business_id, provider)
);

CREATE INDEX idx_razorpay_connections_org ON public.razorpay_connections (organization_id);
CREATE INDEX idx_razorpay_connections_business ON public.razorpay_connections (business_id);

CREATE TRIGGER set_razorpay_connections_updated_at
  BEFORE UPDATE ON public.razorpay_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.razorpay_connections ENABLE ROW LEVEL SECURITY;

-- Customers may read their own connection's status/metadata. Every write
-- (connect, verify, disconnect, token refresh, status transitions) goes
-- through server-side code using supabaseAdmin, which explicitly
-- re-validates organization/business ownership in application code before
-- writing — mirroring google_calendar_connections' pattern exactly.
CREATE POLICY "tenant razorpay connections read" ON public.razorpay_connections
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

-- Column-level protection: even though there is no authenticated UPDATE
-- policy at all (every write is server-only), this explicit column grant
-- means a future `select("*")` from customer-facing code still cannot leak
-- encrypted_credentials — same belt-and-suspenders pattern as
-- google_calendar_connections' own exclusion.
REVOKE SELECT ON public.razorpay_connections FROM authenticated;
GRANT SELECT (
  id, organization_id, business_id, provider, connection_status, merchant_status,
  razorpay_account_id, business_name, display_name, email, phone, token_expires_at,
  scopes, metadata, last_error, connected_at, last_verified_at, disconnected_at,
  created_at, updated_at
) ON public.razorpay_connections TO authenticated;
