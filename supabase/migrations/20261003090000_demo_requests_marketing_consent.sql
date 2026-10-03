-- Records the explicit, unchecked-by-default consent checkbox on the public
-- /contact form (see src/routes/contact.tsx) — a real compliance signal, not
-- just UI copy: whether the submitter actually agreed to be contacted before
-- their row was inserted. Additive only; existing rows default to false
-- since no consent was collected for anything submitted before this column
-- existed.
ALTER TABLE public.demo_requests
  ADD COLUMN IF NOT EXISTS marketing_consent boolean NOT NULL DEFAULT false;
