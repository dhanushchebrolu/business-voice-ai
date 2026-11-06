/**
 * Phase 2.19 smoke-test scenarios and their checks, as pure data and a pure
 * evaluator so both are tested offline (tests/smoke-scenarios.spec.ts)
 * before any paid request.
 *
 * Suites (bench/sarvam-smoke.ts --suite <name>):
 *   original     the five Phase 2.19 scenarios (default, unchanged)
 *   remediation  the Phase 2.19 fixes: relative dates, availability, closing,
 *                no repeated questions, booking + duplicate prevention
 *
 * The checks read what the caller actually heard (the guarded, spoken text)
 * and the deterministic call state, not HTTP statuses.
 */
import type { ServiceRow } from "../src/conversation/understanding.ts";

export const SMOKE_SERVICES: ServiceRow[] = [
  {
    id: "svc-cleaning",
    name: "Cleaning",
    aliases: ["క్లీనింగ్", "क्लीनिंग"],
    durationMinutes: 30,
    priceInr: 800,
  },
  {
    id: "svc-whitening",
    name: "Whitening",
    aliases: ["వైటెనింగ్", "व्हाइटनिंग"],
    durationMinutes: 45,
    priceInr: 3500,
  },
];
/** Monday 2 Nov 2026, 10:00 IST. */
export const SMOKE_NOW_ISO = "2026-11-02T04:30:00Z";
export const SMOKE_HOURS = ["10:00", "11:00", "15:00", "16:00", "17:00"];

export interface SpokenCheck {
  turn: number;
  /** Every pattern must appear in what the agent said on that turn. */
  must?: RegExp[];
  /** No pattern may appear. */
  mustNot?: RegExp[];
  /** The turn must contain no question (goodbyes). */
  noQuestion?: boolean;
  /** The turn must ask something (a clarification). */
  asks?: boolean;
}

export interface SmokeScenario {
  name: string;
  /** What this scenario proves (for the report). */
  covers?: string[];
  turns: string[];
  expectTools: string[];
  expectBooked: boolean;
  inject?: Array<"503" | "cut">;
  /** The calendar's open hours (default SMOKE_HOURS); [] = nothing free. */
  openHours?: string[];
  /** The business clock (default SMOKE_NOW_ISO). */
  nowIso?: string;
  expect?: {
    /** The step the state chose for each caller turn ("clarify:time", "close:booked", ...); null = any. */
    steps?: Array<string | null>;
    date?: string;
    offered?: string[];
    bookingStatus?: string;
    bookings?: number;
    closed?: boolean;
    spoken?: SpokenCheck[];
  };
}

export const ORIGINAL_SCENARIOS: SmokeScenario[] = [
  {
    name: "1-telugu-conversation",
    turns: ["నమస్కారం", "మీ దగ్గర క్లీనింగ్ ఎంత అవుతుంది?", "సరే, ధన్యవాదాలు"],
    expectTools: ["get_service_price"],
    expectBooked: false,
  },
  {
    name: "2-english-availability",
    turns: [
      "Hi there",
      "Is there any time free for a cleaning tomorrow afternoon?",
      "Okay, I'll think about it, thanks",
    ],
    expectTools: ["check_availability"],
    expectBooked: false,
  },
  {
    name: "3-hindi-booking",
    turns: [
      "नमस्ते",
      "कल शाम चार बजे क्लीनिंग चाहिए",
      "जी हाँ, चार बजे ठीक है",
      "मेरा नाम टेस्ट कॉलर है",
      "हाँ, इसी नंबर पर",
      "हाँ, बुक कर दीजिए",
      "एक बार फिर से बुक कर दीजिए",
    ],
    expectTools: ["check_availability", "book_appointment"],
    expectBooked: true,
  },
  {
    name: "4-code-mixed-ambiguity",
    turns: [
      "hello andi",
      "repu evening cleaning kavali, 4 or 5 lo edaina",
      "hmm, ఏది free gaa undi?",
    ],
    expectTools: [],
    expectBooked: false,
  },
  {
    name: "5-failure-recovery",
    turns: ["Hello", "What does a whitening cost?"],
    expectTools: ["get_service_price"],
    expectBooked: false,
    inject: ["503", "cut"],
  },
];

/** "5" said as a digit or a word, in English, Hindi or Telugu. */
const FIVE = /5|five|पांच|पाँच|ఐదు/i;
const FOUR_CLAIMED_FREE =
  /\b4\s*(?:PM|pm|p\.m\.)?\s*(?:is\s+)?(?:free|available)|4\s*बजे\s*(?:खाली|उपलब्ध)\s*है|4\s*(?:గంటలకు|గంటల)?\s*(?:ఖాళీగా|అందుబాటులో)\s*ఉంది/i;

export const REMEDIATION_SCENARIOS: SmokeScenario[] = [
  {
    name: "R1-telugu-repu-either-then-leave",
    covers: ["Telugu repu", "either of two slots", "closing with a booking pending"],
    turns: ["repu evening cleaning kavali, 4 or 5 lo edaina", "5 PM", "సరే, ధన్యవాదాలు"],
    expectTools: ["check_availability"],
    expectBooked: false,
    expect: {
      steps: ["check_availability", "ask:customerName", "confirm_leave"],
      date: "2026-11-03",
      offered: ["16:00", "17:00"],
      bookingStatus: "slot_selected",
      bookings: 0,
      spoken: [{ turn: 2, asks: true }],
    },
  },
  {
    name: "R2-which-is-free-no-repeat",
    covers: [
      "no repeated question after clarification",
      "which slot is free",
      "unavailable slot",
      "Telugu goodbye",
    ],
    turns: [
      "repu evening cleaning kavali, 4 or 5",
      "hmm, ఏది free gaa undi?",
      "అంతే అండి, ధన్యవాదాలు",
    ],
    openHours: ["10:00", "11:00", "15:00", "17:00"], // 4 PM is taken
    expectTools: ["check_availability"],
    expectBooked: false,
    expect: {
      steps: ["clarify:time", "check_availability", "close:not_booked"],
      date: "2026-11-03",
      offered: ["17:00"],
      bookings: 0,
      closed: true,
      spoken: [
        { turn: 0, asks: true },
        { turn: 1, must: [FIVE], mustNot: [FOUR_CLAIMED_FREE] },
        { turn: 2, noQuestion: true },
      ],
    },
  },
  {
    name: "R3-english-today-unavailable-then-decline",
    covers: ["English today", "unavailable slot", "English goodbye (declines)"],
    turns: [
      "I need a cleaning today at 4 PM",
      "okay, what about 5 PM then?",
      "No thanks, I'll call back later",
    ],
    openHours: ["11:00", "17:00"],
    expectTools: ["check_availability"],
    expectBooked: false,
    expect: {
      steps: ["check_availability", "ask:customerName", "close:not_booked"],
      date: "2026-11-02",
      offered: ["11:00", "17:00"],
      bookings: 0,
      closed: true,
      spoken: [
        { turn: 0, mustNot: [FOUR_CLAIMED_FREE] },
        { turn: 2, noQuestion: true },
      ],
    },
  },
  {
    name: "R4-hindi-kal-empty-availability",
    covers: ["Hindi kal", "empty availability", "Hindi goodbye"],
    turns: ["कल सुबह क्लीनिंग चाहिए", "ठीक है, धन्यवाद"],
    openHours: [],
    expectTools: ["check_availability"],
    expectBooked: false,
    expect: {
      steps: ["check_availability", "close:not_booked"],
      date: "2026-11-03",
      offered: [],
      bookingStatus: "no_availability",
      bookings: 0,
      closed: true,
      spoken: [
        { turn: 0, mustNot: [/खाली\s*है|उपलब्ध\s*है|\b(?:is|are)\s+(?:free|available)\b/i] },
        { turn: 1, noQuestion: true },
      ],
    },
  },
  {
    name: "R5-english-today-or-tomorrow",
    covers: ["ambiguous date clarified", "English tomorrow"],
    turns: ["Can I get a cleaning today or tomorrow at 11 AM?", "tomorrow please"],
    expectTools: ["check_availability"],
    expectBooked: false,
    expect: {
      steps: ["clarify:date", "check_availability"],
      date: "2026-11-03",
      offered: ["11:00"],
      bookings: 0,
      spoken: [{ turn: 0, asks: true }],
    },
  },
  {
    name: "R6-telugu-repu-after-midnight",
    covers: ["ambiguous date after midnight", "Telugu today"],
    nowIso: "2026-11-02T19:00:00Z", // Tuesday 3 Nov, 00:30 IST
    turns: ["రేపు ఉదయం 11 గంటలకు క్లీనింగ్ కావాలి", "ఈరోజు"],
    expectTools: ["check_availability"],
    expectBooked: false,
    expect: {
      steps: ["clarify:date", "check_availability"],
      date: "2026-11-03",
      offered: ["11:00"],
      bookings: 0,
      spoken: [{ turn: 0, asks: true }],
    },
  },
  {
    name: "R7-hindi-booking-duplicate-goodbye",
    covers: [
      "Hindi kal",
      "booking confirmation",
      "duplicate-booking prevention",
      "Hindi goodbye after booking",
    ],
    turns: [
      "कल शाम चार बजे क्लीनिंग चाहिए",
      "जी हाँ, चार बजे ठीक है",
      "मेरा नाम टेस्ट कॉलर है",
      "हाँ, इसी नंबर पर",
      "हाँ, बुक कर दीजिए",
      "एक बार फिर से बुक कर दीजिए",
      "बस इतना ही, धन्यवाद",
    ],
    expectTools: ["check_availability", "book_appointment"],
    expectBooked: true,
    expect: {
      steps: [
        "check_availability",
        "ask:customerName",
        "confirm_caller_id",
        "final_confirmation",
        "book",
        "done",
        "close:booked",
      ],
      date: "2026-11-03",
      bookingStatus: "confirmed",
      bookings: 1,
      closed: true,
      spoken: [{ turn: 6, noQuestion: true }],
    },
  },
];

export const SUITES = { original: ORIGINAL_SCENARIOS, remediation: REMEDIATION_SCENARIOS } as const;
export type SuiteName = keyof typeof SUITES;

/** `--suite <name>` (default original). Unknown names are refused, never guessed. */
export function selectSuite(
  argv: readonly string[],
): { ok: true; name: SuiteName } | { ok: false; reason: string } {
  const i = argv.indexOf("--suite");
  if (i < 0) return { ok: true, name: "original" };
  const v = argv[i + 1];
  if (v === "original" || v === "remediation") return { ok: true, name: v };
  return { ok: false, reason: "--suite must be original or remediation." };
}

/** The label used in expect.steps for a state step. */
export function stepLabel(step: { kind: string; slot?: string; outcome?: string }): string {
  if ((step.kind === "ask" || step.kind === "clarify") && step.slot)
    return `${step.kind}:${step.slot}`;
  if (step.kind === "close" && step.outcome) return `close:${step.outcome}`;
  return step.kind;
}

/** Questions in a spoken reply, normalised for comparison. */
export function questionsIn(text: string): string[] {
  return (text.match(/[^.!?।\n]*[?？]/g) ?? [])
    .map((q) =>
      q
        .toLowerCase()
        .replace(/[\s,]+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

export interface ScenarioRun {
  /** The state's step for each caller turn, as stepLabel(). */
  steps: string[];
  transcript: Array<{ caller: string; agent: string }>;
  date: string | null;
  offered: string[];
  bookingStatus: string;
  bookings: number;
  backendBookCalls: number;
  closed: boolean;
}

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export function evaluateScenario(sc: SmokeScenario, run: ScenarioRun): Check[] {
  const checks: Check[] = [];
  const add = (name: string, pass: boolean, detail?: string) =>
    checks.push(detail === undefined ? { name, pass } : { name, pass, detail });

  add(
    "all turns completed",
    run.transcript.length === sc.turns.length,
    `${run.transcript.length}/${sc.turns.length}`,
  );
  run.transcript.forEach((t, i) =>
    add(`turn ${i}: agent spoke`, t.agent.trim().length > 0, t.agent.trim() ? undefined : "silent"),
  );

  // No question repeated word for word on consecutive turns, and no clarification asked twice in a row.
  for (let i = 1; i < run.transcript.length; i++) {
    const prev = new Set(questionsIn(run.transcript[i - 1]!.agent));
    const repeated = questionsIn(run.transcript[i]!.agent).filter((q) => prev.has(q));
    add(
      `turn ${i}: no repeated question`,
      repeated.length === 0,
      repeated.join(" | ") || undefined,
    );
  }
  for (let i = 1; i < run.steps.length; i++) {
    const a = run.steps[i - 1]!;
    if (a.startsWith("clarify:"))
      add(`turn ${i}: clarification not repeated`, run.steps[i] !== a, `${a} -> ${run.steps[i]}`);
  }
  add(
    "at most one booking (duplicate prevention)",
    run.bookings <= 1 && run.backendBookCalls <= 1,
    `bookings=${run.bookings}, book calls=${run.backendBookCalls}`,
  );

  const e = sc.expect;
  if (!e) return checks;
  e.steps?.forEach((want, i) => {
    if (want !== null)
      add(`turn ${i}: step ${want}`, run.steps[i] === want, `got ${run.steps[i] ?? "none"}`);
  });
  if (e.date !== undefined) add(`date ${e.date}`, run.date === e.date, `got ${run.date}`);
  if (e.offered !== undefined)
    add(
      `offered ${e.offered.join(",") || "nothing"}`,
      JSON.stringify(run.offered) === JSON.stringify(e.offered),
      `got ${run.offered.join(",") || "nothing"}`,
    );
  if (e.bookingStatus !== undefined)
    add(
      `booking status ${e.bookingStatus}`,
      run.bookingStatus === e.bookingStatus,
      `got ${run.bookingStatus}`,
    );
  if (e.bookings !== undefined)
    add(`bookings ${e.bookings}`, run.bookings === e.bookings, `got ${run.bookings}`);
  if (e.closed !== undefined)
    add(`closed ${e.closed}`, run.closed === e.closed, `got ${run.closed}`);
  for (const c of e.spoken ?? []) {
    const said = run.transcript[c.turn]?.agent ?? "";
    for (const re of c.must ?? []) add(`turn ${c.turn}: says ${re.source}`, re.test(said), said);
    for (const re of c.mustNot ?? [])
      add(`turn ${c.turn}: does not say ${re.source}`, !re.test(said), said);
    if (c.noQuestion) add(`turn ${c.turn}: goodbye asks nothing`, !/[?？]/.test(said), said);
    if (c.asks) add(`turn ${c.turn}: asks a question`, /[?？]/.test(said), said);
  }
  return checks;
}
