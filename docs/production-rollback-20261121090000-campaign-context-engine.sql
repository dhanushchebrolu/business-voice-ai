-- Rollback for 20261121090000_campaign_context_engine.sql. Run only with approval,
-- after the Worker is back on a version that does not call
-- admit_campaign_outbound_call or read these columns, and with no campaign running.
--
-- Pre-check (read-only):
--   SELECT id, status FROM public.campaigns WHERE status IN ('running', 'paused');
--   SELECT count(*) FROM public.campaign_contacts WHERE status = 'excluded';

BEGIN;
-- Excluded contacts become cancelled (never dialled either way).
UPDATE public.campaign_contacts SET status = 'cancelled' WHERE status = 'excluded';
ALTER TABLE public.campaign_contacts DROP CONSTRAINT IF EXISTS campaign_contacts_status_check;
ALTER TABLE public.campaign_contacts ADD CONSTRAINT campaign_contacts_status_check CHECK (status IN (
  'pending','queued','calling','connected','no_answer','busy','failed',
  'completed','retry_scheduled','opted_out','wrong_number','cancelled','outcome_unknown'
));
ALTER TABLE public.campaign_contacts DROP COLUMN IF EXISTS excluded_reason;

DROP FUNCTION IF EXISTS public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer);

REVOKE INSERT (description, budget_limit), UPDATE (description, budget_limit) ON public.campaigns FROM authenticated;
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_context_reviewed;
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_budget_limit_positive;
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_description_length;
ALTER TABLE public.campaigns
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS context,
  DROP COLUMN IF EXISTS context_version,
  DROP COLUMN IF EXISTS context_reviewed_at,
  DROP COLUMN IF EXISTS context_reviewed_by,
  DROP COLUMN IF EXISTS budget_limit;
COMMIT;

-- admit_single_outbound_call: re-apply its definition from
-- 20261119090000_outbound_call_admission.sql (section 3) to restore the
-- single-calls-only wallet reservation. Keeping the stricter version is also safe.
