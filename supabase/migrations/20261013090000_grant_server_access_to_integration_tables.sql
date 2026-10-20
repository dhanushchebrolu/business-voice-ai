-- ============================================================
-- Server-role access for the integration/booking tables created on
-- 2026-09-24..26.
--
-- Production incident: starting a Google Calendar connection failed with
--   "Failed to create OAuth state: permission denied for table oauth_states"
--
-- Root cause: these tables were created without any GRANT to service_role
-- (every other table in this schema grants explicitly — see e.g.
-- 20260829120932 and 20261009100000). They only worked where the database
-- adds Supabase's legacy default privileges for new public tables (which is
-- what the local test harness emulates). This project does not grant
-- service_role on new tables by default, so the server's own client — which
-- authenticates as service_role and bypasses RLS, but still needs table
-- privileges — was denied. The same request had just read `businesses` and
-- `organization_members` successfully with that client, which rules out a
-- wrong key: only these tables lack the grant.
--
-- This grants exactly the operations the server code performs (SELECT is
-- needed for UPDATE ... RETURNING / upsert as well as reads). Nothing is
-- granted to anon. RLS stays enabled and no policy changes:
--   - oauth_states, payment_webhook_events, payment_domain_events stay
--     server-only (no anon/authenticated access at all);
--   - google_calendar_connections / razorpay_connections keep their
--     existing column-limited SELECT for authenticated (no credentials);
--   - bookings / payment_requests get the plain SELECT their existing
--     "tenant ... read" policies were written for (rows are still limited
--     to the member's own organization by those policies). Writes remain
--     server-only.
-- Idempotent: GRANT of an already-held privilege is a no-op.
-- ============================================================

-- Server-only OAuth CSRF state: create (insert), consume once (update ...
-- where consumed_at is null ... returning).
GRANT SELECT, INSERT, UPDATE ON public.oauth_states TO service_role;

-- Calendar/payment connections: upsert on connect, status/token updates.
GRANT SELECT, INSERT, UPDATE ON public.google_calendar_connections TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.razorpay_connections TO service_role;

-- Bookings are created/cancelled/rescheduled through SECURITY DEFINER RPCs;
-- the server reads them and makes guarded status updates directly.
GRANT SELECT, UPDATE ON public.bookings TO service_role;

-- Customer payments and their webhook/domain-event ledgers.
GRANT SELECT, INSERT, UPDATE ON public.payment_requests TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.payment_webhook_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.payment_domain_events TO service_role;

-- Tenant read access the existing RLS read policies already define.
GRANT SELECT ON public.bookings TO authenticated;
GRANT SELECT ON public.payment_requests TO authenticated;
