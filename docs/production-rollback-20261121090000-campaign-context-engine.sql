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

DROP FUNCTION IF EXISTS public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer, timestamptz, text, text);
DROP FUNCTION IF EXISTS public.admit_campaign_outbound_call(uuid, uuid, uuid, text, integer, integer);

-- Per-call context snapshots are lost with the column (calls themselves survive).
DROP TRIGGER IF EXISTS trg_call_logs_context_snapshot_immutable ON public.call_logs;
DROP FUNCTION IF EXISTS public.call_logs_context_snapshot_immutable();
ALTER TABLE public.call_logs DROP COLUMN IF EXISTS campaign_context_snapshot;

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
-- 20261119090000_outbound_call_admission.sql (section 3) FIRST, then drop the
-- calling-hours helpers it uses:
--   DROP FUNCTION IF EXISTS public.within_outbound_calling_hours(timestamptz);
--   DROP FUNCTION IF EXISTS public.outbound_admission_now();
-- Keeping the stricter single admission (and the helpers) is also safe.
