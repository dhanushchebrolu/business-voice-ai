-- Phase 3: each provisioning run keeps the expected-vs-actual deployment and
-- number checks from its last verification (provisioning-pipeline.server.ts
-- VerificationReport), so the admin screen can explain a failed check
-- without calling Sarvam again. No secrets are stored here.
--
-- Not destructive: one nullable column. Re-runnable. Rollback:
--   ALTER TABLE public.provisioning_runs DROP COLUMN IF EXISTS verification;

ALTER TABLE public.provisioning_runs
  ADD COLUMN IF NOT EXISTS verification jsonb;
