import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  callerAuthorizesBooking,
  emptyAppointmentState,
  injectPaymentEvent,
  isFillerOnly,
  mergeAppointmentState,
  parseCallerIntentFromText,
  quotesPrice,
  pickOption,
  servicesNamedIn,
  startRuntimeSession,
  terminateRuntimeSession,
  timesNamedIn,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { WHICH_ONE_QUESTION, isCorrection, optionReference } from "./voice-intent-lexicon.ts";
import {
  PRICE_AUTHORITY_NOTE,
  UNVERIFIED_PRICES_NOTE,
  withCurrentCallSections,
  type AgentSnapshot,
} from "./agent-instructions.ts";
import { resolveServiceFromText } from "./service-matching.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";
import type { ServiceRow } from "./service-matching.ts";

/**
 * Conversation context on a phone line: "the second one" and "the earlier
 * time" refer to what the agent just read out; "not tomorrow, today" means
 * today; a "yes" books only when it answers the booking question; quoted
 * prices are the current ones; and a cough or a "hmm" that interrupts the
 * agent never costs the caller their answer. Unit tests run the real
 * parsing; runtime tests drive the real runtime with fake STT/TTS/model.
 */

const SERVICES: ServiceRow[] = [
  { id: "svc-ct", name: "Cleaning Teeth", duration_minutes: 30 },
  { id: "svc-rc", name: "Root Canal Treatment", duration_minutes: 60 },
  { id: "svc-tw", name: "Teeth Whitening", duration_minutes: 45 },
];

describe("references to what the agent just read out", () => {
  test("ordinal choices in English, Telugu, Hindi and romanized", () => {
    for (const [said, expected] of [
      ["the second one", { position: 2 }],
      ["Second one please", { position: 2 }],
      ["the third service", { position: 3 }],
      ["రెండోది", { position: 2 }],
      ["మొదటి సర్వీస్", { position: 1 }],
      ["दूसरा वाला", { position: 2 }],
      ["pehla wala", { position: 1 }],
      ["the last one", "last"],
      ["the earlier one", "earlier"],
      ["later one is fine", "later"],
      ["पहले वाला", "earlier"],
    ] as const) {
      assert.deepEqual(optionReference(said), expected, said);
    }
  });

  test("the same words used in their ordinary sense are not references", () => {
    for (const said of [
      "first tell me the price",
      "पहले फीस बताइए",
      "ముందు ఫీజు చెప్పండి",
      "Is this my first visit to a dentist with you all",
      "second",
    ]) {
      assert.equal(optionReference(said), null, said);
    }
  });

  test("times and services named in the agent's reply, in the order said", () => {
    assert.deepEqual(timesNamedIn("I have 5:00 PM or 6:30 PM today."), ["17:00", "18:30"]);
    assert.deepEqual(timesNamedIn("सोमवार, 7:00 pm या 8:00 pm"), ["19:00", "20:00"]);
    assert.deepEqual(timesNamedIn("৭:০০ PM অথবা ৮:০০ PM"), ["19:00", "20:00"]);
    // Opening hours are a range, not times to choose from.
    assert.deepEqual(timesNamedIn("We're open 9:00 AM to 6:00 PM, Monday to Saturday."), []);
    assert.deepEqual(timesNamedIn("सुबह 9:00 am से 6:00 pm तक"), []);
    const listed = servicesNamedIn(
      "We offer Teeth Whitening, Cleaning Teeth and Root Canal Treatment.",
      SERVICES,
    );
    assert.deepEqual(
      listed.map((s) => s.id),
      ["svc-tw", "svc-ct", "svc-rc"],
    );
    assert.deepEqual(servicesNamedIn("We offer Hair Cut.", SERVICES), [], "only this catalogue");
    assert.equal(pickOption(["17:00", "18:30"], "earlier"), "17:00");
    assert.equal(pickOption(["17:00", "18:30"], "later"), "18:30");
    assert.equal(pickOption(listed, { position: 2 })?.id, "svc-ct");
    assert.equal(pickOption(listed, "earlier"), null, "earlier/later is for times only");
    assert.equal(pickOption(listed, { position: 5 }), null);
  });
});

describe("negation of a day", () => {
  test("the day the caller rules out is never the one used", () => {
    for (const [said, day] of [
      ["not tomorrow, today please", "today"],
      ["I don't want tomorrow, can I come today", "today"],
      ["कल नहीं, आज", "today"],
      ["kal nahi aaj", "today"],
      ["రేపు కాదు, ఈరోజు", "today"],
      ["not today, tomorrow", "tomorrow"],
      ["tomorrow please", "tomorrow"],
      // A correction TO a day is not a rejection of it.
      ["no tomorrow is fine", "tomorrow"],
      ["No, tomorrow please", "tomorrow"],
      ["not until tomorrow", "tomorrow"],
    ] as const) {
      assert.equal(parseCallerIntentFromText(said).relativeDate, day, said);
    }
  });

  test("Telugu-English and Hindi-English availability requests", () => {
    for (const said of [
      "slots unnaya cheppandi",
      "రేపు ఏ slots available unnayi?",
      "kal ke slots batao",
      "When are you free tomorrow",
    ]) {
      assert.equal(parseCallerIntentFromText(said).availabilityRequested, true, said);
    }
  });
});

describe("a yes books only when it answers the booking question", () => {
  test("a yes to any other question is not booking approval", () => {
    for (const question of [
      "Do you have any allergies?",
      "Is this your first visit?",
      "Shall I use the number you're calling from?",
      "Is there anything else I can help with?",
    ]) {
      assert.equal(callerAuthorizesBooking("Yes", question), false, question);
    }
    assert.equal(callerAuthorizesBooking("Yes", "Would you like me to book it?"), true);
    assert.equal(callerAuthorizesBooking("అవును", "Do you have any allergies?"), false);
  });

  test("only silence and filler sounds count as an interruption with no words", () => {
    for (const said of ["", "hmm", "uh um", "హ్మ్", "हम्म"]) {
      assert.equal(isFillerOnly(said), true, said);
    }
    // "yes", "ok", "haan", "సరే" are answers, never noise.
    for (const said of ["yes", "ok", "haan", "సరే", "जी हाँ", "wait", "రేపు", "कितना लगेगा"]) {
      assert.equal(isFillerOnly(said), false, said);
    }
  });
});

describe("prices quoted are the current ones", () => {
  const agent = { primary_language: "en-IN", transfer_number: null } as AgentSnapshot["agent"];
  const published =
    "# BUSINESS CONTEXT\nSmile Dental.\n\n# SERVICES AND PRICING\n- Cleaning Teeth: ₹800, ~30 min\n# APPOINTMENTS\nBook any service.\n\n# SAFETY\n- x";
  const live: AgentSnapshot["services"] = [
    { name: "Cleaning Teeth", price: 1200, currency: "INR", duration_minutes: 30, is_active: true },
    { name: "Old Service", price: 50, currency: "INR", is_active: false },
  ];

  test("the published list is replaced by the live one; inactive services are left out", () => {
    const out = withCurrentCallSections(published, agent, live);
    assert.match(out, /- Cleaning Teeth: ₹1,200, ~30 min/);
    assert.doesNotMatch(out, /₹800/, "the stale price is gone");
    assert.doesNotMatch(out, /Old Service/);
    assert.match(out, /# APPOINTMENTS\nBook any service\./, "the next section is untouched");
  });

  test("when the live list can't be read, the published prices are flagged, not presented as current", () => {
    const out = withCurrentCallSections(published, agent, null);
    assert.match(out, /- Cleaning Teeth: ₹800/);
    assert.match(out, /say you can't confirm the current price right now/);
    assert.equal(withCurrentCallSections(out, agent, null), out, "flagged once");
  });

  test("an empty live catalogue means no prices are quoted", () => {
    const out = withCurrentCallSections(published, agent, []);
    assert.match(out, /No services configured\. Do not quote any prices\./);
  });
});

/* ------------------------------------------------------------------ */
/* Through the real runtime                                            */
/* ------------------------------------------------------------------ */

const runtimeAgent: AgentSnapshot["agent"] = {
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

async function drain(hops = 300) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

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

async function openCall(defaultReply?: string, extra: Partial<StartRuntimeSessionInput> = {}) {
  const h: Harness = createHarness(defaultReply ? { defaultReply } : {});
  const callId = `context-${crypto.randomUUID()}`;
  const input: StartRuntimeSessionInput = {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: "00000000-0000-0000-0000-000000000002",
    agentVersion: 3,
    instructions: "You are Aria, a helpful receptionist for Smile Dental.",
    snapshotAgent: runtimeAgent,
    businessName: "Smile Dental",
    bridge: h.bridge,
    businessCountry: "IN",
    callerNumber: "+919876543210",
    services: SERVICES,
    ...extra,
  };
  await startRuntimeSession(input, h.deps);
  await drain();
  let flushed = 0;
  const flushAll = () => {
    while (flushed < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      flushed++;
    }
  };
  const turn = async (said: string, reply: string, language = "en-IN") => {
    flushAll();
    h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({
      type: "final_transcript",
      text: said,
      language,
      languageConfidence: 0.95,
    });
    await drain();
    return h.tts.sentTexts.slice(before).join(" ");
  };
  const knownState = () =>
    (h.llm.calls.at(-1) ?? [])
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
  return { h, callId, turn, knownState, flushAll };
}

describe("ordinary conversation never selects a service", () => {
  test("asking about treatments or services in general picks none", () => {
    for (const said of [
      "What treatments do you do?",
      "What services do you have?",
      "Do you have any procedures for kids?",
      "Can I book an appointment?",
    ]) {
      assert.equal(resolveServiceFromText(SERVICES, said).kind, "none", said);
    }
    const rct = resolveServiceFromText(SERVICES, "root canal treatment please");
    assert.equal(rct.kind === "match" && rct.row.id, "svc-rc", "a named treatment still matches");
  });
});

describe("references through the runtime", () => {
  test("'the earlier one' picks the earlier of the two times the agent offered", async () => {
    const { h, callId, turn, knownState } = await openCall();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date());
    await turn(
      "Cleaning Teeth today please",
      `I have 5:00 PM or 6:30 PM today. Which works for you?\n${marker({ service: "Cleaning Teeth", preferred_date: today })}`,
    );
    await turn(
      "the earlier one",
      `Okay.\n${marker({ service: "Cleaning Teeth", preferred_date: today })}`,
    );
    await turn(
      "Do you have parking?",
      `Yes.\n${marker({ service: "Cleaning Teeth", preferred_date: today })}`,
    );
    assert.match(knownState(), /preferred time: 17:00/);
    assert.equal(
      h.tools.calls.filter((c) => c.name === "book_appointment").length,
      0,
      "a reference never books by itself",
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("'the second one' picks the second service the agent named", async () => {
    const { callId, turn, knownState } = await openCall();
    await turn(
      "What treatments do you do?",
      `We offer Teeth Whitening, Cleaning Teeth and Root Canal Treatment. Which would you like?\n${marker()}`,
    );
    await turn("the second one", `Sure.\n${marker()}`);
    await turn("What time are you open?", `Nine to six.\n${marker()}`);
    assert.match(knownState(), /service: Cleaning Teeth/);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("an interruption that holds no words", () => {
  test("a cough while the agent is thinking: the question is still answered", async () => {
    const { h, callId, flushAll } = await openCall("We're open nine to six.");
    flushAll();
    h.llm.setDelay(20);
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({
      type: "final_transcript",
      text: "What are your hours?",
      language: "en-IN",
      languageConfidence: 0.95,
    });
    await drain();
    // The cough: speech starts while the answer is being prepared, then stops
    // with no words.
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "speech_end" });
    h.stt.emit({ type: "final_transcript", text: "", language: "en-IN" });
    // Two model calls (the cancelled one and the rerun) run on real timers:
    // wait for the answer, bounded, rather than a fixed sleep.
    for (let waited = 0; waited < 2_000; waited += 20) {
      if (h.tts.sentTexts.some((t) => t.includes("nine to six"))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await drain();
    }
    assert.ok(
      h.tts.sentTexts.some((t) => t.includes("nine to six")),
      `the question is answered after all: ${h.tts.sentTexts.join(" | ")}`,
    );
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a 'hmm' while the agent is speaking: the cut-off reply is said again", async () => {
    const { h, callId, turn } = await openCall();
    const reply = await turn("What are your hours?", "We're open nine to six, Monday to Saturday.");
    assert.match(reply, /nine to six/);
    const before = h.tts.sentTexts.length;
    // Audio still playing (not flushed): the caller's "hmm" interrupts it.
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "final_transcript", text: "hmm", language: "en-IN" });
    await drain();
    const again = h.tts.sentTexts.slice(before).join(" ");
    assert.match(again, /nine to six, Monday to Saturday/, again);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a 'yes' over the end of the agent's question is the answer, not noise", async () => {
    const { h, callId, turn } = await openCall();
    await turn("Do you have parking?", "Yes, right outside. Would you like directions?");
    const before = h.tts.sentTexts.length;
    const callsBefore = h.llm.calls.length;
    // Audio still playing: the caller's "yes" overlaps the question's tail.
    h.llm.setNextReply("Take the second left after the bank.");
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "final_transcript", text: "yes", language: "en-IN" });
    await drain();
    const said = h.tts.sentTexts.slice(before).join(" ");
    assert.equal(h.llm.calls.length, callsBefore + 1, "the yes was processed as a turn");
    assert.match(said, /second left/, said);
    assert.doesNotMatch(said, /Would you like directions/, "the question is not repeated");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("real words are a real interruption: no repeat, the new question is answered", async () => {
    const { h, callId, turn } = await openCall();
    await turn("What are your hours?", "We're open nine to six, Monday to Saturday.");
    const before = h.tts.sentTexts.length;
    h.llm.setNextReply("Yes, we're open on Sunday mornings.");
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({
      type: "final_transcript",
      text: "wait, what about Sunday",
      language: "en-IN",
      languageConfidence: 0.95,
    });
    await drain();
    const said = h.tts.sentTexts.slice(before).join(" ");
    assert.doesNotMatch(said, /Monday to Saturday/, said);
    assert.match(said, /Sunday mornings/, said);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

/* ------------------------------------------------------------------ */
/* Corrections, changed choices and late transcripts                  */
/* ------------------------------------------------------------------ */

const utcDay = (offsetDays: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );

describe("a correction is recognized in every way callers say it", () => {
  test("English, Telugu, romanized Telugu and Hindi corrections", () => {
    for (const said of [
      "change it to tomorrow",
      "not that one, the second one",
      "actually, I want cleaning instead",
      "make it 8 PM",
      "రేపటికి మార్చండి",
      "అది కాదు, రెండోది",
      "kaadu, rendodi",
      "repu ki maarchandi",
      "कल कर दीजिए, आज नहीं",
      "badal do, kal ka rakho",
    ]) {
      assert.equal(isCorrection(said), true, said);
    }
    for (const said of ["tomorrow please", "yes", "సరే", "haan", "book it for March 5"]) {
      assert.equal(isCorrection(said), false, said);
    }
  });

  test("romanized Telugu and mixed references point at a position", () => {
    for (const [said, expected] of [
      ["rendodi", { position: 2 }],
      ["kaadu, rendodi", { position: 2 }],
      ["modatidi", { position: 1 }],
      ["not that one, the second one", { position: 2 }],
      ["అది కాదు, రెండోది", { position: 2 }],
    ] as const) {
      assert.deepEqual(optionReference(said), expected, said);
    }
  });
});

describe("a correction changes only what was corrected", () => {
  const known = {
    ...emptyAppointmentState(),
    service: "Root Canal Treatment",
    customerName: "Dhanush",
    phone: "+919876543210",
    phoneSource: "caller_id" as const,
    preferredDate: "2030-10-14",
    preferredTime: "19:00",
    availabilityStatus: "available" as const,
  };
  // The model's state block still repeats the old values.
  const stale = {
    service: known.service,
    preferredDate: known.preferredDate,
    preferredTime: "19:00",
  };

  test("the caller's corrected day wins over the model's stale state; nothing else is erased", () => {
    const merged = mergeAppointmentState(known, stale, {
      preferredDate: "2030-10-15",
      correction: true,
    });
    assert.equal(merged.preferredDate, "2030-10-15");
    assert.equal(merged.preferredTime, "19:00");
    assert.equal(merged.service, "Root Canal Treatment");
    assert.equal(merged.customerName, "Dhanush");
    assert.equal(merged.phone, "+919876543210");
    assert.equal(merged.availabilityStatus, "unknown", "the old check no longer applies");
  });

  test("without a correction the model's state still decides (unchanged behaviour)", () => {
    const merged = mergeAppointmentState(known, stale, { preferredDate: "2030-10-15" });
    assert.equal(merged.preferredDate, "2030-10-14");
  });

  test("a changed service makes the earlier availability check stale too", () => {
    const merged = mergeAppointmentState(known, stale, {
      service: "Cleaning Teeth",
      correction: true,
    });
    assert.equal(merged.service, "Cleaning Teeth");
    assert.equal(merged.preferredTime, "19:00");
    assert.equal(merged.availabilityStatus, "unknown");
    assert.equal(merged.selectedSlot, null);
  });
});

describe("corrections through the runtime", () => {
  test("'actually, I want cleaning instead' replaces the chosen service; the day stays", async () => {
    const { h, callId, turn, knownState } = await openCall();
    const day = utcDay(1);
    const rootCanal = marker({ service: "Root Canal Treatment", preferred_date: day });
    await turn("Root canal treatment tomorrow", `Sure, what time?\n${rootCanal}`);
    await turn("actually, I want cleaning instead", `Okay.\n${rootCanal}`);
    await turn("Do you have parking?", `Yes.\n${rootCanal}`);
    assert.match(knownState(), /service: Cleaning Teeth/);
    assert.match(knownState(), new RegExp(`preferred date: ${day}`));
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("'change it to tomorrow' moves the day even when the model repeats today", async () => {
    const { callId, turn, knownState } = await openCall();
    const todayState = marker({ service: "Cleaning Teeth", preferred_date: utcDay(0) });
    await turn("Cleaning Teeth today please", `What time?\n${todayState}`);
    await turn("change it to tomorrow", `Okay.\n${todayState}`);
    await turn("Do you have parking?", `Yes.\n${todayState}`);
    assert.match(knownState(), new RegExp(`preferred date: ${utcDay(1)}`));
    assert.match(knownState(), /service: Cleaning Teeth/, "the service is kept");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("Telugu 'రేపటికి మార్చండి' moves the day too", async () => {
    const { callId, turn, knownState } = await openCall();
    const todayState = marker({ service: "Cleaning Teeth", preferred_date: utcDay(0) });
    await turn("Cleaning Teeth today please", `What time?\n${todayState}`);
    await turn("రేపటికి మార్చండి", `సరే.\n${todayState}`, "te-IN");
    await turn("parking undaa?", `ఉంది.\n${todayState}`, "te-IN");
    assert.match(knownState(), new RegExp(`preferred date: ${utcDay(1)}`));
    await terminateRuntimeSession(callId, "test cleanup");
  });

  for (const [said, language] of [
    ["kaadu, rendodi", "te-IN"],
    ["అది కాదు, రెండోది", "te-IN"],
    ["not that one, the second one", "en-IN"],
  ] as const) {
    test(`"${said}" changes an already chosen service to the second one listed`, async () => {
      const { callId, turn, knownState } = await openCall();
      const whitening = marker({ service: "Teeth Whitening" });
      await turn("Teeth whitening please", `Sure.\n${whitening}`);
      await turn(
        "What else do you offer?",
        `We offer Teeth Whitening, Cleaning Teeth and Root Canal Treatment.\n${whitening}`,
      );
      await turn(said, `Okay.\n${whitening}`, language);
      await turn("What time are you open?", `Nine to six.\n${whitening}`);
      assert.match(knownState(), /service: Cleaning Teeth/);
      await terminateRuntimeSession(callId, "test cleanup");
    });
  }

  test("'the second one' with no list to point at: asks which one, guesses nothing", async () => {
    const { h, callId, turn, knownState } = await openCall();
    await turn("Hi, I'd like an appointment", `Sure, which service?\n${marker()}`);
    const reply = await turn(
      "the second one",
      `Great, Root Canal Treatment it is.\n${marker({ service: "Root Canal Treatment" })}`,
    );
    assert.ok(reply.includes(WHICH_ONE_QUESTION["en-IN"]), reply);
    await turn("What time are you open?", `Nine to six.\n${marker()}`);
    assert.doesNotMatch(knownState(), /service: Root Canal/);
    assert.equal(h.tools.calls.filter((c) => c.name === "book_appointment").length, 0);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("the same in Telugu: the clarification is asked in Telugu", async () => {
    const { callId, turn } = await openCall();
    await turn("నాకు అపాయింట్‌మెంట్ కావాలి", `ఏ సర్వీస్ కావాలి?\n${marker()}`, "te-IN");
    const reply = await turn(
      "rendodi",
      `సరే, రూట్ కెనాల్.\n${marker({ service: "Root Canal Treatment" })}`,
      "te-IN",
    );
    assert.ok(reply.includes(WHICH_ONE_QUESTION["te-IN"]), reply);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("prices: the live catalogue is the authority", () => {
  const agent = { primary_language: "en-IN", transfer_number: null } as AgentSnapshot["agent"];
  const published =
    "# SERVICES AND PRICING\n- Cleaning Teeth: ₹800, ~30 min\n" +
    `${PRICE_AUTHORITY_NOTE}\n` +
    "# FREQUENTLY ASKED QUESTIONS\nQ: How much is cleaning?\nA: Cleaning is ₹800 and takes half an hour.\n\n# SAFETY\n- x";

  test("live prices say they override any amount in FAQs; the FAQ text itself is kept", () => {
    const live: AgentSnapshot["services"] = [
      {
        name: "Cleaning Teeth",
        price: 1200,
        currency: "INR",
        duration_minutes: 30,
        is_active: true,
      },
    ];
    const out = withCurrentCallSections(published, agent, live);
    assert.match(out, /- Cleaning Teeth: ₹1,200/);
    assert.ok(out.includes(PRICE_AUTHORITY_NOTE), "the authority note travels with live prices");
    assert.match(out, /takes half an hour/, "the descriptive FAQ answer is not removed");
  });

  test("unreadable live prices: no amount anywhere is presented as current", () => {
    const out = withCurrentCallSections(published, agent, null);
    assert.ok(
      !out.includes(PRICE_AUTHORITY_NOTE),
      "the published list no longer claims to be current",
    );
    assert.ok(out.includes(UNVERIFIED_PRICES_NOTE));
    assert.match(UNVERIFIED_PRICES_NOTE, /FAQs or additional knowledge/);
    assert.match(out, /takes half an hour/);
  });

  test("an amount is recognized in every supported way of saying it", () => {
    for (const said of [
      "Cleaning is ₹800.",
      "It costs Rs. 800",
      "It is 800 rupees",
      "eight hundred rupees",
      "इसकी कीमत 800 रुपये है",
      "దీని ధర 800 రూపాయలు",
      "1,200/- only",
    ]) {
      assert.equal(quotesPrice(said), true, said);
    }
    for (const said of [
      "We're open nine to six.",
      "It takes about 30 minutes.",
      "Room 12",
      "We accept RuPay cards.",
    ]) {
      assert.equal(quotesPrice(said), false, said);
    }
  });

  test("when prices can't be verified, a quoted amount is never spoken (English and Telugu)", async () => {
    const { callId, turn } = await openCall(undefined, { pricesUnverified: true });
    const en = await turn("How much is cleaning?", `Cleaning is ₹800.\n${marker()}`);
    assert.doesNotMatch(en, /800/, en);
    assert.match(en, /can't confirm the current price/, en);
    const te = await turn("cleaning ki entha?", `క్లీనింగ్ 800 రూపాయలు.\n${marker()}`, "te-IN");
    assert.doesNotMatch(te, /800/, te);
    assert.match(te, /ప్రస్తుత ధర/, te);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a payment message composed by the server keeps its amount even when prices are unverified", async () => {
    const { h, callId } = await openCall(undefined, { pricesUnverified: true });
    const before = h.tts.sentTexts.length;
    const message =
      "Good news — your payment of INR 500.00 just came through, and your booking is confirmed. Thank you!";
    const result = await injectPaymentEvent(callId, message);
    await drain();
    assert.equal(result.handled, true);
    // Spoken through textForSpeech, which only reshapes punctuation and
    // numbers for the voice: the amount is still said, never replaced.
    const said = h.tts.sentTexts.slice(before).join(" ");
    assert.match(said, /payment of .*500/, said);
    assert.match(said, /booking is confirmed/, said);
    assert.doesNotMatch(said, /can't confirm the current price/, said);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("with verified prices the model's quoted amount is spoken", async () => {
    const { callId, turn } = await openCall();
    const reply = await turn("How much is cleaning?", `Cleaning is ₹1,200.\n${marker()}`);
    assert.match(reply, /₹1,200/);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});

describe("late transcripts never bring back an answer the caller moved past", () => {
  test("words that arrive after the replay started stop the replay; the new question is answered", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { h, callId, turn } = await openCall();
    await turn("What are your hours?", "We're open nine to six, Monday to Saturday.");
    // A sound interrupts the still-playing reply; no words within the
    // recovery window, so the reply is said again.
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "speech_end" });
    t.mock.timers.tick(2_000);
    await drain();
    const replayAt = h.tts.sentTexts.length;
    assert.match(h.tts.sentTexts.at(-1) ?? "", /Monday to Saturday/, "replayed");
    const clearedBefore = h.bridge.clearedCount;
    // The words behind that interruption arrive late.
    h.llm.setNextReply("Yes, we're open on Sunday mornings.");
    h.stt.emit({
      type: "final_transcript",
      text: "what about Sunday",
      language: "en-IN",
      languageConfidence: 0.95,
    });
    await drain();
    assert.ok(h.bridge.clearedCount > clearedBefore, "the replay's audio is cut off");
    const after = h.tts.sentTexts.slice(replayAt).join(" ");
    assert.match(after, /Sunday mornings/, after);
    assert.doesNotMatch(after, /Monday to Saturday/, "the old answer isn't said a third time");
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a cough then a real 'సరే' processes it as an answer; nothing is replayed", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { h, callId, turn } = await openCall();
    await turn("Do you have parking?", "Yes, right outside. Would you like directions?");
    const before = h.tts.sentTexts.length;
    h.llm.setNextReply("Take the second left after the bank.");
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "speech_end" });
    h.stt.emit({ type: "final_transcript", text: "సరే", language: "te-IN" });
    await drain();
    t.mock.timers.tick(2_000);
    await drain();
    const said = h.tts.sentTexts.slice(before).join(" ");
    assert.match(said, /second left/, said);
    assert.doesNotMatch(said, /Would you like directions/, said);
    await terminateRuntimeSession(callId, "test cleanup");
  });
});
