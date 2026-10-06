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
});
