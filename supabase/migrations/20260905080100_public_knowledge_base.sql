-- Backend-controlled knowledge source for the public website chatbot/voice
-- assistant (spec: "Website AI"). Deliberately global/platform-scoped, with
-- no organization_id or any column that could carry customer data — this is
-- the explicit separation between public marketing knowledge and private
-- per-tenant data required by the task. The public assistant must never be
-- able to join this table against anything tenant-scoped.

CREATE TABLE IF NOT EXISTS public.public_knowledge_base (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Unique so the starter seed below (and any future seeding) can be
  -- genuinely idempotent via ON CONFLICT (title); also reasonable content
  -- hygiene for a marketing knowledge base (no duplicate-titled entries).
  title text NOT NULL UNIQUE,
  content text NOT NULL,
  category text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.public_knowledge_base TO anon, authenticated;
GRANT ALL ON public.public_knowledge_base TO service_role;
ALTER TABLE public.public_knowledge_base ENABLE ROW LEVEL SECURITY;

-- Only active entries are visible to anyone other than a platform admin —
-- the public assistant (and any direct client read) only ever sees these.
CREATE POLICY "active knowledge is public" ON public.public_knowledge_base
  FOR SELECT TO anon, authenticated USING (is_active);

CREATE POLICY "platform admins manage knowledge base" ON public.public_knowledge_base
  FOR ALL TO authenticated USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

CREATE INDEX IF NOT EXISTS idx_public_knowledge_active_order
  ON public.public_knowledge_base (is_active, sort_order);

DROP TRIGGER IF EXISTS trg_public_knowledge_base_updated ON public.public_knowledge_base;
CREATE TRIGGER trg_public_knowledge_base_updated BEFORE UPDATE ON public.public_knowledge_base
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed a small set of accurate starter entries so the assistant has
-- something real to answer from immediately. All admin-editable afterwards.
-- Genuinely idempotent: title is UNIQUE (see column above), so re-running
-- this block never creates duplicate rows.
INSERT INTO public.public_knowledge_base (title, content, category, sort_order) VALUES
  (
    'What Vaani is',
    'Vaani is an AI phone receptionist for Indian businesses. It answers every inbound call using the business''s own hours, services, prices, FAQs and rules — nothing is invented. It also logs every call, transcript and captured lead in a dashboard.',
    'overview', 1
  ),
  (
    'Supported languages',
    'Vaani answers calls in eleven Indian languages, including English, Hindi, Telugu, Tamil and Bengali, with natural voices and per-language greetings.',
    'features', 2
  ),
  (
    'How a call works',
    'A customer dials the business number, the call is streamed to Vaani''s voice runtime, speech is recognised in the caller''s language, the business''s published agent version answers using their own data, the reply is spoken back, and a transcript, summary and lead are saved to the dashboard.',
    'features', 3
  ),
  (
    'Business use cases',
    'Vaani suits any business that takes phone calls it cannot always answer immediately — clinics, salons, restaurants, service providers and retail — to quote prices, answer FAQs, take messages and capture leads around the clock.',
    'use_cases', 4
  ),
  (
    'Phone numbers and telephony',
    'A business can bring its own telephony number or have one provisioned through Vaani, depending on the connected provider. Vaani handles the call routing, billing and receptionist logic once a number is connected.',
    'setup', 5
  ),
  (
    'Getting started',
    'Getting started means creating an account, and a Vaani team member provisions and activates the workspace as part of onboarding after the setup payment. To talk to the team first, use the "Book a demo" option.',
    'onboarding', 6
  )
ON CONFLICT (title) DO NOTHING;
