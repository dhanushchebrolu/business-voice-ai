import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyCallerIdOfferAnyLanguage,
  parseCallerIntentFromText,
  resolveCallerIdAnswer,
  startRuntimeSession,
  terminateRuntimeSession,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import { callOutcomeLine } from "./voice-call-outcomes.ts";
import {
  CALLER_ID_QUESTION_BY_LANGUAGE,
  asciiDigits,
  explicitTimeAnyLanguage,
} from "./voice-intent-lexicon.ts";
import { resolveServiceFromText } from "./service-matching.ts";
import { speakablePart } from "./voice-languages.ts";
import { VOICE_LANGUAGES } from "./voice-languages.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ServiceRow } from "./service-matching.ts";

/**
 * The production call of 2026-10-29 on klyro 14b91326, end to end through
 * the real runtime with the model replaced by a script:
 *
 *   English greeting → "Hello" → Telugu booking request → Telugu "what
 *   slots are free today?" asked repeatedly, answered with "I can't hear
 *   you clearly" → English → slots → Hindi "4 PM" → caller-ID consent,
 *   service, name, confirmation → no booking confirmation.
 *
 * The model's state block is deliberately unhelpful here (it never proposes
 * checking availability and never carries the phone number), exactly as on
 * that call: what must make the call work is the runtime's own reading of
 * the caller's words in their language.
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
  { id: "svc-cleaning", name: "Cleaning", duration_minutes: 30 },
  { id: "svc-root-canal", name: "Root Canal Treatment", duration_minutes: 60 },
];
const CALLER = "+919876543210";
/** The test calendar's timezone falls back to UTC (no database in unit tests). */
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date());
const at = (hhmm: string) => ({
  start: `${TODAY}T${hhmm}:00.000Z`,
  end: `${TODAY}T${hhmm.slice(0, 2)}:30:00.000Z`,
});
const SLOT_4PM = at("16:00");
const SLOT_5PM = at("17:00");

type ToolResult = { content: string; isError?: boolean };
const ok = (data: Record<string, unknown>): ToolResult => ({
  content: JSON.stringify({ success: true, data }),
});
const BOOKED: ToolResult = {
  content: JSON.stringify({
    success: true,
    data: { id: "booking-1", status: "CONFIRMED", startAt: SLOT_4PM.start, endAt: SLOT_4PM.end },
    bookingOutcome: "confirmed",
  }),
};

function marker(state: Record<string, unknown> = {}): string {
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

async function drain(hops = 400) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

async function openCall(opts: { availability?: ToolResult[]; booking?: ToolResult[] } = {}) {
  const h: Harness = createHarness();
  const voices: { voice: string; from: number }[] = [];
  const connect = h.deps.connectTts;
  h.deps.connectTts = async (o) => {
    const session = await connect(o);
    voices.push({ voice: o.language, from: h.tts.sentTexts.length });
    return session;
  };
  const availability = opts.availability ?? [ok({ slots: [SLOT_4PM, SLOT_5PM] })];
  const booking = opts.booking ?? [BOOKED];
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
  h.deps.generateReply = async (messages) => {
    // The separate phrasing model (English outcomes only) — never trusted
    // to claim a booking; a plain factual line is enough here.
    if (/a phone receptionist\. Respond in language code/.test(messages[0]?.content ?? "")) {
      return { reply: "That time is available. Would you like me to book it?" };
    }
    return conversational(messages);
  };
  const callId = `flow-${crypto.randomUUID()}`;
  const input: StartRuntimeSessionInput = {
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
  };
  await startRuntimeSession(input, h.deps);
  let flushed = 0;
  /** One caller turn (a final transcript with Sarvam's label); what was said back, with its voice. */
  const turn = async (said: string, reply: string, language: string, confidence = 0.9) => {
    while (flushed < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      flushed++;
    }
    h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "final_transcript", text: said, language, languageConfidence: confidence });
    await drain();
    return h.tts.sentTexts.slice(before).map((text, i) => {
      const owner = [...voices].reverse().find((v) => v.from <= before + i);
      return { voice: owner?.voice ?? "unknown", text };
    });
  };
  const calls = (name: string) => h.tools.calls.filter((c) => c.name === name);
  return { h, callId, turn, calls };
}

const text = (chunks: { text: string }[]) =>
  chunks
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ");
const voicesOf = (chunks: { voice: string }[]) => [...new Set(chunks.map((c) => c.voice))];

describe("the 2026-10-29 call, end to end", () => {
  test("Telugu availability reaches the calendar; a Hindi booking completes exactly once", async () => {
    const { callId, turn, calls } = await openCall();

    const hello = await turn("Hello", "Hello! How can I help you today?" + marker(), "en-IN", 1);
    assert.deepEqual(voicesOf(hello), ["en-IN"]);

    const wants = await turn(
      "నాకు అపాయింట్మెంట్ బుక్ చేయాలి",
      "తప్పకుండా. మీకు ఏ రోజు కావాలి?" + marker(),
      "te-IN",
    );
    assert.deepEqual(voicesOf(wants), ["te-IN"], "Telugu from the first meaningful sentence");

    // The model answers the availability question with "I can't hear you
    // clearly" and no availability proposal — as on the real call.
    const slots = await turn(
      "ఈరోజు ఏ టైం స్లాట్స్ అందుబాటులో ఉన్నాయి?",
      "క్షమించండి, మీ మాట స్పష్టంగా వినిపించలేదు." + marker(),
      "te-IN",
      0.8,
    );
    assert.equal(calls("check_calendar_availability").length, 1, text(slots));
    assert.equal(calls("check_calendar_availability")[0]!.input["dateIso"], TODAY);
    assert.doesNotMatch(text(slots), /వినిపించలేదు/, "never blamed on hearing");
    assert.ok(
      text(slots).includes(
        callOutcomeLine("te-IN", "slotsOnDate", {
          date: TODAY,
          slotStarts: [SLOT_4PM.start, SLOT_5PM.start],
          timeZone: "UTC",
        })!.replace(/\s+/g, " "),
      ),
      text(slots),
    );
    assert.deepEqual(voicesOf(slots), ["te-IN"]);

    // Hindi: service and time in one sentence — "cleaning" in Devanagari.
    await turn(
      "आज शाम चार बजे क्लीनिंग का अपॉइंटमेंट चाहिए",
      "ज़रूर। आपका नाम क्या है?" + marker(),
      "hi-IN",
    );
    // The name, carried by the model's state block (the runtime's own name
    // reading is English-only); the completed details check that slot.
    const name = await turn(
      "मेरा नाम धनुष है",
      "धन्यवाद धनुष जी।" + marker({ customer_name: "Dhanush" }),
      "hi-IN",
    );
    assert.equal(calls("check_calendar_availability").length, 2, text(name));
    assert.deepEqual(voicesOf(name), ["hi-IN"]);

    // The caller says yes to the runtime's own "that time is available —
    // shall I book it?"; the phone number is still missing, so nothing is
    // booked yet and the runtime asks the caller-ID question, in Hindi.
    assert.match(text(name), /बुक कर दें\?/, text(name));
    const yes = await turn("हाँ", "ठीक है।" + marker({ customer_name: "Dhanush" }), "hi-IN");
    assert.ok(text(yes).includes(CALLER_ID_QUESTION_BY_LANGUAGE["hi-IN"]), text(yes));
    assert.equal(calls("book_appointment").length, 0, "nothing booked without a phone number");
    assert.doesNotMatch(text(yes), /कन्फर्म हो गया/, "no success before the backend says so");

    // "Yes, this number" in Hindi settles the phone. The booking the caller
    // already said yes to is now complete, so it is made — once — and only
    // the stored outcome is announced, never the model's own claim.
    const book = await turn(
      "हाँ जी, इसी नंबर पर",
      "आपका अपॉइंटमेंट बुक हो गया है!" + marker({ customer_name: "Dhanush", ready_to_book: true }),
      "hi-IN",
    );
    assert.equal(calls("book_appointment").length, 1, text(book));
    const booked = calls("book_appointment")[0]!.input;
    assert.equal(booked["startIso"], SLOT_4PM.start);
    assert.equal(booked["customerPhone"] ?? booked["phone"], CALLER);
    assert.ok(
      text(book).includes(
        callOutcomeLine("hi-IN", "bookingConfirmed", {
          service: "Cleaning",
          date: TODAY,
          time: "16:00",
        })!.replace(/\s+/g, " "),
      ),
      text(book),
    );
    assert.deepEqual(voicesOf(book), ["hi-IN"]);

    // Repeated confirmations never book twice.
    await turn(
      "हाँ, बुक कर दो",
      "ठीक है।" + marker({ customer_name: "Dhanush", ready_to_book: true }),
      "hi-IN",
    );
    await turn("हाँ हाँ", "ठीक है।" + marker({ customer_name: "Dhanush" }), "hi-IN");
    assert.equal(calls("book_appointment").length, 1, "exactly one booking");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a failed booking is never announced as booked, in Telugu", async () => {
    const { callId, turn, calls } = await openCall({
      booking: [
        {
          content: JSON.stringify({ success: false, error: { code: "INTERNAL", message: "x" } }),
          isError: true,
        },
      ],
    });
    await turn(
      "నాకు ఈరోజు సాయంత్రం 4 గంటలకు క్లీనింగ్ కావాలి",
      "సరే. మీ పేరు?" + marker(),
      "te-IN",
    );
    await turn("నా పేరు ధనుష్", "ధన్యవాదాలు." + marker({ customer_name: "Dhanush" }), "te-IN");
    await turn("అవును", "సరే." + marker({ customer_name: "Dhanush" }), "te-IN");
    // Consent to the number completes the booking the caller said yes to;
    // the backend fails it, and the model's "booked!" is never said.
    const chunks = await turn(
      "అవును అండి",
      "మీ అపాయింట్మెంట్ బుక్ అయింది!" + marker({ customer_name: "Dhanush", ready_to_book: true }),
      "te-IN",
    );
    assert.equal(calls("book_appointment").length, 1, text(chunks));
    assert.doesNotMatch(text(chunks), /బుక్ అయింది!/, text(chunks));
    assert.ok(text(chunks).includes(callOutcomeLine("te-IN", "bookingFailed")!), text(chunks));
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("English callers are unchanged: the same availability question in English", async () => {
    const { callId, turn, calls } = await openCall();
    const chunks = await turn(
      "What slots are available today?",
      "Let me see." + marker(),
      "en-IN",
      0.95,
    );
    assert.equal(calls("check_calendar_availability").length, 1, text(chunks));
    assert.equal(calls("check_calendar_availability")[0]!.input["dateIso"], TODAY);
    assert.deepEqual(voicesOf(chunks), ["en-IN"]);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("today's slots, asked in every supported language", () => {
  const ASK_TODAY: [string, string][] = [
    ["hi-IN", "आज कौन से स्लॉट खाली हैं?"],
    ["te-IN", "ఈరోజు ఏ టైం స్లాట్స్ అందుబాటులో ఉన్నాయి?"],
    ["ta-IN", "இன்று எந்த ஸ்லாட் காலியாக இருக்கிறது?"],
    ["kn-IN", "ಇಂದು ಯಾವ ಸ್ಲಾಟ್ ಖಾಲಿ ಇದೆ?"],
    ["ml-IN", "ഇന്ന് ഏത് സ്ലോട്ട് ഒഴിവുണ്ട്?"],
    ["bn-IN", "আজ কোন স্লট খালি আছে?"],
    ["mr-IN", "आज कोणता स्लॉट रिकामा आहे?"],
    ["gu-IN", "આજે કયો સ્લોટ ખાલી છે?"],
    ["pa-IN", "ਅੱਜ ਕਿਹੜਾ ਸਲਾਟ ਖਾਲੀ ਹੈ?"],
    ["od-IN", "ଆଜି କେଉଁ ସ୍ଲଟ ଖାଲି ଅଛି?"],
    ["en-IN", "Which slots are free today?"],
  ];
  assert.equal(ASK_TODAY.length, VOICE_LANGUAGES.length);
  for (const [code, said] of ASK_TODAY) {
    test(`${code}: the real calendar is checked for today, and its slots are said in ${code}`, async () => {
      const { callId, turn, calls } = await openCall();
      const label = code === "od-IN" ? "or-IN" : code;
      const chunks = await turn(said, "..." + marker(), label);
      assert.equal(calls("check_calendar_availability").length, 1, `${code}: ${text(chunks)}`);
      assert.equal(calls("check_calendar_availability")[0]!.input["dateIso"], TODAY);
      assert.deepEqual(voicesOf(chunks), [code]);
      // English wording comes from the (scripted) phrasing model; every
      // other language is the runtime's own sentence with the real slots.
      if (code !== "en-IN") {
        assert.match(text(chunks), /4|৪|४|౪|೪|൪|੪|୪|௪/, `the real 4 PM slot: ${text(chunks)}`);
      }
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test("no slots today is said truthfully, never invented", async () => {
    const { callId, turn, calls } = await openCall({ availability: [ok({ slots: [] })] });
    const chunks = await turn("ఈరోజు స్లాట్స్ ఖాళీ ఉన్నాయా?", "..." + marker(), "te-IN");
    assert.equal(calls("check_calendar_availability").length, 1);
    assert.ok(
      text(chunks).includes(callOutcomeLine("te-IN", "noSlotsOnDate", { date: TODAY })!),
      text(chunks),
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a calendar failure is reported as a calendar problem, not a hearing problem", async () => {
    const { callId, turn } = await openCall({
      availability: [
        {
          content: JSON.stringify({ success: false, error: { code: "INTERNAL", message: "x" } }),
          isError: true,
        },
      ],
    });
    const chunks = await turn("आज कौन से स्लॉट खाली हैं?", "..." + marker(), "hi-IN");
    assert.ok(
      text(chunks).includes(callOutcomeLine("hi-IN", "calendarCheckFailed")!),
      text(chunks),
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("booking signals in the caller's own words", () => {
  test("availability, dates and times, in native script, romanized and code-mixed", () => {
    const cases: [string, Partial<ReturnType<typeof parseCallerIntentFromText>>][] = [
      [
        "ఈరోజు ఏ టైం స్లాట్స్ అందుబాటులో ఉన్నాయి?",
        { availabilityRequested: true, relativeDate: "today" },
      ],
      ["मुझे आज के available slots बताइए।", { availabilityRequested: true, relativeDate: "today" }],
      ["What slots are available today?", { availabilityRequested: true, relativeDate: "today" }],
      [
        "आज शाम चार बजे",
        { relativeDate: "today", preferredPeriod: "evening", explicitTime: "16:00" },
      ],
      [
        "రేపు సాయంత్రం 4 గంటలకు",
        { relativeDate: "tomorrow", preferredPeriod: "evening", explicitTime: "16:00" },
      ],
      ["సాయంత్రం నాలుగింటికి", { explicitTime: "16:00" }],
      ["रेपु", { relativeDate: null }],
      ["कल सुबह दस बजे", { relativeDate: "tomorrow", explicitTime: "10:00" }],
      ["साढ़े तीन बजे", { explicitTime: "15:30" }],
      ["४ बजे", { explicitTime: "16:00" }],
      ["aaj 4 baje", { relativeDate: "today", explicitTime: "16:00" }],
      ["repu 11 gantalaki", { relativeDate: "tomorrow", explicitTime: "11:00" }],
      // Not times: a duration, a plain number, a name.
      ["ఒక గంట పడుతుందా?", { explicitTime: null }],
      ["मेरे दो बच्चे हैं", { explicitTime: null }],
      ["My name is Kalpana", { relativeDate: null }],
      ["I have 4 kids", { explicitTime: null, availabilityRequested: false }],
    ];
    for (const [said, expected] of cases) {
      const got = parseCallerIntentFromText(said);
      for (const [k, v] of Object.entries(expected)) {
        assert.deepEqual(got[k as keyof typeof got], v, `${said} → ${k}`);
      }
    }
  });

  test("native digits read as numbers", () => {
    assert.equal(asciiDigits("౪ గంటలకు, ४ बजे, ৪টা"), "4 గంటలకు, 4 बजे, 4টা");
    assert.equal(explicitTimeAnyLanguage("৪টায়"), "16:00");
  });

  test("caller-ID consent in Telugu and Hindi, and 'a different number'", () => {
    const offered = { phone: null, callerIdChoice: "offered" as const };
    for (const yes of [
      "అవును",
      "అవును అండి",
      "సరే",
      "ఇదే నంబర్",
      "हाँ",
      "हाँ जी, इसी नंबर पर",
      "जी हाँ",
    ]) {
      assert.equal(resolveCallerIdAnswer(yes, offered, CALLER)?.callerIdChoice, "accepted", yes);
      assert.equal(resolveCallerIdAnswer(yes, offered, CALLER)?.phone, CALLER, yes);
    }
    for (const no of ["వేరే నంబర్", "లేదు", "नहीं", "दूसरा नंबर दूँगा"]) {
      assert.equal(resolveCallerIdAnswer(no, offered, CALLER)?.callerIdChoice, "declined", no);
      assert.equal(resolveCallerIdAnswer(no, offered, CALLER)?.phone, undefined, no);
    }
    // A different number spoken as digits is that number, never the caller ID.
    const spoken = resolveCallerIdAnswer("వేరే నంబర్ 98480 12345", offered, CALLER, "IN");
    assert.equal(spoken?.phone, "+919848012345");
  });

  test("the model's question about a number becomes the runtime's own caller-ID question", () => {
    const state = { phone: null, callerIdChoice: "not_offered" as const };
    const telugu = applyCallerIdOfferAnyLanguage(
      "ధన్యవాదాలు ధనుష్ గారు. మీ ఫోన్ నంబర్ చెప్తారా?",
      "te-IN",
      state,
    );
    assert.equal(telugu.offered, true);
    assert.equal(telugu.reply, `ధన్యవాదాలు ధనుష్ గారు. ${CALLER_ID_QUESTION_BY_LANGUAGE["te-IN"]}`);
    assert.equal(
      applyCallerIdOfferAnyLanguage("मैं आपका नाम नोट कर रहा हूँ।", "hi-IN", state).offered,
      false,
    );
    assert.equal(
      applyCallerIdOfferAnyLanguage("आपका नंबर क्या है?", "hi-IN", {
        phone: "+919876543210",
        callerIdChoice: "accepted",
      }).offered,
      false,
      "never once the number is known",
    );
  });

  test("dental services said in Indian scripts match the configured English names", () => {
    for (const said of [
      "క్లీనింగ్ కావాలి",
      "क्लीनिंग करानी है",
      "க்ளீனிங் வேண்டும்",
      "দাঁত ক্লিনিং",
    ]) {
      const match = resolveServiceFromText(SERVICES, said);
      assert.equal(match.kind === "match" && match.row.name, "Cleaning", said);
    }
    const rootCanal = resolveServiceFromText(SERVICES, "రూట్ కెనాల్ చేయించుకోవాలి");
    assert.equal(rootCanal.kind === "match" && rootCanal.row.name, "Root Canal Treatment");
  });

  test("a stray word in another script is dropped, not the whole answer", () => {
    assert.equal(
      speakablePart("ఈరోజు సాయంత్రం 4 గంటలకు స్లాట్ ఖాళీగా ఉంది, ठीक బుక్ చేయమంటారా?", "te-IN"),
      "ఈరోజు సాయంత్రం 4 గంటలకు స్లాట్ ఖాళీగా ఉంది, బుక్ చేయమంటారా?",
    );
    assert.equal(speakablePart("आज शाम चार बजे का स्लॉट खाली है।", "te-IN"), null);
  });
});
