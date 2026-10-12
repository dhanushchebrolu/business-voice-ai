import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { executeAiTool, type ToolExecutionContext } from "../ai-tools.server.ts";

/**
 * The voice booking tool path end to end — executeAiTool("book_appointment")
 * -> create_calendar_event -> createBooking -> create_booking_atomic, then
 * executeAiTool("check_calendar_availability") -> computeAvailability — all
 * REAL code, over a small in-memory stand-in for Supabase that enforces the
 * schema rules this incident hinged on:
 *   - contacts.phone CHECK (phone ~ '^\+[1-9]\d{6,14}$') — PostgREST 23514
 *   - contacts UNIQUE (organization_id, phone) for the upsert
 *   - bookings UNIQUE (organization_id, idempotency_key) and the RPC's own
 *     idempotent return + business-scoped overlap check
 * The same rules are checked against real PostgreSQL by
 * supabase/migrations/voice_booking_persistence.pg.test.ts.
 *
 * Scenario: Smile Dental (Asia/Kolkata), open 09:00–19:00, caller books the
 * 6:30 PM slot (13:00Z) for 30 minutes. The incident date (12 October 2026)
 * is replaced by a fixed future date: availability never offers past slots,
 * so a literal 2026-10-12 would stop being bookable after that evening.
 */

const ORG = "org-smile";
const BIZ = "biz-smile";
const OTHER_ORG = "org-other";

type Row = Record<string, unknown>;

function makeDb() {
  const tables: Record<string, Row[]> = {
    agent_configs: [
      {
        organization_id: ORG,
        business_id: BIZ,
        capabilities: { calendar_read: true, calendar_book: true },
      },
    ],
    businesses: [
      {
        id: BIZ,
        organization_id: ORG,
        name: "Smile Dental",
        timezone: "Asia/Kolkata",
        country: "IN",
      },
    ],
    google_calendar_connections: [],
    business_hours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      business_id: BIZ,
      day_of_week: d,
      is_closed: false,
      intervals: [{ start: "09:00", end: "19:00" }],
    })),
    business_hour_overrides: [],
    contacts: [],
    bookings: [],
  };
  let seq = 0;
  const rpcCalls: Row[] = [];

  function query(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let columns: string | null = null;
    let upsertPayload: Row | null = null;
    const run = (): { data: unknown; error: unknown } => {
      if (upsertPayload) {
        const phone = String(upsertPayload["phone"]);
        if (table === "contacts" && !/^\+[1-9]\d{6,14}$/.test(phone)) {
          return {
            data: null,
            error: {
              code: "23514",
              message:
                'new row for relation "contacts" violates check constraint "contacts_phone_e164"',
            },
          };
        }
        let row = tables[table]!.find(
          (r) => r["organization_id"] === upsertPayload!["organization_id"] && r["phone"] === phone,
        );
        if (!row) {
          row = { id: `contact-${++seq}`, ...upsertPayload };
          tables[table]!.push(row);
        } else Object.assign(row, upsertPayload);
        return { data: [row], error: null };
      }
      const rows = tables[table]!.filter((r) => filters.every((f) => f(r)));
      return { data: rows, error: null };
    };
    const builder = {
      select(cols?: string) {
        columns = cols ?? "*";
        return builder;
      },
      upsert(payload: Row) {
        upsertPayload = payload;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return builder;
      },
      not(col: string, op: string, list: string) {
        assert.equal(op, "in");
        const excluded = list.replace(/[()]/g, "").split(",");
        filters.push((r) => !excluded.includes(String(r[col])));
        return builder;
      },
      gte(col: string, val: string) {
        filters.push((r) => String(r[col]) >= val);
        return builder;
      },
      lt(col: string, val: string) {
        filters.push((r) => String(r[col]) < val);
        return builder;
      },
      maybeSingle() {
        const { data, error } = run();
        return Promise.resolve({ data: (data as Row[] | null)?.[0] ?? null, error });
      },
      single() {
        const { data, error } = run();
        return Promise.resolve({ data: (data as Row[] | null)?.[0] ?? null, error });
      },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(onFulfilled, onRejected);
      },
    };
    void columns;
    return builder;
  }

  const client = {
    from: (table: string) => query(table),
    // create_booking_atomic, as of 20261010150000: idempotent return,
    // business-scoped overlap check, insert.
    rpc(fn: string, args: Row) {
      rpcCalls.push({ fn, ...args });
      assert.equal(fn, "create_booking_atomic");
      const existing = tables["bookings"]!.find(
        (b) =>
          b["organization_id"] === args["p_organization_id"] &&
          args["p_idempotency_key"] !== null &&
          b["idempotency_key"] === args["p_idempotency_key"],
      );
      if (existing) return Promise.resolve({ data: existing, error: null });
      const overlap = tables["bookings"]!.some(
        (b) =>
          b["business_id"] === args["p_business_id"] &&
          !["CANCELLED", "NO_SHOW", "PAYMENT_EXPIRED", "PAYMENT_FAILED"].includes(
            String(b["status"]),
          ) &&
          String(b["start_at"]) < String(args["p_end_at"]) &&
          String(b["end_at"]) > String(args["p_start_at"]),
      );
      if (overlap) {
        return Promise.resolve({ data: null, error: { message: "SLOT_NO_LONGER_AVAILABLE" } });
      }
      const row = {
        id: `booking-${++seq}`,
        organization_id: args["p_organization_id"],
        business_id: args["p_business_id"],
        contact_id: args["p_contact_id"],
        status: args["p_status"],
        start_at: new Date(String(args["p_start_at"])).toISOString(),
        end_at: new Date(String(args["p_end_at"])).toISOString(),
        timezone: args["p_timezone"],
        customer_name: args["p_customer_name"],
        customer_phone: args["p_customer_phone"],
        source: args["p_source"],
        idempotency_key: args["p_idempotency_key"],
        google_event_id: null,
      };
      tables["bookings"]!.push(row);
      return Promise.resolve({ data: row, error: null });
    },
  };
  return { client: client as never, tables, rpcCalls };
}

const CTX: ToolExecutionContext = {
  organizationId: ORG,
  businessId: BIZ,
  agentConfigId: "agent-1",
  callId: "call-smile-1",
  source: "voice",
};
const DATE = "2030-10-14";
const START = `${DATE}T13:00:00.000Z`; // 6:30 PM IST
const END = `${DATE}T13:30:00.000Z`;

async function book(db: ReturnType<typeof makeDb>, phone: string, ctx = CTX) {
  const result = await executeAiTool(db.client, ctx, "book_appointment", {
    customerName: "Dhanush",
    customerPhone: phone,
    startIso: START,
    endIso: END,
    notes: "teeth cleaning",
  });
  return { ...result, parsed: JSON.parse(result.content) as Row };
}

async function slotsFor(db: ReturnType<typeof makeDb>) {
  const result = await executeAiTool(db.client, CTX, "check_calendar_availability", {
    dateIso: DATE,
    durationMinutes: 30,
  });
  const parsed = JSON.parse(result.content) as { data: { slots: { start: string }[] } };
  return parsed.data.slots.map((s) => s.start);
}

describe("voice booking tool path (Smile Dental, 6:30 PM IST slot)", () => {
  test("6:30 PM IST is offered before booking (business timezone and date are applied)", async () => {
    const db = makeDb();
    assert.ok((await slotsFor(db)).includes(START));
  });

  test("1: a spoken 10-digit number books exactly one CONFIRMED booking, returned with its id and details", async () => {
    const db = makeDb();
    const result = await book(db, "9876543210");
    assert.equal(result.isError, false, result.content);
    const data = result.parsed["data"] as Row;
    assert.equal(typeof data["id"], "string");
    assert.equal(data["status"], "CONFIRMED");
    assert.equal(data["startAt"], START);
    assert.equal(db.tables["bookings"]!.length, 1);
    const [row] = db.tables["bookings"]!;
    assert.equal(row!["customer_phone"], "+919876543210");
    assert.equal(row!["organization_id"], ORG);
    assert.equal(row!["business_id"], BIZ);
    assert.equal(db.tables["contacts"]!.length, 1);
    assert.equal(db.tables["contacts"]![0]!["phone"], "+919876543210");
  });

  test("2: the booked slot is no longer returned as available; neighbours still are", async () => {
    const db = makeDb();
    await book(db, "9876543210");
    const slots = await slotsFor(db);
    assert.ok(!slots.includes(START));
    assert.ok(slots.includes(`${DATE}T12:30:00.000Z`)); // 6:00 PM IST
  });

  test("3: the booking is visible under the scope the dashboard reads (organization), and not to another org", async () => {
    const db = makeDb();
    await book(db, "9876543210");
    // listBookings: .from("bookings").select(...).eq("organization_id", org)
    const mine = db.tables["bookings"]!.filter((b) => b["organization_id"] === ORG);
    const theirs = db.tables["bookings"]!.filter((b) => b["organization_id"] === OTHER_ORG);
    assert.equal(mine.length, 1);
    assert.equal(theirs.length, 0);
  });

  test("8: a retried book_appointment for the same call and slot returns the same booking — never a duplicate", async () => {
    const db = makeDb();
    const first = await book(db, "9876543210");
    const second = await book(db, "+91 98765 43210");
    assert.equal((first.parsed["data"] as Row)["id"], (second.parsed["data"] as Row)["id"]);
    assert.equal(db.tables["bookings"]!.length, 1);
    assert.equal(db.tables["contacts"]!.length, 1);
  });

  test("4: an invalid number fails as INVALID_PHONE (targeted), with nothing written", async () => {
    const db = makeDb();
    const result = await book(db, "12345 678");
    assert.equal(result.isError, true);
    assert.equal((result.parsed["error"] as Row)["code"], "INVALID_PHONE");
    assert.equal(db.tables["bookings"]!.length, 0);
    assert.equal(db.tables["contacts"]!.length, 0);
  });

  test("a different call booking the same slot is rejected — the first booking stands", async () => {
    const db = makeDb();
    await book(db, "9876543210");
    const other = await book(db, "9845012345", { ...CTX, callId: "call-smile-2" });
    assert.equal(other.isError, true);
    assert.equal((other.parsed["error"] as Row)["code"], "SLOT_NO_LONGER_AVAILABLE");
    assert.equal(db.tables["bookings"]!.length, 1);
  });

  test("1: book_appointment reports the stored outcome — a new booking is 'confirmed'", async () => {
    const db = makeDb();
    const result = await book(db, "9876543210");
    assert.equal(result.parsed["bookingOutcome"], "confirmed");
  });

  function seedEarlierAttempt(db: ReturnType<typeof makeDb>, status: string) {
    // An earlier attempt for the SAME call and slot (same idempotency key).
    db.tables["bookings"]!.push({
      id: "booking-earlier",
      organization_id: ORG,
      business_id: BIZ,
      contact_id: null,
      status,
      start_at: START,
      end_at: END,
      timezone: "Asia/Kolkata",
      customer_phone: "+919876543210",
      idempotency_key: `voice:${CTX.callId}:${START}:${END}`,
      google_event_id: null,
    });
  }

  test("8/Google: a retry that finds the earlier CALENDAR_SYNC_FAILED booking reports it as saved — not confirmed, not failed, not duplicated", async () => {
    const db = makeDb();
    seedEarlierAttempt(db, "CALENDAR_SYNC_FAILED");
    const result = await book(db, "9876543210");
    assert.equal(result.isError, false);
    assert.equal(result.parsed["bookingOutcome"], "saved_calendar_sync_failed");
    assert.equal((result.parsed["data"] as Row)["id"], "booking-earlier");
    assert.equal(db.tables["bookings"]!.length, 1);
  });

  test("8: a retry that finds the earlier booking CANCELLED reports nothing booked", async () => {
    const db = makeDb();
    seedEarlierAttempt(db, "CANCELLED");
    const result = await book(db, "9876543210");
    assert.equal(result.isError, true);
    assert.equal((result.parsed["error"] as Row)["code"], "BOOKING_NOT_ACTIVE");
    assert.equal(db.tables["bookings"]!.length, 1, "no second booking created");
  });

  test("a business with no country never gets a guessed +91 — national numbers ask for the country code", async () => {
    const db = makeDb();
    db.tables["businesses"]![0]!["country"] = null;
    const national = await book(db, "9876543210");
    assert.equal(national.isError, true);
    assert.equal((national.parsed["error"] as Row)["code"], "INVALID_PHONE");
    assert.match(String((national.parsed["error"] as Row)["message"]), /country code/i);
    assert.equal(db.tables["contacts"]!.length, 0);

    const international = await book(db, "+91 98765 43210");
    assert.equal(international.isError, false, international.content);
    assert.equal(db.tables["contacts"]![0]!["phone"], "+919876543210");
  });
});
