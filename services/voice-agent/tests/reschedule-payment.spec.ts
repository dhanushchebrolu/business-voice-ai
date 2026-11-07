/**
 * G4 (rescheduling an existing booking) and G5 (payment-required booking)
 * in the LiveKit agent: the real state machine and the real tools, against
 * a recording backend. klyro's side (ownership guard, payment rule,
 * calendar-sync detection) is covered in src/lib/voice-agent/*.test.ts,
 * and the two together end to end there.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  agentSaid,
  applyReading,
  bookingExists,
  newConversation,
  nextStep,
  type BusinessContext,
  type ConversationState,
} from "../src/conversation/state.ts";
import { readUtterance, type ServiceRow } from "../src/conversation/understanding.ts";
import { buildTools, directive } from "../src/agent/receptionist.ts";
import { ReplyGuard } from "../src/conversation/guard.ts";
import type {
  BookResult,
  BookingBackend,
  FindBookingsResult,
  RescheduleResult,
} from "../src/backend/types.ts";

const SERVICES: ServiceRow[] = [
  { id: "svc-cleaning", name: "Teeth Cleaning", durationMinutes: 30, priceInr: 500 },
  { id: "svc-root-canal", name: "Root Canal Treatment", durationMinutes: 90, priceInr: 5000 },
];
const NOW = new Date("2026-11-07T04:30:00Z"); // Sat 10:00 IST
const ctx: BusinessContext = {
  businessName: "Smile Dental",
  timeZone: "Asia/Kolkata",
  services: SERVICES,
  now: () => NOW,
};
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();

function call(callerId: string | null = "+919876543210"): ConversationState {
  return newConversation({ callId: "c1", callerId, primaryLanguage: "en-IN" });
}
function say(s: ConversationState, text: string, stt: string | null = null) {
  applyReading(s, readUtterance(text, { catalog: SERVICES, sttLanguage: stt }), ctx);
  return nextStep(s);
}
const spoken = (s: ConversationState) => agentSaid(s, nextStep(s), { interrupted: false });

/** A backend that records every call; the calendar has 13:30 and 16:00 free every day. */
function backend(
  o: {
    bookings?: {
      id: string;
      date: string;
      hhmm: string;
      serviceId: string | null;
      serviceName: string | null;
      minutes?: number;
    }[];
    find?: FindBookingsResult;
    reschedule?: RescheduleResult[];
    book?: BookResult;
  } = {},
) {
  const calls = {
    availability: [] as { serviceId: string | null; date: string; durationMinutes: number }[],
    book: 0,
    find: 0,
    reschedule: [] as { bookingId: string; startIso: string; endIso: string }[],
  };
  const b: BookingBackend = {
    checkAvailability: async (q) => {
      calls.availability.push({
        serviceId: q.serviceId,
        date: q.date,
        durationMinutes: q.durationMinutes,
      });
      return {
        ok: true,
        slots: ["13:30", "16:00"].map((h) => ({
          startIso: ist(q.date, h),
          endIso: new Date(Date.parse(ist(q.date, h)) + q.durationMinutes * 60_000).toISOString(),
        })),
      };
    },
    book: async (req) => {
      calls.book++;
      return o.book ?? { ok: true, bookingId: "bk-new", outcome: "confirmed", slot: req.slot };
    },
    findMyBookings: async () => {
      calls.find++;
      return (
        o.find ?? {
          ok: true,
          callerIdentified: true,
          bookings: (o.bookings ?? []).map((x) => ({
            id: x.id,
            startIso: ist(x.date, x.hhmm),
            endIso: new Date(
              Date.parse(ist(x.date, x.hhmm)) + (x.minutes ?? 30) * 60_000,
            ).toISOString(),
            serviceId: x.serviceId,
            serviceName: x.serviceName,
          })),
        }
      );
    },
    reschedule: async (req) => {
      calls.reschedule.push({
        bookingId: req.bookingId,
        startIso: req.slot.startIso,
        endIso: req.slot.endIso,
      });
      return o.reschedule?.shift() ?? { ok: true, outcome: "confirmed", slot: req.slot };
    },
  };
  return { b, calls };
}
async function run(s: ConversationState, b: BookingBackend, tool: string): Promise<string> {
  const tools = buildTools({ business: ctx, backend: b, state: s }, new Set()) as Record<
    string,
    { execute: (a: unknown, o: unknown) => Promise<unknown> }
  >;
  return String(await tools[tool]!.execute({}, { ctx: {} as never, toolCallId: "t" }));
}

const ONE = [
  {
    id: "bk-1",
    date: "2026-11-09",
    hhmm: "11:00",
    serviceId: "svc-cleaning",
    serviceName: "Teeth Cleaning",
  },
];
const TWO = [
  ...ONE,
  {
    id: "bk-2",
    date: "2026-11-12",
    hhmm: "17:00",
    serviceId: "svc-root-canal",
    serviceName: "Root Canal Treatment",
    minutes: 90,
  },
];

describe("G4: rescheduling moves the caller's own booking, never books a second one", () => {
  for (const [lang, said] of [
    ["English", "I want to reschedule my appointment"],
    ["English (move)", "can you move my appointment please"],
    ["Telugu", "నా అపాయింట్మెంట్ టైం మార్చాలి"],
    ["Hindi", "मेरी अपॉइंटमेंट का समय बदलना है"],
  ] as const) {
    test(`${lang}: "${said}" looks the booking up first`, () => {
      const s = call();
      assert.deepEqual(say(s, said), { kind: "find_bookings" });
    });
  }

  test("one booking: found, new day and time, checked for ITS service duration, read back, moved once", async () => {
    const s = call();
    say(s, "I want to reschedule my appointment");
    const { b, calls } = backend({
      bookings: [
        {
          ...ONE[0]!,
          serviceId: "svc-root-canal",
          serviceName: "Root Canal Treatment",
          minutes: 90,
        },
      ],
    });
    assert.match(await run(s, b, "find_my_bookings"), /^FOUND: Root Canal Treatment/);
    assert.equal(s.service?.value.id, "svc-root-canal");
    assert.equal(s.service?.provenance, "confirmed");
    assert.deepEqual(nextStep(s), { kind: "ask", slot: "date" });
    assert.equal(say(s, "Monday at 4 PM").kind, "check_availability");
    await run(s, b, "check_availability");
    assert.deepEqual(calls.availability.at(-1), {
      serviceId: "svc-root-canal",
      date: "2026-11-09",
      durationMinutes: 90,
    });
    // the caller's 4 PM is free: the calendar offered it; "4 PM" selects it
    if (nextStep(s).kind === "offer_slots") {
      spoken(s);
      say(s, "4 PM");
    }
    assert.equal(nextStep(s).kind, "final_confirmation");
    assert.match(directive(nextStep(s), s, ctx), /move their Root Canal Treatment/);
    assert.doesNotMatch(
      directive(nextStep(s), s, ctx),
      /name and phone/,
      "no name/phone read-back",
    );
    spoken(s);
    say(s, "yes");
    assert.equal(nextStep(s).kind, "book");
    assert.match(directive(nextStep(s), s, ctx), /reschedule_appointment/);
    assert.match(await run(s, b, "reschedule_appointment"), /^MOVED/);
    assert.deepEqual(calls.reschedule, [
      {
        bookingId: "bk-1",
        startIso: ist("2026-11-09", "16:00"),
        endIso: new Date(Date.parse(ist("2026-11-09", "16:00")) + 90 * 60_000).toISOString(),
      },
    ]);
    assert.equal(calls.book, 0, "never a new booking");
    assert.deepEqual(nextStep(s), { kind: "rescheduled", pendingSync: false });
    // a repeated request never moves it twice
    assert.match(await run(s, b, "reschedule_appointment"), /^NOT_ALLOWED: already_moved/);
    assert.equal(calls.reschedule.length, 1);
  });

  test("several bookings: the caller picks by service, by day, or 'the second one'", async () => {
    for (const [pick, expected, keepsDate] of [
      ["the root canal one", "bk-2", false],
      ["the one on 12 November", "bk-2", true],
      ["the second one", "bk-2", false],
      ["the cleaning", "bk-1", false],
    ] as const) {
      const s = call();
      say(s, "I want to reschedule my appointment");
      const { b } = backend({ bookings: TWO });
      assert.match(await run(s, b, "find_my_bookings"), /^FOUND 2/);
      const step = nextStep(s);
      assert.equal(step.kind, "choose_booking");
      spoken(s);
      say(s, pick);
      assert.equal(s.reschedule.target?.id, expected, pick);
      if (keepsDate)
        assert.equal(s.date, null, "the day that named the booking is not the new day");
    }
  });
  test("an answer that fits both is asked again, never guessed", async () => {
    const s = call();
    say(s, "I want to reschedule my appointment");
    const { b } = backend({ bookings: TWO });
    await run(s, b, "find_my_bookings");
    say(s, "my appointment");
    assert.equal(s.reschedule.target, null);
    assert.equal(nextStep(s).kind, "choose_booking");
  });

  for (const [why, find] of [
    ["not_found", { ok: true, callerIdentified: true, bookings: [] }],
    ["no_caller_id", { ok: true, callerIdentified: false, bookings: [] }],
    ["lookup_failed", { ok: false, error: "backend_unavailable" }],
    ["not_allowed", { ok: false, error: "not_allowed" }],
  ] as const) {
    test(`nothing to move (${why}): said once, nothing changed, no booking question`, async () => {
      const s = call();
      say(s, "I want to reschedule my appointment");
      const { b, calls } = backend({ find: find as FindBookingsResult });
      await run(s, b, "find_my_bookings");
      assert.deepEqual(nextStep(s), { kind: "reschedule_unavailable", why });
      spoken(s);
      assert.equal(nextStep(s).kind, "done");
      assert.equal(calls.reschedule.length + calls.book, 0);
    });
  }

  async function readyToMove(reschedule: RescheduleResult[]) {
    const s = call();
    say(s, "I want to reschedule my appointment");
    const bk = backend({ bookings: ONE, reschedule });
    await run(s, bk.b, "find_my_bookings");
    say(s, "Monday at 4 PM");
    await run(s, bk.b, "check_availability");
    if (nextStep(s).kind === "offer_slots") {
      spoken(s);
      say(s, "4 PM");
    }
    spoken(s);
    say(s, "yes");
    assert.equal(nextStep(s).kind, "book");
    return { s, ...bk };
  }
  test("the new time was just taken: not moved, the old time stands, the calendar is checked again", async () => {
    const { s, b } = await readyToMove([
      {
        ok: false,
        error: "slot_taken",
        retryable: false,
        message: "That time slot is no longer available.",
      },
    ]);
    assert.match(await run(s, b, "reschedule_appointment"), /^SLOT_TAKEN.*NOT moved/);
    assert.equal(s.reschedule.status, "ready");
    assert.equal(nextStep(s).kind, "check_availability");
  });
  test("calendar sync failed after the move: said as changed, the team confirms", async () => {
    const { s, b } = await readyToMove([
      { ok: true, outcome: "saved_calendar_sync_failed", slot: { startIso: "x", endIso: "y" } },
    ]);
    assert.match(await run(s, b, "reschedule_appointment"), /^MOVED_NOT_SYNCED/);
    assert.deepEqual(nextStep(s), { kind: "rescheduled", pendingSync: true });
  });
  test("not the caller's booking (klyro's ownership guard): refused, nothing changed", async () => {
    const { s, b } = await readyToMove([
      {
        ok: false,
        error: "not_found",
        retryable: false,
        message: "No booking was found for this customer.",
      },
    ]);
    assert.match(await run(s, b, "reschedule_appointment"), /^NOT_MOVED/);
    assert.deepEqual(nextStep(s), { kind: "reschedule_failed" });
  });
  test("klyro unreachable: not moved, offered again (same booking, same time: no double move)", async () => {
    const { s, b, calls } = await readyToMove([
      { ok: false, error: "backend_unavailable", retryable: true, message: "network" },
    ]);
    assert.match(await run(s, b, "reschedule_appointment"), /^FAILED/);
    assert.equal(nextStep(s).kind, "book");
    assert.match(await run(s, b, "reschedule_appointment"), /^MOVED/);
    assert.equal(new Set(calls.reschedule.map((r) => `${r.bookingId}@${r.startIso}`)).size, 1);
  });
  test("a reschedule after this call already booked something is not started", () => {
    const s = call();
    s.booking.status = "confirmed";
    say(s, "I want to reschedule my appointment");
    assert.equal(s.reschedule.status, "none");
  });
});

describe("G5: a payment-required booking is held, never called confirmed", () => {
  async function bookedWith(result: BookResult) {
    const s = call();
    say(s, "teeth cleaning tomorrow at 4 PM");
    s.customerName = {
      value: "Dhanush",
      provenance: "confirmed",
      turn: 1,
      evidence: "",
      alternatives: [],
    };
    s.phone!.provenance = "confirmed";
    s.service!.provenance = "confirmed";
    s.date!.provenance = "confirmed";
    s.time!.provenance = "confirmed";
    s.booking.selected = { startIso: ist("2026-11-08", "16:00"), hhmm: "16:00" };
    s.booking.status = "awaiting_final_confirmation";
    const { b, calls } = backend({ book: result });
    const out = await run(s, b, "book_appointment");
    return { s, out, calls };
  }
  const slot = { startIso: ist("2026-11-08", "16:00"), endIso: ist("2026-11-08", "16:30") };
  test("link sent: held until paid; the next step says so; never 'confirmed'", async () => {
    const { s, out } = await bookedWith({
      ok: true,
      bookingId: "hold-1",
      outcome: "payment_pending",
      slot,
      payment: { requested: true, linkSent: true },
    });
    assert.match(out, /^PAYMENT_PENDING:.*WhatsApp.*NOT confirmed/);
    assert.equal(s.booking.status, "payment_pending");
    assert.ok(bookingExists(s), "never booked again on this call");
    const d = directive(nextStep(s), s, ctx);
    assert.match(d, /needs payment/);
    assert.match(d, /confirmed only once the payment is received/);
  });
  test("link not sent: held, the team will send it", async () => {
    const { s, out } = await bookedWith({
      ok: true,
      bookingId: "hold-1",
      outcome: "payment_pending",
      slot,
      payment: { requested: false, linkSent: false },
    });
    assert.match(out, /could not be sent/);
    assert.match(directive(nextStep(s), s, ctx), /team will send it/);
  });
  test("the reply guard removes any 'it is booked / confirmed' sentence while payment is pending", async () => {
    const { s } = await bookedWith({
      ok: true,
      bookingId: "hold-1",
      outcome: "payment_pending",
      slot,
      payment: { requested: true, linkSent: true },
    });
    const g = new ReplyGuard(s, { knownPrices: [] });
    assert.equal(g.check("Your appointment is confirmed for 4 PM."), null);
    assert.equal(g.check("I've booked it for you."), null);
  });
  test("a second book request on the same call does not create another hold", async () => {
    const { s, calls } = await bookedWith({
      ok: true,
      bookingId: "hold-1",
      outcome: "payment_pending",
      slot,
      payment: { requested: true, linkSent: true },
    });
    const out = await run(s, backend().b, "book_appointment");
    assert.match(out, /^NOT_ALLOWED: already_booked/);
    assert.equal(calls.book, 1);
  });
});
