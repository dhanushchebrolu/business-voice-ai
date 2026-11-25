-- Structured, persisted analysis of finished outbound calls (campaign reports).
--
-- One row per call, written by the analysis pipeline (call-analysis.server.ts) after the call
-- is final, and read by the campaign report. The analysis is stored, so a report never
-- regenerates on page load and the same call always reads the same.
--
--   status   'done'        analysed (from the transcript by AI, or from ClickAI's own records
--                          when there is nothing to read): final.
--            'pending_ai'  analysed from ClickAI's own records only; the transcript is waiting
--                          for AI, which is not available yet. Re-done when it is.
--            'no_transcript' there is no transcript to read (a failed or unanswered call, or
--                          none was sent): analysed from ClickAI's own records, final.
--            'failed'      the AI step failed; `attempts` counts tries and the next try waits.
--   source   'ai' | 'rules'  what produced the analysis fields.
--
-- Facts ClickAI holds itself (the call's status, length, booking made, opt-out) are always taken
-- from its own records, never from the model.
--
-- Additive: one table, no existing table is touched. Customers reach it only through the
-- server (service role); there is no direct access for browser roles.
-- Rollback:
--   DROP TABLE IF EXISTS public.call_analyses;

CREATE TABLE IF NOT EXISTS public.call_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  call_id uuid NOT NULL REFERENCES public.call_logs(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
  campaign_contact_id uuid REFERENCES public.campaign_contacts(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('done', 'pending_ai', 'no_transcript', 'failed')),
  source text NOT NULL CHECK (source IN ('ai', 'rules')),
  model text,
  analysis jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  analyzed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_analyses_one_per_call UNIQUE (call_id)
);

CREATE INDEX IF NOT EXISTS idx_call_analyses_campaign
  ON public.call_analyses (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_analyses_retry
  ON public.call_analyses (updated_at) WHERE status IN ('failed', 'pending_ai');

ALTER TABLE public.call_analyses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_analyses FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.call_analyses TO service_role;

DROP TRIGGER IF EXISTS trg_call_analyses_updated ON public.call_analyses;
CREATE TRIGGER trg_call_analyses_updated BEFORE UPDATE ON public.call_analyses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
