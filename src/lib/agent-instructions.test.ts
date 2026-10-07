import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentInstructions,
  SUPPORTED_VOICE_LANGUAGES,
  type AgentSnapshot,
} from "./agent-instructions.ts";

/**
 * Covers two of this session's voice-runtime fixes whose actual behavior
 * lives in the LLM's own compliance with these instructions, not in code
 * this repo can unit-test directly:
 *   1. Duplicate greeting — the runtime speaks its own configured greeting
 *      once (voice-runtime.server.ts, already covered by its own tests);
 *      the fix here is telling the model it must not generate a second one.
 *   2. English-only restriction — removed in favor of the 11-language
 *      common supported set, auto-detection, and code-mixing.
 * What's testable from here is that the generated system prompt actually
 * contains the right instructions — the same convention this repo already
 * uses for prompt-driven behavior it can't execute a real LLM against in
 * CI (see docs/voice-pipeline-testing.md's test-pyramid tiers).
 */

const minimalSnapshot: AgentSnapshot = {
  business: {
    name: "Smile Dental",
    business_type: "dental_clinic",
    description: "A friendly neighborhood dental clinic.",
    address: null,
    city: null,
    state: null,
    country: null,
    postal_code: null,
    website: null,
    email: null,
    primary_phone: null,
    whatsapp: null,
    timezone: "Asia/Kolkata",
    currency: "INR",
  },
  hours: [],
  services: [],
  faqs: [],
  rules: [],
  knowledge: [],
  agent: {
    agent_name: "Aria",
    persona: "friendly",
    custom_personality: null,
    objectives: ["answer_questions"],
    capabilities: {},
    primary_language: "en-IN",
    extra_languages: [],
    multilingual: false,
    voice_id: "ritu",
    speaking_pace: 1,
    greetings: { "en-IN": "Hello, thanks for calling Smile Dental." },
    transfer_number: null,
    after_hours_behavior: "take_message",
  },
};

describe("SUPPORTED_VOICE_LANGUAGES — the Saaras/sarvam-105b-conversations/Bulbul common set", () => {
  test("contains exactly the 11 documented languages, by code", () => {
    const codes = SUPPORTED_VOICE_LANGUAGES.map((l) => l.code).sort();
    assert.deepEqual(codes, [
      "bn-IN",
      "en-IN",
      "gu-IN",
      "hi-IN",
      "kn-IN",
      "ml-IN",
      "mr-IN",
      "od-IN",
      "pa-IN",
      "ta-IN",
      "te-IN",
    ]);
  });
});

describe("buildAgentInstructions — do not repeat the greeting", () => {
  test("instructs the model not to greet the caller again, regardless of agent config", () => {
    const prompt = buildAgentInstructions(minimalSnapshot);
    assert.match(prompt, /already heard your opening greeting/i);
    assert.match(prompt, /do not greet the caller again/i);
  });
});

describe("buildAgentInstructions — language support (no English-only restriction)", () => {
  test("explicitly instructs the model never to refuse a call or claim English-only support", () => {
    const prompt = buildAgentInstructions(minimalSnapshot);
    assert.match(prompt, /never refuse a call or claim you can only help in english/i);
  });

  test("lists every one of the 11 supported languages by name and code", () => {
    const prompt = buildAgentInstructions(minimalSnapshot);
    for (const { code, name } of SUPPORTED_VOICE_LANGUAGES) {
      assert.match(prompt, new RegExp(`${name} \\(${code}\\)`));
    }
  });

  test("instructs auto-detection and code-mixed (Hinglish/Tanglish-style) support", () => {
    const prompt = buildAgentInstructions(minimalSnapshot);
    assert.match(prompt, /detect the caller's language/i);
    assert.match(prompt, /code-mixed/i);
    assert.match(prompt, /hinglish/i);
  });

  test("this behavior does not depend on the agent's own multilingual toggle", () => {
    const monolingualPrompt = buildAgentInstructions(minimalSnapshot);
    const multilingualSnapshot: AgentSnapshot = {
      ...minimalSnapshot,
      agent: {
        ...minimalSnapshot.agent,
        multilingual: true,
        extra_languages: ["hi-IN", "ta-IN"],
      },
    };
    const multilingualPrompt = buildAgentInstructions(multilingualSnapshot);
    // Same language section either way — the pipeline's actual capability,
    // not a per-agent-configured subset.
    assert.equal(
      monolingualPrompt.includes("# LANGUAGE"),
      multilingualPrompt.includes("# LANGUAGE"),
    );
    for (const { code } of SUPPORTED_VOICE_LANGUAGES) {
      assert.equal(monolingualPrompt.includes(code), multilingualPrompt.includes(code));
    }
  });

  test("still names the agent's own primary_language as its default for the greeting and when the caller's language is unclear", () => {
    const prompt = buildAgentInstructions(minimalSnapshot);
    assert.match(prompt, /your default language is en-IN/i);
  });

  test("explicitly instructs switching language the moment the caller asks, by name, in both directions", () => {
    const prompt = buildAgentInstructions(minimalSnapshot);
    assert.match(prompt, /switch immediately/i);
    assert.match(prompt, /telugu/i);
  });
});

describe("buildAgentInstructions — # CURRENT DATE (test for resolving relative dates like 'tomorrow')", () => {
  test("states today's date and the business's own timezone, computed from the business timezone not the server's", () => {
    // A fixed instant deliberately on a day boundary in UTC vs IST (UTC+5:30)
    // so a timezone-naive implementation (e.g. just `now.toISOString()`)
    // would show the WRONG calendar date here.
    const now = new Date("2026-10-07T20:30:00.000Z"); // 2026-10-08 02:00 IST
    const prompt = buildAgentInstructions(minimalSnapshot, now);
    assert.match(prompt, /# CURRENT DATE/);
    assert.match(prompt, /2026-10-08/);
    assert.match(prompt, /Asia\/Kolkata/);
  });

  test("defaults to the real current time when no `now` is passed, so every existing caller keeps working unchanged", () => {
    const prompt = buildAgentInstructions(minimalSnapshot);
    assert.match(prompt, /# CURRENT DATE/);
    assert.match(prompt, new RegExp(String(new Date().getUTCFullYear())));
  });

  test("falls back gracefully instead of throwing for an unrecognized timezone string", () => {
    const badTimezoneSnapshot: AgentSnapshot = {
      ...minimalSnapshot,
      business: { ...minimalSnapshot.business, timezone: "Not/ARealTimezone" },
    };
    assert.doesNotThrow(() => buildAgentInstructions(badTimezoneSnapshot));
  });
});

describe("buildAgentInstructions — # RESPONSE STYLE (test P: concise phone responses)", () => {
  test("instructs short replies, one question at a time, and no repeated information", () => {
    const prompt = buildAgentInstructions(minimalSnapshot);
    assert.match(prompt, /# RESPONSE STYLE/);
    assert.match(prompt, /1–2 short sentences|1-2 short sentences/);
    assert.match(prompt, /one question at a time/i);
    assert.match(prompt, /never repeat information/i);
  });
});

describe("buildAgentInstructions — # APPOINTMENT STATE TRACKING (test Q: no repeated questions for known fields)", () => {
  const bookingAgent: AgentSnapshot = {
    ...minimalSnapshot,
    agent: { ...minimalSnapshot.agent, capabilities: { calendar_book: true } },
  };

  test("is included, with the exact marker protocol, only for an agent permitted to book", () => {
    const prompt = buildAgentInstructions(bookingAgent);
    assert.match(prompt, /# APPOINTMENT STATE TRACKING/);
    assert.match(prompt, /<<<APPT_STATE:/);
    assert.match(prompt, /ready_to_book/);
    assert.match(prompt, /never ask again for a field it already lists/i);
  });

  test("is omitted entirely for an agent without calendar_book — never asked to track or emit the marker", () => {
    const prompt = buildAgentInstructions(minimalSnapshot); // capabilities: {}
    assert.doesNotMatch(prompt, /# APPOINTMENT STATE TRACKING/);
    assert.doesNotMatch(prompt, /APPT_STATE/);
  });
});

/**
 * Production incident: a caller said "I want to book an appointment to
 * clean my teeth" and the agent replied "We do not offer appointments,
 * but we do provide professional teeth cleanings" — a dental clinic with
 * a "Teeth Cleaning" service refusing to book it because no service was
 * literally named "appointment". Fix is prompt-only: "appointment" is the
 * booking action, not a service name, and a caller's own description
 * should be matched to the closest listed service.
 */
describe("buildAgentInstructions — appointment intent (test 13/14: booking requests must not be rejected merely because no service is literally named 'appointment')", () => {
  const dentalSnapshot: AgentSnapshot = {
    ...minimalSnapshot,
    services: [
      {
        name: "Teeth Cleaning",
        description: "Routine cleaning.",
        category: null,
        price: 1500,
        currency: "INR",
        duration_minutes: 30,
        attributes: null,
        is_active: true,
      },
    ],
  };

  test("explicitly instructs the model that 'appointment' is a booking action, not a service name", () => {
    const prompt = buildAgentInstructions(dentalSnapshot);
    assert.match(prompt, /"appointment" is not itself a service/i);
    assert.match(prompt, /never tell the caller appointments aren't offered/i);
  });

  test("instructs matching a caller's own description to the closest listed service", () => {
    const prompt = buildAgentInstructions(dentalSnapshot);
    assert.match(prompt, /match it to the closest listed service yourself/i);
  });

  // Production incident round 2: the prompt already had the three
  // assertions above (shipped in commit 470e2c9) and the agent STILL
  // told a real caller "we do not offer appointments" for this exact
  // dental-cleaning request. A soft instruction wasn't enough — this adds
  // an explicit, unambiguous negative constraint naming the literal
  // forbidden claim, in its own prominent "# APPOINTMENTS" section rather
  // than a trailing sentence after the services list.
  test("has a dedicated APPOINTMENTS section with an explicit hard constraint against the exact forbidden claim", () => {
    const prompt = buildAgentInstructions(dentalSnapshot);
    assert.match(prompt, /# APPOINTMENTS/);
    assert.match(prompt, /never say.*does not offer appointments/i);
  });
});
