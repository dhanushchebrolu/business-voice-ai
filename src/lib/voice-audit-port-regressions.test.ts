import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  callerAuthorizesBooking,
  chunkIntoSentences,
  emptyAppointmentState,
  mergeAppointmentState,
  resolveCallerIdAnswer,
  startRuntimeSession,
  terminateRuntimeSession,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import { callOutcomeLine } from "./voice-call-outcomes.ts";
import {
  CALLER_ID_QUESTION_BY_LANGUAGE,
  CALLER_ID_REJECTED,
  parseNameIntroduction,
  removeMessageSentClaims,
  splitSentences,
} from "./voice-intent-lexicon.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ServiceRow } from "./service-matching.ts";
import type { CallerBooking } from "./calendar/caller-bookings.server.ts";

/**
 * Regressions for the pre-deployment audit of the multilingual voice agent,
 * re-verified against this branch's implementation: caller-ID rejection,
 * names given with a negation, protected tokens (emails, URLs, prices) in
 * TTS chunks, unsupported "message sent" claims, and English hesitation
 * read as booking consent. Pure helpers first, then the real runtime
 * through the deterministic harness (model, STT, TTS, calendar and
 * telephony mocked — no call is placed, nothing is booked or sent).
 */

const CALLER = "+919876543210";
const OTHER = "+919845012345";

/* ------------------------------------------------------------------ */
/* Caller ID                                                           */
/* ------------------------------------------------------------------ */

describe("caller ID: rejecting the calling number never selects it", () => {
  const offered = { phone: null, callerIdChoice: "offered" as const };

  for (const said of [
    "ఈ నెంబర్ కాదు",
    "ఆ నెంబర్ కాదు, వేరేది",
    "same number kaadu",
    "ee number vaddu",
    "यह नंबर नहीं",
    "इस नंबर पर नहीं",
    "not this number",
    "don't use this number",
  ]) {
    test(`"${said}" answering the caller-ID question is declined`, () => {
      assert.ok(CALLER_ID_REJECTED.test(said), "recognised as a rejection");
      const r = resolveCallerIdAnswer(said, offered, CALLER, "IN");
      assert.equal(r?.callerIdChoice, "declined");
      assert.equal(r?.phone ?? null, null, "caller ID never selected");
    });
  }

  test("a rejection with no question pending selects nothing", () => {
    for (const said of ["ఈ నెంబర్ కాదు", "same number kaadu", "not this number"]) {
      const r = resolveCallerIdAnswer(said, { phone: null, callerIdChoice: "not_offered" }, CALLER);
      assert.equal(r?.phone ?? null, null, said);
    }
  });

  test("consent still selects caller ID, including a correction toward it", () => {
    for (const said of [
      "ఇదే నెంబర్ వాడండి",
      "అవును",
      "haan isi number pe",
      "use this number",
      "కాదు, ఇదే నెంబర్ వాడండి",
    ]) {
      const r = resolveCallerIdAnswer(said, offered, CALLER, "IN");
      assert.equal(r?.callerIdChoice, "accepted", said);
      assert.equal(r?.phone, CALLER, said);
    }
  });

  test("a contradictory answer gets one clarification, never acceptance", () => {
    for (const said of ["అవును, ఈ నెంబర్ కాదు", "yes, not this number"]) {
      const r = resolveCallerIdAnswer(said, offered, CALLER, "IN");
      assert.equal(r?.callerIdChoice, "clarifying", said);
      assert.equal(r?.phone ?? null, null, said);
    }
    const again = resolveCallerIdAnswer(
      "yes, not this number",
      { phone: null, callerIdChoice: "clarifying" },
      CALLER,
    );
    assert.equal(again?.callerIdChoice, "declined");
    assert.equal(again?.phone ?? null, null);
  });

  test("a rejection after caller ID was taken clears it; a caller-given number is kept", () => {
    const taken = {
      phone: CALLER,
      callerIdChoice: "accepted" as const,
      phoneSource: "caller_id" as const,
    };
    for (const said of ["ఈ నెంబర్ కాదు", "same number kaadu", "not this number"]) {
      const r = resolveCallerIdAnswer(said, taken, CALLER, "IN");
      assert.equal(r?.callerIdChoice, "declined", said);
      assert.equal(r?.phone, null, said);
    }
    const provided = {
      phone: OTHER,
      callerIdChoice: "declined" as const,
      phoneSource: "caller_provided" as const,
    };
    for (const said of ["same number kaadu", "ఈ నెంబర్ కాదు"]) {
      assert.equal(resolveCallerIdAnswer(said, provided, CALLER, "IN"), null, said);
    }
  });

  test("'not that one' about a slot or service never touches an accepted caller ID", () => {
    const taken = {
      phone: CALLER,
      callerIdChoice: "accepted" as const,
      phoneSource: "caller_id" as const,
    };
    for (const said of [
      "no, not that one, the later one",
      "not this one",
      "don't use that time",
      "ఆ టైం కాదు",
    ]) {
      assert.equal(CALLER_ID_REJECTED.test(said), false, said);
      assert.equal(resolveCallerIdAnswer(said, taken, CALLER, "IN"), null, said);
    }
  });

  test("after a decline, the model's state block cannot re-select the caller ID", () => {
    const declined = { ...emptyAppointmentState(), callerIdChoice: "declined" as const };
    const merged = mergeAppointmentState(declined, { phone: "9876543210" }, { phoneCountry: "IN" });
    assert.equal(merged.phone, null);
    // Before any decline the marker still fills the gap, as before.
    const fresh = { ...emptyAppointmentState(), callerIdChoice: "not_offered" as const };
    assert.equal(
      mergeAppointmentState(fresh, { phone: "9845012345" }, { phoneCountry: "IN" }).phone,
      OTHER,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

describe("names: corrections with a negation, refusals and fillers", () => {
  test("'X కాదు, Y' / 'X nahi, Y' / 'my name is not X, it is Y' give Y and reject X", () => {
    for (const [said, name, rejected] of [
      ["నా పేరు రవి కాదు, రాజు", "రాజు", "రవి"],
      ["naa peru Ravi kaadu, Raju", "Raju", "Ravi"],
      ["mera naam Ravi nahi, Raju", "Raju", "Ravi"],
      ["मेरा नाम रवि नहीं, राजू है", "राजू", "रवि"],
      ["my name is not Ravi, it is Raju", "Raju", "Ravi"],
      ["My name isn't Ravi, it's Raju", "Raju", "Ravi"],
    ] as const) {
      assert.deepEqual(parseNameIntroduction(said), { name, rejected }, said);
    }
  });

  test("refusals, fillers and a bare negation are never a name", () => {
    for (const said of [
      "నా పేరు చెప్పాను కదా",
      "naa peru cheppanu kada",
      "mera naam nahi bataunga",
      "मेरा नाम बताया था",
      "నా పేరు రవి కాదు",
      "my name is not Ravi",
    ]) {
      assert.equal(parseNameIntroduction(said)?.name ?? null, null, said);
    }
    assert.equal(parseNameIntroduction("నా పేరు రవి కాదు")?.rejected, "రవి");
    assert.equal(parseNameIntroduction("I need a cleaning"), null);
  });
});

/* ------------------------------------------------------------------ */
/* Protected tokens in TTS chunks                                      */
/* ------------------------------------------------------------------ */

describe("TTS chunks never split an email, URL, price or title", () => {
  test("splitSentences keeps protected tokens and rejoins exactly", () => {
    const text =
      "The fee is ₹1,499.50. Email clinic@example.com or visit https://smile.example.in/book. Dr. Rao sees you at 6.30 PM. धन्यवाद। Call 98765 43210.";
    const pieces = splitSentences(text);
    assert.equal(pieces.join(""), text);
    assert.deepEqual(
      pieces.map((p) => p.trim()),
      [
        "The fee is ₹1,499.50.",
        "Email clinic@example.com or visit https://smile.example.in/book.",
        "Dr. Rao sees you at 6.30 PM.",
        "धन्यवाद।",
        "Call 98765 43210.",
      ],
    );
  });

  test("chunkIntoSentences sends each protected token whole", () => {
    const chunks = chunkIntoSentences(
      "Our WhatsApp is 98765 43210, email clinic@example.com. The fee is ₹1,499.50 only. Visit https://smile.example.in/book today. Dr. Rao will see you.",
    );
    const joined = chunks.join(" ");
    for (const token of [
      "clinic@example.com",
      "₹1,499.50",
      "https://smile.example.in/book",
      "Dr. Rao",
      "98765 43210",
    ]) {
      assert.ok(
        chunks.some((c) => c.includes(token)),
        `${token} kept whole in one chunk: ${JSON.stringify(chunks)}`,
      );
    }
    assert.doesNotMatch(joined, /example\. com|1,499\. 50|smile\. example/);
  });

  test("danda-ended sentences and short fragments still chunk as before", () => {
    assert.deepEqual(
      chunkIntoSentences(
        "नमस्ते, स्माइल डेंटल में आपका स्वागत है। आज मैं आपकी क्या मदद कर सकती हूँ?",
      ),
      ["नमस्ते, स्माइल डेंटल में आपका स्वागत है।", "आज मैं आपकी क्या मदद कर सकती हूँ?"],
    );
    assert.deepEqual(
      chunkIntoSentences("Ok. Yes. Sure, no problem at all, happy to help with that."),
      ["Ok. Yes. Sure, no problem at all, happy to help with that."],
    );
  });
});

/* ------------------------------------------------------------------ */
/* Message-sent claims                                                 */
/* ------------------------------------------------------------------ */

describe("message-sent guard: unsupported claims removed, contact details kept", () => {
  for (const reply of [
    "You can also send us a WhatsApp message at 98765 43210.",
    "For anything else, email to clinic@example.com.",
    "I can't send a text, but you can WhatsApp us at 98765 43210.",
    "మాకు వాట్సాప్ లో మెసేజ్ చేయండి 98765 43210.",
    "हमें व्हाट्सएप पर मैसेज भेजें।",
    "SMS పంపలేను, క్షమించండి.",
    "The consultation fee is ₹1,499.50. Our email is clinic@example.com.",
    "You will get the details at the front desk.",
  ]) {
    test(`kept verbatim: "${reply}"`, () => {
      assert.deepEqual(removeMessageSentClaims(reply), { reply, removed: 0 });
    });
  }
  for (const reply of [
    "We'll text you the details.",
    "A confirmation has been sent to your phone.",
    "I will send you the details on WhatsApp.",
    "You'll receive an SMS shortly.",
    "మెసేజ్ ద్వారా తెలియజేస్తాము.",
    "మీకు వాట్సాప్ మెసేజ్ పంపిస్తాము.",
    "మీకు SMS వస్తుంది, ఏ సమస్య లేదు.",
    "आपको व्हाट्सएप पर कन्फर्मेशन मिल जाएगा।",
  ]) {
    test(`removed: "${reply}"`, () => {
      assert.deepEqual(removeMessageSentClaims(reply), { reply: "", removed: 1 });
    });
  }
  test("only the claim goes; the facts around it stay byte-for-byte", () => {
    const r = removeMessageSentClaims(
      "Your fee is ₹1,499.50. I've sent the confirmation to your WhatsApp. Email clinic@example.com for changes.",
    );
    assert.deepEqual(r, {
      reply: "Your fee is ₹1,499.50. Email clinic@example.com for changes.",
      removed: 1,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Booking hesitation                                                  */
/* ------------------------------------------------------------------ */

describe("booking: hesitation is not consent", () => {
  const Q = "Shall I book it?";
  const asked = `Just to confirm — Cleaning today at 4 PM for Dhanush. ${Q}`;
  test("a 'yes' with a pause, a condition or 'let me think' never authorizes", () => {
    for (const said of [
      "yes, one second",
      "yes, just a minute",
      "yes, hold on",
      "sure, let me think",
      "yes but actually",
      "yes, but wait",
      "అవును, కానీ ఒక్క నిమిషం",
      "haan lekin ek minute",
    ]) {
      assert.equal(callerAuthorizesBooking(said, asked, Q), false, said);
    }
  });
  test("clear consent still authorizes", () => {
    for (const said of [
      "yes",
      "Yes, book it",
      "sure, go ahead",
      "అవును",
      "బుక్ చేయండి",
      "हाँ, बुक कर दो",
    ]) {
      assert.equal(callerAuthorizesBooking(said, asked, Q), true, said);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Through the real runtime                                            */
/* ------------------------------------------------------------------ */

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
const SERVICES: ServiceRow[] = [{ id: "svc-cleaning", name: "Cleaning", duration_minutes: 30 }];
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date());
const SLOT = { start: `${TODAY}T16:00:00.000Z`, end: `${TODAY}T16:30:00.000Z` };
type ToolResult = { content: string; isError?: boolean };
const ok = (data: Record<string, unknown>): ToolResult => ({
  content: JSON.stringify({ success: true, data }),
});

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

/** A call with an idempotent in-memory calendar (one row per call and slot, like the real key). */
async function openCall(setup?: (h: Harness) => void) {
  const h = createHarness();
  const rows = new Map<string, Record<string, unknown>>();
  const record = h.deps.executeTool!;
  h.deps.executeTool = async (name, toolInput, ctx) => {
    await record(name, toolInput, ctx);
    if (name === "check_calendar_availability") return ok({ slots: [SLOT] });
    if (name === "book_appointment") {
      const key = `voice:${ctx.callId}:${toolInput["startIso"]}`;
      if (!rows.has(key)) rows.set(key, { ...toolInput, id: `b-${rows.size + 1}` });
      return {
        content: JSON.stringify({
          success: true,
          data: {
            id: rows.get(key)!["id"],
            status: "CONFIRMED",
            startAt: SLOT.start,
            endAt: SLOT.end,
          },
          bookingOutcome: "confirmed",
        }),
      };
    }
    return ok({});
  };
  const conversational = h.deps.generateReply;
  h.deps.generateReply = async (messages) => {
    if (/a phone receptionist\. Respond in language code/.test(messages[0]?.content ?? "")) {
      return { reply: "That time is available. Would you like me to book it?" };
    }
    return conversational(messages);
  };
  setup?.(h);
  const callId = `audit-port-${crypto.randomUUID()}`;
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
  const turn = async (said: string, reply: string, language: string) => {
    while (flushed < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      flushed++;
    }
    h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "final_transcript", text: said, language, languageConfidence: 0.9 });
    await drain();
    return h.tts.sentTexts.slice(before).join(" ").replace(/\s+/g, " ");
  };
  const booked = () => h.tools.calls.filter((c) => c.name === "book_appointment");
  return { h, callId, turn, booked, rows };
}

/** Telugu: service/time, then the name, then "yes" — the runtime then asks the caller-ID question. */
async function teluguUpToCallerIdQuestion(turn: Awaited<ReturnType<typeof openCall>>["turn"]) {
  await turn("నాకు ఈరోజు సాయంత్రం 4 గంటలకు క్లీనింగ్ కావాలి", "సరే. మీ పేరు?" + marker(), "te-IN");
  await turn("నా పేరు ధనుష్", "ధన్యవాదాలు." + marker({ customer_name: "Dhanush" }), "te-IN");
  const asked = await turn("అవును", "సరే." + marker({ customer_name: "Dhanush" }), "te-IN");
  assert.ok(asked.includes(CALLER_ID_QUESTION_BY_LANGUAGE["te-IN"]), asked);
}

describe("runtime: caller-ID rejection end to end", () => {
  for (const said of ["ఈ నెంబర్ కాదు", "same number kaadu", "not this number"]) {
    test(`"${said}" to the caller-ID question: nothing is ever booked on the calling number`, async () => {
      const { callId, turn, booked } = await openCall();
      await teluguUpToCallerIdQuestion(turn);
      // The model re-types the caller ID into its state block — never used.
      await turn(
        said,
        "సరే." + marker({ customer_name: "Dhanush", phone: "9876543210", ready_to_book: true }),
        "te-IN",
      );
      await turn(
        "బుక్ చేయండి",
        "బుక్ చేస్తున్నాను." +
          marker({ customer_name: "Dhanush", phone: "9876543210", ready_to_book: true }),
        "te-IN",
      );
      await turn(
        "అవును",
        "సరే." + marker({ customer_name: "Dhanush", ready_to_book: true }),
        "te-IN",
      );
      for (const call of booked()) {
        assert.notEqual(call.input["customerPhone"] ?? call.input["phone"], CALLER);
      }
      assert.equal(booked().length, 0, "no number given yet: nothing booked");
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test("consent still books once, on the caller ID, with the read-back first", async () => {
    const { callId, turn, booked } = await openCall();
    await teluguUpToCallerIdQuestion(turn);
    const summary = await turn(
      "అవును అండి",
      "సరే." + marker({ customer_name: "Dhanush", ready_to_book: true }),
      "te-IN",
    );
    assert.match(summary, /బుక్ చేయమంటారా\?/, summary);
    await turn(
      "బుక్ చేయండి",
      "సరే." + marker({ customer_name: "Dhanush", ready_to_book: true }),
      "te-IN",
    );
    await turn(
      "బుక్ చేయండి",
      "సరే." + marker({ customer_name: "Dhanush", ready_to_book: true }),
      "te-IN",
    );
    assert.equal(booked().length, 1, "booked once; the repeat never books twice");
    assert.equal(booked()[0]!.input["customerPhone"] ?? booked()[0]!.input["phone"], CALLER);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("runtime: a negated name correction outranks the model's stale name", () => {
  for (const [said, expected, language] of [
    ["my name is not Ravi, it is Raju", "Raju", "en-IN"],
    ["naa peru Ravi kaadu, Raju", "Raju", "te-IN"],
    ["నా పేరు రవి కాదు, రాజు", "రాజు", "te-IN"],
  ] as const) {
    test(`"${said}" is the name read back and booked`, async () => {
      const { callId, turn, booked } = await openCall();
      await turn(
        "I need a cleaning today at 4 PM, my name is Ravi",
        "Sure." + marker({ customer_name: "Ravi" }),
        "en-IN",
      );
      await turn(said, "Okay." + marker({ customer_name: "Ravi" }), language);
      await turn(
        "Use this same number",
        "Okay." + marker({ customer_name: "Ravi", ready_to_book: true }),
        "en-IN",
      );
      await turn(
        "Yes, book it",
        "Booking." + marker({ customer_name: "Ravi", ready_to_book: true }),
        "en-IN",
      );
      assert.equal(booked().length, 1);
      assert.equal(booked()[0]!.input["customerName"], expected);
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test("'నా పేరు చెప్పాను కదా' never becomes the name", async () => {
    const { callId, turn, booked } = await openCall();
    await turn(
      "నాకు ఈరోజు సాయంత్రం 4 గంటలకు క్లీనింగ్ కావాలి",
      "సరే. మీ పేరు?" + marker(),
      "te-IN",
    );
    await turn("నా పేరు చెప్పాను కదా", "క్షమించండి, మీ పేరు?" + marker(), "te-IN");
    await turn("నా పేరు ధనుష్", "ధన్యవాదాలు." + marker(), "te-IN");
    await turn("అవును", "సరే." + marker(), "te-IN");
    await turn("అవును అండి", "సరే." + marker({ ready_to_book: true }), "te-IN");
    await turn("బుక్ చేయండి", "సరే." + marker({ ready_to_book: true }), "te-IN");
    assert.equal(booked().length, 1, "the booking still completes");
    assert.equal(booked()[0]!.input["customerName"], "ధనుష్");
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("runtime: hesitation never books; one clear yes books once", () => {
  test("'yes, one second' then 'yes, hold on' then 'yes' — exactly one booking", async () => {
    const { callId, turn, booked } = await openCall();
    const m = marker({ customer_name: "Dhanush" });
    await turn("I need a cleaning today at 4 PM", "Sure. Your name?" + marker(), "en-IN");
    await turn("my name is Dhanush", "Thanks." + m, "en-IN");
    await turn("yes", "Okay." + m, "en-IN");
    const summary = await turn("Use this same number", "Okay." + m, "en-IN");
    assert.match(summary, /Shall I book it\?/, summary);
    const r = marker({ customer_name: "Dhanush", ready_to_book: true });
    await turn("yes, one second", "Booking." + r, "en-IN");
    assert.equal(booked().length, 0, "a pause is not consent");
    await turn("yes, hold on", "Booking." + r, "en-IN");
    assert.equal(booked().length, 0, "'hold on' is not consent");
    await turn("Okay, shall we continue?", "Sure. Shall I book it?" + m, "en-IN");
    await turn("Yes, book it", "Booking." + r, "en-IN");
    await turn("Yes, book it", "Booking." + r, "en-IN");
    assert.equal(booked().length, 1, "one booking, never two");
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("runtime: unsupported message-sent claims are never spoken", () => {
  test("English reply: the claim goes, the WhatsApp number and email stay", async () => {
    const { callId, turn } = await openCall();
    const spoken = await turn(
      "How can I contact the clinic?",
      "You can WhatsApp us at 98765 43210 or email clinic@example.com. We'll text you the details too." +
        marker(),
      "en-IN",
    );
    assert.match(spoken, /98765 43210/);
    assert.match(spoken, /clinic@example\.com/);
    assert.doesNotMatch(spoken, /text you/i, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("Telugu reply: an unrelated 'లేదు' does not let the claim through", async () => {
    const { callId, turn } = await openCall();
    const spoken = await turn(
      "మీరు ఈరోజు తెరిచి ఉన్నారా?",
      "మేము తెరిచి ఉన్నాము. మీకు SMS వస్తుంది, ఏ సమస్య లేదు." + marker(),
      "te-IN",
    );
    assert.match(spoken, /తెరిచి ఉన్నాము/);
    assert.doesNotMatch(spoken, /SMS/, spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("reply that is only a claim falls back to the step the call is on (never silence)", async () => {
    const { callId, turn } = await openCall();
    const spoken = await turn(
      "Okay",
      "A confirmation has been sent to your phone." + marker(),
      "en-IN",
    );
    assert.doesNotMatch(spoken, /sent to your phone/i, spoken);
    assert.ok(spoken.trim().length > 0, "the caller still hears something");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  for (const isError of [false, true]) {
    test(`a payment link ${isError ? "that failed to send is still never claimed" : "really sent this call may be mentioned"}`, async () => {
      const { callId, turn } = await openCall((h) => {
        h.deps.resolveAvailableTools = async () => [
          { name: "request_payment", description: "d", input_schema: { type: "object" } },
        ];
        h.deps.generateReplyWithTools = async () => ({
          reply: "I've sent the payment link to your WhatsApp.",
          toolCalls: [{ name: "request_payment", input: {}, isError }],
        });
      });
      const spoken = await turn("Please send me the payment link", "unused", "en-IN");
      if (isError) assert.doesNotMatch(spoken, /sent the payment link/i, spoken);
      else assert.match(spoken, /sent the payment link to your WhatsApp/, spoken);
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test("reschedule in Telugu: only the runtime's own sentence is spoken, never model claims", async () => {
    const booking: CallerBooking = {
      id: "b-1",
      startAt: "2030-10-14T06:30:00.000Z",
      endAt: "2030-10-14T07:00:00.000Z",
      timezone: "Asia/Kolkata",
      status: "CONFIRMED",
      serviceId: null,
      serviceName: "Root Canal Treatment",
      customerName: "Dhanush Kumar",
    };
    const { callId, turn } = await openCall((h) => {
      h.deps.findCallerBookings = async () => [booking];
      h.deps.generateReply = async () => ({
        reply: "మీ అపాయింట్‌మెంట్ చూశాను. మీకు వాట్సాప్ మెసేజ్ పంపిస్తాము.",
      });
    });
    const spoken = await turn("నా అపాయింట్‌మెంట్ reschedule చేయాలి", "unused", "te-IN");
    assert.doesNotMatch(spoken, /పంపిస్తాము|వాట్సాప్/, spoken);
    const expected = callOutcomeLine("te-IN", "rescheduleAskNewTime", {
      appointment: { service: "Root Canal Treatment", startIso: booking.startAt },
      timeZone: "Asia/Kolkata",
    })!;
    assert.ok(spoken.includes(expected.replace(/\s+/g, " ")), spoken);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});
