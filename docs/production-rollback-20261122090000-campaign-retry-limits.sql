-- Rollback for 20261122090000_campaign_retry_limits.sql. Removes the two
-- constraints only; no data changes. The application keeps applying the same
-- limits (campaign-outcome.ts, launch), so rolling this back does not re-open
-- repeated calls to someone who answered.
BEGIN;
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_retry_statuses_allowed;
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_retry_after_minutes_range;
COMMIT;
