-- Phase F: Admin CRM for demo requests.
--
-- The public "Book a demo" form (src/routes/contact.tsx) already inserts
-- into demo_requests, and RLS already lets any visitor INSERT while only
-- platform admins can SELECT/UPDATE (20260905080000). Nothing in src/ reads
-- or manages these requests yet. This adds the smallest column set an admin
-- CRM page needs — status vocabulary, internal notes, conversion tracking —
-- without touching the existing table's public-facing shape.

-- Column-scoped INSERT: a public submitter must never be able to set
-- status/admin_notes/converted/organization_id directly (e.g. by POSTing to
-- PostgREST outside the app's own form) — only the fields the form actually
-- collects. RLS is row-level and can't restrict this; a column grant can.
REVOKE INSERT ON public.demo_requests FROM anon, authenticated;
GRANT INSERT (name, email, phone, business_name, message) ON public.demo_requests TO anon, authenticated;

ALTER TABLE public.demo_requests
  ADD COLUMN IF NOT EXISTS admin_notes text,
  ADD COLUMN IF NOT EXISTS converted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Normalize any existing free-text status values onto the canonical 5-value
-- vocabulary before constraining the column. Anything unrecognized falls
-- back to NEW rather than violating the CHECK added below.
UPDATE public.demo_requests SET status = 'NEW' WHERE status IS NULL OR lower(status) = 'new';
UPDATE public.demo_requests SET status = 'CONTACTED' WHERE lower(status) = 'contacted';
UPDATE public.demo_requests SET status = 'DEMO_SCHEDULED' WHERE lower(status) = 'demo_scheduled';
UPDATE public.demo_requests SET status = 'WON' WHERE lower(status) = 'won';
UPDATE public.demo_requests SET status = 'LOST' WHERE lower(status) = 'lost';
UPDATE public.demo_requests
  SET status = 'NEW'
  WHERE status NOT IN ('NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'WON', 'LOST');

ALTER TABLE public.demo_requests ALTER COLUMN status SET DEFAULT 'NEW';
ALTER TABLE public.demo_requests
  ADD CONSTRAINT demo_requests_status_check
  CHECK (status IN ('NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'WON', 'LOST'));

-- A converted request must carry the organization it became — status=WON
-- alone does not imply conversion; "convert" is a separate, explicit admin
-- action (createClientAccount + this row's update), so the two can't drift.
ALTER TABLE public.demo_requests
  ADD CONSTRAINT demo_requests_converted_requires_org
  CHECK (NOT converted OR organization_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_demo_requests_status ON public.demo_requests (status);
CREATE INDEX IF NOT EXISTS idx_demo_requests_organization_id
  ON public.demo_requests (organization_id) WHERE organization_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_demo_requests_updated ON public.demo_requests;
CREATE TRIGGER trg_demo_requests_updated BEFORE UPDATE ON public.demo_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- admin_notes/converted/organization_id/status are all admin-managed only.
-- RLS is row-level, not column-level: the existing "platform admins update
-- demo requests" UPDATE policy already restricts every column to rows an
-- admin can reach (is_platform_admin()), so no new policy is needed — a
-- non-admin authenticated user still has zero rows to update at all.
