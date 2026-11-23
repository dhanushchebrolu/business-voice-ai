-- Retry-safe campaign creation (campaign reliability audit, finding 1).
--
-- Creating a campaign was a plain INSERT: two tabs, a retry after a timeout,
-- or a resubmission after a lost response created a second campaign. The
-- wizard now sends one idempotency key per creation session; a repeated
-- create with the same key hits this unique index instead of inserting again,
-- and the server returns the campaign that already exists (same pattern as
-- bookings.idempotency_key and payment_requests.idempotency_key).
--
--   - campaigns.idempotency_key is nullable: existing campaigns and any path
--     that does not send a key keep NULL, and NULLs never conflict.
--   - Unique per organization only, so two workspaces can never collide or
--     learn about each other's campaigns through a key.
--   - Campaign names stay non-unique; no existing row, status or constraint
--     is changed.
--
-- Additive and re-runnable. Rollback:
-- docs/production-rollback-20261123090000-campaign-creation-idempotency.sql

ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_org_idempotency_key
  ON public.campaigns (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
