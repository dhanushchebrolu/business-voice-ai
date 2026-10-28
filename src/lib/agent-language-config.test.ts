import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { voiceIdInput, voiceLanguageCode } from "./agent-config-input.ts";
import { buildAgentInstructions, type AgentSnapshot } from "./agent-instructions.ts";
import { SUPPORTED_VOICE_LANGUAGES } from "./agent-instructions.ts";

/**
 * Language configuration from the dashboard to the prompt. Multilingual
 * behavior is automatic for every agent (voice-languages.ts
 * nextCallLanguage), so the only language setting a customer has is the
 * primary language: where a call starts. These tests pin that there is no
 * toggle anywhere in that path, and that saved languages are validated.
 */

const repoFile = (...parts: string[]) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", ...parts), "utf8").replace(
    /\r\n/g,
    "\n",
  );

describe("input validation (saveAgentConfiguration / synthesizeVoicePreview)", () => {
  test("language codes: Odia normalized, anything outside the 11 rejected", () => {
    assert.equal(voiceLanguageCode.parse("or-IN"), "od-IN");
    assert.equal(voiceLanguageCode.parse("hi-IN"), "hi-IN");
    for (const bad of ["ur-IN", "en-US", "auto", ""]) {
      assert.equal(voiceLanguageCode.safeParse(bad).success, false, bad);
    }
  });

  test("voice: a known bulbul:v3 speaker, case-insensitive; unknown voices rejected", () => {
    assert.equal(voiceIdInput.parse("Ritu"), "ritu");
    assert.equal(voiceIdInput.safeParse("meera").success, false);
  });
});

describe("no language-switching setting between the dashboard and the call", () => {
  const dashboard = repoFile("src", "routes", "app.agent.tsx");
  const functions = repoFile("src", "lib", "agent.functions.ts");
  const saveStart = functions.indexOf("export const saveAgentConfiguration = createServerFn");
  const saveFn = functions.slice(saveStart, functions.indexOf("\nexport const ", saveStart + 1));

  test("the dashboard has no 'Switch language automatically' toggle and sends no multilingual flag", () => {
    assert.doesNotMatch(dashboard, /Switch language automatically/);
    assert.doesNotMatch(dashboard, /multilingual/);
  });

  test("saving never writes multilingual, extra_languages, or a language mode", () => {
    const update =
      /\.from\("agent_configs"\)\s*\n\s*\.update\(\{([\s\S]*?)\}\)\s*\n\s*\.eq\("id", agentRow\.id\);/.exec(
        saveFn,
      );
    assert.ok(update, "expected saveAgentConfiguration's field update");
    for (const column of ["multilingual", "extra_languages", "language_mode"]) {
      assert.doesNotMatch(update[1]!, new RegExp(`\\b${column}\\b`), column);
    }
  });

  test("an older dashboard that still sends multilingual is accepted, not rejected", () => {
    const schemaStart = functions.indexOf("const saveAgentConfigurationInput = z.object({");
    const schema = functions.slice(schemaStart, functions.indexOf("\n});", schemaStart));
    assert.match(schema, /multilingual: z\.boolean\(\)\.optional\(\),/);
    assert.match(schema, /primary_language: voiceLanguageCode,/);
    assert.match(schema, /voice_id: voiceIdInput,/);
  });

  test("there is no migration for a language mode", () => {
    const migrations = repoFile(
      "supabase",
      "migrations",
      "20260908110000_sarvam_provider_mapping.sql",
    );
    assert.doesNotMatch(migrations, /language_mode/);
  });
});

describe("the prompt is the same automatic-multilingual section for every agent", () => {
  const snapshot = (agent: Partial<AgentSnapshot["agent"]>): AgentSnapshot => ({
    business: {
      name: "Smile Dental",
      business_type: "dental_clinic",
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
      greetings: { "en-IN": "Hello." },
      transfer_number: null,
      after_hours_behavior: "take_message",
      ...agent,
    },
  });
  const languageOf = (prompt: string) => prompt.slice(prompt.indexOf("# LANGUAGE"));

  test("multilingual and extra_languages make no difference", () => {
    const base = languageOf(buildAgentInstructions(snapshot({})));
    assert.equal(
      languageOf(
        buildAgentInstructions(snapshot({ multilingual: true, extra_languages: ["hi-IN"] })),
      ),
      base,
    );
    for (const { code, name } of SUPPORTED_VOICE_LANGUAGES) {
      assert.match(base, new RegExp(`${name} \\(${code}\\)`));
    }
  });

  test("tells the model a language change keeps everything the caller already said", () => {
    assert.match(
      languageOf(buildAgentInstructions(snapshot({}))),
      /A change of language never resets the conversation/,
    );
  });

  test("the primary language (normalized) is the default", () => {
    assert.match(
      languageOf(buildAgentInstructions(snapshot({ primary_language: "or-IN" }))),
      /Your default language is od-IN/,
    );
  });
});
