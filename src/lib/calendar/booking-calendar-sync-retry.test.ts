import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CALENDAR_SYNC_BACKOFF_MS,
  MAX_AUTOMATIC_CALENDAR_SYNC_ATTEMPTS,
  eventMatchesBooking,
  isCalendarSyncRetryDue,
  nextCalendarSyncAttemptAt,
  retryBookingCalendarSync,
  retryDueCalendarSyncFailures,
} from "./booking-service.server.ts";
import {
  CalendarProviderError,
  type CalendarEventInput,
  type CalendarProvider,
  type NormalizedCalendarEvent,
} from "./calendar-provider.ts";

/**
 * Recovery of CALENDAR_SYNC_FAILED bookings: idempotent event creation
 * (tag lookup before create), verification before CONFIRMED, retry
 * limits/backoff, org isolation, and race safety.
 */

const NOW = new Date("2030-10-14T10:00:00.000Z");
const START = "2030-10-14T13:00:00.000Z";
const END = "2030-10-14T13:30:00.000Z";

type Filters = { op: string; col: string; val: unknown }[];
interface Call {
  table: string;
  kind: "select" | "update";
  payload?: Record<string, unknown>;
  filters: Filters;
}

/**
 * Programmable fake Supabase client: every query is recorded with its
 * filters and answered by `respond`, so tests assert both outcomes and
 * exactly which rows a write was guarded on.
 */
function makeFakeSupabase(respond: (call: Call) => { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, kind: "select", filters: [] };
      const chain: Record<string, unknown> = {};
      const addFilter = (op: string) => (col: string, val: unknown) => {
        call.filters.push({ op, col, val });
        return chain;
      };
      const run = () => {
        calls.push(call);
        return Promise.resolve(respond(call));
      };
      Object.assign(chain, {
        select: () => chain,
        update(payload: Record<string, unknown>) {
          call.kind = "update";
          call.payload = payload;
          return chain;
        },
        eq: addFilter("eq"),
        gt: addFilter("gt"),
        gte: addFilter("gte"),
        order: () => chain,
        limit: (n: number) => addFilter("limit")("limit", n),
        maybeSingle: run,
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          return run().then(resolve, reject);
        },
      });
      return chain;
    },
  };
  return { client: client as never, calls };
}

function filterValue(call: Call, col: string): unknown {
  return call.filters.find((f) => f.col === col)?.val;
}

function bookingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    organization_id: "org-1",
    business_id: "biz-1",
    status: "CALENDAR_SYNC_FAILED",
    start_at: START,
    end_at: END,
    timezone: "Asia/Kolkata",
    customer_name: "Dhanush",
    google_event_id: null,
    calendar_connection_id: "conn-1",
    metadata: {
      calendar_sync_error: "Google Calendar is temporarily unavailable.",
      calendar_sync_attempts: 0,
      calendar_sync_next_attempt_at: "2030-10-14T09:55:00.000Z",
    },
    updated_at: "2030-10-14T09:50:00.000Z",
    ...overrides,
  };
}

/** Default DB behaviour: booking found, connection found, every guarded write matches one row. */
function standardDb(
  booking: Record<string, unknown> | null,
  opts: { connection?: boolean; claimRows?: number; confirmRows?: number } = {},
) {
  return makeFakeSupabase((call) => {
    if (call.table === "bookings" && call.kind === "select") return { data: booking, error: null };
    if (call.table === "google_calendar_connections") {
      return { data: opts.connection === false ? null : { id: "conn-1" }, error: null };
    }
    if (call.table === "bookings" && call.kind === "update") {
      if (call.payload?.["status"] === "CONFIRMED") {
        const n = opts.confirmRows ?? 1;
        return { data: Array.from({ length: n }, () => ({ id: "booking-1" })), error: null };
      }
      if (filterValue(call, "updated_at") !== undefined) {
        const n = opts.claimRows ?? 1;
        return { data: Array.from({ length: n }, () => ({ id: "booking-1" })), error: null };
      }
      return { data: null, error: null };
    }
    throw new Error(`unexpected call ${call.table}.${call.kind}`);
  });
}

function event(overrides: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent {
  return {
    id: "evt-1",
    title: "Appointment - Dhanush",
    description: undefined,
    start: "2030-10-14T18:30:00+05:30",
    end: "2030-10-14T19:00:00+05:30",
    status: "confirmed",
    clickaiBookingId: "booking-1",
    ...overrides,
  };
}

function makeProvider(behaviour: {
  existingTagged?: NormalizedCalendarEvent | null;
  getEvent?: (id: string) => NormalizedCalendarEvent | null;
  createEvent?: (input: CalendarEventInput) => NormalizedCalendarEvent;
}) {
  const log = {
    created: [] as CalendarEventInput[],
    deleted: [] as string[],
    updated: [] as string[],
    found: 0,
  };
  const provider: CalendarProvider = {
    listCalendars: async () => [],
    getBusyPeriods: async () => [],
    createEvent: async (input) => {
      log.created.push(input);
      return behaviour.createEvent ? behaviour.createEvent(input) : event({ id: "evt-new" });
    },
    updateEvent: async (_cal, id) => {
      log.updated.push(id);
      return event({ id });
    },
    deleteEvent: async (_cal, id) => {
      log.deleted.push(id);
    },
    getEvent: async (_cal, id) => (behaviour.getEvent ? behaviour.getEvent(id) : event({ id })),
    findEventByBookingId: async () => {
      log.found++;
      return behaviour.existingTagged ?? null;
    },
  };
  return { provider, log };
}

const resolverFor = (provider: CalendarProvider) => {
  const seen: string[] = [];
  const resolve = async (connectionId: string) => {
    seen.push(connectionId);
    return { provider, calendarId: "clinic-cal" };
  };
  return { resolve, seen };
};

describe("backoff schedule and eligibility", () => {
  test("5 min, 30 min, 2 h after attempts 0, 1, 2; none after the 3rd", () => {
    assert.equal(MAX_AUTOMATIC_CALENDAR_SYNC_ATTEMPTS, 3);
    for (const [attempts, delay] of CALENDAR_SYNC_BACKOFF_MS.entries()) {
      assert.equal(
        nextCalendarSyncAttemptAt(attempts, NOW),
        new Date(NOW.getTime() + delay).toISOString(),
      );
    }
    assert.equal(nextCalendarSyncAttemptAt(3, NOW), null);
  });

  test("due only for future CALENDAR_SYNC_FAILED bookings with attempts left and elapsed backoff", () => {
    const due = { status: "CALENDAR_SYNC_FAILED", start_at: START, metadata: {} };
    assert.equal(isCalendarSyncRetryDue(due, NOW), true);
    assert.equal(isCalendarSyncRetryDue({ ...due, status: "CONFIRMED" }, NOW), false);
    assert.equal(
      isCalendarSyncRetryDue({ ...due, start_at: "2030-10-14T09:00:00.000Z" }, NOW),
      false,
    );
    assert.equal(
      isCalendarSyncRetryDue({ ...due, metadata: { calendar_sync_attempts: 3 } }, NOW),
      false,
    );
    assert.equal(
      isCalendarSyncRetryDue(
        { ...due, metadata: { calendar_sync_next_attempt_at: "2030-10-14T10:05:00.000Z" } },
        NOW,
      ),
      false,
    );
  });

  test("verification requires the tag, a live status and the exact booked instants (any offset)", () => {
    const b = { id: "booking-1", start_at: START, end_at: END };
    assert.equal(eventMatchesBooking(event(), b), true);
    assert.equal(eventMatchesBooking(event({ clickaiBookingId: "booking-2" }), b), false);
    assert.equal(eventMatchesBooking(event({ clickaiBookingId: undefined }), b), false);
    assert.equal(eventMatchesBooking(event({ status: "cancelled" }), b), false);
    assert.equal(eventMatchesBooking(event({ start: "2030-10-14T19:30:00+05:30" }), b), false);
    assert.equal(eventMatchesBooking(null, b), false);
  });
});

describe("retryBookingCalendarSync", () => {
  test("creates a tagged event, re-reads it, and only then confirms with google_event_id", async () => {
    const { client, calls } = standardDb(bookingRow());
    const { provider, log } = makeProvider({});
    const { resolve } = resolverFor(provider);

    const result = await retryBookingCalendarSync(client, resolve, {
      organizationId: "org-1",
      bookingId: "booking-1",
      trigger: "automatic",
      now: NOW,
    });

    assert.deepEqual(result, {
      outcome: "confirmed",
      bookingId: "booking-1",
      googleEventId: "evt-new",
      reusedExistingEvent: false,
    });
    assert.equal(log.found, 1, "looked for an existing tagged event before creating");
    assert.equal(log.created.length, 1);
    assert.equal(log.created[0]!.clickaiBookingId, "booking-1");
    assert.equal(log.created[0]!.startIso, START);
    assert.equal(log.created[0]!.endIso, END);
    // No phone number is copied into the retried event.
    assert.doesNotMatch(log.created[0]!.description ?? "", /\+?\d{10}/);

    const confirm = calls.find((c) => c.payload?.["status"] === "CONFIRMED")!;
    assert.equal(confirm.payload!["google_event_id"], "evt-new");
    assert.equal(filterValue(confirm, "status"), "CALENDAR_SYNC_FAILED", "confirm is guarded");
    const meta = confirm.payload!["metadata"] as Record<string, unknown>;
    assert.equal(meta["calendar_sync_attempts"], 1);
    assert.equal(meta["calendar_sync_error"], undefined);
    assert.equal(meta["calendar_sync_next_attempt_at"], undefined);
  });

  test("dedup: an event a previous attempt already tagged is reused — never a second event", async () => {
    const { client, calls } = standardDb(bookingRow());
    const { provider, log } = makeProvider({ existingTagged: event({ id: "evt-earlier" }) });
    const { resolve } = resolverFor(provider);

    const result = await retryBookingCalendarSync(client, resolve, {
      organizationId: "org-1",
      bookingId: "booking-1",
      trigger: "automatic",
      now: NOW,
    });
    assert.equal(result.outcome, "confirmed");
    assert.equal(log.created.length, 0, "no new event when one already exists");
    const confirm = calls.find((c) => c.payload?.["status"] === "CONFIRMED")!;
    assert.equal(confirm.payload!["google_event_id"], "evt-earlier");
  });

  test("a booking whose own event drifted (failed reschedule) is patched, verified and confirmed", async () => {
    let patched = false;
    const { client } = standardDb(bookingRow({ google_event_id: "evt-old" }));
    const { provider, log } = makeProvider({
      getEvent: (id) =>
        patched
          ? event({ id })
          : event({ id, start: "2030-10-14T17:00:00+05:30", end: "2030-10-14T17:30:00+05:30" }),
    });
    const origUpdate = provider.updateEvent;
    provider.updateEvent = async (...args) => {
      patched = true;
      return origUpdate(...args);
    };
    const { resolve } = resolverFor(provider);
    const result = await retryBookingCalendarSync(client, resolve, {
      organizationId: "org-1",
      bookingId: "booking-1",
      trigger: "staff",
      now: NOW,
    });
    assert.equal(result.outcome, "confirmed");
    assert.deepEqual(log.updated, ["evt-old"]);
    assert.equal(log.created.length, 0);
  });

  test("verification failure: the booking stays CALENDAR_SYNC_FAILED and the unverified event is removed", async () => {
    const { client, calls } = standardDb(bookingRow());
    const { provider, log } = makeProvider({
      // Google returns the event, but at the wrong time.
      getEvent: (id) => event({ id, start: "2030-10-15T18:30:00+05:30" }),
    });
    const { resolve } = resolverFor(provider);
    const result = await retryBookingCalendarSync(client, resolve, {
      organizationId: "org-1",
      bookingId: "booking-1",
      trigger: "automatic",
      now: NOW,
    });
    assert.deepEqual(result, {
      outcome: "failed",
      bookingId: "booking-1",
      code: "CALENDAR_CONFLICT",
      attempts: 1,
    });
    assert.deepEqual(log.deleted, ["evt-new"]);
    assert.equal(
      calls.some((c) => c.payload?.["status"] === "CONFIRMED"),
      false,
      "never confirmed without verification",
    );
  });

  test("a Google failure records the attempt and schedules the next one; nothing sensitive is logged", async () => {
    const { client, calls } = standardDb(bookingRow());
    const { provider } = makeProvider({
      createEvent: () => {
        throw new CalendarProviderError("CALENDAR_UNAVAILABLE", "Google is down", true);
      },
    });
    const { resolve } = resolverFor(provider);
    const logged: unknown[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => logged.push(args);
    let result;
    try {
      result = await retryBookingCalendarSync(client, resolve, {
        organizationId: "org-1",
        bookingId: "booking-1",
        trigger: "automatic",
        now: NOW,
      });
    } finally {
      console.warn = origWarn;
    }
    assert.deepEqual(result, {
      outcome: "failed",
      bookingId: "booking-1",
      code: "CALENDAR_UNAVAILABLE",
      attempts: 1,
    });
    const claim = calls.find((c) => filterValue(c, "updated_at") !== undefined)!;
    const meta = claim.payload!["metadata"] as Record<string, unknown>;
    assert.equal(meta["calendar_sync_attempts"], 1);
    assert.equal(
      meta["calendar_sync_next_attempt_at"],
      new Date(NOW.getTime() + CALENDAR_SYNC_BACKOFF_MS[1]).toISOString(),
    );
    const text = JSON.stringify(logged);
    assert.doesNotMatch(text, /Dhanush|token|\+91/i);
  });

  test("retry limit: an automatic retry after 3 attempts is skipped; a staff retry is still allowed", async () => {
    const exhausted = bookingRow({
      metadata: { calendar_sync_attempts: 3, calendar_sync_next_attempt_at: null },
    });
    const auto = standardDb(exhausted);
    const { provider, log } = makeProvider({});
    const { resolve } = resolverFor(provider);
    assert.deepEqual(
      await retryBookingCalendarSync(auto.client, resolve, {
        organizationId: "org-1",
        bookingId: "booking-1",
        trigger: "automatic",
        now: NOW,
      }),
      { outcome: "skipped", bookingId: "booking-1", reason: "attempts_exhausted" },
    );
    assert.equal(log.created.length, 0);

    const staff = standardDb(exhausted);
    const result = await retryBookingCalendarSync(staff.client, resolve, {
      organizationId: "org-1",
      bookingId: "booking-1",
      trigger: "staff",
      now: NOW,
    });
    assert.equal(result.outcome, "confirmed");
  });

  test("backoff: an automatic retry before the next attempt time is skipped", async () => {
    const { client } = standardDb(
      bookingRow({
        metadata: {
          calendar_sync_attempts: 1,
          calendar_sync_next_attempt_at: "2030-10-14T10:20:00.000Z",
        },
      }),
    );
    const { provider } = makeProvider({});
    const result = await retryBookingCalendarSync(client, resolverFor(provider).resolve, {
      organizationId: "org-1",
      bookingId: "booking-1",
      trigger: "automatic",
      now: NOW,
    });
    assert.deepEqual(result, { outcome: "skipped", bookingId: "booking-1", reason: "not_due" });
  });

  test("past appointments are never retried, even by staff", async () => {
    const { client } = standardDb(bookingRow({ start_at: "2030-10-14T09:00:00.000Z" }));
    const { provider, log } = makeProvider({});
    const result = await retryBookingCalendarSync(client, resolverFor(provider).resolve, {
      organizationId: "org-1",
      bookingId: "booking-1",
      trigger: "staff",
      now: NOW,
    });
    assert.deepEqual(result, { outcome: "skipped", bookingId: "booking-1", reason: "in_past" });
    assert.equal(log.created.length, 0);
  });

  test("org isolation: another organization's booking is reported not_found and never touched", async () => {
    const { client, calls } = standardDb(bookingRow({ organization_id: "org-OTHER" }));
    const { provider, log } = makeProvider({});
    const result = await retryBookingCalendarSync(client, resolverFor(provider).resolve, {
      organizationId: "org-1",
      bookingId: "booking-1",
      trigger: "staff",
      now: NOW,
    });
    assert.deepEqual(result, { outcome: "skipped", bookingId: "booking-1", reason: "not_found" });
    assert.equal(log.created.length, 0);
    assert.equal(
      calls.some((c) => c.kind === "update"),
      false,
    );
  });

  test("org isolation: only a CONNECTED connection of the booking's own org and business is used", async () => {
    const { client, calls } = standardDb(bookingRow());
    const { provider } = makeProvider({});
    const { resolve, seen } = resolverFor(provider);
    await retryBookingCalendarSync(client, resolve, {
      organizationId: "org-1",
      bookingId: "booking-1",
      trigger: "automatic",
      now: NOW,
    });
    const connectionQuery = calls.find((c) => c.table === "google_calendar_connections")!;
    assert.equal(filterValue(connectionQuery, "organization_id"), "org-1");
    assert.equal(filterValue(connectionQuery, "business_id"), "biz-1");
    assert.equal(filterValue(connectionQuery, "status"), "CONNECTED");
    assert.equal(filterValue(connectionQuery, "id"), "conn-1");
    assert.deepEqual(seen, ["conn-1"]);
  });

  test("no live connection: skipped without consuming an attempt", async () => {
    const { client, calls } = standardDb(bookingRow(), { connection: false });
    const { provider } = makeProvider({});
    const result = await retryBookingCalendarSync(client, resolverFor(provider).resolve, {
      organizationId: "org-1",
      bookingId: "booking-1",
      trigger: "automatic",
      now: NOW,
    });
    assert.deepEqual(result, {
      outcome: "skipped",
      bookingId: "booking-1",
      reason: "no_calendar_connection",
    });
    assert.equal(
      calls.some((c) => c.kind === "update"),
      false,
    );
  });

  test("concurrency: when another worker already claimed the attempt, nothing is created", async () => {
    const { client } = standardDb(bookingRow(), { claimRows: 0 });
    const { provider, log } = makeProvider({});
    const result = await retryBookingCalendarSync(client, resolverFor(provider).resolve, {
      organizationId: "org-1",
      bookingId: "booking-1",
      trigger: "automatic",
      now: NOW,
    });
    assert.deepEqual(result, {
      outcome: "skipped",
      bookingId: "booking-1",
      reason: "already_in_progress",
    });
    assert.equal(log.created.length, 0);
  });

  test("a booking cancelled during the retry is not confirmed, and the event created for it is removed", async () => {
    const { client } = standardDb(bookingRow(), { confirmRows: 0 });
    const { provider, log } = makeProvider({});
    const result = await retryBookingCalendarSync(client, resolverFor(provider).resolve, {
      organizationId: "org-1",
      bookingId: "booking-1",
      trigger: "automatic",
      now: NOW,
    });
    assert.deepEqual(result, { outcome: "lost_race", bookingId: "booking-1" });
    assert.deepEqual(log.deleted, ["evt-new"]);
  });

  test("a booking no longer in CALENDAR_SYNC_FAILED is left alone", async () => {
    const { client } = standardDb(bookingRow({ status: "CONFIRMED" }));
    const { provider } = makeProvider({});
    const result = await retryBookingCalendarSync(client, resolverFor(provider).resolve, {
      organizationId: "org-1",
      bookingId: "booking-1",
      trigger: "staff",
      now: NOW,
    });
    assert.deepEqual(result, {
      outcome: "skipped",
      bookingId: "booking-1",
      reason: "not_sync_failed",
    });
  });
});

describe("retryDueCalendarSyncFailures — bounded automatic sweep", () => {
  test("retries at most `limit` due bookings, each in its own organization's scope", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `b-${i}`,
      organization_id: i % 2 ? "org-A" : "org-B",
      status: "CALENDAR_SYNC_FAILED",
      start_at: START,
      metadata:
        i === 0
          ? { calendar_sync_attempts: 3 } // exhausted
          : i === 1
            ? { calendar_sync_next_attempt_at: "2030-10-14T11:00:00.000Z" } // not due
            : { calendar_sync_attempts: 1 },
    }));
    const retried: { id: unknown; org: unknown }[] = [];
    const { client, calls } = makeFakeSupabase((call) => {
      if (call.table === "bookings" && call.kind === "select") {
        const id = filterValue(call, "id");
        if (id === undefined) return { data: rows, error: null };
        const row = rows.find((r) => r.id === id)!;
        retried.push({ id, org: row.organization_id });
        return {
          data: bookingRow({
            id,
            organization_id: row.organization_id,
            metadata: row.metadata,
          }),
          error: null,
        };
      }
      if (call.table === "google_calendar_connections")
        return { data: { id: "conn-1" }, error: null };
      return { data: [{ id: "x" }], error: null };
    });
    const { provider } = makeProvider({});
    const summary = await retryDueCalendarSyncFailures(client, resolverFor(provider).resolve, {
      now: NOW,
      limit: 3,
    });
    assert.equal(summary.attempted, 3);
    assert.deepEqual(
      retried.map((r) => r.id),
      ["b-2", "b-3", "b-4"],
    );
    const sweep = calls[0]!;
    assert.equal(filterValue(sweep, "status"), "CALENDAR_SYNC_FAILED");
    assert.equal(filterValue(sweep, "start_at"), NOW.toISOString(), "future bookings only");
  });
});
