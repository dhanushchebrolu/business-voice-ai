import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createBooking,
  rescheduleBooking,
  cancelBooking,
  getBooking,
  BookingError,
  type CreateBookingInput,
} from "./booking-service.server.ts";
import { CalendarProviderError, type CalendarProvider } from "./calendar-provider.ts";

/**
 * Generic scripted fake Supabase client: every terminal call (maybeSingle/
 * single/the bare promise from a filter chain like .limit()) consumes the
 * next entry from `script`, in call order. Good enough for these
 * sequential, single-threaded service functions.
 */
function makeFakeSupabase(script: { result: unknown }[]) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  let i = 0;

  function consume(table: string, method: string, ...args: unknown[]) {
    calls.push({ table, method, args });
    const entry = script[i];
    i++;
    if (!entry)
      throw new Error(`test bug: no scripted response for call #${i} (${table}.${method})`);
    return entry.result;
  }

  function chain(table: string) {
    const self = {
      select: (...a: unknown[]) => {
        calls.push({ table, method: "select", args: a });
        return self;
      },
      eq: (...a: unknown[]) => {
        calls.push({ table, method: "eq", args: a });
        return self;
      },
      neq: (...a: unknown[]) => {
        calls.push({ table, method: "neq", args: a });
        return self;
      },
      not: (...a: unknown[]) => {
        calls.push({ table, method: "not", args: a });
        return self;
      },
      lt: (...a: unknown[]) => {
        calls.push({ table, method: "lt", args: a });
        return self;
      },
      gt: (...a: unknown[]) => {
        calls.push({ table, method: "gt", args: a });
        return self;
      },
      limit: (...a: unknown[]) => Promise.resolve(consume(table, "limit", ...a)),
      maybeSingle: () => Promise.resolve(consume(table, "maybeSingle")),
      single: () => Promise.resolve(consume(table, "single")),
    };
    return self;
  }

  const client = {
    from(table: string) {
      return {
        select: (...a: unknown[]) => {
          calls.push({ table, method: "select", args: a });
          return chain(table);
        },
        insert: (payload: unknown) => {
          calls.push({ table, method: "insert", args: [payload] });
          return chain(table);
        },
        upsert: (payload: unknown, opts: unknown) => {
          calls.push({ table, method: "upsert", args: [payload, opts] });
          return chain(table);
        },
        update: (payload: unknown) => {
          calls.push({ table, method: "update", args: [payload] });
          return chain(table);
        },
      };
    },
  };
  return { client: client as never, calls };
}

function fakeProvider(overrides: Partial<CalendarProvider> = {}): CalendarProvider {
  return {
    listCalendars: async () => [],
    getBusyPeriods: async () => [],
    createEvent: async (input) => ({
      id: "google-event-1",
      title: input.title,
      description: input.description,
      start: input.startIso,
      end: input.endIso,
      status: "confirmed",
    }),
    updateEvent: async (_c, _e, input) => ({
      id: "google-event-1",
      title: input.title ?? "",
      description: input.description,
      start: input.startIso ?? "",
      end: input.endIso ?? "",
      status: "confirmed",
    }),
    deleteEvent: async () => {},
    getEvent: async () => null,
    ...overrides,
  };
}

const BASE_INPUT: CreateBookingInput = {
  organizationId: "org-1",
  businessId: "biz-1",
  calendarConnectionId: "conn-1",
  calendarId: "clinic-cal",
  customerName: "Rahul",
  customerPhone: "+911234567890",
  startIso: "2026-09-25T10:30:00.000Z",
  endIso: "2026-09-25T11:00:00.000Z",
  timezone: "Asia/Kolkata",
  source: "voice",
  businessName: "ABC Dental Clinic",
};

describe("createBooking", () => {
  test("happy path: no idempotency key, no conflict -> insert, create event, confirm", async () => {
    const { client, calls } = makeFakeSupabase([
      { result: { data: null, error: null } }, // conflict check
      { result: { data: { id: "contact-1" }, error: null } }, // contact upsert
      {
        result: {
          data: {
            id: "booking-1",
            status: "PENDING_CONFIRMATION",
            start_at: BASE_INPUT.startIso,
            end_at: BASE_INPUT.endIso,
            timezone: "Asia/Kolkata",
            google_event_id: null,
            contact_id: "contact-1",
          },
          error: null,
        },
      }, // insert
      {
        result: {
          data: {
            id: "booking-1",
            status: "CONFIRMED",
            start_at: BASE_INPUT.startIso,
            end_at: BASE_INPUT.endIso,
            timezone: "Asia/Kolkata",
            google_event_id: "google-event-1",
            contact_id: "contact-1",
          },
          error: null,
        },
      }, // confirm update
    ]);
    const provider = fakeProvider();

    const result = await createBooking(client, provider, BASE_INPUT);
    assert.equal(result.status, "CONFIRMED");
    assert.equal(result.googleEventId, "google-event-1");

    const insertCall = calls.find((c) => c.method === "insert" && c.table === "bookings");
    const payload = insertCall!.args[0] as Record<string, unknown>;
    assert.equal(payload["status"], "PENDING_CONFIRMATION");
  });

  test("idempotent retry: an existing booking with the same key is returned, no new insert/event", async () => {
    const { client, calls } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "booking-existing",
            status: "CONFIRMED",
            start_at: BASE_INPUT.startIso,
            end_at: BASE_INPUT.endIso,
            timezone: "Asia/Kolkata",
            google_event_id: "google-event-1",
            contact_id: "contact-1",
          },
          error: null,
        },
      },
    ]);
    let eventCreated = false;
    const provider = fakeProvider({
      createEvent: async () => {
        eventCreated = true;
        throw new Error("must not be called");
      },
    });

    const result = await createBooking(client, provider, {
      ...BASE_INPUT,
      idempotencyKey: "retry-key-1",
    });
    assert.equal(result.id, "booking-existing");
    assert.equal(eventCreated, false);
    assert.equal(calls.filter((c) => c.table === "bookings" && c.method === "insert").length, 0);
  });

  test("rejects a slot that a conflict check finds already booked, before any insert", async () => {
    const { client, calls } = makeFakeSupabase([
      { result: { data: [{ id: "other-booking" }], error: null } },
    ]);
    const provider = fakeProvider();
    await assert.rejects(
      () => createBooking(client, provider, BASE_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof BookingError);
        assert.equal(err.code, "SLOT_NO_LONGER_AVAILABLE");
        return true;
      },
    );
    assert.equal(calls.filter((c) => c.table === "bookings" && c.method === "insert").length, 0);
  });

  test("rejects end time before or equal to start time without touching the database", async () => {
    const { client, calls } = makeFakeSupabase([]);
    const provider = fakeProvider();
    await assert.rejects(
      () => createBooking(client, provider, { ...BASE_INPUT, endIso: BASE_INPUT.startIso }),
      BookingError,
    );
    assert.equal(calls.length, 0);
  });

  test("a duplicate-key DB error (exact-start-time race) is reported as SLOT_NO_LONGER_AVAILABLE, not a raw DB error", async () => {
    const { client } = makeFakeSupabase([
      { result: { data: null, error: null } }, // conflict check passes
      { result: { data: { id: "contact-1" }, error: null } }, // contact upsert
      { result: { data: null, error: { code: "23505", message: "duplicate key" } } }, // insert races and loses
    ]);
    const provider = fakeProvider();
    await assert.rejects(
      () => createBooking(client, provider, BASE_INPUT),
      (err: unknown) => {
        assert.ok(err instanceof BookingError);
        assert.equal(err.code, "SLOT_NO_LONGER_AVAILABLE");
        return true;
      },
    );
  });

  test("reconciliation: booking is inserted but the Google event fails -> marked CALENDAR_SYNC_FAILED, never silently lost", async () => {
    const { client, calls } = makeFakeSupabase([
      { result: { data: null, error: null } }, // conflict check
      { result: { data: { id: "contact-1" }, error: null } }, // contact upsert
      {
        result: {
          data: {
            id: "booking-1",
            status: "PENDING_CONFIRMATION",
            start_at: BASE_INPUT.startIso,
            end_at: BASE_INPUT.endIso,
            timezone: "Asia/Kolkata",
            google_event_id: null,
            contact_id: "contact-1",
          },
          error: null,
        },
      }, // insert
      { result: { error: null } }, // reconciliation update (no .single() chained on this path in the real code — see below)
    ]);
    const provider = fakeProvider({
      createEvent: async () => {
        throw new CalendarProviderError(
          "CALENDAR_UNAVAILABLE",
          "Google Calendar is temporarily unavailable.",
          true,
        );
      },
    });

    await assert.rejects(() => createBooking(client, provider, BASE_INPUT), CalendarProviderError);

    const reconcileUpdate = calls.find(
      (c) =>
        c.table === "bookings" &&
        c.method === "update" &&
        (c.args[0] as Record<string, unknown>)["status"] === "CALENDAR_SYNC_FAILED",
    );
    assert.ok(reconcileUpdate, "expected a CALENDAR_SYNC_FAILED reconciliation update");
  });
});

describe("rescheduleBooking", () => {
  test("happy path: re-checks availability, updates the Google event, marks RESCHEDULED", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "booking-1",
            organization_id: "org-1",
            calendar_connection_id: "conn-1",
            google_event_id: "google-event-1",
            timezone: "Asia/Kolkata",
            status: "CONFIRMED",
          },
          error: null,
        },
      }, // load booking
      { result: { data: null, error: null } }, // conflict check
      {
        result: {
          data: {
            id: "booking-1",
            status: "RESCHEDULED",
            start_at: "2026-09-26T10:30:00.000Z",
            end_at: "2026-09-26T11:00:00.000Z",
            timezone: "Asia/Kolkata",
            google_event_id: "google-event-1",
            contact_id: null,
          },
          error: null,
        },
      }, // update
    ]);
    let updatedEvent = false;
    const provider = fakeProvider({
      updateEvent: async () => {
        updatedEvent = true;
        return {
          id: "google-event-1",
          title: "",
          description: undefined,
          start: "",
          end: "",
          status: "confirmed",
        };
      },
    });

    const result = await rescheduleBooking(client, provider, {
      organizationId: "org-1",
      bookingId: "booking-1",
      calendarId: "clinic-cal",
      newStartIso: "2026-09-26T10:30:00.000Z",
      newEndIso: "2026-09-26T11:00:00.000Z",
    });
    assert.equal(result.status, "RESCHEDULED");
    assert.equal(updatedEvent, true);
  });

  test("refuses to reschedule a booking belonging to a different organization", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "booking-1",
            organization_id: "org-OTHER",
            calendar_connection_id: "conn-1",
            google_event_id: null,
            timezone: "Asia/Kolkata",
            status: "CONFIRMED",
          },
          error: null,
        },
      },
    ]);
    const provider = fakeProvider();
    await assert.rejects(
      () =>
        rescheduleBooking(client, provider, {
          organizationId: "org-1",
          bookingId: "booking-1",
          calendarId: "c",
          newStartIso: "2026-09-26T10:30:00.000Z",
          newEndIso: "2026-09-26T11:00:00.000Z",
        }),
      (err: unknown) => {
        assert.ok(err instanceof BookingError);
        assert.equal(err.code, "NOT_FOUND");
        return true;
      },
    );
  });

  test("rejects a reschedule target that conflicts with another active booking", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "booking-1",
            organization_id: "org-1",
            calendar_connection_id: "conn-1",
            google_event_id: "google-event-1",
            timezone: "Asia/Kolkata",
            status: "CONFIRMED",
          },
          error: null,
        },
      },
      { result: { data: [{ id: "other-booking" }], error: null } },
    ]);
    const provider = fakeProvider();
    await assert.rejects(
      () =>
        rescheduleBooking(client, provider, {
          organizationId: "org-1",
          bookingId: "booking-1",
          calendarId: "c",
          newStartIso: "2026-09-26T10:30:00.000Z",
          newEndIso: "2026-09-26T11:00:00.000Z",
        }),
      (err: unknown) => {
        assert.ok(err instanceof BookingError);
        assert.equal(err.code, "SLOT_NO_LONGER_AVAILABLE");
        return true;
      },
    );
  });
});

describe("cancelBooking", () => {
  test("happy path: deletes the Google event and marks CANCELLED", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "booking-1",
            organization_id: "org-1",
            google_event_id: "google-event-1",
            notes: null,
          },
          error: null,
        },
      },
      {
        result: {
          data: {
            id: "booking-1",
            status: "CANCELLED",
            start_at: "s",
            end_at: "e",
            timezone: "Asia/Kolkata",
            google_event_id: "google-event-1",
            contact_id: null,
          },
          error: null,
        },
      },
    ]);
    let deleted = false;
    const provider = fakeProvider({
      deleteEvent: async () => {
        deleted = true;
      },
    });

    const result = await cancelBooking(client, provider, {
      organizationId: "org-1",
      bookingId: "booking-1",
      calendarId: "c",
    });
    assert.equal(result.status, "CANCELLED");
    assert.equal(deleted, true);
  });

  test("cancelling a booking whose Google event is already gone still succeeds (idempotent)", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "booking-1",
            organization_id: "org-1",
            google_event_id: "google-event-1",
            notes: null,
          },
          error: null,
        },
      },
      {
        result: {
          data: {
            id: "booking-1",
            status: "CANCELLED",
            start_at: "s",
            end_at: "e",
            timezone: "Asia/Kolkata",
            google_event_id: "google-event-1",
            contact_id: null,
          },
          error: null,
        },
      },
    ]);
    const provider = fakeProvider({
      deleteEvent: async () => {
        throw new CalendarProviderError(
          "CALENDAR_NOT_FOUND",
          "That calendar or event could not be found.",
        );
      },
    });
    const result = await cancelBooking(client, provider, {
      organizationId: "org-1",
      bookingId: "booking-1",
      calendarId: "c",
    });
    assert.equal(result.status, "CANCELLED");
  });

  test("refuses to cancel a booking belonging to a different organization", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "booking-1",
            organization_id: "org-OTHER",
            google_event_id: null,
            notes: null,
          },
          error: null,
        },
      },
    ]);
    const provider = fakeProvider();
    await assert.rejects(
      () =>
        cancelBooking(client, provider, {
          organizationId: "org-1",
          bookingId: "booking-1",
          calendarId: "c",
        }),
      (err: unknown) => {
        assert.ok(err instanceof BookingError);
        assert.equal(err.code, "NOT_FOUND");
        return true;
      },
    );
  });
});

describe("getBooking", () => {
  test("returns null (not another tenant's booking) when the organization does not match", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "booking-1",
            organization_id: "org-OTHER",
            status: "CONFIRMED",
            start_at: "s",
            end_at: "e",
            timezone: "Asia/Kolkata",
            google_event_id: null,
            contact_id: null,
          },
          error: null,
        },
      },
    ]);
    const result = await getBooking(client, { organizationId: "org-1", bookingId: "booking-1" });
    assert.equal(result, null);
  });

  test("returns the booking when it belongs to the caller's organization", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: {
            id: "booking-1",
            organization_id: "org-1",
            status: "CONFIRMED",
            start_at: "s",
            end_at: "e",
            timezone: "Asia/Kolkata",
            google_event_id: "g1",
            contact_id: "c1",
          },
          error: null,
        },
      },
    ]);
    const result = await getBooking(client, { organizationId: "org-1", bookingId: "booking-1" });
    assert.equal(result?.id, "booking-1");
  });
});
