-- Auth/website fixes phase:
--  1. A real, non-fake destination for the public "Book a demo" CTA — a
--     lead-capture table any visitor (including anon) can insert into, that
--     only platform admins can read. No booking/scheduling logic is
--     implemented; a human on the Vaani team follows up.
--  2. Per-user Settings needs somewhere durable to persist Preferences and
--     Notifications — these are genuinely new user-scoped columns on the
--     existing `profiles` table (already RLS'd to the owning user), not a
--     new table, so no new RLS policy is required.

CREATE TABLE IF NOT EXISTS public.demo_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  business_name text,
  message text,
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT INSERT ON public.demo_requests TO anon, authenticated;
GRANT SELECT, UPDATE ON public.demo_requests TO authenticated;
GRANT ALL ON public.demo_requests TO service_role;
ALTER TABLE public.demo_requests ENABLE ROW LEVEL SECURITY;

-- Anyone (including a signed-out visitor) can submit a demo request. There is
-- no SELECT policy for anon/authenticated non-admins, so a submitter cannot
-- read back their own or anyone else's row through this policy.
CREATE POLICY "anyone can request a demo" ON public.demo_requests
  FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "platform admins read demo requests" ON public.demo_requests
  FOR SELECT TO authenticated USING (public.is_platform_admin());

CREATE POLICY "platform admins update demo requests" ON public.demo_requests
  FOR UPDATE TO authenticated USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

CREATE INDEX IF NOT EXISTS idx_demo_requests_created ON public.demo_requests (created_at DESC);

-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS preferred_language text,
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN IF NOT EXISTS notify_email boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_call_summaries boolean NOT NULL DEFAULT true;
