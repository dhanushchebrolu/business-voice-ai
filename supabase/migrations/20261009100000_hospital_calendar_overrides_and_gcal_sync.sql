-- Hospital availability calendar: daily overrides, Google Calendar
-- two-way sync infrastructure, and a data-shape fix for an existing bug.
--
-- ============================================================
-- 0. Data fix: business_hours.intervals shape mismatch.
--
-- Confirmed by inspection: the dashboard's Hours editor
-- (app.business.tsx) and the onboarding seed (app.onboarding.tsx) wrote
-- intervals as [{from, to}], while calendar-service.server.ts's
-- BusinessHoursInterval (the actual availability/booking engine) has
-- always read [{start, end}] — a business configuring hours through
-- either of those UIs got intervals the booking engine could never
-- parse (interval.start/interval.end both undefined), silently breaking
-- slot generation. Both write sites are fixed in this same change (code,
-- not just this migration); this statement repairs any data already
-- written in the old shape. Idempotent and safe to re-run: it only
-- touches rows whose intervals actually contain a 'from' key, and
-- COALESCEs so a row already in the new shape (or a mix) is left
-- unchanged in effect.
-- ============================================================
UPDATE public.business_hours
SET intervals = (
  SELECT COALESCE(
    jsonb_agg(jsonb_build_object(
      'start', COALESCE(elem->>'start', elem->>'from'),
      'end', COALESCE(elem->>'end', elem->>'to')
    )),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(intervals) elem
)
WHERE intervals IS NOT NULL
  AND jsonb_array_length(intervals) > 0
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(intervals) e WHERE e ? 'from'
  );

-- ============================================================
-- 1. business_hour_overrides — date-specific exceptions to the recurring
--    weekly schedule (business_hours). One row per (business, date):
--    `intervals` holds explicit open/close decisions for sub-ranges of
--    that date ("open an extra slot", "close this slot"); is_full_day_closure
--    is the holiday/emergency case and makes `intervals` irrelevant.
--    Precedence (enforced in calendar-service.server.ts's computeAvailability,
--    never duplicated in SQL): full-day closure > this override's
--    intervals > the recurring weekly schedule > confirmed bookings/
--    external busy periods (which always win regardless of any of the
--    above — an override can open or close a PERIOD, never an already-
--    booked or externally-busy instant).
--
--    Removing an override (DELETE the row) restores the recurring
--    weekly schedule for that date with no other side effect — there is
--    deliberately no "soft delete"/disabled flag, since an override that
--    isn't in effect and an override that doesn't exist are the same
--    thing from computeAvailability's point of view.
-- ============================================================
CREATE TABLE public.business_hour_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,

  -- The LOCAL calendar date (in the business's own configured timezone)
  -- this override applies to — never interpreted as UTC midnight; see
  -- calendar/timezone.ts's zonedWallTimeToUtc/businessDayUtcBounds, which
  -- this override's own consumer (computeAvailability) also uses.
  override_date DATE NOT NULL,

  is_full_day_closure BOOLEAN NOT NULL DEFAULT false,

  -- [{ "start": "HH:mm", "end": "HH:mm", "isOpen": boolean }, ...] — local
  -- wall-clock times, same convention as business_hours.intervals.
  -- isOpen:true OPENS a period (even outside the recurring weekly hours
  -- — "open an extra slot"); isOpen:false CLOSES a period (even one the
  -- recurring weekly hours would otherwise have opened — "close this
  -- slot"). Ignored entirely when is_full_day_closure is true.
  intervals JSONB NOT NULL DEFAULT '[]'::jsonb,

  reason TEXT,
  created_by UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (business_id, override_date)
);

CREATE INDEX idx_business_hour_overrides_business_date
  ON public.business_hour_overrides (business_id, override_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_hour_overrides TO authenticated;
GRANT ALL ON public.business_hour_overrides TO service_role;
ALTER TABLE public.business_hour_overrides ENABLE ROW LEVEL SECURITY;
-- Same policy shape as business_hours' own "tenant hours" policy —
-- hospital staff manage their own overrides directly; tenant isolation
-- is the only authorization boundary that exists anywhere else in this
-- dashboard today (see bookings.functions.ts's own header comment), so
-- this does not invent a new, inconsistent permission model for one
-- feature.
CREATE POLICY "tenant hour overrides" ON public.business_hour_overrides
  FOR ALL TO authenticated
  USING (public.is_org_member(organization_id))
  WITH CHECK (public.is_org_member(organization_id));
CREATE TRIGGER trg_business_hour_overrides_updated
  BEFORE UPDATE ON public.business_hour_overrides
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- 2. google_calendar_connections — incremental-sync state additions.
--    sync_token powers events.list's incremental sync (Google's
--    documented mechanism — see the sync service's own doc comment for
--    the full 410-Gone/full-resync fallback flow). channel_id/
--    channel_resource_id/channel_expiration identify the push
--    notification channel registered via events.watch, so the webhook
--    can look up which connection a notification belongs to, and so a
--    renewal sweep can find channels approaching their (Google-imposed,
--    max ~7-day) expiration.
-- ============================================================
ALTER TABLE public.google_calendar_connections ADD COLUMN IF NOT EXISTS sync_token TEXT;
ALTER TABLE public.google_calendar_connections ADD COLUMN IF NOT EXISTS channel_id TEXT;
ALTER TABLE public.google_calendar_connections ADD COLUMN IF NOT EXISTS channel_resource_id TEXT;
ALTER TABLE public.google_calendar_connections ADD COLUMN IF NOT EXISTS channel_expiration TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gcal_connections_channel_id
  ON public.google_calendar_connections (channel_id)
  WHERE channel_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gcal_connections_channel_expiration
  ON public.google_calendar_connections (channel_expiration)
  WHERE channel_id IS NOT NULL;

-- ============================================================
-- 3. external_calendar_events — the local, continuously-synced mirror of
--    "what Google says exists right now" for a connection. This is the
--    CACHE availability reads (both the dashboard calendar view and the
--    voice agent's check_calendar_availability lookup) query for
--    "external busy periods", instead of a live freeBusy call on every
--    single lookup. It is explicitly NOT authoritative for bookings —
--    ClickAI's own `bookings` table remains the sole source of truth for
--    patient appointments; this table only ever describes Google's OWN
--    calendar state, including events ClickAI itself created (tracked via
--    is_clickai_managed/linked_booking_id so sync/reconciliation can tell
--    the difference — see the sync service's own doc comment for the
--    full conflict policy).
--
--    The one place that still does a LIVE getBusyPeriods call, never this
--    cache, is createBooking()'s existing external-recheck immediately
--    before createEvent (Round F) — this cache speeds up lookups, it
--    never replaces that one authoritative pre-write check.
-- ============================================================
CREATE TABLE public.external_calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  calendar_connection_id UUID NOT NULL REFERENCES public.google_calendar_connections(id) ON DELETE CASCADE,

  google_event_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  is_all_day BOOLEAN NOT NULL DEFAULT false,

  -- Set only when this Google event can be traced back to one of
  -- ClickAI's own bookings (by google_event_id match at sync time) —
  -- never guessed from title/time coincidence (spec: "never associate
  -- an unknown event with a patient booking by guesswork").
  linked_booking_id UUID REFERENCES public.bookings(id) ON DELETE SET NULL,
  is_clickai_managed BOOLEAN NOT NULL DEFAULT false,

  -- Google's own event.updated timestamp — lets the sync service tell a
  -- genuinely newer external edit apart from redelivery of a notification
  -- it already processed.
  raw_updated_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (calendar_connection_id, google_event_id)
);

CREATE INDEX idx_external_events_connection_window
  ON public.external_calendar_events (calendar_connection_id, start_at, end_at)
  WHERE status != 'cancelled';
CREATE INDEX idx_external_events_linked_booking
  ON public.external_calendar_events (linked_booking_id)
  WHERE linked_booking_id IS NOT NULL;

ALTER TABLE public.external_calendar_events ENABLE ROW LEVEL SECURITY;
-- Read-only for tenant members (the dashboard calendar view reads this
-- directly for "externally busy" slot states) — every write comes from
-- the sync service via supabaseAdmin, same rationale as `bookings`' own
-- "every write goes through server-side code" policy.
CREATE POLICY "tenant external calendar events read" ON public.external_calendar_events
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
GRANT SELECT ON public.external_calendar_events TO authenticated;
GRANT ALL ON public.external_calendar_events TO service_role;

-- ============================================================
-- 4. calendar_sync_conflicts — unsafe-to-auto-resolve reconciliation
--    cases, surfaced to staff rather than resolved by guessing. A
--    ClickAI-managed Google event that was modified or deleted outside
--    ClickAI creates exactly one OPEN row here; the underlying booking
--    row is never touched automatically (spec: "a Google Calendar
--    deletion must not silently erase a patient booking").
-- ============================================================
CREATE TABLE public.calendar_sync_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  booking_id UUID REFERENCES public.bookings(id) ON DELETE CASCADE,
  calendar_connection_id UUID NOT NULL REFERENCES public.google_calendar_connections(id) ON DELETE CASCADE,
  google_event_id TEXT,

  conflict_type TEXT NOT NULL CHECK (conflict_type IN ('EXTERNALLY_MODIFIED', 'EXTERNALLY_DELETED')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,

  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_calendar_sync_conflicts_business_status
  ON public.calendar_sync_conflicts (business_id, status);
CREATE INDEX idx_calendar_sync_conflicts_booking
  ON public.calendar_sync_conflicts (booking_id)
  WHERE booking_id IS NOT NULL;

ALTER TABLE public.calendar_sync_conflicts ENABLE ROW LEVEL SECURITY;
-- Staff can read AND resolve (update status/resolution_notes) — this is
-- the one write authenticated users get on this table; INSERT stays
-- server-only (the sync service is the only thing allowed to RAISE a
-- conflict).
CREATE POLICY "tenant sync conflicts read" ON public.calendar_sync_conflicts
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY "tenant sync conflicts resolve" ON public.calendar_sync_conflicts
  FOR UPDATE TO authenticated
  USING (public.is_org_member(organization_id))
  WITH CHECK (public.is_org_member(organization_id));
GRANT SELECT, UPDATE ON public.calendar_sync_conflicts TO authenticated;
GRANT ALL ON public.calendar_sync_conflicts TO service_role;
CREATE TRIGGER trg_calendar_sync_conflicts_updated
  BEFORE UPDATE ON public.calendar_sync_conflicts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
