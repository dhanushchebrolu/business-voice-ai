import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  check_calendar_availability,
  create_calendar_event,
  update_calendar_event,
  cancel_calendar_event,
  get_calendar_event,
} from "./calendar-tools.server.ts";

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

  test("check_calendar_availability reports GOOGLE_AUTH_REQUIRED when no calendar is connected yet", async () => {
    const { client } = makeFakeSupabase([
      { result: { data: AGENT_ROW_ALL_PERMITTED, error: null } },
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
      { result: { data: null, error: null } }, // no connection row
    ]);
    const result = await check_calendar_availability(client, {
      organizationId: "org-1",
      businessId: "biz-1",
      dateIso: "2026-09-25",
      durationMinutes: 30,
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, "GOOGLE_AUTH_REQUIRED");
  });

  test("check_calendar_availability reports GOOGLE_AUTH_REQUIRED when the connection exists but is not CONNECTED (e.g. NEEDS_REAUTH)", async () => {
    const { client } = makeFakeSupabase([
      { result: { data: AGENT_ROW_ALL_PERMITTED, error: null } },
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
      {
        result: {
          data: { id: "conn-1", calendar_id: "clinic-cal", status: "NEEDS_REAUTH" },
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
    if (!result.success) assert.equal(result.error.code, "GOOGLE_AUTH_REQUIRED");
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
