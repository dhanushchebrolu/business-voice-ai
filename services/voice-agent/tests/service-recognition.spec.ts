/**
 * G1: natural-language service recognition in the LiveKit agent, through the
 * production runtime's matcher (src/lib/service-matching.ts). Every case
 * runs the real pipeline: readUtterance -> applyReading -> nextStep, and the
 * real check_availability tool for the id and duration that reach the
 * backend. Phrases are written the way Sarvam STT writes them (Indian
 * scripts, English loanwords in script, Latin code-mixing, misrecognitions).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  agentSaid,
  applyReading,
  newConversation,
  nextStep,
  type BusinessContext,
  type ConversationState,
} from "../src/conversation/state.ts";
import {
  readUtterance,
  resolveServices,
  type ServiceRow,
} from "../src/conversation/understanding.ts";
import { buildTools } from "../src/agent/receptionist.ts";
import type { BookingBackend } from "../src/backend/types.ts";

/** A catalogue as klyro sends it: names and durations from `services`, no aliases. */
const CATALOG: ServiceRow[] = [
  { id: "svc-cleaning", name: "Teeth Cleaning", durationMinutes: 30 },
  { id: "svc-root-canal", name: "Root Canal Treatment", durationMinutes: 90 },
  { id: "svc-whitening", name: "Teeth Whitening", durationMinutes: 45 },
  { id: "svc-checkup", name: "Dental Checkup", durationMinutes: 20 },
];
const AMBIGUOUS: ServiceRow[] = [
  { id: "svc-cleaning", name: "Teeth Cleaning", durationMinutes: 30 },
  { id: "svc-cleaning-polish", name: "Teeth Cleaning & Polish", durationMinutes: 45 },
  { id: "svc-root-canal", name: "Root Canal Treatment", durationMinutes: 90 },
];
const NOW = new Date("2026-11-07T04:30:00Z"); // 10:00 IST
const ctxFor = (services: ServiceRow[]): BusinessContext => ({
  businessName: "Smile Dental",
  timeZone: "Asia/Kolkata",
  services,
  now: () => NOW,
});

function call(): ConversationState {
  return newConversation({ callId: "c1", callerId: "+919876543210", primaryLanguage: "en-IN" });
}
function say(s: ConversationState, text: string, catalog = CATALOG, stt: string | null = null) {
  applyReading(
    s,
    readUtterance(text, {
      catalog,
      sttLanguage: stt,
      fuzzyServices:
        !s.service || s.service.provenance === "uncertain" || s.lastQuestion === "service",
    }),
    ctxFor(catalog),
  );
  return nextStep(s);
}
const serviceId = (s: ConversationState) => s.service?.value.id ?? null;

describe("G1: what callers say resolves to the business's own service", () => {
  const cases: [string, string, string | null][] = [
    // exact names (any case, inside a sentence)
    ["exact", "Teeth Cleaning", "svc-cleaning"],
    ["exact in a sentence", "I want teeth cleaning", "svc-cleaning"],
    ["exact, other row", "root canal treatment please", "svc-root-canal"],
    // natural English
    ["natural phrase", "Clean my teeth", "svc-cleaning"],
    ["partial name", "Root canal", "svc-root-canal"],
    ["synonym (scaling)", "I need scaling", "svc-cleaning"],
    ["synonym (dental cleaning)", "dental cleaning", "svc-cleaning"],
    ["synonym (bleaching)", "teeth bleaching", "svc-whitening"],
    ["synonym (check-up)", "just a check-up", "svc-checkup"],
    // STT variations from real calls
    ["STT disfluency", "Clean cleaning my teeth.", "svc-cleaning"],
    ["STT misheard 'teeth'", "ఫీత్ క్లీనింగ్", "svc-cleaning"],
    // Telugu
    ["Telugu loanword", "టీత్ క్లీనింగ్.", "svc-cleaning"],
    ["Telugu natural", "పళ్ళు క్లీన్ చేసుకోవాలి అనుకుంటున్నాను.", "svc-cleaning"],
    ["Telugu native verb", "పళ్ళు శుభ్రం చేయించుకోవాలి", "svc-cleaning"],
    ["Telugu root canal", "రూట్ కెనాల్ చేయించుకోవాలి", "svc-root-canal"],
    // Hindi
    ["Hindi loanword", "क्लीनिंग करवानी है", "svc-cleaning"],
    ["Hindi native", "दांत साफ करवाने हैं", "svc-cleaning"],
    ["Hindi root canal", "रूट कैनाल करवाना है", "svc-root-canal"],
    // code-mixed (Latin and script)
    ["Telugu-English mixed", "నాకు teeth cleaning కావాలి", "svc-cleaning"],
    ["Hinglish", "mujhe root canal karwana hai", "svc-root-canal"],
    ["Tanglish script", "பல் சுத்தம் செய்யணும்", "svc-cleaning"],
    ["Kannada", "ಹಲ್ಲು ಸ್ವಚ್ಛ ಮಾಡಿಸಬೇಕು", "svc-cleaning"],
    // never a guess
    ["body word only", "my tooth hurts", null],
    ["unknown service", "I want a haircut", null],
    ["no service at all", "tomorrow at 4 PM", null],
  ];
  for (const [label, said, expected] of cases) {
    test(`${label}: ${JSON.stringify(said)} -> ${expected ?? "nothing"}`, () => {
      const s = call();
      say(s, said);
      assert.equal(serviceId(s), expected);
      if (expected) assert.notEqual(s.service?.provenance, "uncertain");
    });
  }

  test("the match kind is reported (exact / fuzzy / none), never the words", () => {
    assert.equal(resolveServices("teeth cleaning", CATALOG).kind, "exact");
    assert.equal(resolveServices("clean my teeth", CATALOG).kind, "fuzzy");
    assert.equal(resolveServices("my tooth hurts", CATALOG).kind, "none");
    assert.equal(resolveServices("teeth cleaning", []).kind, "none");
  });

  test("an empty catalogue never produces a service, and the agent asks for it", () => {
    const s = call();
    const step = say(s, "Clean my teeth tomorrow at 4 PM", []);
    assert.equal(s.service, null);
    assert.deepEqual(step, { kind: "ask", slot: "service" });
  });
});

describe("G1: several services fit equally -> the caller chooses, never us", () => {
  for (const said of ["టీత్ క్లీనింగ్", "Clean my teeth", "పళ్ళు క్లీన్ చేసుకోవాలి"]) {
    test(`${JSON.stringify(said)} with two cleaning services asks which one`, () => {
      const s = call();
      const step = say(s, said, AMBIGUOUS);
      assert.equal(s.service?.provenance, "uncertain");
      assert.equal(step.kind, "clarify");
      assert.deepEqual(step.kind === "clarify" && [...step.options].sort(), [
        "Teeth Cleaning",
        "Teeth Cleaning & Polish",
      ]);
      assert.equal(resolveServices(said, AMBIGUOUS).kind, "ambiguous");
    });
  }
  test("the answer to 'which one?' settles it, and the question is not asked again", () => {
    const s = call();
    say(s, "Clean my teeth", AMBIGUOUS);
    agentSaid(s, nextStep(s), { interrupted: false });
    const step = say(s, "the one with polish", AMBIGUOUS);
    assert.equal(serviceId(s), "svc-cleaning-polish");
    assert.equal(s.service?.provenance, "explicit");
    assert.notEqual(step.kind, "clarify");
  });
  test("an exact name is never ambiguous", () => {
    const s = call();
    say(s, "Teeth Cleaning", AMBIGUOUS);
    assert.equal(serviceId(s), "svc-cleaning");
    assert.equal(s.service?.provenance, "explicit");
  });
});

describe("G1: a settled service is not replaced by a passing mention", () => {
  test("after 'root canal', a question that mentions cleaning keeps root canal", () => {
    const s = call();
    say(s, "root canal");
    say(s, "do you also clean teeth?");
    assert.equal(serviceId(s), "svc-root-canal");
  });
  test("a correction does change it", () => {
    const s = call();
    say(s, "root canal");
    say(s, "actually, clean my teeth instead");
    assert.equal(serviceId(s), "svc-cleaning");
  });
});

describe("G1: the resolved service id and duration reach the calendar", () => {
  test("natural Telugu -> Teeth Cleaning's id and 30 minutes; 'root canal' -> 90 minutes", async () => {
    for (const [said, id, minutes] of [
      ["టీత్ క్లీనింగ్ రేపు సాయంత్రం 4 గంటలకు", "svc-cleaning", 30],
      ["root canal tomorrow at 4 PM", "svc-root-canal", 90],
    ] as const) {
      const s = call();
      const step = say(s, said);
      assert.equal(step.kind, "check_availability", said);
      const queries: Parameters<BookingBackend["checkAvailability"]>[0][] = [];
      const backend: BookingBackend = {
        checkAvailability: async (q) => (queries.push(q), { ok: true, slots: [] }),
        book: async () => {
          throw new Error("not booking");
        },
      };
      const tools = buildTools({ business: ctxFor(CATALOG), backend, state: s }, new Set());
      await tools.check_availability.execute({}, { ctx: {} as never, toolCallId: "t" } as never);
      assert.equal(queries.length, 1);
      assert.equal(queries[0]!.serviceId, id);
      assert.equal(queries[0]!.durationMinutes, minutes);
    }
  });
  test("no availability check (and so no slot offered) before the service is known", () => {
    const s = call();
    const step = say(s, "tomorrow at 4 PM");
    assert.deepEqual(step, { kind: "ask", slot: "service" });
  });
});
