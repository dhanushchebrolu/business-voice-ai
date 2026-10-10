import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  check_calendar_availability,
  create_calendar_event,
  update_calendar_event,
  cancel_calendar_event,
  get_calendar_event,
  resolveCalendarContext,
  resolveOverrideForDate,
} from "./calendar-tools.server.ts";
import { encryptCredential } from "../google-calendar/google-calendar-crypto.server.ts";
import { _resetWarnedKeysForTests } from "./business-hours-validation.ts";

/**
 * These tests target the tenant/permission gating every tool must apply
 * before touching a calendar connection or a booking (spec section 39:
 * "AI tool permission checks", section 10: "never trust organization_id
 * supplied by the browser"). They deliberately stop short of exercising
 * the real Google refresh/provider path (already covered by
 * google-calendar-connection.server.test.ts and
 * booking-service.server.test.ts) — a fake here would just re-assert
 * those modules' own already-tested behavior.
 */

function makeFakeSupabase(script: { result: unknown }[]) {
  const calls: { table: string; filters: Record<string, unknown> }[] = [];
  let i = 0;

  function chain(table: string) {
    const filters: Record<string, unknown> = {};
    const self = {
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return self;
      },
      maybeSingle: () => {
        calls.push({ table, filters });
        const entry = script[i];
        i++;
        if (!entry) throw new Error(`test bug: no scripted response for call #${i} (${table})`);
        return Promise.resolve(entry.result);
      },
    };
    return self;
  }

  const client = {
    from(table: string) {
      return { select: () => chain(table) };
    },
  };
  return { client: client as never, calls };
}

const AGENT_ROW_ALL_PERMITTED = {
  organization_id: "org-1",
  capabilities: {
    calendar_read: true,
    calendar_book: true,
    calendar_reschedule: true,
    calendar_cancel: true,
  },
};

describe("permission gating — never calls the calendar service without the right capability", () => {
  test("check_calendar_availability is denied when the agent lacks calendar_read", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: { organization_id: "org-1", capabilities: { calendar_read: false } },
          error: null,
        },
      },
    ]);
    const result = await check_calendar_availability(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      dateIso: "2026-09-25",
      durationMinutes: 30,
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "TOOL_NOT_PERMITTED");
  });

  test("create_calendar_event is denied when the agent lacks calendar_book", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: { organization_id: "org-1", capabilities: { calendar_book: false } },
          error: null,
        },
      },
    ]);
    const result = await create_calendar_event(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      startIso: "2026-09-25T10:30:00.000Z",
      endIso: "2026-09-25T11:00:00.000Z",
      source: "voice",
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "TOOL_NOT_PERMITTED");
  });

  test("update_calendar_event is denied when the agent lacks calendar_reschedule", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: { organization_id: "org-1", capabilities: { calendar_reschedule: false } },
          error: null,
        },
      },
    ]);
    const result = await update_calendar_event(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      bookingId: "booking-1",
      newStartIso: "2026-09-26T10:30:00.000Z",
      newEndIso: "2026-09-26T11:00:00.000Z",
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "TOOL_NOT_PERMITTED");
  });

  test("cancel_calendar_event is denied when the agent lacks calendar_cancel", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: { organization_id: "org-1", capabilities: { calendar_cancel: false } },
          error: null,
        },
      },
    ]);
    const result = await cancel_calendar_event(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      bookingId: "booking-1",
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "TOOL_NOT_PERMITTED");
  });

  test("no agent configured for the business is treated as denied, not as an unhandled crash", async () => {
    const { client } = makeFakeSupabase([{ result: { data: null, error: null } }]);
    const result = await check_calendar_availability(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      dateIso: "2026-09-25",
      durationMinutes: 30,
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "AGENT_NOT_FOUND");
  });

  test("an agent belonging to a different organization is never trusted, even if businessId matches", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: { organization_id: "org-OTHER", capabilities: { calendar_read: true } },
          error: null,
        },
      },
    ]);
    const result = await check_calendar_availability(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      dateIso: "2026-09-25",
      durationMinutes: 30,
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "AGENT_NOT_FOUND");
  });
});

describe("tenant/connection gating — after permission passes", () => {
  test("check_calendar_availability rejects a business that does not belong to the caller's organization", async () => {
    const { client } = makeFakeSupabase([
      { result: { data: AGENT_ROW_ALL_PERMITTED, error: null } }, // permission check
      {
        result: {
          data: { id: "biz-1", organization_id: "org-OTHER", name: "X", timezone: "Asia/Kolkata" },
          error: null,
        },
      }, // business lookup
    ]);
    const result = await check_calendar_availability(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      dateIso: "2026-09-25",
      durationMinutes: 30,
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "BUSINESS_NOT_FOUND");
  });

  test("check_calendar_availability succeeds from ClickAI's own database alone when no calendar is connected yet (Google Calendar is optional, not required)", async () => {
    const client = makeThenableFakeSupabase({
      agent_configs: [{ result: { data: AGENT_ROW_ALL_PERMITTED, error: null } }],
      businesses: [
        {
          result: {
            data: {
              id: "biz-1",
              organization_id: "org-1",
              name: "ABC Clinic",
              timezone: "Asia/Kolkata",
            },
            error: null,
          },
        },
      ],
      google_calendar_connections: [{ result: { data: null, error: null } }], // no connection row
      business_hours: [
        {
          result: {
            data: [
              { day_of_week: 5, is_closed: false, intervals: [{ start: "09:00", end: "11:00" }] },
            ],
            error: null,
          },
        }, // 2026-11-20 is a Friday = day_of_week 5
      ],
      bookings: [{ result: { data: [], error: null } }],
      business_hour_overrides: [{ result: { data: null, error: null } }],
    });
    const result = await check_calendar_availability(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      dateIso: "2026-11-20",
      durationMinutes: 30,
    });
    assert.equal(result.success, true);
    if (result.success) {
      const starts = result.data.slots.map((s) => s.start);
      // 09:00/09:30/10:00/10:30 IST — no Google provider is ever consulted
      // (no connection row means there is nothing to consult), yet
      // availability is still computed, not blocked.
      assert.deepEqual(starts, [
        "2026-11-20T03:30:00.000Z",
        "2026-11-20T04:00:00.000Z",
        "2026-11-20T04:30:00.000Z",
        "2026-11-20T05:00:00.000Z",
      ]);
    }
  });

  test("check_calendar_availability succeeds from ClickAI's own database alone when the connection exists but is not CONNECTED (e.g. NEEDS_REAUTH)", async () => {
    const client = makeThenableFakeSupabase({
      agent_configs: [{ result: { data: AGENT_ROW_ALL_PERMITTED, error: null } }],
      businesses: [
        {
          result: {
            data: {
              id: "biz-1",
              organization_id: "org-1",
              name: "ABC Clinic",
              timezone: "Asia/Kolkata",
            },
            error: null,
          },
        },
      ],
      google_calendar_connections: [
        {
          result: {
            data: { id: "conn-1", calendar_id: "clinic-cal", status: "NEEDS_REAUTH" },
            error: null,
          },
        },
      ],
      business_hours: [
        {
          result: {
            data: [
              { day_of_week: 5, is_closed: false, intervals: [{ start: "09:00", end: "11:00" }] },
            ],
            error: null,
          },
        },
      ],
      bookings: [{ result: { data: [], error: null } }],
      business_hour_overrides: [{ result: { data: null, error: null } }],
    });
    const result = await check_calendar_availability(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      dateIso: "2026-11-20",
      durationMinutes: 30,
    });
    assert.equal(result.success, true);
    if (result.success) {
      const starts = result.data.slots.map((s) => s.start);
      // A NEEDS_REAUTH connection is not usable, so it is treated exactly
      // like no connection at all — the stale/broken Google link never
      // blocks ClickAI's own availability from being computed.
      assert.deepEqual(starts, [
        "2026-11-20T03:30:00.000Z",
        "2026-11-20T04:00:00.000Z",
        "2026-11-20T04:30:00.000Z",
        "2026-11-20T05:00:00.000Z",
      ]);
    }
  });
});

const CRYPTO_KEY = "GOOGLE_CALENDAR_CREDENTIAL_ENCRYPTION_KEY";
const CONFIG_VARS = [
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REDIRECT_URI",
] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  originalEnv[CRYPTO_KEY] = process.env[CRYPTO_KEY];
  process.env[CRYPTO_KEY] = randomBytes(32).toString("base64");
  for (const key of CONFIG_VARS) {
    originalEnv[key] = process.env[key];
    process.env[key] = `test-${key.toLowerCase()}`;
  }
});

afterEach(() => {
  for (const key of [CRYPTO_KEY, ...CONFIG_VARS]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

/**
 * A thenable-chain fake: every method returns the same object, which
 * resolves whichever script entry is next whenever something actually
 * awaits it — matching real supabase-js's "the builder itself is a
 * thenable" behavior regardless of which methods were chained before the
 * await, so it doesn't need a bespoke shape per call site the way the
 * narrower fake above does. Needed here because check_calendar_availability's
 * real call chain (resolveCalendarContext -> getCalendarProviderForConnection
 * -> the day's bookings/overrides reads) mixes .maybeSingle(), .not(),
 * .gte(), and .lt() in ways the simpler fake above was never built to
 * support.
 */
/**
 * Keyed per-table, NOT a single shared sequence — check_calendar_availability
 * issues the bookings read and resolveOverrideForDate's read concurrently
 * (inside one Promise.all), so a single global call-order counter is
 * fragile: which of two same-tick thenables actually resolves first depends
 * on engine microtask scheduling, not call-site order in the source. Per-
 * table queues make the fake immune to that ordering, matching how a real
 * Supabase client's concurrent requests are correctly disambiguated by
 * which table/query they are, not by which happened to settle first.
 */
function makeThenableFakeSupabase(scriptsByTable: Record<string, { result: unknown }[]>) {
  const indices: Record<string, number> = {};
  function consume(table: string) {
    const queue = scriptsByTable[table] ?? [];
    const idx = indices[table] ?? 0;
    indices[table] = idx + 1;
    const entry = queue[idx];
    if (!entry)
      throw new Error(`test bug: no scripted response for call #${idx + 1} on table ${table}`);
    return entry.result;
  }
  function chain(table: string): Record<string, (...a: unknown[]) => unknown> {
    const self: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["select", "eq", "not", "gte", "lt", "update", "maybeSingle"]) {
      self[m] = () => self;
    }
    (self as unknown as { then: unknown })["then"] = (
      resolve: (v: unknown) => void,
      reject?: (e: unknown) => void,
    ) => {
      try {
        resolve(consume(table));
      } catch (e) {
        if (reject) reject(e);
        else throw e;
      }
    };
    return self;
  }
  return { from: (table: string) => chain(table) } as never;
}

function fakeFetchSequence(responses: { status: number; body: unknown }[]): typeof fetch {
  let i = 0;
  return (async () => {
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("check_calendar_availability — daily overrides are actually fetched and applied, not just computeAvailability's own unit tests", () => {
  test("a slot the recurring weekly schedule would offer is excluded when a date-specific override closes it", async () => {
    const encrypted = encryptCredential(JSON.stringify({ refreshToken: "stored-refresh-token" }));
    const client = makeThenableFakeSupabase({
      agent_configs: [{ result: { data: AGENT_ROW_ALL_PERMITTED, error: null } }],
      businesses: [
        {
          result: {
            data: {
              id: "biz-1",
              organization_id: "org-1",
              name: "Clinic",
              timezone: "Asia/Kolkata",
            },
            error: null,
          },
        },
      ],
      // Three sequential (never concurrent with each other) reads/writes on
      // this table: the connection lookup in resolveCalendarContext, then
      // getValidAccessToken's own connection read, then its token-refresh
      // bookkeeping update.
      google_calendar_connections: [
        {
          result: {
            data: { id: "conn-1", calendar_id: "clinic-cal", status: "CONNECTED" },
            error: null,
          },
        },
        {
          result: {
            data: {
              id: "conn-1",
              status: "CONNECTED",
              calendar_id: "clinic-cal",
              encrypted_credentials: encrypted,
            },
            error: null,
          },
        },
        { result: { error: null } },
      ],
      business_hours: [
        {
          result: {
            data: [
              { day_of_week: 5, is_closed: false, intervals: [{ start: "09:00", end: "11:00" }] },
            ],
            error: null,
          },
        }, // 2026-11-20 is a Friday = day_of_week 5
      ],
      bookings: [{ result: { data: [], error: null } }],
      business_hour_overrides: [
        {
          result: {
            data: {
              is_full_day_closure: false,
              intervals: [{ start: "09:30", end: "10:00", isOpen: false }],
            },
            error: null,
          },
        }, // closes 09:30-10:00 IST for this one date
      ],
    });
    const fetchImpl = fakeFetchSequence([
      { status: 200, body: { access_token: "fresh-access", expires_in: 3600 } }, // OAuth refresh
      { status: 200, body: { calendars: { "clinic-cal": { busy: [] } } } }, // freeBusy — nothing externally busy
    ]);

    const originalFetch = globalThis.fetch;
    // calendar-tools.server.ts calls getCalendarProviderForConnection with no
    // explicit fetchImpl (production code has no reason to inject one) — so
    // patching the global fetch is the only way to intercept those HTTP
    // calls without changing that call site just for this test.
    globalThis.fetch = fetchImpl;
    try {
      const result = await check_calendar_availability(client, {
        organizationId: "org-1",
        businessId: "biz-1",
        dateIso: "2026-11-20",
        durationMinutes: 30,
      });
      assert.equal(result.success, true);
      if (result.success) {
        const starts = result.data.slots.map((s) => s.start);
        // 09:00 IST = 03:30Z, 09:30 IST = 04:00Z (closed by the override), 10:00 IST = 04:30Z, 10:30 IST = 05:00Z
        assert.deepEqual(starts, [
          "2026-11-20T03:30:00.000Z",
          "2026-11-20T04:30:00.000Z",
          "2026-11-20T05:00:00.000Z",
        ]);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("get_calendar_event", () => {
  test("is gated on calendar_read like availability checks are", async () => {
    const { client } = makeFakeSupabase([
      {
        result: {
          data: { organization_id: "org-1", capabilities: { calendar_read: false } },
          error: null,
        },
      },
    ]);
    const result = await get_calendar_event(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      bookingId: "booking-1",
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "TOOL_NOT_PERMITTED");
  });
});

/** Supports both .maybeSingle() and a direct await on the filter chain (business_hours's own fetch is awaited without .maybeSingle()). */
function makeFakeAdmin(responses: Record<string, unknown>) {
  function chain(table: string) {
    const builder = {
      eq: () => builder,
      maybeSingle: () => Promise.resolve(responses[table]),
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(responses[table]).then(onFulfilled, onRejected),
    };
    return builder;
  }
  return { from: (table: string) => ({ select: () => chain(table) }) } as never;
}

describe("legacy-invalid business_hours/business_hour_overrides rows — fail closed with a diagnostic, never silently available", () => {
  beforeEach(() => {
    _resetWarnedKeysForTests();
  });

  test("resolveCalendarContext still returns normally (fail-closed stays the caller's job, not this function's) for a business with a reversed weekly interval, but logs a diagnostic once", async () => {
    const calls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const admin = makeFakeAdmin({
        businesses: {
          data: {
            id: "biz-1",
            organization_id: "org-1",
            name: "Test Clinic",
            timezone: "Asia/Kolkata",
          },
          error: null,
        },
        google_calendar_connections: {
          data: { id: "conn-1", calendar_id: "cal-1", status: "CONNECTED" },
          error: null,
        },
        business_hours: {
          data: [
            { day_of_week: 1, is_closed: false, intervals: [{ start: "23:59", end: "00:00" }] },
          ],
          error: null,
        },
      });
      const result = await resolveCalendarContext(admin, "org-1", "biz-1");
      assert.ok(
        !("errorCode" in result),
        "a legacy-invalid row must not surface as a BUSINESS_NOT_FOUND-style error",
      );
      if (!("errorCode" in result)) {
        assert.deepEqual(result.businessHours[0]!.intervals, [{ start: "23:59", end: "00:00" }]);
      }
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(calls.length, 1, "expected exactly one diagnostic log for the one invalid day");
    const [, details] = calls[0]!;
    assert.deepEqual(details, {
      businessId: "biz-1",
      dayOfWeek: 1,
      intervals: [{ start: "23:59", end: "00:00" }],
    });
  });

  test("resolveCalendarContext logs the diagnostic only once across repeated calls for the same business+day", async () => {
    const calls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const admin = makeFakeAdmin({
        businesses: {
          data: {
            id: "biz-1",
            organization_id: "org-1",
            name: "Test Clinic",
            timezone: "Asia/Kolkata",
          },
          error: null,
        },
        google_calendar_connections: {
          data: { id: "conn-1", calendar_id: "cal-1", status: "CONNECTED" },
          error: null,
        },
        business_hours: {
          data: [
            { day_of_week: 1, is_closed: false, intervals: [{ start: "23:59", end: "00:00" }] },
          ],
          error: null,
        },
      });
      await resolveCalendarContext(admin, "org-1", "biz-1");
      await resolveCalendarContext(admin, "org-1", "biz-1");
      await resolveCalendarContext(admin, "org-1", "biz-1");
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(calls.length, 1, "repeated lookups for the same business+day must not re-log");
  });

  test("a valid business_hours row never logs a diagnostic", async () => {
    const calls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const admin = makeFakeAdmin({
        businesses: {
          data: {
            id: "biz-1",
            organization_id: "org-1",
            name: "Test Clinic",
            timezone: "Asia/Kolkata",
          },
          error: null,
        },
        google_calendar_connections: {
          data: { id: "conn-1", calendar_id: "cal-1", status: "CONNECTED" },
          error: null,
        },
        business_hours: {
          data: [
            { day_of_week: 1, is_closed: false, intervals: [{ start: "09:00", end: "19:00" }] },
          ],
          error: null,
        },
      });
      await resolveCalendarContext(admin, "org-1", "biz-1");
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(calls.length, 0);
  });

  test("resolveOverrideForDate logs a date-specific diagnostic for a reversed override interval, without changing its returned value", async () => {
    const calls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const admin = makeFakeAdmin({
        business_hour_overrides: {
          data: {
            is_full_day_closure: false,
            intervals: [{ start: "23:59", end: "00:00", isOpen: true }],
          },
          error: null,
        },
      });
      const override = await resolveOverrideForDate(admin, "biz-1", "2026-10-09");
      assert.deepEqual(override, {
        isFullDayClosure: false,
        intervals: [{ start: "23:59", end: "00:00", isOpen: true }],
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(calls.length, 1);
    const [, details] = calls[0]!;
    assert.deepEqual(details, {
      businessId: "biz-1",
      dateIso: "2026-10-09",
      intervals: [{ start: "23:59", end: "00:00", isOpen: true }],
    });
  });

  test("a full-day-closure override never logs, regardless of its stored intervals", async () => {
    const calls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => calls.push(args);
    try {
      const admin = makeFakeAdmin({
        business_hour_overrides: {
          data: { is_full_day_closure: true, intervals: [{ start: "23:59", end: "00:00" }] },
          error: null,
        },
      });
      await resolveOverrideForDate(admin, "biz-1", "2026-10-09");
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(calls.length, 0);
  });
});
