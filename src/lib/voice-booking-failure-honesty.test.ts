import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  startRuntimeSession,
  terminateRuntimeSession,
  claimsAvailability,
  claimsBookingSuccess,
  isClaimCheckableText,
  mentionsBookingInAnyScript,
  type RuntimeDeps,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ServiceRow } from "./service-matching.ts";
import type { ClaudeTool } from "./claude.server.ts";
import { callOutcomeLine } from "./voice-call-outcomes.ts";

/**
 * When a booking fails, the caller is never told it was booked — whatever
 * the model says. Every model call below MISBEHAVES: the wording model
 * (which phrases a real calendar/booking result) always answers "Great
 * news, you're all booked and confirmed!", and the conversational model
 * keeps claiming the booking too. The runtime must speak the real outcome:
 * truthful, short, and offering to try again or choose another time.
 *
 * Drives the REAL voice runtime through the deterministic harness; the
 * calendar tools are in-memory stand-ins. No network, database or calendar.
 */

const agent = (language = "en-IN"): AgentSnapshot["agent"] => ({
  agent_name: "Aria",
  persona: "professional",
  custom_personality: null,
  objectives: ["answer_questions"],
  capabilities: {},
  primary_language: language,
  extra_languages: [],
  multilingual: false,
  voice_id: "ritu",
  speaking_pace: 1,
  greetings: { [language]: "Hello, thanks for calling Smile Dental. How can I help you today?" },
  transfer_number: null,
  after_hours_behavior: "take_message",
});

const SERVICES: ServiceRow[] = [
  { id: "svc-root-canal", name: "Root Canal Treatment", duration_minutes: 30 },
];
const CALLER_ID = "+919876543210";
const DATE = "2030-10-14";
const SLOT_7PM = { start: `${DATE}T19:00:00.000Z`, end: `${DATE}T19:30:00.000Z` };
const SLOT_8PM = { start: `${DATE}T20:00:00.000Z`, end: `${DATE}T20:30:00.000Z` };
const KNOWN = {
  service: "Root Canal Treatment",
  customer_name: "Dhanush",
  preferred_date: DATE,
  preferred_time: "19:00",
};
const FALSE_SUCCESS = "Great news, you're all booked and confirmed!";
/** What the misbehaving model says, in any of its forms — must never reach the caller after a failure. */
const FALSE_SUCCESS_SPOKEN =
  /great news|all booked|you're booked|you're all set|I've booked|booked it|is confirmed|बुकिंग हो गई/i;

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
/** The conversational model, misbehaving: claims the booking every turn. */
const LYING = (state: Record<string, unknown> = {}) =>
  `${FALSE_SUCCESS}\n${marker({ ...KNOWN, ready_to_book: true, ...state })}`;

type ToolResult = { content: string; isError?: boolean };
const ok = (data: Record<string, unknown>): ToolResult => ({
  content: JSON.stringify({ success: true, data }),
});
const err = (code: string): ToolResult => ({
  content: JSON.stringify({ success: false, error: { code, message: code } }),
  isError: true,
});
const BOOKED: ToolResult = {
  content: JSON.stringify({
    success: true,
    data: { id: "booking-1", status: "CONFIRMED", startAt: SLOT_7PM.start, endAt: SLOT_7PM.end },
    bookingOutcome: "confirmed",
  }),
};

interface Script {
  /** Availability answers, in order (the last one repeats). */
  availability?: ToolResult[];
  /** book_appointment answers, in order (the last one repeats). */
  booking?: ToolResult[];
  language?: string;
  /** What the wording model says, given the facts it was handed (default: the false success claim). */
  wording?: (facts: string) => string;
  extraDeps?: Partial<RuntimeDeps>;
}

async function openCall(script: Script = {}) {
  const h = createHarness();
  const availability = script.availability ?? [ok({ slots: [SLOT_7PM, SLOT_8PM] })];
  const booking = script.booking ?? [BOOKED];
  let a = 0;
  let b = 0;
  const record = h.deps.executeTool!;
  h.deps.executeTool = async (name, toolInput, ctx) => {
    await record(name, toolInput, ctx);
    if (name === "check_calendar_availability") {
      return availability[Math.min(a++, availability.length - 1)]!;
    }
    if (name === "book_appointment") return booking[Math.min(b++, booking.length - 1)]!;
    return ok({});
  };
  const conversational = h.deps.generateReply;
  h.deps.generateReply = async (messages) =>
    /a phone receptionist\. Respond in language code/.test(messages[0]?.content ?? "")
      ? { reply: script.wording?.(messages.at(-1)?.content ?? "") ?? FALSE_SUCCESS }
      : conversational(messages);
  Object.assign(h.deps, script.extraDeps ?? {});
  const callId = `honesty-${crypto.randomUUID()}`;
  const input: StartRuntimeSessionInput = {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: "00000000-0000-0000-0000-000000000002",
    agentVersion: 3,
    instructions: "You are Aria, a helpful receptionist for Smile Dental.",
    snapshotAgent: agent(script.language),
    businessName: "Smile Dental",
    bridge: h.bridge,
    businessCountry: "IN",
    callerNumber: CALLER_ID,
    services: SERVICES,
  };
  await startRuntimeSession(input, h.deps);
  let emitted = 0;
  const turn = async (said: string, reply: string, language?: string) => {
    while (emitted < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      emitted++;
    }
    h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "final_transcript", text: said, language: language ?? "en-IN" });
    await drain();
    return h.tts.sentTexts.slice(before).join(" ");
  };
  const calls = (name: string) => h.tools.calls.filter((c) => c.name === name);
  return { h, callId, turn, calls };
}

async function drain(hops = 300) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

/** Root canal at 7 PM, caller-ID consent, name — the slot is checked and the caller asked. */
async function upToBookingQuestion(t: Awaited<ReturnType<typeof openCall>>["turn"]) {
  await t(
    "Root canal treatment today at 7 PM",
    `Sure. May I use the number you're calling from?\n${marker({ ...KNOWN, customer_name: null })}`,
  );
  await t(
    "Yes, use the number I'm calling from",
    `Thanks. May I have your name?\n${marker({ ...KNOWN, customer_name: null })}`,
  );
  const asked = await t("I am Dhanush", LYING({ ready_to_book: false }));
  // The wording model's "you're all booked" is rejected for the availability
  // result too: nothing has been booked at this point.
  assert.doesNotMatch(asked, FALSE_SUCCESS_SPOKEN, asked);
  assert.match(asked, /would you like me to book it\?/i, asked);
  return asked;
}

function assertNoFalseSuccess(spoken: string) {
  assert.doesNotMatch(spoken, FALSE_SUCCESS_SPOKEN, `claimed a booking that failed: ${spoken}`);
}

describe("a failed booking is never announced as booked, whatever the model says", () => {
  for (const code of [
    "SLOT_NO_LONGER_AVAILABLE",
    "SLOT_UNAVAILABLE",
    "CALENDAR_CONFLICT",
    "SLOT_OUTSIDE_SCHEDULE",
  ]) {
    test(`calendar conflict (${code}): 'that time was just taken' and another time offered`, async () => {
      const { callId, turn, calls } = await openCall({ booking: [err(code)] });
      await upToBookingQuestion(turn);
      const spoken = await turn("Yes, book it", LYING());
      assert.equal(calls("book_appointment").length, 1);
      assertNoFalseSuccess(spoken);
      assert.match(spoken, /that time was just taken, so I couldn't book it/i, spoken);
      assert.match(spoken, /choose another time\?/i, spoken);
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test("the slot is gone by the booking step's re-check: never booked, real alternatives offered", async () => {
    const { callId, turn, calls } = await openCall({
      availability: [ok({ slots: [SLOT_7PM, SLOT_8PM] }), ok({ slots: [SLOT_8PM] })],
    });
    await upToBookingQuestion(turn);
    const spoken = await turn("Yes, book it", LYING());
    assert.equal(calls("book_appointment").length, 0, "an unavailable slot is never booked");
    assertNoFalseSuccess(spoken);
    assert.match(spoken, /isn't available/i, spoken);
    assert.match(spoken, /8:00 PM/, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a tool error: truthful, offers to try again — and a retry rebooks the same slot exactly once", async () => {
    const { callId, turn, calls } = await openCall({ booking: [err("UNKNOWN"), BOOKED] });
    await upToBookingQuestion(turn);
    const failed = await turn("Yes, book it", LYING());
    assertNoFalseSuccess(failed);
    assert.match(failed, /the booking attempt failed on our end, so I can't confirm it/i, failed);
    assert.match(failed, /try again, or choose another time\?/i, failed);

    const retried = await turn("Yes, try again", LYING());
    assert.equal(calls("book_appointment").length, 2, "retried once");
    const [first, second] = calls("book_appointment");
    assert.equal(second!.input["startIso"], first!.input["startIso"], "same slot");
    assert.equal(second!.input["endIso"], first!.input["endIso"]);
    assert.equal(second!.ctx.callId, first!.ctx.callId, "same call → same idempotency key");
    assert.match(retried, /confirmed for/i, "only the real success is announced");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a booking timeout (the calendar never answers): never claimed, never called a failure", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { callId, turn, calls, h } = await openCall();
    await upToBookingQuestion(turn);
    const execute = h.deps.executeTool!;
    h.deps.executeTool = async (name, toolInput, ctx) =>
      name === "book_appointment"
        ? (await execute(name, toolInput, ctx), new Promise<never>(() => {}))
        : execute(name, toolInput, ctx);
    const before = h.tts.sentTexts.length;
    h.llm.setNextReply(LYING());
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "final_transcript", text: "Yes, book it", language: "en-IN" });
    await drain();
    t.mock.timers.tick(10_000); // CALENDAR_TOOL_TIMEOUT_MS
    await drain();
    const spoken = h.tts.sentTexts.slice(before).join(" ");
    assert.equal(calls("book_appointment").length, 1);
    assertNoFalseSuccess(spoken);
    assert.match(spoken, /can't tell yet whether your booking went through/i, spoken);
    assert.doesNotMatch(spoken, /couldn't (?:book|confirm)|failed/i, "not called a failure");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a reported CALENDAR_TIMEOUT error: the outcome is unknown, so it's said to be unknown", async () => {
    const { callId, turn } = await openCall({ booking: [err("CALENDAR_TIMEOUT")] });
    await upToBookingQuestion(turn);
    const spoken = await turn("Yes, book it", LYING());
    assertNoFalseSuccess(spoken);
    assert.match(spoken, /can't tell yet whether your booking went through/i, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("the calendar is unreachable at the booking step: 'haven't booked anything', retry offered", async () => {
    const { callId, turn, calls } = await openCall({
      availability: [ok({ slots: [SLOT_7PM] }), err("GOOGLE_AUTH_REQUIRED")],
    });
    await upToBookingQuestion(turn);
    const spoken = await turn("Yes, book it", LYING());
    assert.equal(calls("book_appointment").length, 0);
    assertNoFalseSuccess(spoken);
    assert.match(spoken, /I haven't booked anything/i, spoken);
    assert.match(spoken, /try again, or choose another time\?/i, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a 'success' result with no stored status is not a booking", async () => {
    const { callId, turn } = await openCall({ booking: [ok({ id: "b1" })] });
    await upToBookingQuestion(turn);
    const spoken = await turn("Yes, book it", LYING());
    assert.match(spoken, /wasn't able to complete that booking, so it isn't confirmed/i, spoken);
    assert.doesNotMatch(spoken, /great news|all booked/i, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("an invalid phone number: never claimed, only the number is asked for", async () => {
    const { callId, turn } = await openCall({ booking: [err("INVALID_PHONE")] });
    await upToBookingQuestion(turn);
    const spoken = await turn("Yes, book it", LYING());
    assertNoFalseSuccess(spoken);
    assert.match(spoken, /phone number again/i, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a Hindi caller: the wording model's 'booking ho gayi' after a failure is never spoken", async () => {
    const { callId, turn } = await openCall({
      booking: [err("SLOT_NO_LONGER_AVAILABLE")],
      wording: (facts) =>
        /\bIS available\b/.test(facts)
          ? "Good news — that time is available. Would you like me to book it?"
          : "आपकी बुकिंग हो गई है!",
    });
    await upToBookingQuestion(turn);
    const spoken = await turn("हाँ, book it", LYING(), "hi-IN");
    assert.doesNotMatch(spoken, /बुकिंग हो गई/, spoken);
    // The truthful outcome, as the runtime's own Hindi sentence (never the
    // English one, which a Hindi caller may not follow).
    assert.ok(spoken.includes(callOutcomeLine("hi-IN", "bookingSlotTaken")!), spoken);
    assert.doesNotMatch(spoken, /that time was just taken/i, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a Hindi caller: even honest-looking Hindi wording of a failure is not trusted — the runtime's sentence is spoken", async () => {
    const honest = "माफ़ कीजिए, वह समय अभी बुक नहीं हो पाया। क्या आप कोई और समय चुनना चाहेंगे?";
    const { callId, turn } = await openCall({
      booking: [err("SLOT_NO_LONGER_AVAILABLE")],
      wording: (facts) =>
        /\bIS available\b/.test(facts)
          ? "Good news — that time is available. Would you like me to book it?"
          : honest,
    });
    await upToBookingQuestion(turn);
    const spoken = await turn("हाँ, book it", LYING(), "hi-IN");
    assert.doesNotMatch(spoken, /बुक नहीं हो पाया/, spoken);
    assert.ok(spoken.includes(callOutcomeLine("hi-IN", "bookingSlotTaken")!), spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("the conversational model can't claim a booking that never happened", () => {
  test("a non-booking turn where the model says 'you're booked': replaced with where things stand", async () => {
    const { callId, turn, calls } = await openCall();
    await upToBookingQuestion(turn);
    const spoken = await turn("What's your address?", `${FALSE_SUCCESS}\n${marker(KNOWN)}`);
    assert.equal(calls("book_appointment").length, 0);
    assertNoFalseSuccess(spoken);
    assert.match(
      spoken,
      /I haven't booked anything yet\. Just to confirm — .*Shall I book it\?/,
      spoken,
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("native tool-calling: a refused book_appointment followed by 'I've booked it' is never spoken", async () => {
    const tools: ClaudeTool[] = [
      { name: "book_appointment", description: "d", input_schema: { type: "object" } },
    ];
    const { h, callId } = await openCall({
      extraDeps: {
        resolveAvailableTools: async () => tools,
        generateReplyWithTools: async (_m, _t, execute) => {
          const result = await execute("book_appointment", { startIso: SLOT_7PM.start });
          return {
            reply: "I've booked it — you're all set!",
            toolCalls: [{ name: "book_appointment", input: {}, isError: Boolean(result.isError) }],
          };
        },
      },
    });
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance("What are your opening hours?");
    await drain();
    const spoken = h.tts.sentTexts.slice(before).join(" ");
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);
    assertNoFalseSuccess(spoken);
    assert.match(spoken, /I haven't booked anything yet/i, spoken);
    assert.doesNotMatch(spoken, /try again/i, "the caller never asked to book — nothing 'failed'");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("native tool-calling: a model that claims a booking without calling any tool is corrected", async () => {
    const { h, callId } = await openCall({
      extraDeps: {
        resolveAvailableTools: async () => [
          {
            name: "check_calendar_availability",
            description: "d",
            input_schema: { type: "object" },
          },
        ],
        generateReplyWithTools: async () => ({
          reply: "Done, you're booked for 7 PM!",
          toolCalls: [],
        }),
      },
    });
    const before = h.tts.sentTexts.length;
    h.stt.speakUtterance("Can I come in at 7 PM?");
    await drain();
    const spoken = h.tts.sentTexts.slice(before).join(" ");
    assertNoFalseSuccess(spoken);
    assert.match(spoken, /I haven't booked anything yet/i, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a real booking is still announced, and later talk about it is allowed", async () => {
    const { callId, turn, calls } = await openCall();
    await upToBookingQuestion(turn);
    const booked = await turn("Yes, book it", LYING());
    assert.equal(calls("book_appointment").length, 1);
    assert.match(
      booked,
      /You're all set — your Root Canal Treatment at Smile Dental is confirmed/,
      booked,
    );
    const later = await turn(
      "Is it confirmed?",
      `Yes, your appointment is confirmed for 7 PM.\n${marker(KNOWN)}`,
    );
    assert.match(later, /confirmed for 7 PM/, later);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("claim detection", () => {
  test("claimsBookingSuccess judges each sentence on its own", () => {
    for (const claim of [
      "You're all booked!",
      "Your appointment is confirmed.",
      "Sorry I couldn't check earlier. But you're booked for 7 PM!",
      "I've reserved that slot for you.",
      "आपकी बुकिंग कन्फर्म है।",
      "Booking ho gayi, book ho gaya.",
    ]) {
      assert.equal(claimsBookingSuccess(claim), true, claim);
    }
    for (const honest of [
      "I couldn't book that.",
      "It isn't confirmed yet.",
      "I haven't booked anything yet. Shall I book it?",
      "That time was just taken, so I couldn't book it.",
      "वह समय बुक नहीं हो पाया।",
      "Would you like me to try again?",
    ]) {
      assert.equal(claimsBookingSuccess(honest), false, honest);
    }
  });

  test("claimsAvailability", () => {
    assert.equal(claimsAvailability("Good news — 7 PM is available."), true);
    assert.equal(claimsAvailability("That time isn't available."), false);
    assert.equal(claimsAvailability("I couldn't reach the calendar."), false);
  });
});

/**
 * Languages the runtime can't reliably check. The voice agent supports
 * English plus ten Indian languages (agent-instructions.ts,
 * SUPPORTED_VOICE_LANGUAGES). Only English text (Latin script) can be
 * checked for a false "you're booked"; for every other language, when
 * nothing was booked, model wording is never trusted — the runtime speaks
 * its own sentence instead.
 */
const UNCHECKED_LANGUAGES: { code: string; name: string; falseClaim: string; neutral: string }[] = [
  {
    code: "hi-IN",
    name: "Hindi",
    falseClaim: "आपकी अपॉइंटमेंट बुक हो गई है!",
    neutral: "हमारा क्लिनिक सुबह नौ बजे खुलता है।",
  },
  {
    code: "bn-IN",
    name: "Bengali",
    falseClaim: "আপনার অ্যাপয়েন্টমেন্ট বুক হয়ে গেছে!",
    neutral: "আমাদের ক্লিনিক সকাল নটায় খোলে।",
  },
  {
    code: "ta-IN",
    name: "Tamil",
    falseClaim: "உங்கள் அப்பாயிண்ட்மெண்ட் புக் ஆகிவிட்டது!",
    neutral: "எங்கள் கிளினிக் காலை ஒன்பது மணிக்கு திறக்கும்.",
  },
  {
    code: "te-IN",
    name: "Telugu",
    falseClaim: "మీ అపాయింట్‌మెంట్ బుక్ అయింది!",
    neutral: "మా క్లినిక్ ఉదయం తొమ్మిది గంటలకు తెరుస్తారు.",
  },
  {
    code: "gu-IN",
    name: "Gujarati",
    falseClaim: "તમારી એપોઇન્ટમેન્ટ બુક થઈ ગઈ છે!",
    neutral: "અમારું ક્લિનિક સવારે નવ વાગ્યે ખુલે છે.",
  },
  {
    code: "kn-IN",
    name: "Kannada",
    falseClaim: "ನಿಮ್ಮ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಬುಕ್ ಆಗಿದೆ!",
    neutral: "ನಮ್ಮ ಕ್ಲಿನಿಕ್ ಬೆಳಿಗ್ಗೆ ಒಂಬತ್ತು ಗಂಟೆಗೆ ತೆರೆಯುತ್ತದೆ.",
  },
  {
    code: "ml-IN",
    name: "Malayalam",
    falseClaim: "നിങ്ങളുടെ അപ്പോയിന്റ്മെന്റ് ബുക്ക് ചെയ്തു!",
    neutral: "ഞങ്ങളുടെ ക്ലിനിക് രാവിലെ ഒമ്പത് മണിക്ക് തുറക്കും.",
  },
  {
    code: "mr-IN",
    name: "Marathi",
    falseClaim: "तुमची अपॉइंटमेंट बुक झाली आहे!",
    neutral: "आमचे क्लिनिक सकाळी नऊ वाजता उघडते.",
  },
  {
    code: "pa-IN",
    name: "Punjabi",
    falseClaim: "ਤੁਹਾਡੀ ਅਪੌਇੰਟਮੈਂਟ ਬੁੱਕ ਹੋ ਗਈ ਹੈ!",
    neutral: "ਸਾਡਾ ਕਲੀਨਿਕ ਸਵੇਰੇ ਨੌਂ ਵਜੇ ਖੁੱਲ੍ਹਦਾ ਹੈ।",
  },
  {
    code: "od-IN",
    name: "Odia",
    falseClaim: "ଆପଣଙ୍କ ଆପଏଣ୍ଟମେଣ୍ଟ ବୁକ ହୋଇଗଲା!",
    neutral: "ଆମ କ୍ଲିନିକ ସକାଳ ନଅଟାରେ ଖୋଲେ।",
  },
];

describe("languages the runtime can't check: model wording never reports an unsuccessful booking", () => {
  for (const lang of UNCHECKED_LANGUAGES) {
    test(`${lang.name}: a failed booking worded by the model as a success is never spoken`, async () => {
      const { callId, turn, calls } = await openCall({
        booking: [err("SLOT_NO_LONGER_AVAILABLE")],
        wording: (facts) =>
          /\bIS available\b/.test(facts)
            ? "Good news — that time is available. Would you like me to book it?"
            : lang.falseClaim,
      });
      await upToBookingQuestion(turn);
      const spoken = await turn("Yes, book it", LYING(), lang.code);
      assert.equal(calls("book_appointment").length, 1);
      assert.ok(!spoken.includes(lang.falseClaim), `${lang.name} false claim spoken: ${spoken}`);
      assert.ok(
        spoken.includes(callOutcomeLine(lang.code, "bookingSlotTaken")!),
        `${lang.name}: expected the runtime's own sentence in ${lang.name}: ${spoken}`,
      );
      await terminateRuntimeSession(callId, "test cleanup");
    });

    test(`${lang.name}: a conversational reply claiming a booking that never happened is replaced`, async () => {
      const { callId, turn, calls } = await openCall();
      await upToBookingQuestion(turn);
      const spoken = await turn(
        "Do you have parking?",
        `${lang.falseClaim}\n${marker(KNOWN)}`,
        lang.code,
      );
      assert.equal(calls("book_appointment").length, 0);
      assert.ok(!spoken.includes(lang.falseClaim), `${lang.name} false claim spoken: ${spoken}`);
      // Every detail is known, so the runtime's own summary reads them back
      // and asks to book (a question a bare "yes" can answer).
      const readBack = callOutcomeLine(lang.code, "confirmBooking", {
        service: KNOWN.service,
        date: KNOWN.preferred_date,
        time: KNOWN.preferred_time,
        customerName: KNOWN.customer_name,
      })!;
      assert.ok(
        spoken.includes(readBack),
        `${lang.name}: expected the runtime's own sentence in ${lang.name}: ${spoken}`,
      );
      await terminateRuntimeSession(callId, "test cleanup");
    });

    test(`${lang.name}: an ordinary reply with no booking in it is still spoken as written`, async () => {
      const { callId, turn } = await openCall();
      const spoken = await turn("When do you open?", lang.neutral, lang.code);
      assert.ok(spoken.includes(lang.neutral), `${lang.name} ordinary reply replaced: ${spoken}`);
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test("Telugu: a claim using no booking word, on a turn where the model proposed booking, is still replaced", async () => {
    const { callId, turn, calls } = await openCall();
    await upToBookingQuestion(turn);
    // "Everything is ready!" — no booking vocabulary, but the model's own
    // state block says ready_to_book while the caller confirmed nothing.
    const spoken = await turn(
      "Do you have parking?",
      `అంతా సిద్ధం!\n${marker({ ...KNOWN, ready_to_book: true })}`,
      "te-IN",
    );
    assert.equal(calls("book_appointment").length, 0);
    assert.ok(!spoken.includes("అంతా సిద్ధం"), spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("Telugu: a model reply in Telugu script is never trusted even when the detected language says English", async () => {
    const { callId, turn } = await openCall();
    await upToBookingQuestion(turn);
    const spoken = await turn(
      "Do you have parking?",
      `మీ అపాయింట్‌మెంట్ బుక్ అయింది!\n${marker(KNOWN)}`,
      "en-IN",
    );
    assert.ok(!spoken.includes("బుక్ అయింది"), spoken);
    assert.match(spoken, /I haven't booked anything yet/i, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("Telugu: after a REAL booking, the runtime's own Telugu confirmation is spoken — not the model's unchecked wording", async () => {
    const { callId, turn, calls } = await openCall({
      wording: (facts) =>
        /\bIS available\b/.test(facts)
          ? "Good news — that time is available. Would you like me to book it?"
          : /booking succeeded/i.test(facts)
            ? "మీ అపాయింట్‌మెంట్ బుక్ అయింది. ఇంకేమైనా సహాయం కావాలా?"
            : FALSE_SUCCESS,
    });
    await upToBookingQuestion(turn);
    const spoken = await turn("Yes, book it", LYING(), "te-IN");
    assert.equal(calls("book_appointment").length, 1);
    assert.match(spoken, /నిర్ధారణ అయింది/, spoken);
    assert.doesNotMatch(spoken, /బుక్ అయింది/, "the model's wording is not used");
    assert.match(spoken, /ఇంకేమైనా సహాయం కావాలా\?/, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("Hinglish in Latin script is checked: 'aapki booking ho gayi' after a failure is rejected", async () => {
    const { callId, turn } = await openCall();
    await upToBookingQuestion(turn);
    // "Parking hai kya?" is romanized Hindi: the call is now answered in
    // Hindi, and the Latin-script claim is still caught on a Hindi call.
    const spoken = await turn("Parking hai kya?", `Aapki booking ho gayi hai!\n${marker(KNOWN)}`);
    assert.doesNotMatch(spoken, /booking ho gayi/i, spoken);
    assert.match(spoken, /क्या यह अपॉइंटमेंट बुक कर दूँ\?/, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("which text the runtime can check", () => {
    assert.equal(isClaimCheckableText("You're all set — ₹5,000, 7 PM."), true);
    assert.equal(isClaimCheckableText("Aapki booking ho gayi hai"), true);
    for (const lang of UNCHECKED_LANGUAGES) {
      assert.equal(isClaimCheckableText(lang.falseClaim), false, lang.name);
      assert.equal(mentionsBookingInAnyScript(lang.falseClaim), true, lang.name);
      assert.equal(mentionsBookingInAnyScript(lang.neutral), false, lang.name);
    }
  });
});

/* ------------------------------------------------------------------ */
/* A booking request that timed out: reconciled, never guessed         */
/* ------------------------------------------------------------------ */

type Call = Awaited<ReturnType<typeof openCall>>;

/** book_appointment that answers only when the test says so (recorded as called). */
function heldBookingRequest(h: Harness) {
  let settle: (result: ToolResult) => void = () => {};
  const execute = h.deps.executeTool!;
  h.deps.executeTool = async (name, toolInput, ctx) => {
    const answer = await execute(name, toolInput, ctx);
    if (name !== "book_appointment") return answer;
    return new Promise<ToolResult>((resolve) => {
      settle = resolve;
    });
  };
  return { settle: (result: ToolResult) => settle(result) };
}

/** Every TTS chunk reported delivered, so the caller is only listening. */
function audioFinished(h: Harness) {
  for (let i = 0; i < h.tts.sentTexts.length; i++) h.tts.emit({ type: "flushed" });
}

/** Up to the booking question, then "Yes, book it" while book_appointment hangs past its deadline. */
async function bookingThatTimesOut(
  t: { mock: { timers: { tick: (ms: number) => void } } },
  call: Call,
) {
  await upToBookingQuestion(call.turn);
  audioFinished(call.h);
  const before = call.h.tts.sentTexts.length;
  call.h.llm.setNextReply(LYING());
  call.h.stt.emit({ type: "speech_start" });
  call.h.stt.emit({ type: "final_transcript", text: "Yes, book it", language: "en-IN" });
  await drain();
  t.mock.timers.tick(10_000); // CALENDAR_TOOL_TIMEOUT_MS
  await drain();
  const spoken = call.h.tts.sentTexts.slice(before).join(" ");
  assert.match(spoken, /can't tell yet whether your booking went through/i, spoken);
  audioFinished(call.h);
  return spoken;
}

describe("a booking request that timed out is reconciled before anything else is said or booked", () => {
  test("it succeeds after the deadline: the caller is told it is confirmed, and it is this call's booking", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const call = await openCall();
    const request = heldBookingRequest(call.h);
    await bookingThatTimesOut(t, call);
    const before = call.h.tts.sentTexts.length;
    request.settle(BOOKED);
    await drain();
    const late = call.h.tts.sentTexts.slice(before).join(" ");
    assert.match(late, /now heard back: your Root Canal Treatment for .* is confirmed/i, late);
    assert.equal(call.calls("book_appointment").length, 1, "one booking request, never two");
    // Asking to book that slot again (different words: the same words within
    // two seconds are dropped as one transcript, and would prove nothing)
    // reaches the booking path — and hears the outcome already known for the
    // slot: no second request, and no fresh availability check that would
    // now find the slot taken by this very booking.
    const checksBefore = call.calls("check_calendar_availability").length;
    audioFinished(call.h);
    const again = await call.turn("Please book it for me", LYING());
    assert.match(again, /is confirmed/i, again);
    assert.doesNotMatch(again, /isn't available/i, again);
    assert.equal(call.calls("book_appointment").length, 1);
    assert.equal(call.calls("check_calendar_availability").length, checksBefore);
    await terminateRuntimeSession(call.callId, "test cleanup");
    assert.equal(call.h.persistence.records[0]?.outcome, "booked");
  });

  test("it fails after the deadline: the caller is told nothing was booked", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const call = await openCall();
    const request = heldBookingRequest(call.h);
    await bookingThatTimesOut(t, call);
    const before = call.h.tts.sentTexts.length;
    request.settle(err("SLOT_NO_LONGER_AVAILABLE"));
    await drain();
    const late = call.h.tts.sentTexts.slice(before).join(" ");
    assert.match(late, /the booking didn't go through, so nothing is booked/i, late);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });

  test("while it is unresolved, no second booking request is made — even for the same slot", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const call = await openCall();
    heldBookingRequest(call.h);
    await bookingThatTimesOut(t, call);
    // Different words: the same words within two seconds are one transcript.
    const reply = await call.turn("Yes please, go ahead and book it", LYING());
    assert.match(reply, /still checking whether your earlier booking went through/i, reply);
    assertNoFalseSuccess(reply);
    assert.equal(call.calls("book_appointment").length, 1);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });

  test("the request never answers: the stored row is found by its idempotency key, for this tenant only", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const lookups: { organizationId: string; businessId: string; idempotencyKey: string }[] = [];
    const call = await openCall({
      extraDeps: {
        findBookingByIdempotencyKey: async (query) => {
          lookups.push(query);
          return { id: "booking-1", status: "CONFIRMED", startAt: SLOT_7PM.start };
        },
      },
    });
    heldBookingRequest(call.h);
    await bookingThatTimesOut(t, call);
    assert.equal(lookups.length, 0, "not looked up before the reconciliation delay");
    const before = call.h.tts.sentTexts.length;
    t.mock.timers.tick(15_000); // BOOKING_RECONCILE_MS (the silence check-in came at 12 s)
    await drain();
    // Held while the check-in is still playing; said once it has finished.
    audioFinished(call.h);
    t.mock.timers.tick(500);
    await drain();
    assert.deepEqual(lookups, [
      {
        organizationId: "00000000-0000-0000-0000-000000000000",
        businessId: "00000000-0000-0000-0000-000000000001",
        idempotencyKey: `voice:${call.callId}:${SLOT_7PM.start}:${SLOT_7PM.end}`,
      },
    ]);
    const late = call.h.tts.sentTexts.slice(before).join(" ");
    assert.match(late, /is confirmed/i, late);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });

  test("still nothing after every lookup: said to be unknown, and nothing else is booked on this call", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let lookups = 0;
    const call = await openCall({
      extraDeps: {
        findBookingByIdempotencyKey: async () => {
          lookups++;
          return null;
        },
      },
    });
    heldBookingRequest(call.h);
    await bookingThatTimesOut(t, call);
    const before = call.h.tts.sentTexts.length;
    t.mock.timers.tick(15_000);
    await drain();
    assert.equal(lookups, 1);
    assert.doesNotMatch(
      call.h.tts.sentTexts.slice(before).join(" "),
      /booking|confirm/i,
      "'not found yet' is not an answer",
    );
    audioFinished(call.h);
    t.mock.timers.tick(15_000);
    await drain();
    assert.equal(lookups, 2);
    audioFinished(call.h);
    t.mock.timers.tick(500);
    await drain();
    const late = call.h.tts.sentTexts.slice(before).join(" ");
    assert.match(late, /still can't confirm whether the booking went through/i, late);
    assertNoFalseSuccess(late);
    audioFinished(call.h);
    const again = await call.turn("Book it for me please", LYING());
    assert.match(again, /still can't confirm/i, again);
    assert.equal(call.calls("book_appointment").length, 1);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });

  test("the call ends first: a late answer says nothing into an ended call", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const call = await openCall();
    const request = heldBookingRequest(call.h);
    await bookingThatTimesOut(t, call);
    await terminateRuntimeSession(call.callId, "test cleanup");
    const before = call.h.tts.sentTexts.length;
    request.settle(BOOKED);
    await drain();
    t.mock.timers.tick(60_000);
    await drain();
    assert.equal(call.h.tts.sentTexts.length, before, "nothing spoken after the call ended");
  });

  test("Telugu: the unresolved booking is described in Telugu, not as a failure", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const call = await openCall({ language: "te-IN" });
    heldBookingRequest(call.h);
    await upToBookingQuestion(call.turn);
    audioFinished(call.h);
    const before = call.h.tts.sentTexts.length;
    call.h.llm.setNextReply(LYING());
    call.h.stt.emit({ type: "speech_start" });
    call.h.stt.emit({ type: "final_transcript", text: "అవును, బుక్ చేయండి", language: "te-IN" });
    await drain();
    t.mock.timers.tick(10_000);
    await drain();
    const spoken = call.h.tts.sentTexts.slice(before).join(" ");
    assert.ok(
      spoken.includes(callOutcomeLine("te-IN", "bookingUnresolved")!),
      `Telugu unresolved line: ${spoken}`,
    );
    await terminateRuntimeSession(call.callId, "test cleanup");
  });
});

/* ------------------------------------------------------------------ */
/* Turn deadline, changed slots, outcomes, quiet-line announcements     */
/* ------------------------------------------------------------------ */

/** Captures structured log lines (event name and fields) while `fn` runs. */
async function captureLogs(
  fn: () => Promise<void>,
): Promise<{ event: string; fields: Record<string, unknown> }[]> {
  const lines: { event: string; fields: Record<string, unknown> }[] = [];
  const original = console.info;
  console.info = (event: unknown, fields?: unknown) => {
    if (typeof event === "string") {
      lines.push({ event, fields: (fields ?? {}) as Record<string, unknown> });
    }
  };
  try {
    await fn();
  } finally {
    console.info = original;
  }
  return lines;
}

describe("the turn runs out of time while a booking request is still running", () => {
  const tools: ClaudeTool[] = [
    { name: "book_appointment", description: "d", input_schema: { type: "object" } },
  ];

  test("no generic error: the outcome is reconciled, nothing else is booked, and the late success is announced", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let attempt = 0;
    const toolResults: string[] = [];
    const call = await openCall({
      extraDeps: {
        resolveAvailableTools: async () => tools,
        generateReplyWithTools: async (_messages, _tools, execute) => {
          attempt++;
          if (attempt === 1) {
            return { reply: "Root canal at 7 PM for Dhanush. Shall I book it?", toolCalls: [] };
          }
          // The model is slow (20 s), then the booking request outlives the
          // rest of the 25-second turn deadline.
          await new Promise((resolve) => setTimeout(resolve, 20_000));
          const result = await execute("book_appointment", {
            startIso: SLOT_7PM.start,
            endIso: SLOT_7PM.end,
          });
          toolResults.push(result.content);
          return {
            reply: "Booked.",
            toolCalls: [{ name: "book_appointment", input: {}, isError: false }],
          };
        },
      },
    });
    const request = heldBookingRequest(call.h);
    await call.turn("Root canal at 7 PM please", "unused");
    audioFinished(call.h);
    const before = call.h.tts.sentTexts.length;
    call.h.stt.emit({ type: "speech_start" });
    call.h.stt.emit({ type: "final_transcript", text: "Yes", language: "en-IN" });
    await drain();
    t.mock.timers.tick(20_000); // the model answers and calls book_appointment
    await drain();
    assert.equal(call.calls("book_appointment").length, 1, "the request is running");
    t.mock.timers.tick(5_000); // TURN_DEADLINE_MS (25 s) passes first
    await drain();
    const spoken = call.h.tts.sentTexts.slice(before).join(" ");
    assert.match(spoken, /can't tell yet whether your booking went through/i, spoken);
    assert.doesNotMatch(spoken, /something went wrong/i, "never the generic error");
    assertNoFalseSuccess(spoken);

    // While unresolved, another booking is refused before it reaches the booking layer.
    audioFinished(call.h);
    await call.turn("Yes please, book it now", "unused");
    t.mock.timers.tick(20_000);
    await drain();
    assert.equal(call.calls("book_appointment").length, 1, "no second booking request");
    assert.match(toolResults.at(-1) ?? "", /BOOKING_OUTCOME_PENDING/);

    // The original request now succeeds: told, recorded, once.
    audioFinished(call.h);
    const lateFrom = call.h.tts.sentTexts.length;
    request.settle(BOOKED);
    await drain();
    audioFinished(call.h);
    t.mock.timers.tick(500);
    await drain();
    assert.match(call.h.tts.sentTexts.slice(lateFrom).join(" "), /is confirmed/i);
    await terminateRuntimeSession(call.callId, "test cleanup");
    assert.equal(call.h.persistence.records[0]?.outcome, "booked");
  });
});

describe("a late result never overwrites what the caller asked for since", () => {
  test("the caller moved to 8 PM while 7 PM was unresolved: told 7 PM is booked, 8 PM stays their request", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const call = await openCall();
    const request = heldBookingRequest(call.h);
    await bookingThatTimesOut(t, call);
    await call.turn(
      "Actually, make it 8 PM instead",
      `Okay.\n${marker({ ...KNOWN, preferred_time: "20:00" })}`,
    );
    audioFinished(call.h);
    const before = call.h.tts.sentTexts.length;
    const logs = await captureLogs(async () => {
      request.settle(BOOKED);
      await drain();
      audioFinished(call.h);
      t.mock.timers.tick(500);
      await drain();
    });
    const late = call.h.tts.sentTexts.slice(before).join(" ");
    assert.match(late, /7:00 PM is confirmed|7 PM is confirmed|at 7:00 PM/i, late);
    assert.ok(logs.some((l) => l.event === "voice_runtime:late_booking_slot_differs"));
    await call.turn(
      "Do you have parking?",
      `Yes.\n${marker({ ...KNOWN, preferred_time: "20:00" })}`,
    );
    const known = (call.h.llm.calls.at(-1) ?? [])
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    assert.match(known, /preferred time: 20:00/, "the newer request is kept");
    await terminateRuntimeSession(call.callId, "test cleanup");
    assert.equal(call.h.persistence.records[0]?.outcome, "booked", "7 PM really is held");
  });
});

describe("the call outcome counts only bookings that are really held", () => {
  const PENDING: ToolResult = {
    content: JSON.stringify({
      success: true,
      data: { id: "booking-p", status: "PENDING_CONFIRMATION", startAt: SLOT_7PM.start },
      bookingOutcome: "pending",
    }),
  };
  for (const [name, booking, expected] of [
    ["confirmed", [BOOKED], "booked"],
    ["pending confirmation", [PENDING], "completed"],
    ["failed", [err("UNKNOWN")], "completed"],
    ["timed out, unresolved", [err("CALENDAR_TIMEOUT")], "booking_unresolved"],
  ] as const) {
    test(`${name} → ${expected}`, async () => {
      const call = await openCall({ booking: [...booking] });
      await upToBookingQuestion(call.turn);
      await call.turn("Yes, book it", LYING());
      await terminateRuntimeSession(call.callId, "call ended: completed");
      assert.equal(call.h.persistence.records[0]?.outcome, expected);
    });
  }
});

describe("a late booking result never talks over the caller", () => {
  test("the caller starts speaking just before the result arrives: it waits, then comes first in the reply", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const call = await openCall();
    const request = heldBookingRequest(call.h);
    await bookingThatTimesOut(t, call);
    call.h.stt.emit({ type: "speech_start" }); // the caller is talking
    const before = call.h.tts.sentTexts.length;
    request.settle(BOOKED);
    await drain();
    t.mock.timers.tick(2_000);
    await drain();
    assert.equal(call.h.tts.sentTexts.length, before, "nothing said over the caller");
    call.h.llm.setNextReply(`Yes, there's parking.\n${marker(KNOWN)}`);
    call.h.stt.emit({
      type: "final_transcript",
      text: "Is there parking nearby?",
      language: "en-IN",
    });
    await drain();
    const reply = call.h.tts.sentTexts.slice(before).join(" ");
    assert.match(
      reply,
      /is confirmed[\s\S]*parking/i,
      `the result first, then the answer: ${reply}`,
    );
    await terminateRuntimeSession(call.callId, "test cleanup");
  });
});

describe("nothing is booked, moved or asked after the call ends", () => {
  test("a booking confirmation delivered after termination: no model call, no tool call", async () => {
    const call = await openCall();
    await upToBookingQuestion(call.turn);
    await terminateRuntimeSession(call.callId, "call ended: completed");
    const llm = call.h.llm.calls.length;
    const tools = call.h.tools.calls.length;
    call.h.stt.emit({ type: "speech_start" });
    call.h.stt.emit({ type: "final_transcript", text: "Yes, book it", language: "en-IN" });
    await drain();
    assert.equal(call.h.llm.calls.length, llm, "no model call");
    assert.equal(call.h.tools.calls.length, tools, "no calendar or booking call");
  });

  test("a turn already running when the call ends: its booking call is refused", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const tools: ClaudeTool[] = [
      { name: "book_appointment", description: "d", input_schema: { type: "object" } },
    ];
    let attempt = 0;
    const results: string[] = [];
    const call = await openCall({
      extraDeps: {
        resolveAvailableTools: async () => tools,
        generateReplyWithTools: async (_m, _t, execute) => {
          attempt++;
          if (attempt === 1) return { reply: "7 PM for Dhanush. Shall I book it?", toolCalls: [] };
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          const result = await execute("book_appointment", {
            startIso: SLOT_7PM.start,
            endIso: SLOT_7PM.end,
          });
          results.push(result.content);
          return { reply: "Booked.", toolCalls: [] };
        },
      },
    });
    await call.turn("Root canal at 7 PM please", "unused");
    call.h.stt.emit({ type: "speech_start" });
    call.h.stt.emit({ type: "final_transcript", text: "Yes", language: "en-IN" });
    await drain();
    await terminateRuntimeSession(call.callId, "call ended: completed");
    t.mock.timers.tick(5_000);
    await drain();
    assert.equal(call.calls("book_appointment").length, 0, "never reached the booking layer");
    assert.match(results[0] ?? "", /CALL_ENDED/);
  });

  test("a reschedule asked for while a booking is unresolved: nothing is looked up or moved", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let lookups = 0;
    const call = await openCall({
      extraDeps: {
        findCallerBookings: async () => {
          lookups++;
          return [];
        },
      },
    });
    heldBookingRequest(call.h);
    await bookingThatTimesOut(t, call);
    const reply = await call.turn("Can I reschedule my appointment?", LYING());
    assert.match(reply, /still checking whether your earlier booking went through/i, reply);
    assert.equal(lookups, 0, "no booking looked up to move");
    assert.equal(call.calls("reschedule_appointment").length, 0);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });
});

describe("booking failures are logged by code, never by message", () => {
  test("a booking request that throws after the deadline: the log carries the error class, not its text", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const call = await openCall();
    let fail: (e: Error) => void = () => {};
    const execute = call.h.deps.executeTool!;
    call.h.deps.executeTool = async (name, toolInput, ctx) => {
      const answer = await execute(name, toolInput, ctx);
      if (name !== "book_appointment") return answer;
      return new Promise<ToolResult>((_resolve, reject) => {
        fail = reject;
      });
    };
    await bookingThatTimesOut(t, call);
    const logs = await captureLogs(async () => {
      fail(new TypeError("customer 9876543210 Dhanush could not be saved"));
      await drain();
    });
    const line = logs.find((l) => l.event === "voice_runtime:booking_late_request_failed");
    assert.ok(line, "the failure is logged");
    assert.equal(line!.fields["error"], "TypeError");
    assert.doesNotMatch(JSON.stringify(line!.fields), /9876543210|Dhanush/);
    await terminateRuntimeSession(call.callId, "test cleanup");
  });
});
