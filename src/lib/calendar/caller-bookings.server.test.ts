import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  callerOwnsBooking,
  guardBookingOwnership,
  findCallerUpcomingBookings,
  findReturningCallerFirstName,
  phoneMatchesCaller,
  storedPhoneVariants,
} from "./caller-bookings.server.ts";

/**
 * Caller identity for rescheduling and returning-customer greetings —
 * against an in-memory stand-in for the tables that applies the same
 * eq/in/gt/like filters PostgREST would. No network or database.
 */

type Row = Record<string, unknown>;

function makeDb(tables: Record<string, Row[]>) {
  const queries: { table: string; filters: string[] }[] = [];
  function builder(table: string) {
    let rows = [...(tables[table] ?? [])];
    const filters: string[] = [];
    let limit = Infinity;
    const chain = {
      select: () => chain,
      eq(col: string, val: unknown) {
        filters.push(`eq:${col}`);
        rows = rows.filter((r) => r[col] === val);
        return chain;
      },
      in(col: string, vals: unknown[]) {
        filters.push(`in:${col}`);
        rows = rows.filter((r) => vals.includes(r[col]));
        return chain;
      },
      gt(col: string, val: string) {
        filters.push(`gt:${col}`);
        rows = rows.filter((r) => new Date(String(r[col])).getTime() > new Date(val).getTime());
        return chain;
      },
      like(col: string, pattern: string) {
        filters.push(`like:${col}`);
        const prefix = pattern.replace(/%$/, "");
        rows = rows.filter(
          (r) => typeof r[col] === "string" && (r[col] as string).startsWith(prefix),
        );
        return chain;
      },
      order: () => chain,
      limit(n: number) {
        limit = n;
        return chain;
      },
      maybeSingle: () => {
        queries.push({ table, filters });
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        queries.push({ table, filters });
        return Promise.resolve({ data: rows.slice(0, limit), error: null }).then(resolve, reject);
      },
    };
    return chain;
  }
  return { client: { from: (t: string) => builder(t) } as never, queries };
}

const ORG = "org-1";
const BIZ = "biz-1";
const OTHER_ORG = "org-2";
const OTHER_BIZ = "biz-2";
const CALLER = "+919876543210";
const NOW = new Date("2030-10-14T00:00:00.000Z");

function booking(overrides: Row): Row {
  return {
    id: "b-1",
    organization_id: ORG,
    business_id: BIZ,
    start_at: "2030-10-14T06:30:00+00:00",
    end_at: "2030-10-14T07:00:00+00:00",
    timezone: "Asia/Kolkata",
    status: "CONFIRMED",
    service_id: "svc-rc",
    customer_name: "Dhanush Kumar",
    customer_phone: CALLER,
    contact_id: null,
    idempotency_key: null,
    created_at: "2030-10-01T00:00:00Z",
    ...overrides,
  };
}

const SERVICES = [
  { id: "svc-rc", name: "Root Canal Treatment", business_id: BIZ },
  { id: "svc-tc", name: "Teeth Cleaning", business_id: BIZ },
];

describe("caller phone matching (Indian formats)", () => {
  test("every stored form of the same Indian number matches the caller's E.164 ID", () => {
    for (const stored of [
      "+919876543210",
      "919876543210",
      "9876543210",
      "09876543210",
      "+91 98765 43210",
      "98765-43210",
    ]) {
      assert.equal(phoneMatchesCaller(stored, CALLER, "IN"), true, stored);
    }
  });

  test("a different number, a truncated number, or nothing never matches", () => {
    for (const stored of ["+919876543211", "987654321", "", null, "+14155550123"]) {
      assert.equal(phoneMatchesCaller(stored, CALLER, "IN"), false, String(stored));
    }
  });

  test("the query variants cover the stored forms and only that number", () => {
    assert.deepEqual(storedPhoneVariants(CALLER).sort(), [
      "+919876543210",
      "09876543210",
      "919876543210",
      "9876543210",
    ]);
  });
});

describe("findCallerUpcomingBookings", () => {
  test("returns the caller's own upcoming booking with its stored service and name", async () => {
    const { client } = makeDb({ bookings: [booking({})], services: SERVICES, contacts: [] });
    const found = await findCallerUpcomingBookings(client, {
      organizationId: ORG,
      businessId: BIZ,
      callerE164: CALLER,
      country: "IN",
      now: NOW,
    });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, "b-1");
    assert.equal(found[0]!.serviceName, "Root Canal Treatment");
    assert.equal(found[0]!.customerName, "Dhanush Kumar");
  });

  test("a booking stored with a national-format number is still the caller's", async () => {
    const { client } = makeDb({
      bookings: [booking({ customer_phone: "09876543210" })],
      services: SERVICES,
      contacts: [],
    });
    const found = await findCallerUpcomingBookings(client, {
      organizationId: ORG,
      businessId: BIZ,
      callerE164: CALLER,
      country: "IN",
      now: NOW,
    });
    assert.deepEqual(
      found.map((b) => b.id),
      ["b-1"],
    );
  });

  test("a different caller sees nothing — not another customer's booking", async () => {
    const { client } = makeDb({ bookings: [booking({})], services: SERVICES, contacts: [] });
    const found = await findCallerUpcomingBookings(client, {
      organizationId: ORG,
      businessId: BIZ,
      callerE164: "+919845012345",
      country: "IN",
      now: NOW,
    });
    assert.deepEqual(found, []);
  });

  test("no caller ID: nothing is looked up at all", async () => {
    const { client, queries } = makeDb({ bookings: [booking({})], services: SERVICES });
    const found = await findCallerUpcomingBookings(client, {
      organizationId: ORG,
      businessId: BIZ,
      callerE164: null,
      now: NOW,
    });
    assert.deepEqual(found, []);
    assert.equal(queries.length, 0);
  });

  test("tenant isolation: the same number's bookings at another organization or business are never returned", async () => {
    const { client, queries } = makeDb({
      bookings: [
        booking({ id: "other-org", organization_id: OTHER_ORG }),
        booking({ id: "other-biz", business_id: OTHER_BIZ }),
        booking({ id: "mine" }),
      ],
      services: SERVICES,
      contacts: [],
    });
    const found = await findCallerUpcomingBookings(client, {
      organizationId: ORG,
      businessId: BIZ,
      callerE164: CALLER,
      country: "IN",
      now: NOW,
    });
    assert.deepEqual(
      found.map((b) => b.id),
      ["mine"],
    );
    for (const q of queries.filter((q) => q.table === "bookings")) {
      assert.ok(q.filters.includes("eq:organization_id"), "every bookings query is org-scoped");
      assert.ok(q.filters.includes("eq:business_id"), "every bookings query is business-scoped");
    }
  });

  test("past, cancelled and payment-pending bookings are not offered for rescheduling", async () => {
    const { client } = makeDb({
      bookings: [
        booking({ id: "past", start_at: "2030-10-13T06:30:00+00:00" }),
        booking({ id: "cancelled", status: "CANCELLED" }),
        booking({ id: "pending-payment", status: "PENDING_PAYMENT" }),
        booking({ id: "rescheduled", status: "RESCHEDULED" }),
      ],
      services: SERVICES,
      contacts: [],
    });
    const found = await findCallerUpcomingBookings(client, {
      organizationId: ORG,
      businessId: BIZ,
      callerE164: CALLER,
      country: "IN",
      now: NOW,
    });
    assert.deepEqual(
      found.map((b) => b.id),
      ["rescheduled"],
    );
  });

  test("bookings linked through the caller's contact, and bookings made on this call, count; several are returned soonest first", async () => {
    const { client } = makeDb({
      bookings: [
        booking({
          id: "via-contact",
          customer_phone: null,
          contact_id: "contact-1",
          start_at: "2030-10-16T06:30:00+00:00",
          end_at: "2030-10-16T07:00:00+00:00",
          service_id: "svc-tc",
        }),
        booking({
          id: "this-call",
          customer_phone: "+919845012345",
          idempotency_key: "voice:call-9:2030-10-15T06:30:00.000Z:2030-10-15T07:00:00.000Z",
          start_at: "2030-10-15T06:30:00+00:00",
          end_at: "2030-10-15T07:00:00+00:00",
        }),
        booking({
          id: "other-call",
          customer_phone: "+919845012345",
          idempotency_key: "voice:call-8:x:y",
        }),
      ],
      services: SERVICES,
      contacts: [{ id: "contact-1", organization_id: ORG, phone: CALLER, name: "Dhanush" }],
    });
    const found = await findCallerUpcomingBookings(client, {
      organizationId: ORG,
      businessId: BIZ,
      callerE164: CALLER,
      callId: "call-9",
      country: "IN",
      now: NOW,
    });
    assert.deepEqual(
      found.map((b) => b.id),
      ["this-call", "via-contact"],
    );
  });
});

describe("callerOwnsBooking (server-side check behind reschedule_appointment)", () => {
  const db = () =>
    makeDb({
      bookings: [
        booking({}),
        booking({ id: "contact-linked", customer_phone: null, contact_id: "contact-1" }),
        booking({ id: "other-biz", business_id: OTHER_BIZ }),
        booking({
          id: "this-call",
          customer_phone: "+919845012345",
          idempotency_key: "voice:call-9:a:b",
        }),
      ],
      contacts: [{ id: "contact-1", organization_id: ORG, phone: CALLER }],
    });
  const check = (bookingId: string, callerE164: string | null, callId: string | null = null) =>
    callerOwnsBooking(db().client, {
      organizationId: ORG,
      businessId: BIZ,
      bookingId,
      callerE164,
      callId,
      country: "IN",
    });

  test("the matching caller owns the booking", async () => {
    assert.equal(await check("b-1", CALLER), true);
    assert.equal(await check("contact-linked", CALLER), true);
  });

  test("a different number does not, and neither does a withheld caller ID", async () => {
    assert.equal(await check("b-1", "+919845012345"), false);
    assert.equal(await check("b-1", null), false);
    assert.equal(await check("contact-linked", "+919845012345"), false);
  });

  test("another business's booking is never owned, even with the right number", async () => {
    assert.equal(await check("other-biz", CALLER), false);
  });

  test("an unknown booking id is simply not owned", async () => {
    assert.equal(await check("does-not-exist", CALLER), false);
  });

  test("a booking made on this same call is the caller's, whatever number it carries", async () => {
    assert.equal(await check("this-call", null, "call-9"), true);
    assert.equal(await check("this-call", null, "call-8"), false);
  });
});

describe("findReturningCallerFirstName", () => {
  const find = (tables: Record<string, Row[]>, callerE164: string | null = CALLER) =>
    findReturningCallerFirstName(makeDb(tables).client, {
      organizationId: ORG,
      businessId: BIZ,
      callerE164,
      country: "IN",
    });

  test("a known contact is greeted by first name", async () => {
    assert.equal(
      await find({
        contacts: [{ organization_id: ORG, phone: CALLER, name: "dhanush kumar" }],
        bookings: [],
      }),
      "Dhanush",
    );
  });

  test("the name on the caller's past bookings is used when there is no contact name", async () => {
    assert.equal(
      await find({ contacts: [], bookings: [booking({ customer_name: "Priya" })] }),
      "Priya",
    );
  });

  test("an unknown number gets no name", async () => {
    assert.equal(
      await find({ contacts: [], bookings: [booking({ customer_phone: "+919845012345" })] }),
      null,
    );
  });

  test("a shared number with two different names gets no name (never the wrong person)", async () => {
    assert.equal(
      await find({
        contacts: [{ organization_id: ORG, phone: CALLER, name: "Dhanush" }],
        bookings: [booking({ customer_name: "Priya" })],
      }),
      null,
    );
  });

  test("tenant isolation: another organization's contact and another business's booking are ignored", async () => {
    assert.equal(
      await find({
        contacts: [{ organization_id: OTHER_ORG, phone: CALLER, name: "Mallory" }],
        bookings: [booking({ business_id: OTHER_BIZ, customer_name: "Mallory" })],
      }),
      null,
    );
  });

  test("no caller ID, or a value that isn't a speakable name, gets no name", async () => {
    assert.equal(await find({ contacts: [], bookings: [] }, null), null);
    assert.equal(
      await find({
        contacts: [{ organization_id: ORG, phone: CALLER, name: "+919876543210" }],
        bookings: [],
      }),
      null,
    );
  });
});

describe("guardBookingOwnership (runs before reschedule_appointment is dispatched)", () => {
  const ARGS = {
    bookingId: "b-1",
    newStartIso: "2030-10-14T07:30:00.000Z",
    newEndIso: "2030-10-14T08:00:00.000Z",
  };
  const tables = () => ({
    bookings: [
      booking({ customer_phone: "09876543210" }),
      booking({ id: "other-biz", business_id: OTHER_BIZ }),
    ],
    contacts: [],
  });
  const guard = (
    ctx: Partial<Parameters<typeof guardBookingOwnership>[1]>,
    input: Record<string, unknown> = ARGS,
    name = "reschedule_appointment",
  ) =>
    guardBookingOwnership(
      makeDb(tables()).client,
      { organizationId: ORG, businessId: BIZ, phoneCountry: "IN", ...ctx },
      name,
      input,
    );

  test("the matching caller (number stored in national format) may proceed", async () => {
    assert.equal(await guard({ callerE164: CALLER }), null);
  });

  test("a different number is refused with NOT_FOUND that reveals nothing about the booking", async () => {
    const refused = await guard({ callerE164: "+919845012345" });
    assert.ok(refused);
    assert.equal(refused.isError, true);
    const parsed = JSON.parse(refused.content) as { error: { code: string; message: string } };
    assert.equal(parsed.error.code, "NOT_FOUND");
    assert.doesNotMatch(parsed.error.message, /b-1|\d{4}|Dhanush|Root/);
  });

  test("no trusted identity (withheld caller ID, or a channel without one) is refused", async () => {
    assert.ok(await guard({}));
    assert.ok(await guard({ callerE164: null }));
  });

  test("another business's booking id is refused even for the right number", async () => {
    assert.ok(await guard({ callerE164: CALLER }, { ...ARGS, bookingId: "other-biz" }));
  });

  test("tools that don't change an existing booking, and malformed input, are left alone", async () => {
    assert.equal(await guard({}, { dateIso: "2030-10-14" }, "check_calendar_availability"), null);
    assert.equal(
      await guard({}, { newStartIso: "x" }),
      null,
      "left to the tool's INVALID_TOOL_INPUT",
    );
  });
});
