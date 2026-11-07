import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  callerAuthorizesBooking,
  chunkIntoSentences,
  textForSpeech,
  startRuntimeSession,
  terminateRuntimeSession,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { normalizeSttMessage } from "./sarvam-realtime.server.ts";
import { withCurrentLanguageSection } from "./agent-instructions.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import {
  callOutcomeLine,
  anythingElseQuestion,
  callerBookingIntentAnyLanguage,
} from "./voice-call-outcomes.ts";
import { FALLBACK_MESSAGES } from "./voice-fallback-messages.ts";
import { MISSING_DETAIL_QUESTION } from "./voice-intent-lexicon.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ServiceRow } from "./service-matching.ts";
import type { CallerBooking } from "./calendar/caller-bookings.server.ts";

/**
 * Booking, rescheduling and call-closing outcomes on non-English calls, end
 * to end through the real runtime: what the caller actually hears, which
 * TTS voice said it, and what the transcript records — never the model's
 * unchecked wording, and never English to a caller speaking another
 * language.
 *
 * Voice attribution: the fake TTS records every chunk in one list across
 * connections, so trackVoices notes where each successful (re)connection
 * took over. The runtime only ever forwards the ACTIVE connection's audio
 * (stale connections are dropped — voice-runtime.server.ts onTtsEvent), so
 * every chunk after a takeover point was said by that voice.
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
  { id: "svc-root-canal", name: "Root Canal Treatment", duration_minutes: 30 },
];
const CALLER = "+919876543210";
const DATE = "2030-10-14";
const SLOT_7PM = { start: `${DATE}T19:00:00.000Z`, end: `${DATE}T19:30:00.000Z` };
const SLOT_8PM = { start: `${DATE}T20:00:00.000Z`, end: `${DATE}T20:30:00.000Z` };
const KNOWN = {
  service: "Root Canal Treatment",
  customer_name: "Dhanush",
  preferred_date: DATE,
  preferred_time: "19:00",
};

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
/** The model claims success and asks to book; only the stored outcome may be spoken. */
const LYING = `Great news, you're all booked and confirmed!\n${marker({ ...KNOWN, ready_to_book: true })}`;

async function drain(hops = 300) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

/** Where each successful TTS (re)connection took over, by index into the spoken-chunk list. */
function trackVoices(h: Harness): { voice: string; from: number }[] {
  const takeovers: { voice: string; from: number }[] = [];
  const connect = h.deps.connectTts;
  h.deps.connectTts = async (opts) => {
    const session = await connect(opts);
    takeovers.push({ voice: opts.language, from: h.tts.sentTexts.length });
    return session;
  };
  return takeovers;
}

/** Chunks [from, to) with the voice that said each one. */
function spokenWithVoices(
  h: Harness,
  takeovers: { voice: string; from: number }[],
  from: number,
): { voice: string; text: string }[] {
  return h.tts.sentTexts.slice(from).map((text, i) => {
    const index = from + i;
    const owner = [...takeovers].reverse().find((t) => t.from <= index);
    return { voice: owner?.voice ?? "unknown", text };
  });
}

const joined = (chunks: { text: string }[]) =>
  chunks
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ");
const squash = (s: string) => s.replace(/\s+/g, " ");

interface BookingScript {
  availability?: ToolResult[];
  booking?: ToolResult[];
  /** The separate phrasing model (composeHonestBookingReply) — counted, and may throw. */
  wording?: (facts: string) => string;
  /** The instructions the call starts with (routeToAgentRuntime's output). */
  instructions?: string;
}

async function openBookingCall(script: BookingScript = {}) {
  const h = createHarness();
  const takeovers = trackVoices(h);
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
  let phrasingCalls = 0;
  const conversational = h.deps.generateReply;
  h.deps.generateReply = async (messages) => {
    if (/a phone receptionist\. Respond in language code/.test(messages[0]?.content ?? "")) {
      phrasingCalls++;
      const wording =
        script.wording ??
        ((facts: string) =>
          /\bIS available\b/.test(facts)
            ? "Good news — that time is available. Would you like me to book it?"
            : "Great news, you're all booked and confirmed!");
      return { reply: wording(messages.at(-1)?.content ?? "") };
    }
    return conversational(messages);
  };
  const callId = `outcomes-${crypto.randomUUID()}`;
  const input: StartRuntimeSessionInput = {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: "00000000-0000-0000-0000-000000000002",
    agentVersion: 3,
    instructions: script.instructions ?? "You are Aria, a helpful receptionist for Smile Dental.",
    snapshotAgent: agent,
    businessName: "Smile Dental",
    bridge: h.bridge,
    businessCountry: "IN",
    callerNumber: CALLER,
    services: SERVICES,
  };
  await startRuntimeSession(input, h.deps);
  let emitted = 0;
  /** One caller turn from a raw Sarvam realtime STT message, through the real normalizeSttMessage. */
  const rawTurn = async (raw: Record<string, unknown>, reply: string) => {
    while (emitted < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      emitted++;
    }
    h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.emit({ type: "speech_start" });
    h.stt.emit(normalizeSttMessage(raw));
    await drain();
    return spokenWithVoices(h, takeovers, before);
  };
  /** One caller turn; returns what was spoken during it, chunk by chunk, with its voice. */
  const turn = async (said: string, reply: string, language = "en-IN") => {
    while (emitted < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      emitted++;
    }
    h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "final_transcript", text: said, language, languageConfidence: 0.95 });
    await drain();
    return spokenWithVoices(h, takeovers, before);
  };
  const calls = (name: string) => h.tools.calls.filter((c) => c.name === name);
  const transcript = () => h.persistence.records.at(-1)?.turns.map((t) => t.text) ?? [];
  return { h, callId, turn, rawTurn, calls, transcript, phrasingCalls: () => phrasingCalls };
}

/** English set-up: root canal tonight at 7 PM, caller-ID consent, name — the slot is offered. */
async function upToBookingQuestion(turn: Awaited<ReturnType<typeof openBookingCall>>["turn"]) {
  await turn(
    "Root canal treatment today at 7 PM",
    `Sure. May I use the number you're calling from?\n${marker({ ...KNOWN, customer_name: null })}`,
  );
  await turn(
    "Yes, use the number I'm calling from",
    `Thanks. May I have your name?\n${marker({ ...KNOWN, customer_name: null })}`,
  );
  // The completed details trigger the real availability check, which asks
  // the caller whether to book (the question a bare "yes" can answer).
  const asked = await turn("I am Dhanush", `Thanks.\n${marker({ ...KNOWN })}`);
  assert.match(joined(asked), /would you like me to book it\?/i, joined(asked));
}

describe("booking outcomes in the caller's language, by the matching voice", () => {
  test("Hindi: a real booking is confirmed with the stored date and time, in Hindi, by the Hindi voice", async () => {
    const { callId, turn, calls, transcript, phrasingCalls } = await openBookingCall();
    await upToBookingQuestion(turn);
    const phrasingBefore = phrasingCalls();
    const chunks = await turn("हाँ, बुक कर दो प्लीज़", LYING, "hi-IN");

    assert.equal(calls("book_appointment").length, 1);
    const expected = callOutcomeLine("hi-IN", "bookingConfirmed", {
      service: "Root Canal Treatment",
      date: DATE,
      time: "19:00",
    })!;
    const said = joined(chunks);
    assert.ok(said.includes(squash(expected)), said);
    assert.ok(said.includes(squash(anythingElseQuestion("hi-IN"))), said);
    assert.doesNotMatch(said, /all booked|you're all set|anything else/i, said);
    for (const c of chunks) assert.equal(c.voice, "hi-IN", `said by ${c.voice}: ${c.text}`);
    assert.equal(phrasingCalls(), phrasingBefore, "no unchecked model wording was requested");
    await terminateRuntimeSession(callId, "test cleanup");
    assert.ok(
      transcript().some((t) => squash(t).includes(squash(expected))),
      "the transcript records what was said",
    );
  });

  test("Telugu: a slot taken at booking time is reported truthfully in Telugu by the Telugu voice", async () => {
    const { callId, turn, calls } = await openBookingCall({
      booking: [err("SLOT_NO_LONGER_AVAILABLE")],
    });
    await upToBookingQuestion(turn);
    const chunks = await turn("సరే, బుక్ చేయండి దయచేసి", LYING, "te-IN");

    assert.equal(calls("book_appointment").length, 1);
    const said = joined(chunks);
    assert.ok(said.includes(squash(callOutcomeLine("te-IN", "bookingSlotTaken")!)), said);
    assert.doesNotMatch(said, /all booked|confirmed|that time was just taken/i, said);
    for (const c of chunks) assert.equal(c.voice, "te-IN", `said by ${c.voice}: ${c.text}`);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a failing phrasing model can't mislead a Hindi caller: the outcome needs no model at all", async () => {
    const { callId, turn } = await openBookingCall({
      booking: [err("SLOT_NO_LONGER_AVAILABLE")],
      wording: () => {
        throw new Error("phrasing model down");
      },
    });
    await upToBookingQuestion(turn);
    const chunks = await turn("हाँ, बुक कर दो प्लीज़", LYING, "hi-IN");
    const said = joined(chunks);
    assert.ok(said.includes(squash(callOutcomeLine("hi-IN", "bookingSlotTaken")!)), said);
    assert.doesNotMatch(said, /all booked|something went wrong/i, said);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("Hindi: an unavailable slot offers exactly the calendar's real alternatives, formatted in Hindi", async () => {
    const { callId, turn, calls } = await openBookingCall({
      availability: [ok({ slots: [SLOT_7PM, SLOT_8PM] }), ok({ slots: [SLOT_8PM] })],
    });
    await upToBookingQuestion(turn);
    const chunks = await turn("हाँ, बुक कर दो प्लीज़", LYING, "hi-IN");
    assert.equal(calls("book_appointment").length, 0, "an unavailable slot is never booked");
    const expected = callOutcomeLine("hi-IN", "slotUnavailableAlternatives", {
      slotStarts: [SLOT_8PM.start],
      timeZone: "UTC",
    })!;
    const said = joined(chunks);
    assert.ok(said.includes(squash(expected)), said);
    assert.match(said, /8:00/, "the one real alternative");
    for (const c of chunks) assert.equal(c.voice, "hi-IN");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("English is unchanged: the verbatim English confirmation, by the English voice", async () => {
    const { callId, turn } = await openBookingCall();
    await upToBookingQuestion(turn);
    const chunks = await turn("Yes, book it", LYING);
    const said = joined(chunks);
    assert.match(said, /You're all set — your Root Canal Treatment at Smile Dental is confirmed/);
    assert.match(said, /Is there anything else I can help you with\?/);
    for (const c of chunks) assert.equal(c.voice, "en-IN");
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

/* ------------------------------------------------------------------ */
/* Booking authorization: only the runtime's own question counts         */
/* ------------------------------------------------------------------ */

/**
 * English set-up, then the caller gives their name in `language`: the call
 * switches language and the completed details trigger the real
 * availability check, which asks the runtime's own localized booking
 * question. Returns that question.
 */
async function upToLocalizedBookingQuestion(
  turn: Awaited<ReturnType<typeof openBookingCall>>["turn"],
  language: "hi-IN" | "te-IN",
  name: string,
): Promise<string> {
  await turn(
    "Root canal treatment today at 7 PM",
    `Sure. May I use the number you're calling from?\n${marker({ ...KNOWN, customer_name: null })}`,
  );
  await turn(
    "Yes, use the number I'm calling from",
    `Thanks. May I have your name?\n${marker({ ...KNOWN, customer_name: null })}`,
  );
  const asked = await turn(name, `${marker({ ...KNOWN })}`, language);
  const question = callOutcomeLine(language, "slotAvailable", { date: DATE, time: "19:00" })!;
  assert.ok(joined(asked).includes(squash(question)), joined(asked));
  for (const c of asked) assert.equal(c.voice, language, `said by ${c.voice}: ${c.text}`);
  return question;
}

const HINDI_NAME = "जी मेरा नाम धनुष है";
const TELUGU_NAME = "నా పేరు ధనుష్ అండి";

describe("callerAuthorizesBooking: a bare yes in another language needs the runtime's own question", () => {
  const hindiQuestion = callOutcomeLine("hi-IN", "slotAvailable", { date: DATE, time: "19:00" })!;
  const teluguQuestion = callOutcomeLine("te-IN", "slotAvailable", { date: DATE, time: "19:00" })!;

  test("a bare Hindi or Telugu yes answers the runtime's booking question it was asked", () => {
    assert.equal(callerAuthorizesBooking("हाँ", hindiQuestion, hindiQuestion), true);
    assert.equal(callerAuthorizesBooking("అవును", teluguQuestion, teluguQuestion), true);
    // An acknowledgement spoken before the same question doesn't hide it.
    assert.equal(callerAuthorizesBooking("हाँ", `ठीक है। ${hindiQuestion}`, hindiQuestion), true);
  });

  test("model wording about booking that ends in '?' is not a booking question", () => {
    for (const asked of [
      "बुकिंग के बारे में कुछ और जानना है?",
      "क्या आप बुकिंग की जानकारी सुनना चाहेंगे?",
      "బుకింగ్ గురించి ఇంకా ఏమైనా తెలుసుకోవాలా?",
    ]) {
      for (const runtimeQuestion of [null, hindiQuestion]) {
        assert.equal(callerAuthorizesBooking("हाँ", asked, runtimeQuestion), false, asked);
        assert.equal(callerAuthorizesBooking("అవును", asked, runtimeQuestion), false, asked);
      }
    }
  });

  test("the runtime's 'that time was taken — another time?' and 'anything else?' are not booking questions", () => {
    const taken = callOutcomeLine("hi-IN", "bookingSlotTaken")!;
    assert.equal(callerAuthorizesBooking("हाँ", taken, hindiQuestion), false);
    const anythingElse = anythingElseQuestion("te-IN");
    assert.equal(callerAuthorizesBooking("అవును", anythingElse, teluguQuestion), false);
  });

  test("an explicit command stands alone; a refusal or a wait never counts", () => {
    assert.equal(callerAuthorizesBooking("बुक कर दो", "जी, बताइए।"), true);
    assert.equal(callerAuthorizesBooking("సరే, బుక్ చేయండి", "సరే."), true);
    for (const said of ["नहीं, अभी बुक मत करो", "रुकिए, एक मिनट", "లేదు, ఇప్పుడు వద్దు", "ఆగండి"]) {
      assert.equal(callerAuthorizesBooking(said, hindiQuestion, hindiQuestion), false, said);
    }
  });

  test("English is unchanged: its question patterns still work with no recorded question", () => {
    assert.equal(
      callerAuthorizesBooking(
        "Yes",
        "Good news — 7 PM is available. Would you like me to book it?",
      ),
      true,
    );
    assert.equal(callerAuthorizesBooking("Yes", "Would you like to hear our prices?"), false);
  });
});

describe("booking authorization through the runtime, in any language", () => {
  test("1. Hindi: a bare 'हाँ' to the runtime's own Hindi booking question books the asked slot", async () => {
    const { callId, turn, calls } = await openBookingCall();
    await upToLocalizedBookingQuestion(turn, "hi-IN", HINDI_NAME);
    const chunks = await turn("हाँ", LYING, "hi-IN");
    assert.equal(calls("book_appointment").length, 1, joined(chunks));
    assert.equal(calls("book_appointment")[0]!.input["startIso"], SLOT_7PM.start);
    const expected = callOutcomeLine("hi-IN", "bookingConfirmed", {
      service: "Root Canal Treatment",
      date: DATE,
      time: "19:00",
    })!;
    assert.ok(joined(chunks).includes(squash(expected)), joined(chunks));
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("2. Hindi: a bare 'हाँ' after a generic question about booking information books nothing", async () => {
    // Model wording about a booking reaches the caller only once a booking
    // is confirmed (until then the runtime says its own line instead), so
    // the generic question is asked after the first booking.
    const { callId, turn, calls } = await openBookingCall();
    await upToLocalizedBookingQuestion(turn, "hi-IN", HINDI_NAME);
    await turn("हाँ", LYING, "hi-IN");
    assert.equal(calls("book_appointment").length, 1);
    const generic = "बुकिंग के बारे में कुछ और जानना है?";
    const asked = await turn("एक और सवाल है जी", `${generic}\n${marker({ ...KNOWN })}`, "hi-IN");
    assert.ok(joined(asked).includes(generic), joined(asked));
    const chunks = await turn("हाँ", LYING, "hi-IN");
    assert.equal(calls("book_appointment").length, 1, `no second booking: ${joined(chunks)}`);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("2a. before any booking, model wording about booking is replaced by the runtime's own read-back question", async () => {
    const { callId, turn, calls } = await openBookingCall();
    await upToLocalizedBookingQuestion(turn, "hi-IN", HINDI_NAME);
    const said = await turn(
      "पहले बताइए फीस कितनी लगेगी",
      `फीस पाँच सौ रुपये है। बुकिंग के बारे में कुछ और जानना है?\n${marker({ ...KNOWN })}`,
      "hi-IN",
    );
    // The caller never hears the generic question — only the runtime's
    // explicit booking question — so a "yes" to it is real consent.
    assert.doesNotMatch(joined(said), /कुछ और जानना है/, joined(said));
    const readBack = callOutcomeLine("hi-IN", "confirmBooking", {
      service: "Root Canal Treatment",
      date: DATE,
      time: "19:00",
      customerName: KNOWN.customer_name,
    })!;
    assert.ok(joined(said).includes(squash(readBack)), joined(said));
    assert.equal(calls("book_appointment").length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("2b. Hindi: a bare 'हाँ' to 'that time was just taken — another time?' doesn't book again", async () => {
    const { callId, turn, calls } = await openBookingCall({
      booking: [err("SLOT_NO_LONGER_AVAILABLE")],
    });
    await upToLocalizedBookingQuestion(turn, "hi-IN", HINDI_NAME);
    const taken = await turn("हाँ", LYING, "hi-IN");
    assert.equal(calls("book_appointment").length, 1);
    assert.ok(joined(taken).includes(squash(callOutcomeLine("hi-IN", "bookingSlotTaken")!)));
    // "Yes, another time" is not "book that one again".
    const chunks = await turn("हाँ", LYING, "hi-IN");
    assert.equal(calls("book_appointment").length, 1, joined(chunks));
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("3. Telugu: 'అవును' after 'anything else?' books nothing", async () => {
    const { callId, turn, calls } = await openBookingCall();
    await upToLocalizedBookingQuestion(turn, "te-IN", TELUGU_NAME);
    await turn(
      "క్లినిక్ ఎక్కడ ఉంది చెప్పండి",
      `మేము ఎంజీ రోడ్‌లో ఉన్నాము. ${anythingElseQuestion("te-IN")}\n${marker({ ...KNOWN })}`,
      "te-IN",
    );
    const chunks = await turn("అవును", LYING, "te-IN");
    assert.equal(calls("book_appointment").length, 0, joined(chunks));
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("4. an explicit Hindi or Telugu command books, with every detail known and the slot available", async () => {
    for (const [language, name, command] of [
      ["hi-IN", HINDI_NAME, "ठीक है, बुक कर दो"],
      ["te-IN", TELUGU_NAME, "సరే, బుక్ చేయండి"],
    ] as const) {
      const { callId, turn, calls } = await openBookingCall();
      await upToLocalizedBookingQuestion(turn, language, name);
      // An unrelated exchange first, so only the command itself can authorize.
      await turn(
        language === "hi-IN" ? "पार्किंग की सुविधा है क्या" : "పార్కింగ్ సౌకర్యం ఉందా చెప్పండి",
        `${language === "hi-IN" ? "जी, पार्किंग है।" : "అవును, పార్కింగ్ ఉంది."}\n${marker({ ...KNOWN })}`,
        language,
      );
      await turn(command, LYING, language);
      assert.equal(calls("book_appointment").length, 1, language);
      await terminateRuntimeSession(callId, "test cleanup");
    }
  });

  test("5. a refusal or a request to wait after the runtime's question books nothing", async () => {
    for (const said of ["नहीं, अभी बुक मत करो", "रुकिए, एक मिनट"]) {
      const { callId, turn, calls } = await openBookingCall();
      await upToLocalizedBookingQuestion(turn, "hi-IN", HINDI_NAME);
      const chunks = await turn(said, LYING, "hi-IN");
      assert.equal(calls("book_appointment").length, 0, `${said}: ${joined(chunks)}`);
      await terminateRuntimeSession(callId, "test cleanup");
    }
  });

  test("6a. missing details: an explicit Hindi command books nothing without the caller's name", async () => {
    const { callId, turn, calls } = await openBookingCall();
    await turn(
      "Root canal treatment today at 7 PM",
      `Sure. May I use the number you're calling from?\n${marker({ ...KNOWN, customer_name: null })}`,
    );
    await turn(
      "Yes, use the number I'm calling from",
      `Thanks. May I have your name?\n${marker({ ...KNOWN, customer_name: null })}`,
    );
    const lyingWithoutName = `Great news, you're all booked!\n${marker({ ...KNOWN, customer_name: null, ready_to_book: true })}`;
    const chunks = await turn("बस अभी बुक कर दो", lyingWithoutName, "hi-IN");
    assert.equal(calls("book_appointment").length, 0, joined(chunks));
    assert.doesNotMatch(joined(chunks), /all booked/i);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("6b. an unavailable slot: a bare 'हाँ' to the alternatives question books nothing", async () => {
    const { callId, turn, calls } = await openBookingCall({
      availability: [ok({ slots: [SLOT_8PM] })],
    });
    await turn(
      "Root canal treatment today at 7 PM",
      `Sure. May I use the number you're calling from?\n${marker({ ...KNOWN, customer_name: null })}`,
    );
    await turn(
      "Yes, use the number I'm calling from",
      `Thanks. May I have your name?\n${marker({ ...KNOWN, customer_name: null })}`,
    );
    const offered = await turn(HINDI_NAME, `${marker({ ...KNOWN })}`, "hi-IN");
    const alternatives = callOutcomeLine("hi-IN", "slotUnavailableAlternatives", {
      slotStarts: [SLOT_8PM.start],
      timeZone: "UTC",
    })!;
    assert.ok(joined(offered).includes(squash(alternatives)), joined(offered));
    const chunks = await turn("हाँ", LYING, "hi-IN");
    assert.equal(calls("book_appointment").length, 0, joined(chunks));
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("7a. switching language mid-answer keeps an authorization the runtime's question earned", async () => {
    const { callId, turn, calls } = await openBookingCall();
    await upToLocalizedBookingQuestion(turn, "hi-IN", HINDI_NAME);
    // Asked in Hindi, answered with a clear Telugu yes. (Whole-utterance
    // answers only: a longer sentence that contains "అవును" isn't consent.)
    await turn("అవును", LYING, "te-IN");
    assert.equal(calls("book_appointment").length, 1);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("7b. switching language never carries an old question forward as authorization", async () => {
    const { callId, turn, calls } = await openBookingCall();
    await upToLocalizedBookingQuestion(turn, "hi-IN", HINDI_NAME);
    // The caller switches to English about something else; the model asks a
    // non-booking question. The recorded Hindi question is no longer the
    // last thing asked, so a bare "yes" books nothing.
    await turn(
      "Actually, what are your opening hours today?",
      `We're open until 9 PM. Would you like to hear our prices?\n${marker({ ...KNOWN })}`,
      "en-IN",
    );
    const chunks = await turn("Yes", LYING, "en-IN");
    assert.equal(calls("book_appointment").length, 0, joined(chunks));
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("'not booked yet' with every detail known asks a question a bare yes can answer", () => {
  /** Hindi set-up up to the runtime's own question, then an unrelated turn, then the model claims a booking nobody authorized. */
  async function upToNotBookedYet(language: "hi-IN" | "te-IN", name: string) {
    const call = await openBookingCall();
    await upToLocalizedBookingQuestion(call.turn, language, name);
    await call.turn(
      language === "hi-IN" ? "पहले बताइए फीस कितनी लगेगी" : "ముందు ఫీజు ఎంత అవుతుందో చెప్పండి",
      `${language === "hi-IN" ? "फीस पाँच सौ रुपये है।" : "ఫీజు ఐదు వందల రూపాయలు."}\n${marker({ ...KNOWN })}`,
      language,
    );
    const said = await call.turn(language === "hi-IN" ? "ठीक है जी" : "సరే అండి", LYING, language);
    return { ...call, said };
  }
  const readBack = (language: string, customerName: string) =>
    callOutcomeLine(language, "confirmBooking", {
      service: "Root Canal Treatment",
      date: DATE,
      time: "19:00",
      customerName,
    })!;

  test("the caller hears the details read back with the runtime's booking question, and nothing is booked", async () => {
    const { callId, calls, said } = await upToNotBookedYet("hi-IN", HINDI_NAME);
    assert.equal(calls("book_appointment").length, 0);
    assert.ok(joined(said).includes(squash(readBack("hi-IN", KNOWN.customer_name))), joined(said));
    assert.doesNotMatch(joined(said), /all booked|Shall I book/i);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a bare 'हाँ' to it books — no loop of 'nothing booked yet'", async () => {
    const { callId, turn, calls } = await upToNotBookedYet("hi-IN", HINDI_NAME);
    const chunks = await turn("हाँ", LYING, "hi-IN");
    assert.equal(calls("book_appointment").length, 1, joined(chunks));
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("'confirm it' in Hindi or Telugu books; 'don't confirm' never does", async () => {
    for (const [language, name, said, books] of [
      ["hi-IN", HINDI_NAME, "कन्फर्म कर दीजिए", 1],
      ["te-IN", TELUGU_NAME, "నిర్ధారించండి", 1],
      ["hi-IN", HINDI_NAME, "नहीं, अभी कन्फर्म मत कीजिए", 0],
    ] as const) {
      const { callId, turn, calls } = await upToNotBookedYet(language, name);
      const chunks = await turn(said, LYING, language);
      assert.equal(calls("book_appointment").length, books, `${said}: ${joined(chunks)}`);
      await terminateRuntimeSession(callId, "test cleanup");
    }
  });

  test("with a detail still missing, only that detail is asked for and a bare yes books nothing", async () => {
    const { callId, turn, calls } = await openBookingCall();
    await turn(
      "Root canal treatment today at 7 PM",
      `Sure. May I use the number you're calling from?\n${marker({ ...KNOWN, customer_name: null })}`,
    );
    await turn(
      "Yes, use the number I'm calling from",
      `Thanks. May I have your name?\n${marker({ ...KNOWN, customer_name: null })}`,
    );
    const noName = `Great news, you're all booked!\n${marker({ ...KNOWN, customer_name: null, ready_to_book: true })}`;
    const said = await turn("ठीक है जी बताइए", noName, "hi-IN");
    assert.ok(joined(said).includes(MISSING_DETAIL_QUESTION["hi-IN"].name), joined(said));
    const chunks = await turn("हाँ", noName, "hi-IN");
    assert.equal(calls("book_appointment").length, 0, joined(chunks));
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("callerBookingIntentAnyLanguage: 'confirm it' as an instruction", () => {
  test("a confirm command in every supported language is an explicit instruction", () => {
    for (const said of [
      "कन्फर्म कर दीजिए",
      "पुष्टि कीजिए",
      "खात्री करा",
      "নিশ্চিত করুন",
      "உறுதிசெய்யுங்கள்",
      "కన్ఫర్మ్ చేయండి",
      "నిర్ధారించండి",
      "પુષ્ટિ કરો",
      "ಖಚಿತಪಡಿಸಿ",
      "ഉറപ്പാക്കുക",
      "ਪੁਸ਼ਟੀ ਕਰੋ",
      "ନିଶ୍ଚିତ କରନ୍ତୁ",
      "confirm kar dijiye",
    ]) {
      assert.equal(callerBookingIntentAnyLanguage(said), "instruct", said);
    }
  });

  test("a mention, a question or a 'not confirmed' form is not an instruction", () => {
    for (const said of [
      "क्या मेरी बुकिंग कन्फर्म हुई?",
      "ಖಚಿತಪಡಿಸಿಲ್ಲ",
      "ఇంకా నిర్ధారించలేదు",
      "पुष्टि करता हूँ",
    ]) {
      assert.notEqual(callerBookingIntentAnyLanguage(said), "instruct", said);
    }
    for (const said of ["पुष्टि मत कीजिए", "కన్ఫర్మ్ చేయవద్దు"]) {
      assert.equal(callerBookingIntentAnyLanguage(said), "decline", said);
    }
  });

  test("every language's read-back question names the service and time, and ends as a question", () => {
    for (const language of [
      "hi-IN",
      "bn-IN",
      "ta-IN",
      "te-IN",
      "gu-IN",
      "kn-IN",
      "ml-IN",
      "mr-IN",
      "pa-IN",
      "od-IN",
    ]) {
      const line = callOutcomeLine(language, "notBookedYetConfirm", {
        service: "Root Canal Treatment",
        date: DATE,
        time: "19:00",
      })!;
      assert.match(line, /Root Canal Treatment/, language);
      assert.match(line, /\?$/, language);
      assert.notEqual(line, callOutcomeLine(language, "notBookedYet"), language);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The production failure: an agent published before calls became      */
/* multilingual, on raw Sarvam realtime STT messages                    */
/* ------------------------------------------------------------------ */

/**
 * The production agent (version 2, published 16 September) still carries the
 * old generated "# LANGUAGE\nRespond in: en-IN." — and production read only
 * `language_code`, which Sarvam's realtime endpoint never sends, so a Telugu
 * caller was told "I can only assist in English". These calls start from
 * that published text after routeToAgentRuntime's call-time override, and
 * feed Sarvam's own realtime messages through normalizeSttMessage.
 */
const SEPTEMBER_PROMPT =
  "# BUSINESS CONTEXT\nYou are the phone receptionist for Smile Dental.\n\n" +
  "# RULES AND RESTRICTIONS\n1. Only answer with information given above.\n\n" +
  "# LANGUAGE\nRespond in: en-IN.\n\n" +
  "# SAFETY\n- Never claim a booking was completed unless a tool confirmed it.";
const CALL_INSTRUCTIONS = withCurrentLanguageSection(SEPTEMBER_PROMPT, agent);
const final = (text: string, extra: Record<string, unknown>) => ({
  event: "transcript.final",
  utterance_idx: 0,
  text,
  ...extra,
});
const systemText = (h: Harness) =>
  (h.llm.calls.at(-1) ?? [])
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
const TELUGU_QUESTION = "మీ క్లినిక్ ఎక్కడ ఉంది చెప్పండి";
const TELUGU_REPLY = "మేము ఎంజీ రోడ్‌లో ఉన్నాము.";
const HINDI_REPLY = "जी हाँ, बताइए मैं आपकी क्या मदद करूँ?";

describe("an old published prompt and Sarvam's realtime language fields, end to end", () => {
  test("the call's instructions carry today's language rules, not the published English-only one", () => {
    assert.doesNotMatch(CALL_INSTRUCTIONS, /Respond in: en-IN\./);
    assert.match(CALL_INSTRUCTIONS, /Never refuse a call or claim you can only help in English/);
    assert.ok(
      CALL_INSTRUCTIONS.startsWith(
        SEPTEMBER_PROMPT.slice(0, SEPTEMBER_PROMPT.indexOf("# LANGUAGE")),
      ),
    );
  });

  test("a Telugu caller (language + language_confidence) is answered in Telugu, by the Telugu voice", async () => {
    const { h, callId, rawTurn } = await openBookingCall({ instructions: CALL_INSTRUCTIONS });
    const chunks = await rawTurn(
      final(TELUGU_QUESTION, { language: "te-IN", language_confidence: "0.92" }),
      TELUGU_REPLY,
    );
    const system = systemText(h);
    assert.doesNotMatch(system, /Respond in: en-IN\./, "no English-only rule reaches the model");
    assert.match(system, /Reply to the caller's next message in Telugu \(te-IN\)/);
    assert.ok(joined(chunks).includes(TELUGU_REPLY), joined(chunks));
    for (const c of chunks) assert.equal(c.voice, "te-IN", `said by ${c.voice}: ${c.text}`);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("'Hindi lo matladadava?' (romanized Telugu) switches to Hindi, then 'English lo matladandi' back to English", async () => {
    const { h, callId, rawTurn } = await openBookingCall({ instructions: CALL_INSTRUCTIONS });
    await rawTurn(
      final(TELUGU_QUESTION, { language: "te-IN", language_confidence: "0.92" }),
      TELUGU_REPLY,
    );
    const hindi = await rawTurn(
      final("Hindi lo matladadava?", { language: "te-IN", language_confidence: "0.61" }),
      HINDI_REPLY,
    );
    assert.match(systemText(h), /Reply to the caller's next message in Hindi \(hi-IN\)/);
    assert.ok(joined(hindi).includes(HINDI_REPLY), joined(hindi));
    for (const c of hindi) assert.equal(c.voice, "hi-IN", `said by ${c.voice}: ${c.text}`);

    const english = await rawTurn(
      final("English lo matladandi", { language: "te-IN", language_confidence: "0.58" }),
      "Sure, how can I help you?",
    );
    assert.match(systemText(h), /Reply to the caller's next message in English \(en-IN\)/);
    for (const c of english) assert.equal(c.voice, "en-IN", `said by ${c.voice}: ${c.text}`);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a Telugu-script request for Hindi ('హిందీలో మాట్లాడతావా?') switches to Hindi", async () => {
    const { h, callId, rawTurn } = await openBookingCall({ instructions: CALL_INSTRUCTIONS });
    await rawTurn(
      final(TELUGU_QUESTION, { language: "te-IN", language_confidence: "0.92" }),
      TELUGU_REPLY,
    );
    const chunks = await rawTurn(
      final("హిందీలో మాట్లాడతావా?", { language: "te-IN", language_confidence: "0.95" }),
      HINDI_REPLY,
    );
    assert.match(systemText(h), /Reply to the caller's next message in Hindi \(hi-IN\)/);
    for (const c of chunks) assert.equal(c.voice, "hi-IN", `said by ${c.voice}: ${c.text}`);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a Hindi caller in Devanagari is answered in Hindi; an English caller stays in English", async () => {
    const hindiCall = await openBookingCall({ instructions: CALL_INSTRUCTIONS });
    const hindi = await hindiCall.rawTurn(
      final("आपका क्लिनिक कहाँ है बताइए", { language: "hi-IN", language_confidence: "0.94" }),
      "हमारा क्लिनिक एमजी रोड पर है।",
    );
    for (const c of hindi) assert.equal(c.voice, "hi-IN");
    await terminateRuntimeSession(hindiCall.callId, "test cleanup");

    const englishCall = await openBookingCall({ instructions: CALL_INSTRUCTIONS });
    const english = await englishCall.rawTurn(
      final("Is there parking near your clinic?", {
        language: "en-IN",
        language_confidence: "0.97",
      }),
      "Yes, there is parking right outside.",
    );
    assert.match(
      systemText(englishCall.h),
      /Reply to the caller's next message in English \(en-IN\)/,
    );
    assert.ok(joined(english).includes("Yes, there is parking right outside."));
    for (const c of english) assert.equal(c.voice, "en-IN");
    await terminateRuntimeSession(englishCall.callId, "test cleanup");
  });

  test("the legacy `language_code` field still drives the switch", async () => {
    const { callId, rawTurn } = await openBookingCall({ instructions: CALL_INSTRUCTIONS });
    const chunks = await rawTurn(final(TELUGU_QUESTION, { language_code: "te-IN" }), TELUGU_REPLY);
    for (const c of chunks) assert.equal(c.voice, "te-IN", `said by ${c.voice}: ${c.text}`);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("uncertain, missing, invalid or unsupported detection keeps the current language", async () => {
    const { h, callId, rawTurn } = await openBookingCall({ instructions: CALL_INSTRUCTIONS });
    await rawTurn(
      final("Is there parking near your clinic?", {
        language: "en-IN",
        language_confidence: "0.97",
      }),
      "Yes, there is parking right outside.",
    );
    const cases: [string, Record<string, unknown>][] = [
      ["can I come in the evening", { language: "te-IN", language_confidence: "0.40" }],
      ["can you tell me the fee please", {}],
      ["what is the fee for cleaning", { language: "te-IN", language_confidence: "abc" }],
      ["is parking available near you", { language: "ur-IN", language_confidence: "0.99" }],
    ];
    for (const [text, extra] of cases) {
      const chunks = await rawTurn(final(text, extra), "Our fee is five hundred rupees.");
      assert.match(systemText(h), /in English \(en-IN\)/, JSON.stringify(extra));
      for (const c of chunks)
        assert.equal(c.voice, "en-IN", `${JSON.stringify(extra)}: ${c.voice}`);
    }
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a short acknowledgement never flips an established Telugu call to English", async () => {
    const { h, callId, rawTurn } = await openBookingCall({ instructions: CALL_INSTRUCTIONS });
    await rawTurn(
      final(TELUGU_QUESTION, { language: "te-IN", language_confidence: "0.92" }),
      TELUGU_REPLY,
    );
    const chunks = await rawTurn(
      final("ok", { language: "en-IN", language_confidence: "0.99" }),
      "సరే, ఇంకా ఏమైనా కావాలా?",
    );
    assert.match(systemText(h), /in Telugu \(te-IN\)/);
    for (const c of chunks) assert.equal(c.voice, "te-IN", `said by ${c.voice}: ${c.text}`);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

/**
 * The production call of 2026-10-29 that the earlier fix did not cover:
 * "Hello", then romanized Telugu, then Devanagari Hindi — all answered in
 * English. Sarvam's realtime STT labelled the first two "en-IN" (the
 * romanized Telugu at 0.6), and "Hello" at confidence 1 had locked the call
 * to English, so the Hindi sentence needed a second confirming sentence.
 */
describe("the caller's language from their own words, without being asked", () => {
  test("Hello → romanized Telugu → Devanagari Hindi: Telugu, then Hindi, by the matching voice", async () => {
    const { h, callId, rawTurn } = await openBookingCall({ instructions: CALL_INSTRUCTIONS });
    const hello = await rawTurn(
      final("Hello", { language: "en-IN", language_confidence: "1" }),
      "Hello! How can I help you today?",
    );
    for (const c of hello) assert.equal(c.voice, "en-IN");

    const telugu = await rawTurn(
      final("Appointment book cheyali anukuntunnaru", {
        language: "en-IN",
        language_confidence: "0.6",
      }),
      "తప్పకుండా, ఏ రోజు, ఏ సమయానికి కావాలి?",
    );
    assert.match(systemText(h), /Reply to the caller's next message in Telugu \(te-IN\)/);
    assert.ok(telugu.length > 0);
    for (const c of telugu) assert.equal(c.voice, "te-IN", `said by ${c.voice}: ${c.text}`);

    const hindi = await rawTurn(
      final("आज तीन बजे अपार्टमेंट बुक कर दो।", { language: "hi-IN", language_confidence: "0.55" }),
      "ज़रूर, आज तीन बजे के लिए आपका नाम बताइए?",
    );
    assert.match(systemText(h), /Reply to the caller's next message in Hindi \(hi-IN\)/);
    assert.ok(hindi.length > 0);
    for (const c of hindi) assert.equal(c.voice, "hi-IN", `said by ${c.voice}: ${c.text}`);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  // "I want an appointment" in each language, as saaras:v3-realtime writes
  // it, with the low-confidence label Sarvam gives code-mixed speech — the
  // script alone must decide.
  const FIRST_UTTERANCES: [string, string, Record<string, unknown>][] = [
    ["te-IN", "నాకు అపాయింట్మెంట్ బుక్ చేయాలి", { language: "en-IN", language_confidence: "0.55" }],
    ["hi-IN", "मुझे अपॉइंटमेंट बुक करनी है", { language: "en-IN", language_confidence: "0.55" }],
    [
      "ta-IN",
      "எனக்கு ஒரு அப்பாயின்ட்மென்ட் வேண்டும்",
      { language: "en-IN", language_confidence: "0.5" },
    ],
    ["kn-IN", "ನನಗೆ ಒಂದು ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಬೇಕು", { language: "en-IN", language_confidence: "0.5" }],
    [
      "ml-IN",
      "എനിക്ക് ഒരു അപ്പോയിന്റ്മെന്റ് വേണം",
      { language: "en-IN", language_confidence: "0.5" },
    ],
    ["bn-IN", "আমার একটা অ্যাপয়েন্টমেন্ট চাই", { language: "en-IN", language_confidence: "0.5" }],
    ["mr-IN", "मला अपॉइंटमेंट बुक करायची आहे", { language: "mr-IN", language_confidence: "0.5" }],
    ["gu-IN", "મારે એપોઇન્ટમેન્ટ બુક કરવી છે", { language: "en-IN", language_confidence: "0.5" }],
    ["pa-IN", "ਮੈਨੂੰ ਅਪੌਇੰਟਮੈਂਟ ਬੁੱਕ ਕਰਨੀ ਹੈ", { language: "en-IN", language_confidence: "0.5" }],
    ["od-IN", "ମୋତେ ଗୋଟିଏ ଆପଏଣ୍ଟମେଣ୍ଟ ଦରକାର", { language: "or-IN", language_confidence: "0.5" }],
  ];
  for (const [code, said, extra] of FIRST_UTTERANCES) {
    test(`a ${code} caller's first sentence is answered in ${code}, by the ${code} voice`, async () => {
      const { h, callId, rawTurn } = await openBookingCall({ instructions: CALL_INSTRUCTIONS });
      // The reply repeats the caller's words: any text in the right script.
      const chunks = await rawTurn(final(said, extra), said);
      assert.ok(systemText(h).includes(`next message in`) && systemText(h).includes(`(${code})`));
      assert.ok(chunks.length > 0);
      for (const c of chunks) assert.equal(c.voice, code, `said by ${c.voice}: ${c.text}`);
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test("romanized Hindi is answered in Hindi; plain English stays English", async () => {
    const hindiCall = await openBookingCall({ instructions: CALL_INSTRUCTIONS });
    const hindi = await hindiCall.rawTurn(
      final("Mujhe kal appointment chahiye", { language: "en-IN", language_confidence: "0.62" }),
      "ज़रूर, कल किस समय आना चाहेंगे?",
    );
    assert.match(systemText(hindiCall.h), /in Hindi \(hi-IN\)/);
    for (const c of hindi) assert.equal(c.voice, "hi-IN");
    await terminateRuntimeSession(hindiCall.callId, "test cleanup");

    const englishCall = await openBookingCall({ instructions: CALL_INSTRUCTIONS });
    const english = await englishCall.rawTurn(
      final("I want to book an appointment for tomorrow at 3 PM", {
        language: "en-IN",
        language_confidence: "0.6",
      }),
      "Sure, may I have your name?",
    );
    assert.match(systemText(englishCall.h), /in English \(en-IN\)/);
    for (const c of english) assert.equal(c.voice, "en-IN");
    await terminateRuntimeSession(englishCall.callId, "test cleanup");
  });

  test("Telugu → Hindi → English across a call, and a short native-script 'ok' moves nothing", async () => {
    const { h, callId, rawTurn } = await openBookingCall({ instructions: CALL_INSTRUCTIONS });
    await rawTurn(
      final(TELUGU_QUESTION, { language: "te-IN", language_confidence: "0.7" }),
      TELUGU_REPLY,
    );
    const hindi = await rawTurn(
      final("मुझे कल सुबह दस बजे आना है", { language: "hi-IN", language_confidence: "0.7" }),
      HINDI_REPLY,
    );
    for (const c of hindi) assert.equal(c.voice, "hi-IN");
    const ack = await rawTurn(
      final("ఓకే", { language: "te-IN", language_confidence: "0.99" }),
      "जी, और कुछ?",
    );
    assert.match(systemText(h), /in Hindi \(hi-IN\)/);
    for (const c of ack) assert.equal(c.voice, "hi-IN");
    const english = await rawTurn(
      final("Actually can we continue this conversation", {
        language: "en-IN",
        language_confidence: "0.9",
      }),
      "Of course, go ahead.",
    );
    for (const c of english) assert.equal(c.voice, "en-IN");
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("text for the voice", () => {
  test("markdown, bullets and emoji are removed; dates, times, amounts and names are untouched", () => {
    assert.equal(
      textForSpeech("**Sure!** Your slot is on 14-10-2030 at 7:30 PM 😊"),
      "Sure! Your slot is on 14-10-2030 at 7:30 PM",
    );
    assert.equal(
      textForSpeech("## Options\n- Root canal: ₹4,500\n- Cleaning: ₹800"),
      "Options\nRoot canal: ₹4,500\nCleaning: ₹800",
    );
    for (const plain of [
      "ఆదివారం, 3:30 PMకి డాక్టర్ రావు గారు ఉంటారు.",
      "जी, कल सुबह 10 बजे का समय मिल जाएगा।",
      "Your email is dhanush_c@example.com, right?",
      "It's 2.5 hours, Dr. K. Rao.",
    ]) {
      assert.equal(textForSpeech(plain), plain);
    }
  });

  test("Indian-language sentences ending in a danda are split like English ones", () => {
    assert.deepEqual(
      chunkIntoSentences("ज़रूर, आपका अपॉइंटमेंट देख लेती हूँ। कल सुबह दस बजे ठीक रहेगा?"),
      ["ज़रूर, आपका अपॉइंटमेंट देख लेती हूँ।", "कल सुबह दस बजे ठीक रहेगा?"],
    );
  });
});

describe("closing the call after 'anything else?', in any language", () => {
  const cases = [
    { language: "hi-IN", yes: "हाँ, बुक कर दो प्लीज़", no: "नहीं, धन्यवाद" },
    { language: "te-IN", yes: "సరే, బుక్ చేయండి దయచేసి", no: "లేదు, ధన్యవాదాలు" },
    { language: "en-IN", yes: "Yes, book it", no: "No, thanks" },
  ] as const;
  for (const { language, yes, no } of cases) {
    test(`${language}: "${no}" after the booking ends the call with a goodbye in that language`, async () => {
      const { callId, turn } = await openBookingCall();
      await upToBookingQuestion(turn);
      await turn(yes, LYING, language);
      const chunks = await turn(no, "Anything else?", language);
      const goodbye =
        language === "en-IN"
          ? "Thank you for calling Smile Dental. Goodbye!"
          : FALLBACK_MESSAGES[language].farewell("Smile Dental");
      assert.ok(joined(chunks).includes(squash(goodbye)), joined(chunks));
      for (const c of chunks) assert.equal(c.voice, language);
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }
});

describe("the repeated-question response sets the same closing state in every language", () => {
  for (const language of ["hi-IN", "te-IN", "en-IN"] as const) {
    test(`${language}: after the same answer three times, the alternative is offered and a 'no' then ends the call`, async () => {
      const { callId, turn } = await openBookingCall();
      // Three differently worded questions (an identical transcript inside
      // the duplicate-delivery window is dropped as a redelivery), answered
      // with the same reply each time.
      const questions =
        language === "hi-IN"
          ? ["आपकी कीमत क्या है बताइए", "कीमत कितनी है जी", "फीस कितनी लगेगी बताइए"]
          : language === "te-IN"
            ? ["మీ ధర ఎంత చెప్పండి దయచేసి", "ధర ఎంత అవుతుంది చెప్పండి", "ఫీజు ఎంత ఉంటుంది దయచేసి"]
            : ["what is your price please", "how much does it cost", "tell me the fee please"];
      const sameReply =
        language === "hi-IN"
          ? "हमारी कीमत पाँच सौ रुपये है।"
          : language === "te-IN"
            ? "మా ధర ఐదు వందల రూపాయలు."
            : "Our price is five hundred rupees.";
      let last: { voice: string; text: string }[] = [];
      for (const question of questions) last = await turn(question, sameReply, language);
      const alternative =
        language === "en-IN"
          ? "I'm sorry, I don't seem to be able to sort this out on this call."
          : FALLBACK_MESSAGES[language].repeatedQuestion("");
      assert.ok(joined(last).includes(squash(alternative)), joined(last));
      for (const c of last) assert.equal(c.voice, language);

      const no = language === "hi-IN" ? "नहीं" : language === "te-IN" ? "లేదు" : "No";
      const end = await turn(no, "Anything else?", language);
      const goodbye =
        language === "en-IN"
          ? "Thank you for calling Smile Dental. Goodbye!"
          : FALLBACK_MESSAGES[language].farewell("Smile Dental");
      assert.ok(joined(end).includes(squash(goodbye)), joined(end));
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }
});

describe("mixed-language text and the active voice", () => {
  test("Hinglish in Latin script — names, numbers, English terms — is spoken as written by the Hindi voice", async () => {
    const { callId, turn } = await openBookingCall();
    await turn("मुझे जानकारी चाहिए", "जी, बताइए।", "hi-IN");
    const reply = "Dhanush ji, aapka root canal 7 PM ko hai, fee ₹500 hai.";
    const chunks = await turn("मेरा अपॉइंटमेंट कब है", reply, "hi-IN");
    assert.ok(joined(chunks).includes(reply), joined(chunks));
    for (const c of chunks) assert.equal(c.voice, "hi-IN");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a reply in another Indian script never reaches the Hindi voice", async () => {
    const { callId, turn, transcript } = await openBookingCall();
    await turn("मुझे जानकारी चाहिए", "जी, बताइए।", "hi-IN");
    // No booking words, so it is the script check — not the booking guard —
    // that stops it.
    const tamil = "நாளை காலை பத்து மணிக்கு வாருங்கள்.";
    const chunks = await turn("क्लिनिक कब खुलता है", tamil, "hi-IN");
    const said = joined(chunks);
    assert.doesNotMatch(said, /வாருங்கள்/, said);
    assert.ok(said.includes(squash(FALLBACK_MESSAGES["hi-IN"].toolTurnRetry(""))), said);
    await terminateRuntimeSession(callId, "test cleanup");
    assert.ok(!transcript().includes(tamil), "the unspoken text is not recorded");
  });
});

/* ------------------------------------------------------------------ */
/* Rescheduling                                                         */
/* ------------------------------------------------------------------ */

interface StoredBooking {
  id: string;
  startAt: string;
  endAt: string;
  timezone: string;
  status: string;
}

async function openRescheduleCall() {
  const h = createHarness();
  const takeovers = trackVoices(h);
  const booking: StoredBooking = {
    id: "b-1",
    startAt: `${DATE}T06:30:00.000Z`, // 12:00 IST
    endAt: `${DATE}T07:00:00.000Z`,
    timezone: "Asia/Kolkata",
    status: "CONFIRMED",
  };
  h.deps.findCallerBookings = async (): Promise<CallerBooking[]> => [
    {
      id: booking.id,
      startAt: booking.startAt,
      endAt: booking.endAt,
      timezone: booking.timezone,
      status: booking.status,
      serviceId: null,
      serviceName: "Root Canal Treatment",
      customerName: "Dhanush Kumar",
    },
  ];
  const record = h.deps.executeTool!;
  h.deps.executeTool = async (name, toolInput, ctx) => {
    await record(name, toolInput, ctx);
    if (name === "reschedule_appointment") {
      booking.startAt = String(toolInput["newStartIso"]);
      booking.endAt = String(toolInput["newEndIso"]);
      booking.status = "RESCHEDULED";
      return ok({ id: booking.id, status: "RESCHEDULED", startAt: booking.startAt });
    }
    return ok({});
  };
  const callId = `reschedule-ml-${crypto.randomUUID()}`;
  await startRuntimeSession(
    {
      callId,
      organizationId: "00000000-0000-0000-0000-000000000000",
      businessId: "00000000-0000-0000-0000-000000000001",
      agentConfigId: "00000000-0000-0000-0000-000000000002",
      agentVersion: 3,
      instructions: "You are Aria, a helpful receptionist for Smile Dental.",
      snapshotAgent: agent,
      businessName: "Smile Dental",
      bridge: h.bridge,
      businessCountry: "IN",
      callerNumber: CALLER,
      services: SERVICES,
    },
    h.deps,
  );
  let emitted = 0;
  const turn = async (said: string, language: string) => {
    while (emitted < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      emitted++;
    }
    h.llm.setNextReply("ठीक है।");
    const before = h.tts.sentTexts.length;
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "final_transcript", text: said, language, languageConfidence: 0.95 });
    await drain();
    return spokenWithVoices(h, takeovers, before);
  };
  const calls = (name: string) => h.tools.calls.filter((c) => c.name === name);
  return { h, callId, turn, calls, booking };
}

describe("rescheduling on a Hindi call", () => {
  test("the stored appointment is described, and the move confirmed, in Hindi by the Hindi voice", async () => {
    const { callId, turn, calls, booking } = await openRescheduleCall();
    const ask = await turn("mujhe apna appointment reschedule karna hai", "hi-IN");
    const expectedAsk = callOutcomeLine("hi-IN", "rescheduleAskNewTime", {
      appointment: { service: "Root Canal Treatment", startIso: `${DATE}T06:30:00.000Z` },
      timeZone: "Asia/Kolkata",
    })!;
    assert.ok(joined(ask).includes(squash(expectedAsk)), joined(ask));
    for (const c of ask) assert.equal(c.voice, "hi-IN");

    const done = await turn("1 PM pe kar dijiye please", "hi-IN");
    assert.equal(calls("reschedule_appointment").length, 1);
    assert.equal(booking.startAt, `${DATE}T07:30:00.000Z`, "moved to 1 PM IST");
    const expectedDone = callOutcomeLine("hi-IN", "rescheduleMoved", {
      date: DATE,
      time: "13:00",
      timeZone: "Asia/Kolkata",
    })!;
    const said = joined(done);
    assert.ok(said.includes(squash(expectedDone)), said);
    assert.ok(said.includes(squash(anythingElseQuestion("hi-IN"))), said);
    assert.doesNotMatch(said, /moved to|Done,/, said);
    for (const c of done) assert.equal(c.voice, "hi-IN");
    await terminateRuntimeSession(callId, "test cleanup");
  });
});
