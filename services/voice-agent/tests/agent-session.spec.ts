/**
 * End to end through LiveKit's real AgentSession (text mode: the same turn
 * pipeline, tool executor, chat context and interruption handling a phone
 * call uses, minus audio). The model is LiveKit's FakeLLM with scripted
 * replies — including deliberately bad ones — so these tests prove what the
 * code guarantees whatever a model says. They do NOT measure a real
 * model's understanding or voice quality (that needs real calls).
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { initializeLogger, voice } from "@livekit/agents";
import { ReceptionistAgent } from "../src/agent/receptionist.ts";
import { InMemoryBookingBackend, type InMemoryOptions } from "../src/backend/in-memory.ts";
import type { BookingBackend } from "../src/backend/types.ts";
import { newConversation, type BusinessContext } from "../src/conversation/state.ts";
import type { ServiceRow } from "../src/conversation/understanding.ts";

initializeLogger({ pretty: false, level: "error" });

const SERVICES: ServiceRow[] = [
  {
    id: "svc-cleaning",
    name: "Cleaning",
    aliases: ["క్లీనింగ్", "क्लीनिंग"],
    durationMinutes: 30,
    priceInr: 800,
  },
  {
    id: "svc-root-canal",
    name: "Root Canal",
    aliases: ["రూట్ కెనాల్", "रूट कैनाल"],
    durationMinutes: 60,
    priceInr: null,
  },
];
const NOW = new Date("2026-11-02T04:30:00Z"); // 10:00 IST, Monday
const BUSINESS: BusinessContext = {
  businessName: "Smile Dental",
  timeZone: "Asia/Kolkata",
  services: SERVICES,
  now: () => NOW,
};
const HOURS = ["10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00"];
const out = (s: string) => JSON.stringify(s); // tool output as the model sees it

type Script = voice.testing.FakeLLMResponse[];
const sessions: voice.AgentSession[] = [];
after(async () => {
  for (const s of sessions) await s.close();
});

async function openCall(script: Script, backend: BookingBackend, callId = "call-1") {
  const state = newConversation({ callId, callerId: "+919876543210", primaryLanguage: "en-IN" });
  const guarded: string[] = [];
  const tools: Array<{ name: string; ok: boolean }> = [];
  const agent = new ReceptionistAgent({
    business: BUSINESS,
    backend,
    state,
    onGuard: (r) => guarded.push(...r.map((x) => x.rule)),
    onTool: (t) => tools.push({ name: t.name, ok: t.ok }),
  });
  const session = new voice.AgentSession({ llm: new voice.testing.FakeLLM(script) });
  sessions.push(session);
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    const item = ev.item;
    if (item.type === "message" && item.role === "assistant") agent.recordSpoken(item.interrupted);
  });
  await session.start({ agent });
  const said: string[] = [];
  const turn = async (text: string) => {
    const r = await session.run({ userInput: text }).wait();
    const msgs = r.events
      .filter((e) => e.type === "message")
      .map((e) => (e as { item: { textContent?: string } }).item.textContent ?? "");
    said.push(...msgs);
    return { events: r.events, reply: msgs.join(" ") };
  };
  return { session, agent, state, turn, said, guarded, tools };
}

const backendWith = (o: Partial<InMemoryOptions> = {}) =>
  new InMemoryBookingBackend({
    timeZoneOffset: "+05:30",
    openHours: HOURS,
    callId: "call-1",
    ...o,
  });

const BOOKED_4PM = out("BOOKED: the booking for 4 PM is confirmed.");

/* The Smile Dental production call (2026-10-29), with a well-behaved model. */
const SMILE: Script = [
  { input: "Hello", content: "Hello! How can I help you today?" },
  { input: "నాకు అపాయింట్మెంట్ బుక్ చేయాలి", content: "తప్పకుండా. మీకు ఏ సర్వీస్ కావాలి?" },
  {
    input: "ఈరోజు ఏ టైం స్లాట్స్ అందుబాటులో ఉన్నాయి?",
    content: "ఈరోజే చూస్తాను. మీకు ఏ సర్వీస్ కావాలి?",
  },
  {
    input: "आज शाम चार बजे क्लीनिंग चाहिए",
    content: "मैं कैलेंडर देख रही हूँ।",
    toolCalls: [{ name: "check_availability", args: {} }],
  },
  {
    input: out("AVAILABLE: 4 PM is free. Ask if they want it."),
    content: "शाम 4 बजे खाली है। क्या यह समय ठीक रहेगा?",
  },
  { input: "जी हाँ", content: "आपका नाम क्या है?" },
  {
    input: "मेरा नाम धनुष है",
    content: "धन्यवाद धनुष जी। क्या हम 3210 पर खत्म होने वाला यही नंबर इस्तेमाल करें?",
  },
  {
    input: "हाँ जी, इसी नंबर पर",
    content: "क्लीनिंग, आज शाम 4 बजे, धनुष, नंबर 3210। क्या मैं इसे पक्का करूँ?",
  },
  { input: "हाँ, बुक कर दीजिए", toolCalls: [{ name: "book_appointment", args: {} }] },
  { input: BOOKED_4PM, content: "आपका अपॉइंटमेंट शाम 4 बजे के लिए बुक हो गया है।" },
];

describe("AgentSession: the Smile Dental call books for real", () => {
  test("Telugu -> Hindi, backend-confirmed booking, booked claim only after the tool", async () => {
    const backend = backendWith();
    const c = await openCall(SMILE, backend);
    for (const r of SMILE.filter((x) => !x.input.startsWith('"'))) await c.turn(r.input);
    assert.equal(c.state.booking.status, "confirmed");
    assert.equal(backend.bookings.size, 1);
    assert.equal(backend.calls.book, 1);
    assert.equal(
      c.said.findIndex((x) => /बुक हो गया/.test(x)),
      c.said.length - 1,
    );
    assert.deepEqual(c.guarded, []);
    assert.equal(c.state.language.current, "hi-IN");
    for (const k of ["service", "date", "time", "customerName", "phone"] as const)
      assert.equal(c.state[k]?.provenance, "confirmed", k);
  });
});

describe("AgentSession: what a bad model cannot do", () => {
  test("premature booking claim, invented availability, two questions -> removed", async () => {
    const backend = backendWith();
    const c = await openCall(
      [
        {
          input: "I want a cleaning tomorrow at 3 PM",
          content:
            "Your appointment is booked for 3 PM tomorrow. 3 PM is available. What's your name? And your phone number?",
        },
      ],
      backend,
    );
    const { reply } = await c.turn("I want a cleaning tomorrow at 3 PM");
    assert.equal(reply.trim(), "What's your name?");
    assert.deepEqual(c.guarded.sort(), [
      "premature_booking_claim",
      "second_question",
      "unoffered_availability",
    ]);
    assert.equal(backend.bookings.size, 0);
  });
  test("a fully unsafe reply is replaced with the safe next line", async () => {
    const c = await openCall(
      [{ input: "cleaning please", content: "Done, you're booked!" }],
      backendWith(),
    );
    assert.equal(
      (await c.turn("cleaning please")).reply.trim(),
      "Which day would you like to come in?",
    );
  });
  test("book_appointment before confirmation does nothing", async () => {
    const backend = backendWith();
    const c = await openCall(
      [
        {
          input: "book me a cleaning tomorrow at 3 PM",
          toolCalls: [{ name: "book_appointment", args: {} }],
        },
        {
          input: out("NOT_ALLOWED: no_slot_selected. Do not tell the caller it is booked."),
          content: "Let me check that time first.",
        },
      ],
      backend,
    );
    await c.turn("book me a cleaning tomorrow at 3 PM");
    assert.equal(backend.calls.book, 0);
  });
  test("prices: only the business's own price; unknown prices are never invented", async () => {
    const c = await openCall(
      [
        {
          input: "how much is a root canal",
          content: "A root canal costs ₹4,500. Would you like to book?",
        },
        { input: "how much is cleaning", toolCalls: [{ name: "get_service_price", args: {} }] },
        { input: out("PRICE: Cleaning costs ₹800."), content: "Cleaning costs ₹800." },
      ],
      backendWith(),
    );
    assert.ok(!/4,?500/.test((await c.turn("how much is a root canal")).reply));
    assert.ok(c.guarded.includes("unbacked_price"));
    assert.equal((await c.turn("how much is cleaning")).reply.trim(), "Cleaning costs ₹800.");
  });
});

/** Drives a call to the point where the caller confirmed the read-back. */
async function toFinalConfirmation(backend: BookingBackend, finals: Script, callId: string) {
  const script: Script = [
    { input: "cleaning today at 4 PM", toolCalls: [{ name: "check_availability", args: {} }] },
    {
      input: out("AVAILABLE: 4 PM is free. Ask if they want it."),
      content: "4 PM is free. Shall I take it?",
    },
    { input: "yes that one", content: "May I have your name?" },
    { input: "my name is Ravi", content: "Can I use the number ending 3210?" },
    {
      input: "yes use this number",
      content: "Cleaning today at 4 PM for Ravi on 3210. Shall I confirm?",
    },
    { input: "yes please confirm", toolCalls: [{ name: "book_appointment", args: {} }] },
    ...finals,
  ];
  const c = await openCall(script, backend, callId);
  for (const t of [
    "cleaning today at 4 PM",
    "yes that one",
    "my name is Ravi",
    "yes use this number",
  ])
    await c.turn(t);
  return c;
}

describe("AgentSession: tools, failures, retries, concurrency, calendar", () => {
  test("availability failure (STT/LLM fine, backend down): nothing claimed, retry works", async () => {
    const backend = backendWith({ failAvailability: 1 });
    const c = await openCall(
      [
        { input: "cleaning today at 4 PM", toolCalls: [{ name: "check_availability", args: {} }] },
        {
          input: out(
            "FAILED: the calendar could not be checked (calendar_unreachable). Nothing is booked. Apologise and offer to try again.",
          ),
          content: "Sorry, I couldn't reach the calendar. Shall I try again?",
        },
        { input: "yes try again", toolCalls: [{ name: "check_availability", args: {} }] },
        {
          input: out("AVAILABLE: 4 PM is free. Ask if they want it."),
          content: "4 PM is free. Shall I take it?",
        },
      ],
      backend,
    );
    await c.turn("cleaning today at 4 PM");
    assert.equal(c.state.booking.status, "failed");
    await c.turn("yes try again");
    assert.equal(backend.calls.availability, 2);
    assert.equal(c.state.booking.status, "slots_offered");
    assert.deepEqual(
      c.tools.map((t) => t.ok),
      [false, true],
    );
  });

  test("booking backend down, retried (same call + slot = same key): exactly one booking; repeat request refused", async () => {
    const backend = backendWith({ failBooking: 1 });
    const c = await toFinalConfirmation(
      backend,
      [
        {
          input: out(
            "FAILED: The booking system did not respond. Nothing is booked yet. Offer to try again.",
          ),
          content: "Sorry, nothing is booked yet. Shall I try again?",
        },
        { input: "yes try booking again", toolCalls: [{ name: "book_appointment", args: {} }] },
        { input: BOOKED_4PM, content: "You're booked for 4 PM today." },
        { input: "please book it again", toolCalls: [{ name: "book_appointment", args: {} }] },
        {
          input: out("NOT_ALLOWED: already_booked. Do not tell the caller it is booked."),
          content: "Your 4 PM booking is already in place.",
        },
      ],
      "call-1",
    );
    await c.turn("yes please confirm");
    assert.equal(c.state.booking.status, "awaiting_final_confirmation");
    await c.turn("yes try booking again");
    assert.equal(c.state.booking.status, "confirmed");
    await c.turn("please book it again");
    assert.equal(backend.bookings.size, 1);
    assert.equal(backend.calls.book, 2);
  });

  test("two callers, one slot: one booking, the other caller is told and nothing is claimed", async () => {
    const shared = backendWith();
    const finals: Script = [
      { input: BOOKED_4PM, content: "You're booked for 4 PM today." },
      {
        input: out(
          "SLOT_TAKEN: That time was just booked by someone else. Nothing is booked. Apologise and check availability again.",
        ),
        content: "Sorry, that time was just taken. Let me look for another.",
      },
    ];
    const a = await toFinalConfirmation(shared.forCall("call-a"), finals, "call-a");
    const b = await toFinalConfirmation(shared.forCall("call-b"), finals, "call-b");
    await Promise.all([a.turn("yes please confirm"), b.turn("yes please confirm")]);
    assert.deepEqual([a.state.booking.status, b.state.booking.status].sort(), [
      "confirmed",
      "none",
    ]);
    assert.equal(shared.bookings.size, 1);
    const loser = a.state.booking.status === "none" ? a : b;
    assert.ok(loser.said.at(-1)!.includes("just taken"));
    assert.ok(!loser.said.some((x) => /you're booked/i.test(x)));
  });

  test("calendar sync failure: saved and held, never claimed as confirmed", async () => {
    const backend = backendWith({ calendarSyncFails: true });
    const c = await toFinalConfirmation(
      backend,
      [
        {
          input: out(
            "SAVED_NOT_CONFIRMED: the booking for 4 PM is saved and the slot is held, but the calendar could not be updated; the team will confirm it. Do not say it is confirmed.",
          ),
          content:
            "Your booking is confirmed! It's saved for 4 PM and the team will confirm it shortly.",
        },
      ],
      "call-1",
    );
    const { reply } = await c.turn("yes please confirm");
    assert.equal(c.state.booking.status, "held_pending_sync");
    assert.ok(!/is confirmed/i.test(reply), reply);
    assert.ok(/team will confirm/i.test(reply));
    assert.ok(c.guarded.includes("premature_booking_claim"));
  });

  test("a backend that throws (timeout) is reported as a tool failure, not a crash", async () => {
    const throwing: BookingBackend = {
      checkAvailability: async () => {
        throw new Error("klyro timeout");
      },
      book: async () => {
        throw new Error("klyro timeout");
      },
    };
    const c = await openCall(
      [{ input: "cleaning today at 4 PM", toolCalls: [{ name: "check_availability", args: {} }] }],
      throwing,
    );
    await c.turn("cleaning today at 4 PM");
    assert.deepEqual(c.tools, [{ name: "check_availability", ok: false }]);
    assert.notEqual(c.state.booking.status, "confirmed");
  });

  test("concurrent calls keep separate state (no cross-call leakage)", async () => {
    const backend = backendWith();
    const scriptA: Script = [
      { input: "I need a cleaning tomorrow", content: "What time would suit you?" },
    ];
    const scriptB: Script = [
      { input: "root canal today please", content: "What time would suit you?" },
    ];
    const [a, b] = await Promise.all([
      openCall(scriptA, backend, "A"),
      openCall(scriptB, backend, "B"),
    ]);
    await Promise.all([a.turn("I need a cleaning tomorrow"), b.turn("root canal today please")]);
    assert.equal(a.state.service?.value.id, "svc-cleaning");
    assert.equal(b.state.service?.value.id, "svc-root-canal");
    assert.notEqual(a.state.date?.value, b.state.date?.value);
  });
});

describe("AgentSession: interruptions", () => {
  test("a reply cut off by the caller is not counted as asked; what was said is kept", async () => {
    const c = await openCall(
      [
        {
          input: "I need a cleaning",
          content:
            "Sure. Which day would you like to come in? We have several days open this week.",
          ttft: 50,
          duration: 3000,
        },
      ],
      backendWith(),
    );
    const run = c.session.run({ userInput: "I need a cleaning" });
    await new Promise((r) => setTimeout(r, 300));
    await c.session.interrupt();
    await run.wait();
    assert.equal(c.state.timesAsked.date, undefined);
    assert.equal(c.state.lastQuestion, null);
    assert.equal(c.state.service?.value.id, "svc-cleaning");
  });
});
