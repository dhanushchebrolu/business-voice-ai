import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  startRuntimeSession,
  terminateRuntimeSession,
  detectRescheduleRequest,
  extractRequestedDate,
  parseCallerIntentFromText,
  personalizeGreeting,
  selectCallerBooking,
  type StartRuntimeSessionInput,
  type ToolExecContext,
} from "./voice-runtime.server.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ServiceRow } from "./service-matching.ts";
import type { CallerBooking } from "./calendar/caller-bookings.server.ts";

/**
 * Production incident (Smile Dental): a caller booked 12:00, asked to
 * reschedule to 1 PM, and ended up with TWO bookings — 1 PM was created as
 * a new booking and 12:00 stayed booked. A call from a different number
 * could also have asked to move an appointment it didn't own.
 *
 * Drives the REAL voice runtime through the deterministic harness. The
 * booking store below stands in for the database with the same contract
 * the real code has: reschedule_appointment moves the SAME booking (the
 * atomic reschedule_booking_atomic RPC — covered against real PostgreSQL
 * in supabase/migrations/voice_reschedule.pg.test.ts) and only for the
 * caller who owns it (callerOwnsBooking — covered in
 * caller-bookings.server.test.ts and ai-tools.server.test.ts).
 */

const agent: AgentSnapshot["agent"] = {
  agent_name: "Aria",
  persona: "professional",
  custom_personality: null,
  objectives: ["answer_questions"],
  capabilities: {},
  primary_language: "en-IN",
  extra_languages: [],
  multilingual: false,
  voice_id: "ritu",
  speaking_pace: 1,
  greetings: { "en-IN": "Hello, thanks for calling Smile Dental. How can I help you today?" },
  transfer_number: null,
  after_hours_behavior: "take_message",
};

const SERVICES: ServiceRow[] = [
  { id: "svc-teeth-cleaning", name: "Teeth Cleaning", duration_minutes: 30 },
  { id: "svc-root-canal", name: "Root Canal Treatment", duration_minutes: 30 },
];

const ORG = "00000000-0000-0000-0000-000000000000";
const BIZ = "00000000-0000-0000-0000-000000000001";
const CALLER = "+919876543210";
const OTHER_CALLER = "+919845012345";
const DATE = "2030-10-14";

interface StoredBooking {
  id: string;
  businessId: string;
  ownerPhone: string;
  startAt: string;
  endAt: string;
  timezone: string;
  status: string;
  serviceName: string | null;
  customerName: string | null;
}

/** The booking store: same-row reschedule, overlap and working-hours checks, ownership by caller ID. */
function makeStore() {
  const bookings: StoredBooking[] = [];
  let seq = 0;
  const active = (b: StoredBooking) => !["CANCELLED", "NO_SHOW"].includes(b.status);
  const overlaps = (id: string, start: number, end: number) =>
    bookings.some(
      (b) =>
        b.id !== id &&
        active(b) &&
        new Date(b.startAt).getTime() < end &&
        new Date(b.endAt).getTime() > start,
    );
  const localHour = (iso: string, tz: string) =>
    Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(
        new Date(iso),
      ),
    );
  let nextRescheduleOverride: { content: string; isError?: boolean } | null = null;
  /** rescheduleBooking's real behaviour when Google fails AFTER the database move committed: the row is moved (CALENDAR_SYNC_FAILED) and the calendar error is thrown. */
  let failCalendarAfterCommit: string | null = null;
  return {
    bookings,
    add(b: Partial<StoredBooking> & { startAt: string; endAt: string }) {
      const row: StoredBooking = {
        id: `b-${++seq}`,
        businessId: BIZ,
        ownerPhone: CALLER,
        timezone: "Asia/Kolkata",
        status: "CONFIRMED",
        serviceName: "Root Canal Treatment",
        customerName: "Dhanush Kumar",
        ...b,
      };
      bookings.push(row);
      return row;
    },
    failNextReschedule(result: { content: string; isError?: boolean }) {
      nextRescheduleOverride = result;
    },
    failCalendarAfterNextMove(code: string) {
      failCalendarAfterCommit = code;
    },
    findCallerBookings: async (q: { businessId: string; callerE164: string }) =>
      bookings
        .filter((b) => b.businessId === q.businessId && b.ownerPhone === q.callerE164 && active(b))
        .sort((a, b) => a.startAt.localeCompare(b.startAt))
        .map((b): CallerBooking => ({
          id: b.id,
          startAt: b.startAt,
          endAt: b.endAt,
          timezone: b.timezone,
          status: b.status,
          serviceId: null,
          serviceName: b.serviceName,
          customerName: b.customerName,
        })),
    execute(name: string, input: Record<string, unknown>, ctx: ToolExecContext) {
      if (name === "check_calendar_availability") {
        // Every free half hour of the requested (UTC) day.
        const day = String(input["dateIso"]);
        const slots = [];
        for (let m = 0; m < 24 * 60; m += 30) {
          const start = new Date(`${day}T00:00:00.000Z`).getTime() + m * 60_000;
          const end = start + 30 * 60_000;
          if (!overlaps("", start, end)) {
            slots.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
          }
        }
        return { content: JSON.stringify({ success: true, data: { slots } }) };
      }
      if (name === "book_appointment") {
        const row = this.add({
          startAt: String(input["startIso"]),
          endAt: String(input["endIso"]),
          ownerPhone: String(input["customerPhone"]),
          timezone: "UTC",
          customerName: String(input["customerName"] ?? ""),
        });
        return {
          content: JSON.stringify({
            success: true,
            data: { id: row.id, status: "CONFIRMED", startAt: row.startAt, endAt: row.endAt },
            bookingOutcome: "confirmed",
          }),
        };
      }
      if (name === "reschedule_appointment") {
        if (nextRescheduleOverride) {
          const r = nextRescheduleOverride;
          nextRescheduleOverride = null;
          return r;
        }
        const fail = (code: string) => ({
          content: JSON.stringify({ success: false, error: { code, message: code } }),
          isError: true,
        });
        const row = bookings.find((b) => b.id === input["bookingId"]);
        // callerOwnsBooking: same business AND the trusted caller ID matches.
        if (!row || row.businessId !== ctx.businessId || row.ownerPhone !== ctx.callerE164) {
          return fail("NOT_FOUND");
        }
        const start = new Date(String(input["newStartIso"])).getTime();
        const end = new Date(String(input["newEndIso"])).getTime();
        const hour = localHour(String(input["newStartIso"]), row.timezone);
        if (hour < 9 || hour >= 19) return fail("SLOT_OUTSIDE_SCHEDULE");
        if (overlaps(row.id, start, end)) return fail("SLOT_NO_LONGER_AVAILABLE");
        row.startAt = new Date(start).toISOString();
        row.endAt = new Date(end).toISOString();
        row.status = "RESCHEDULED";
        if (failCalendarAfterCommit) {
          row.status = "CALENDAR_SYNC_FAILED";
          const calendarCode = failCalendarAfterCommit;
          failCalendarAfterCommit = null;
          return fail(calendarCode);
        }
        return {
          content: JSON.stringify({
            success: true,
            data: { id: row.id, status: "RESCHEDULED", startAt: row.startAt, endAt: row.endAt },
          }),
        };
      }
      return { content: JSON.stringify({ success: true, data: {} }) };
    },
  };
}

function input(callId: string, h: Harness, callerNumber: string | null): StartRuntimeSessionInput {
  return {
    callId,
    organizationId: ORG,
    businessId: BIZ,
    agentConfigId: "00000000-0000-0000-0000-000000000002",
    agentVersion: 3,
    instructions: "You are Aria, a helpful receptionist for Smile Dental.",
    snapshotAgent: agent,
    businessName: "Smile Dental",
    bridge: h.bridge,
    businessCountry: "IN",
    callerNumber,
    services: SERVICES,
  };
}

async function drain(hops = 300) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

function marker(state: Record<string, unknown>): string {
  return `<<<APPT_STATE:${JSON.stringify({
    service: null,
    customer_name: null,
    phone: null,
    email: null,
    preferred_date: null,
    preferred_time: null,
    preferred_period: null,
    wants_next_available: false,
    checking_availability: false,
    ready_to_book: false,
    ...state,
  })}>>>`;
}

async function openCall(
  store: ReturnType<typeof makeStore>,
  callerNumber: string | null = CALLER,
  opts: { returningName?: string | null } = {},
) {
  const h = createHarness();
  const record = h.deps.executeTool!;
  h.deps.executeTool = async (name, toolInput, ctx) => {
    await record(name, toolInput, ctx);
    return store.execute(name, toolInput, ctx);
  };
  h.deps.findCallerBookings = store.findCallerBookings;
  if (opts.returningName !== undefined) {
    h.deps.findReturningCallerName = async () => opts.returningName ?? null;
  }
  const callId = `reschedule-${crypto.randomUUID()}`;
  await startRuntimeSession(input(callId, h, callerNumber), h.deps);
  let emitted = 0;
  const turn = async (said: string, reply = "Sure.") => {
    while (emitted < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      emitted++;
    }
    h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance(said);
    await drain();
    return h.tts.sentTexts.slice(before).join(" ");
  };
  const calls = (name: string) => h.tools.calls.filter((c) => c.name === name);
  return { h, callId, turn, calls };
}

const noon = { startAt: `${DATE}T06:30:00.000Z`, endAt: `${DATE}T07:00:00.000Z` }; // 12:00 IST
const live = (store: ReturnType<typeof makeStore>) =>
  store.bookings.filter((b) => !["CANCELLED", "NO_SHOW"].includes(b.status));

describe("rescheduling moves the existing booking — never a second booking", () => {
  test("book 12:00 then 'reschedule it to 1 PM' on the same call: one booking, same id, now at 13:00", async () => {
    const store = makeStore();
    const { callId, turn, calls } = await openCall(store);
    const WHEN = { preferred_date: DATE, preferred_time: "12:00" };
    await turn("I'd like to book a root canal", `Sure, when?\n${marker({})}`);
    await turn(
      "At 12 PM, my name is Dhanush and use the number I'm calling from",
      `Thanks Dhanush. Shall I book it?\n${marker({ ...WHEN, customer_name: "Dhanush" })}`,
    );
    await turn("Yes, book it", `Booking.\n${marker({ ...WHEN, ready_to_book: true })}`);
    assert.equal(calls("book_appointment").length, 1, "the original booking");
    const original = store.bookings[0]!;
    assert.equal(original.startAt, `${DATE}T12:00:00.000Z`);

    const reply = await turn(
      "Actually, can you reschedule it to 1 PM?",
      // The model wants to book again — the runtime must not.
      `Booking 1 PM.\n${marker({ ...WHEN, preferred_time: "13:00", ready_to_book: true })}`,
    );
    assert.equal(calls("book_appointment").length, 1, "no second booking was created");
    assert.equal(calls("reschedule_appointment").length, 1);
    assert.equal(calls("reschedule_appointment")[0]!.input["bookingId"], original.id);
    assert.equal(live(store).length, 1, "only one live booking");
    assert.equal(live(store)[0]!.id, original.id, "the booking id is preserved");
    assert.equal(live(store)[0]!.startAt, `${DATE}T13:00:00.000Z`, "now at 13:00");
    assert.match(reply, /moved to/i, reply);
    assert.match(reply, /1 PM/, reply);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a returning caller reschedules: stored service and name reused, only the new time asked", async () => {
    const store = makeStore();
    store.add(noon);
    const { callId, turn, calls } = await openCall(store);
    const ask = await turn("I want to reschedule my appointment");
    assert.match(ask, /Dhanush/, "uses the stored name");
    assert.match(ask, /Root Canal Treatment/, "uses the stored treatment");
    assert.match(ask, /what new date and time/i, ask);
    assert.doesNotMatch(ask, /which (service|treatment)|your name|phone number/i, ask);

    const done = await turn("1 PM please");
    assert.equal(calls("book_appointment").length, 0);
    assert.equal(calls("reschedule_appointment").length, 1);
    const moved = calls("reschedule_appointment")[0]!;
    assert.equal(moved.input["newStartIso"], `${DATE}T07:30:00.000Z`, "1 PM IST");
    assert.equal(moved.input["newEndIso"], `${DATE}T08:00:00.000Z`, "same 30-minute duration");
    assert.equal(moved.ctx.callerE164, CALLER, "the trusted caller ID goes to the ownership check");
    assert.match(done, /Done, Dhanush/, done);
    assert.equal(live(store).length, 1);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("'move my 12 PM appointment to 1 PM' in one breath: 12 PM identifies it, 1 PM is the new time", async () => {
    const store = makeStore();
    store.add(noon);
    const { callId, turn, calls } = await openCall(store);
    await turn("Can you move my 12 PM appointment to 1 PM?");
    assert.equal(calls("reschedule_appointment").length, 1);
    assert.equal(calls("reschedule_appointment")[0]!.input["newStartIso"], `${DATE}T07:30:00.000Z`);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a failed reschedule (slot taken) leaves the original booking intact and says so", async () => {
    const store = makeStore();
    const mine = store.add(noon);
    store.add({
      startAt: `${DATE}T07:30:00.000Z`,
      endAt: `${DATE}T08:00:00.000Z`,
      ownerPhone: OTHER_CALLER,
    });
    const { callId, turn, calls } = await openCall(store);
    const reply = await turn("Please reschedule my appointment to 1 PM");
    assert.equal(calls("reschedule_appointment").length, 1);
    assert.equal(mine.startAt, noon.startAt, "original time unchanged");
    assert.equal(mine.status, "CONFIRMED");
    assert.match(reply, /isn't available/i, reply);
    assert.match(reply, /unchanged/i, reply);
    assert.doesNotMatch(reply, /moved to/i, reply);
    assert.equal(calls("book_appointment").length, 0);

    // The caller picks another time: the same booking moves.
    await turn("How about 2 PM then?");
    assert.equal(mine.startAt, `${DATE}T08:30:00.000Z`);
    assert.equal(live(store).length, 2, "still exactly one booking for this caller");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("outside working hours: original intact, another time asked", async () => {
    const store = makeStore();
    const mine = store.add(noon);
    const { callId, turn } = await openCall(store);
    const reply = await turn("Reschedule my appointment to 9 PM");
    assert.match(reply, /outside our working hours/i, reply);
    assert.equal(mine.startAt, noon.startAt);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a Google Calendar update failure after the move committed is reported as moved — never as a failure", async () => {
    const store = makeStore();
    const mine = store.add(noon);
    store.failCalendarAfterNextMove("CALENDAR_UNAVAILABLE");
    const { callId, turn, calls } = await openCall(store);
    const reply = await turn("Reschedule my appointment to 1 PM");
    assert.equal(mine.startAt, `${DATE}T07:30:00.000Z`, "the database move committed");
    assert.equal(mine.status, "CALENDAR_SYNC_FAILED", "flagged for the calendar retry job");
    assert.match(reply, /has been moved to/i, reply);
    assert.match(reply, /our team will finish updating the calendar/i, reply);
    assert.equal(calls("reschedule_appointment").length, 1, "never retried into a second write");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a calendar error before anything was written: the re-read shows the original, and the caller hears it is unchanged", async () => {
    const store = makeStore();
    const mine = store.add(noon);
    store.failNextReschedule({
      content: JSON.stringify({
        success: false,
        error: { code: "NEEDS_REAUTH", message: "reconnect" },
      }),
      isError: true,
    });
    const { callId, turn } = await openCall(store);
    const reply = await turn("Reschedule my appointment to 1 PM");
    assert.equal(mine.startAt, noon.startAt);
    assert.match(reply, /couldn't change that/i, reply);
    assert.match(reply, /unchanged/i, reply);
    assert.doesNotMatch(reply, /moved to/i, reply);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("an unknown outcome (timeout/unexpected error) claims neither success nor 'unchanged'", async () => {
    const store = makeStore();
    store.add(noon);
    store.failNextReschedule({
      content: JSON.stringify({
        success: false,
        error: { code: "CALENDAR_TIMEOUT", message: "timeout" },
      }),
      isError: true,
    });
    const { callId, turn } = await openCall(store);
    const reply = await turn("Reschedule my appointment to 1 PM");
    assert.match(reply, /couldn't confirm that change/i, reply);
    assert.doesNotMatch(reply, /moved to|unchanged/i, reply);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("retrying the same request doesn't duplicate: the booking is already at that time", async () => {
    const store = makeStore();
    store.add(noon);
    const { callId, turn, calls } = await openCall(store);
    await turn("Reschedule my appointment to 1 PM");
    const again = await turn("Please reschedule my appointment to 1 PM");
    assert.match(again, /already booked for that time/i, again);
    assert.equal(calls("reschedule_appointment").length, 1, "no second write");
    assert.equal(calls("book_appointment").length, 0);
    assert.equal(live(store).length, 1);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("caller identity", () => {
  test("a different number can't see or modify another caller's booking — and nothing is booked instead", async () => {
    const store = makeStore();
    const theirs = store.add(noon);
    const { callId, turn, calls } = await openCall(store, OTHER_CALLER);
    const reply = await turn(
      "I want to reschedule my appointment to 1 PM, my number is 9876543210",
      `Booking 1 PM.\n${marker({ preferred_date: DATE, preferred_time: "13:00", ready_to_book: true })}`,
    );
    assert.match(reply, /couldn't find an upcoming appointment/i, reply);
    assert.doesNotMatch(reply, /Root Canal|Dhanush|12 PM/i, "reveals nothing about the booking");
    assert.equal(calls("reschedule_appointment").length, 0);
    assert.equal(calls("book_appointment").length, 0, "never silently books a new appointment");
    assert.equal(theirs.startAt, noon.startAt);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("even a forged booking id from a different number is refused by the ownership check", async () => {
    const store = makeStore();
    const theirs = store.add(noon);
    const result = store.execute(
      "reschedule_appointment",
      {
        bookingId: theirs.id,
        newStartIso: `${DATE}T07:30:00.000Z`,
        newEndIso: `${DATE}T08:00:00.000Z`,
      },
      {
        organizationId: ORG,
        businessId: BIZ,
        agentConfigId: null,
        callId: "x",
        callerE164: OTHER_CALLER,
      },
    );
    assert.equal(result.isError, true);
    assert.equal(theirs.startAt, noon.startAt);
  });

  test("a withheld caller ID: refused politely; a spoken number is not accepted as proof", async () => {
    const store = makeStore();
    const theirs = store.add(noon);
    const { callId, turn, calls } = await openCall(store, null);
    const reply = await turn("Reschedule my appointment to 1 PM. My number is 9876543210.");
    assert.match(reply, /call from the phone number it was booked with/i, reply);
    assert.equal(calls("reschedule_appointment").length, 0);
    assert.equal(calls("book_appointment").length, 0);
    assert.equal(theirs.startAt, noon.startAt);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("tenant isolation: the same number's booking at another business is not found", async () => {
    const store = makeStore();
    store.add({ ...noon, businessId: "another-business" });
    const { callId, turn, calls } = await openCall(store);
    const reply = await turn("I'd like to reschedule my appointment");
    assert.match(reply, /couldn't find an upcoming appointment/i, reply);
    assert.equal(calls("reschedule_appointment").length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("several appointments", () => {
  test("asks which one, then moves only the one chosen", async () => {
    const store = makeStore();
    const rc = store.add(noon);
    const tc = store.add({
      startAt: "2030-10-15T09:30:00.000Z",
      endAt: "2030-10-15T10:00:00.000Z",
      serviceName: "Teeth Cleaning",
    });
    const { callId, turn, calls } = await openCall(store);
    const ask = await turn("I need to reschedule my appointment to 4 PM");
    assert.match(ask, /2 upcoming appointments/i, ask);
    assert.match(ask, /which one/i, ask);
    assert.equal(calls("reschedule_appointment").length, 0, "nothing moved before clarifying");

    await turn("The teeth cleaning one");
    assert.equal(calls("reschedule_appointment").length, 1);
    assert.equal(calls("reschedule_appointment")[0]!.input["bookingId"], tc.id);
    assert.equal(tc.startAt, "2030-10-15T10:30:00.000Z", "4 PM IST on its own date");
    assert.equal(rc.startAt, noon.startAt, "the other appointment is untouched");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("'never mind' leaves everything as it is", async () => {
    const store = makeStore();
    const a = store.add(noon);
    store.add({ startAt: "2030-10-15T09:30:00.000Z", endAt: "2030-10-15T10:00:00.000Z" });
    const { callId, turn, calls } = await openCall(store);
    await turn("Reschedule my appointment please");
    const reply = await turn("Never mind");
    assert.match(reply, /left your appointment as it is/i, reply);
    assert.equal(calls("reschedule_appointment").length, 0);
    assert.equal(a.startAt, noon.startAt);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("a time change right after booking is confirmed as a move, never booked twice", () => {
  test("'1 PM instead' after booking asks to confirm the move; 'yes' moves the same booking", async () => {
    const store = makeStore();
    const { callId, turn, calls } = await openCall(store);
    const WHEN = { preferred_date: DATE, preferred_time: "12:00" };
    await turn(
      "Book a root canal at 12 PM, I'm Dhanush, use the number I'm calling from",
      `Shall I book it?\n${marker({ ...WHEN, customer_name: "Dhanush" })}`,
    );
    await turn("Yes, book it", `Booking.\n${marker({ ...WHEN, ready_to_book: true })}`);
    assert.equal(calls("book_appointment").length, 1);

    const confirm = await turn(
      "Hmm, can we do 1 PM instead?",
      `Booking 1 PM.\n${marker({ ...WHEN, preferred_time: "13:00", ready_to_book: true })}`,
    );
    assert.match(confirm, /would you like to move your/i, confirm);
    assert.equal(calls("reschedule_appointment").length, 0);
    await turn("Yes please", `Booking.\n${marker({ ...WHEN, ready_to_book: true })}`);
    assert.equal(calls("book_appointment").length, 1, "never booked a second time");
    assert.equal(calls("reschedule_appointment").length, 1);
    assert.equal(live(store).length, 1);
    assert.equal(live(store)[0]!.startAt, `${DATE}T13:00:00.000Z`);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("repeating the time just booked is not treated as a move", async () => {
    const store = makeStore();
    const { callId, turn, calls } = await openCall(store);
    const WHEN = { preferred_date: DATE, preferred_time: "12:00" };
    await turn(
      "Book a root canal at 12 PM, I'm Dhanush, use the number I'm calling from",
      `Shall I book it?\n${marker({ ...WHEN, customer_name: "Dhanush" })}`,
    );
    await turn("Yes, book it", `Booking.\n${marker({ ...WHEN, ready_to_book: true })}`);
    const reply = await turn("Great, so 12 PM then", `Yes.\n${marker(WHEN)}`);
    assert.match(reply, /already booked for that time/i, reply);
    assert.equal(calls("reschedule_appointment").length, 0);
    assert.equal(calls("book_appointment").length, 1);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("'book another appointment' is a new booking, not a move", () => {
    const intent = parseCallerIntentFromText("Can I book another appointment at 3 PM?");
    assert.equal(
      detectRescheduleRequest("Can I book another appointment at 3 PM?", intent, true),
      null,
    );
  });
});

describe("returning customers are greeted by name", () => {
  test("a known caller's greeting includes their first name — and no appointment details", async () => {
    const store = makeStore();
    store.add(noon);
    const { h, callId } = await openCall(store, CALLER, { returningName: "Dhanush" });
    const greeting = h.tts.sentTexts[0] ?? "";
    assert.match(greeting, /^Hello Dhanush, thanks for calling Smile Dental/, greeting);
    assert.doesNotMatch(greeting, /root canal|12|appointment on/i, greeting);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("an unknown or ambiguous number gets the normal greeting", async () => {
    const { h, callId } = await openCall(makeStore(), CALLER, { returningName: null });
    assert.match(h.tts.sentTexts[0] ?? "", /^Hello, thanks for calling Smile Dental/);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("the lookup never delays the greeting: a slow lookup falls back to the normal greeting", async () => {
    const h = createHarness();
    let lookups = 0;
    h.deps.findReturningCallerName = () => {
      lookups++;
      return new Promise<string | null>(() => {}); // never settles
    };
    const callId = `reschedule-${crypto.randomUUID()}`;
    await startRuntimeSession(input(callId, h, CALLER), h.deps);
    assert.equal(lookups, 1);
    assert.match(h.tts.sentTexts[0] ?? "", /^Hello, thanks for calling Smile Dental/);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("no caller ID: no lookup at all", async () => {
    const h = createHarness();
    let lookups = 0;
    h.deps.findReturningCallerName = async () => {
      lookups++;
      return "Dhanush";
    };
    const callId = `reschedule-${crypto.randomUUID()}`;
    await startRuntimeSession(input(callId, h, null), h.deps);
    assert.equal(lookups, 0);
    assert.match(h.tts.sentTexts[0] ?? "", /^Hello, thanks for calling/);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("personalizeGreeting: after the salutation, a prefix for English without one, unchanged otherwise", () => {
    assert.equal(
      personalizeGreeting("Hello, thanks for calling X.", "Ravi", "en-IN"),
      "Hello Ravi, thanks for calling X.",
    );
    assert.equal(
      personalizeGreeting("Thank you for calling X.", "Ravi", "en-IN"),
      "Hi Ravi! Thank you for calling X.",
    );
    assert.equal(
      personalizeGreeting("नमस्ते, X में आपका स्वागत है।", "Ravi", "hi-IN"),
      "नमस्ते, X में आपका स्वागत है।",
    );
    assert.equal(
      personalizeGreeting("Hello, thanks for calling X.", null, "en-IN"),
      "Hello, thanks for calling X.",
    );
  });
});

describe("pure helpers", () => {
  const NOW = new Date("2030-10-14T04:00:00.000Z"); // 09:30 IST, Monday
  const intent = (t: string) => parseCallerIntentFromText(t);

  test("detectRescheduleRequest", () => {
    for (const t of [
      "I want to reschedule",
      "Can you re-schedule my booking",
      "Please postpone my appointment",
      "Move my appointment to Friday",
      "Can you shift the booking to 3 PM",
      "Move it to 4 PM",
    ]) {
      assert.equal(detectRescheduleRequest(t, intent(t), false), "explicit", t);
    }
    for (const t of ["I'd like to book an appointment at 3 PM", "What time do you open?"]) {
      assert.equal(detectRescheduleRequest(t, intent(t), false), null, t);
    }
    assert.equal(
      detectRescheduleRequest("3 PM instead?", intent("3 PM instead?"), true),
      "implicit",
    );
    assert.equal(detectRescheduleRequest("3 PM instead?", intent("3 PM instead?"), false), null);
    // While a new booking is still being collected, "change it to tomorrow"
    // corrects that request; once something was booked, it is a reschedule.
    const change = "change it to tomorrow";
    assert.equal(detectRescheduleRequest(change, intent(change), false, true), null);
    assert.equal(detectRescheduleRequest(change, intent(change), true, true), "explicit");
    assert.equal(detectRescheduleRequest(change, intent(change), false, false), "explicit");
  });

  test("extractRequestedDate resolves named dates in the business timezone", () => {
    const tz = "Asia/Kolkata";
    const d = (t: string) => extractRequestedDate(t, intent(t), tz, NOW);
    assert.equal(d("tomorrow"), "2030-10-15");
    assert.equal(d("on Friday"), "2030-10-18");
    assert.equal(d("20th October"), "2030-10-20");
    assert.equal(d("October 20"), "2030-10-20");
    assert.equal(d("the 2nd"), "2030-11-02");
    assert.equal(d("5 January"), "2031-01-05");
    assert.equal(d("at 3 PM"), null);
  });

  test("selectCallerBooking picks by service, position, date or time — never guesses", () => {
    const b = (id: string, startAt: string, serviceName: string): CallerBooking => ({
      id,
      startAt,
      endAt: startAt,
      timezone: "Asia/Kolkata",
      status: "CONFIRMED",
      serviceId: null,
      serviceName,
      customerName: null,
    });
    const list = [
      b("a", "2030-10-14T06:30:00.000Z", "Root Canal Treatment"),
      b("c", "2030-10-15T09:30:00.000Z", "Teeth Cleaning"),
    ];
    const pick = (t: string) => selectCallerBooking(list, t, intent(t), NOW)?.booking.id ?? null;
    assert.equal(pick("the root canal"), "a");
    assert.equal(pick("the cleaning one, teeth cleaning"), "c");
    assert.equal(pick("the second one"), "c");
    assert.equal(pick("the one tomorrow"), "c");
    assert.equal(pick("the 12 PM one"), "a");
    assert.equal(pick("hmm"), null);
  });
});
