import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { GoogleCalendarProvider } from "./google-calendar-provider.server.ts";
import { CalendarProviderError } from "./calendar-provider.ts";

function noopSleep() {
  return Promise.resolve();
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function fakeFetch(responses: { status: number; body: unknown }[]): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      ...(next.body === undefined ? {} : { headers: { "Content-Type": "application/json" } }),
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeProvider(responses: { status: number; body: unknown }[]) {
  const { fetchImpl, calls } = fakeFetch(responses);
  const provider = new GoogleCalendarProvider({
    accessToken: "test-access-token",
    fetchImpl,
    sleepImpl: noopSleep,
  });
  return { provider, calls };
}

describe("listCalendars", () => {
  test("normalizes Google's calendarList response", async () => {
    const { provider } = makeProvider([
      {
        status: 200,
        body: {
          items: [
            { id: "primary", summary: "business@example.com", primary: true },
            { id: "clinic-cal-id", summary: "Clinic Appointments" },
          ],
        },
      },
    ]);
    const calendars = await provider.listCalendars();
    assert.deepEqual(calendars, [
      { id: "primary", name: "business@example.com", primary: true },
      { id: "clinic-cal-id", name: "Clinic Appointments", primary: false },
    ]);
  });

  test("never throws for zero calendars — returns an empty list", async () => {
    const { provider } = makeProvider([{ status: 200, body: {} }]);
    assert.deepEqual(await provider.listCalendars(), []);
  });
});

describe("getBusyPeriods", () => {
  test("returns the normalized busy periods for the requested calendar", async () => {
    const { provider, calls } = makeProvider([
      {
        status: 200,
        body: {
          calendars: {
            "clinic-cal": {
              busy: [{ start: "2026-09-25T09:00:00Z", end: "2026-09-25T09:30:00Z" }],
            },
          },
        },
      },
    ]);
    const busy = await provider.getBusyPeriods({
      calendarId: "clinic-cal",
      timeMinIso: "2026-09-25T00:00:00Z",
      timeMaxIso: "2026-09-26T00:00:00Z",
    });
    assert.deepEqual(busy, [{ start: "2026-09-25T09:00:00Z", end: "2026-09-25T09:30:00Z" }]);
    assert.equal(calls[0]!.method, "POST");
    assert.match(calls[0]!.url, /\/freeBusy$/);
  });
});

describe("createEvent", () => {
  test("creates an event and returns the normalized result", async () => {
    const { provider, calls } = makeProvider([
      {
        status: 200,
        body: {
          id: "google-event-1",
          summary: "Appointment - Rahul",
          start: { dateTime: "2026-09-25T16:00:00+05:30" },
          end: { dateTime: "2026-09-25T16:30:00+05:30" },
          status: "confirmed",
        },
      },
    ]);
    const event = await provider.createEvent({
      calendarId: "clinic-cal",
      title: "Appointment - Rahul",
      startIso: "2026-09-25T16:00:00+05:30",
      endIso: "2026-09-25T16:30:00+05:30",
      timezone: "Asia/Kolkata",
    });
    assert.equal(event.id, "google-event-1");
    assert.equal(event.status, "confirmed");
    assert.equal(calls[0]!.method, "POST");
    assert.match(calls[0]!.url, /\/calendars\/clinic-cal\/events$/);
  });
});

describe("deleteEvent / getEvent", () => {
  test("getEvent returns null (not a throw) when Google reports 404", async () => {
    const { provider } = makeProvider([{ status: 404, body: { error: { message: "Not Found" } } }]);
    const event = await provider.getEvent("clinic-cal", "missing-event");
    assert.equal(event, null);
  });

  test("deleteEvent succeeds on a 204 No Content response", async () => {
    const { provider } = makeProvider([{ status: 204, body: undefined }]);
    await provider.deleteEvent("clinic-cal", "event-1");
  });
});

describe("error mapping — never a raw Google error", () => {
  test("401 maps to GOOGLE_AUTH_REQUIRED", async () => {
    const { provider } = makeProvider([
      { status: 401, body: { error: { message: "invalid_token" } } },
    ]);
    await assert.rejects(
      () => provider.listCalendars(),
      (err: unknown) => {
        assert.ok(err instanceof CalendarProviderError);
        assert.equal(err.code, "GOOGLE_AUTH_REQUIRED");
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  test("403 maps to CALENDAR_ACCESS_DENIED", async () => {
    const { provider } = makeProvider([{ status: 403, body: {} }]);
    await assert.rejects(
      () => provider.listCalendars(),
      (err: unknown) => {
        assert.ok(err instanceof CalendarProviderError);
        assert.equal(err.code, "CALENDAR_ACCESS_DENIED");
        return true;
      },
    );
  });

  test("409 maps to CALENDAR_CONFLICT", async () => {
    const { provider } = makeProvider([{ status: 409, body: {} }]);
    await assert.rejects(
      () =>
        provider.createEvent({
          calendarId: "c",
          title: "t",
          startIso: "2026-09-25T16:00:00Z",
          endIso: "2026-09-25T16:30:00Z",
          timezone: "Asia/Kolkata",
        }),
      (err: unknown) => {
        assert.ok(err instanceof CalendarProviderError);
        assert.equal(err.code, "CALENDAR_CONFLICT");
        return true;
      },
    );
  });

  test("a 401/403/404 is never retried (retrying an invalid credential cannot succeed)", async () => {
    const { provider, calls } = makeProvider([{ status: 401, body: {} }]);
    await assert.rejects(() => provider.listCalendars());
    assert.equal(calls.length, 1);
  });
});

describe("retry policy — only transient failures, within budget", () => {
  test("a 429 is retried and can succeed on a later attempt", async () => {
    const { provider, calls } = makeProvider([
      { status: 429, body: {} },
      { status: 200, body: { items: [] } },
    ]);
    const calendars = await provider.listCalendars();
    assert.deepEqual(calendars, []);
    assert.equal(calls.length, 2);
  });

  test("a 5xx is retried up to the retry budget, then throws CALENDAR_UNAVAILABLE", async () => {
    const { provider, calls } = makeProvider([
      { status: 503, body: {} },
      { status: 503, body: {} },
      { status: 503, body: {} },
    ]);
    await assert.rejects(
      () => provider.listCalendars(),
      (err: unknown) => {
        assert.ok(err instanceof CalendarProviderError);
        assert.equal(err.code, "CALENDAR_UNAVAILABLE");
        assert.equal(err.retryable, true);
        return true;
      },
    );
    // 1 initial attempt + MAX_RETRIES(2) retries = 3 total requests, never more.
    assert.equal(calls.length, 3);
  });
});
