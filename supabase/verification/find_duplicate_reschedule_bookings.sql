-- Read-only: find bookings left behind by the voice reschedule defect.
--
-- Before the fix, "reschedule my appointment to 1 PM" on a call created a
-- NEW booking at the new time and left the original booking live. This
-- lists every caller (same organization, business and phone — the booking's
-- contact phone, else its customer_phone) who has MORE THAN ONE live,
-- upcoming booking, so staff can decide which one the customer really
-- wants.
--
-- SELECT only: no INSERT/UPDATE/DELETE/ALTER, no temporary objects. Output
-- shows only the last 4 digits of a phone number and no names.
--
-- Reading the result:
--   same_call_group  > 1  — several bookings created on the SAME call (the
--                           voice idempotency key 'voice:<call id>:…'),
--                           the strongest sign of the defect: the earlier
--                           one is usually the time the caller moved away
--                           from.
--   created_order         — 1 = created first.
--
-- Reconciling (do NOT delete rows, and do NOT update status in SQL): confirm
-- with the customer which time they want, then cancel the unwanted booking
-- from the dashboard (Bookings → Cancel). That path runs
-- cancel_booking_atomic, releases the slot, deletes its Google Calendar
-- event and closes any open payment request — none of which a direct SQL
-- change would do.
--
-- Optional: to limit the result to one tenant, uncomment the
-- organization filter in "live" and put the organization id in it.

WITH live AS (
  SELECT
    b.id,
    b.organization_id,
    b.business_id,
    b.status,
    b.service_id,
    b.start_at,
    b.end_at,
    b.timezone,
    b.created_at,
    b.source,
    COALESCE(ct.phone, b.customer_phone) AS identity_phone,
    CASE
      WHEN b.idempotency_key LIKE 'voice:%' THEN split_part(b.idempotency_key, ':', 2)
    END AS voice_call_id
  FROM public.bookings b
  LEFT JOIN public.contacts ct
    ON ct.id = b.contact_id AND ct.organization_id = b.organization_id
  WHERE b.status IN ('CONFIRMED', 'RESCHEDULED', 'PENDING_CONFIRMATION', 'CALENDAR_SYNC_FAILED')
    AND b.start_at > now()
    -- AND b.organization_id = '00000000-0000-0000-0000-000000000000'
),
callers_with_several AS (
  SELECT organization_id, business_id, identity_phone
  FROM live
  WHERE identity_phone IS NOT NULL AND identity_phone <> ''
  GROUP BY organization_id, business_id, identity_phone
  HAVING count(*) > 1
)
SELECT
  l.organization_id,
  l.business_id,
  right(l.identity_phone, 4) AS phone_last4,
  l.id AS booking_id,
  l.status,
  l.source,
  l.service_id,
  l.start_at AT TIME ZONE l.timezone AS local_start,
  l.end_at AT TIME ZONE l.timezone AS local_end,
  l.created_at,
  l.voice_call_id,
  CASE
    WHEN l.voice_call_id IS NULL THEN 1
    ELSE count(*) OVER (
      PARTITION BY l.organization_id, l.business_id, l.identity_phone, l.voice_call_id
    )
  END AS same_call_group,
  row_number() OVER (
    PARTITION BY l.organization_id, l.business_id, l.identity_phone
    ORDER BY l.created_at, l.id
  ) AS created_order
FROM live l
JOIN callers_with_several c
  ON c.organization_id = l.organization_id
 AND c.business_id = l.business_id
 AND c.identity_phone = l.identity_phone
ORDER BY l.organization_id, l.business_id, l.identity_phone, l.created_at, l.id;
