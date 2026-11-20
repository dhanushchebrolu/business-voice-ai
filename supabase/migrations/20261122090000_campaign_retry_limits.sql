-- Campaign retry limits (GATE C4 audit finding H1).
--
-- Customers may write a draft campaign's retry settings directly (column
-- grants on campaigns), and nothing limited them: retry_statuses could
-- include 'completed' and retry_after_minutes could be 0 or negative, so a
-- person who answered could be called again every minute up to max_attempts.
--
-- From now on, in the database itself:
--   - only an unanswered attempt is retried: retry_statuses holds only
--     'no_answer', 'busy' and 'failed' (an empty list means no retries);
--   - a retry waits at least 15 minutes, and at most 7 days.
-- The application applies the same limits (campaign-outcome.ts) and launch
-- refuses a campaign outside them, so rows from before this migration are
-- held to them too.
--
-- Production had 0 campaigns when this was written; ADD CONSTRAINT validates
-- every existing row and fails (changing nothing) if any is outside the limits.

ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_retry_statuses_allowed;
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_retry_statuses_allowed CHECK (
    retry_statuses <@ ARRAY['no_answer', 'busy', 'failed']::text[]
  );

ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_retry_after_minutes_range;
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_retry_after_minutes_range CHECK (
    retry_after_minutes BETWEEN 15 AND 10080
  );
