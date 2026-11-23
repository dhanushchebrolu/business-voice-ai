-- Rollback for 20261123090000_campaign_creation_idempotency.sql. Removes the
-- unique index and the column; no other data changes. Deploy an application
-- version that does not send idempotency_key first, or campaign creation
-- fails on the missing column.
BEGIN;
DROP INDEX IF EXISTS public.idx_campaigns_org_idempotency_key;
ALTER TABLE public.campaigns DROP COLUMN IF EXISTS idempotency_key;
COMMIT;
