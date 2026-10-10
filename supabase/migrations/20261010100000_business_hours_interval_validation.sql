-- Schema-level backstop for business_hours.intervals /
-- business_hour_overrides.intervals: rejects a malformed or reversed
-- {start, end} interval at write time, for every write path — the two
-- locked RPCs (set_business_weekly_hours, apply_business_schedule_override
-- in 20261009120000_atomic_schedule_validation_and_locking.sql) AND the two
-- legacy direct-table writes (app.business.tsx, app.onboarding.tsx), which
-- bypass those RPCs entirely and are reachable by any authenticated tenant
-- member via this table's own "tenant hours"/"tenant hour overrides" RLS
-- grants. A TypeScript-only check (business-hours-validation.ts) cannot
-- close that gap by itself, since nothing stops a caller from hitting
-- PostgREST directly; this trigger is the one place the rule can't be
-- bypassed.
--
-- Deliberately separate from, and does not modify, the already-reviewed
-- pending migration batch (20260908110000..20261009120000) — this is a
-- new, independent, additive-only migration. It is NOT applied to
-- production by this change; authoring it here does not run it.
--
-- Root-caused bug this closes: the dashboard Hours editor and onboarding
-- seed (fixed for shape in 20261009100000's own "Data fix" section) can
-- still write a structurally-correct-but-semantically-backwards interval
-- like {"start":"23:59","end":"00:00"} — confirmed present today on one
-- production business, 7 rows. Traced in this session: both the JS
-- precedence engine (calendar-service.server.ts's mergeRanges/
-- subtractRange, via their own `r.end > r.start` filters) and the SQL
-- precedence engine (business_effective_open_ranges) already fail CLOSED
-- for such a row — no booking can ever match a range whose end precedes
-- its start — but silently, indistinguishable from an intentionally closed
-- day. This migration stops any NEW bad row from being written; it does
-- not touch, repair, or backfill the existing ones (see the trigger body's
-- own comment on why it cannot: it only fires on INSERT/UPDATE).
--
-- Rule (identical to src/lib/calendar/business-hours-validation.ts — see
-- that file's own header for the shared contract both sides implement):
--   - Validation is skipped ENTIRELY whenever the row claims to be closed
--     (business_hours.is_closed, business_hour_overrides.
--     is_full_day_closure) — intervals may hold anything in that case,
--     matching both RPCs' own `CASE WHEN closed THEN '[]' ELSE p_intervals
--     END` normalization exactly, so a legitimate closure can never be
--     rejected.
--   - Otherwise intervals must be a JSON array (empty is valid — "open,
--     nothing configured yet" is a real, distinct state, not an error);
--     every element must be a JSON object with string "start"/"end"
--     matching strict zero-padded 24h HH:mm, with end STRICTLY after
--     start (equal rejected, no overnight wraparound, no swap/normalize);
--     business_hour_overrides elements additionally require a boolean
--     "isOpen" key (every existing write path already always sends one —
--     apply_business_schedule_override's own p_intervals comes from
--     calendar-dashboard.functions.ts's overrideIntervalSchema, which zod-
--     requires it — so this tightens a previously-silent "missing isOpen
--     treated as close" gap into an explicit rejection, without changing
--     behavior for any current caller).
--   - On UPDATE (never INSERT, which has no prior row to compare against),
--     re-validation only runs when the closed-flag or intervals actually
--     changed from their stored value. An update to any other column on a
--     row whose existing intervals are already invalid (legacy data) is
--     never blocked by that pre-existing, unrelated problem.
CREATE OR REPLACE FUNCTION public.validate_business_hours_interval_shape()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_closed BOOLEAN;
  v_old_closed BOOLEAN;
  v_elem JSONB;
  v_start TEXT;
  v_end TEXT;
  v_index INT := 0;
BEGIN
  -- True SQL NULL cannot actually reach here (both columns are NOT NULL),
  -- but if it ever did, let the column's own NOT NULL constraint raise its
  -- own standard, equally explicit error rather than this function doing
  -- so redundantly.
  IF NEW.intervals IS NULL THEN
    RETURN NEW;
  END IF;

  -- Written as an actual IF/ELSE (control flow), not a single CASE
  -- expression — PL/pgSQL evaluates a CASE expression as one combined SQL
  -- expression, which requires resolving every field reference in it
  -- regardless of which branch wins, and NEW's composite type only ever
  -- has ONE of these two columns depending on which table fired the
  -- trigger. Confirmed against a real Postgres 16 instance: the CASE form
  -- raised "record new has no field is_full_day_closure" even when
  -- TG_TABLE_NAME = 'business_hours'. Separate IF/ELSE branches are true
  -- PL/pgSQL statements, so only the taken branch's field is ever touched.
  IF TG_TABLE_NAME = 'business_hours' THEN
    v_closed := NEW.is_closed;
  ELSE
    v_closed := NEW.is_full_day_closure;
  END IF;

  -- On UPDATE only (there is no OLD row on INSERT, so this never applies
  -- there — every INSERT of an open row is always fully validated below),
  -- skip re-validation entirely when neither the closed-flag nor
  -- intervals actually changed from their prior value. Without this, any
  -- future update that touches an unrelated column on a row whose
  -- EXISTING intervals are already invalid (legacy data written before
  -- this trigger existed, e.g. production's {"start":"23:59","end":
  -- "00:00"} rows) would be rejected for a reason that has nothing to do
  -- with what the caller was actually trying to change. An update that
  -- DOES touch either field is still fully validated, exactly as before.
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'business_hours' THEN
      v_old_closed := OLD.is_closed;
    ELSE
      v_old_closed := OLD.is_full_day_closure;
    END IF;
    IF v_closed IS NOT DISTINCT FROM v_old_closed
       AND NEW.intervals IS NOT DISTINCT FROM OLD.intervals THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Closed / full-day-closure rows are never inspected — whatever
  -- intervals holds (stale data, '[]', even malformed JSON) is accepted
  -- unchanged. This is what guarantees a legitimate closure write can
  -- never be rejected by this trigger.
  IF v_closed THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(NEW.intervals) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID_BUSINESS_HOURS_INTERVAL: intervals must be a JSON array (got %)',
      jsonb_typeof(NEW.intervals);
  END IF;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(NEW.intervals) LOOP
    v_index := v_index + 1;

    IF jsonb_typeof(v_elem) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'INVALID_BUSINESS_HOURS_INTERVAL: interval % must be a JSON object (got %)',
        v_index, jsonb_typeof(v_elem);
    END IF;

    IF NOT (v_elem ? 'start') OR jsonb_typeof(v_elem -> 'start') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'INVALID_BUSINESS_HOURS_INTERVAL: interval % is missing a string "start"', v_index;
    END IF;
    IF NOT (v_elem ? 'end') OR jsonb_typeof(v_elem -> 'end') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'INVALID_BUSINESS_HOURS_INTERVAL: interval % is missing a string "end"', v_index;
    END IF;

    IF TG_TABLE_NAME = 'business_hour_overrides' THEN
      IF NOT (v_elem ? 'isOpen') OR jsonb_typeof(v_elem -> 'isOpen') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'INVALID_BUSINESS_HOURS_INTERVAL: override interval % is missing a boolean "isOpen"',
          v_index;
      END IF;
    END IF;

    v_start := v_elem ->> 'start';
    v_end := v_elem ->> 'end';

    IF v_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RAISE EXCEPTION 'INVALID_BUSINESS_HOURS_INTERVAL: interval % has a malformed start time "%"',
        v_index, v_start;
    END IF;
    IF v_end !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RAISE EXCEPTION 'INVALID_BUSINESS_HOURS_INTERVAL: interval % has a malformed end time "%"',
        v_index, v_end;
    END IF;
    -- Lexical comparison is exact here: both sides are already confirmed
    -- to match the fixed-width zero-padded HH:mm pattern above, so lexical
    -- order and numeric minute-of-day order agree exactly. No day-
    -- rollover is ever inferred from a backwards pair.
    IF v_end <= v_start THEN
      RAISE EXCEPTION 'INVALID_BUSINESS_HOURS_INTERVAL: interval % end "%" must be after start "%" (overnight hours are not supported)',
        v_index, v_end, v_start;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_business_hours_validate_intervals
  BEFORE INSERT OR UPDATE ON public.business_hours
  FOR EACH ROW EXECUTE FUNCTION public.validate_business_hours_interval_shape();

CREATE TRIGGER trg_business_hour_overrides_validate_intervals
  BEFORE INSERT OR UPDATE ON public.business_hour_overrides
  FOR EACH ROW EXECUTE FUNCTION public.validate_business_hours_interval_shape();
