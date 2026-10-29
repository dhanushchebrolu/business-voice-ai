import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { voiceIdInput, voiceLanguageCode } from "./agent-config-input.ts";
import {
  buildAgentInstructions,
  withCurrentLanguageSection,
  type AgentSnapshot,
} from "./agent-instructions.ts";
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

describe("withCurrentLanguageSection — calls never replay an outdated language rule", () => {
  const agent = (over: Partial<AgentSnapshot["agent"]> = {}): AgentSnapshot["agent"] => ({
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
    ...over,
  });
  /** Today's section, taken from a freshly built prompt (the one source of the wording). */
  const currentSection = (a: AgentSnapshot["agent"]) => {
    const built = buildAgentInstructions({
      business: {
        name: "X",
        business_type: "dental_clinic",
        timezone: "Asia/Kolkata",
        currency: "INR",
      },
      hours: [],
      services: [],
      faqs: [],
      rules: [],
      knowledge: [],
      agent: a,
    });
    const start = built.indexOf("# LANGUAGE\n") + "# LANGUAGE\n".length;
    return built.slice(start, built.indexOf("\n", start));
  };
  // The shape of an agent published before every call became multilingual
  // (agent-instructions.ts before 6 October): the production agent's
  // version 2, published 16 September, still says "Respond in: en-IN.".
  const before =
    "# BUSINESS CONTEXT\nYou are the phone receptionist for Smile Dental.\n\n" +
    "# RULES AND RESTRICTIONS\n1. Only answer with information given above.\n\n" +
    "# ESCALATION\nNo transfer number configured — take a message.\n\n";
  const after =
    "# SAFETY\n- Only use information from this document and confirmed tool results.\n" +
    "- Never claim a booking, cancellation or message was completed unless a tool confirmed it.";
  const published = `${before}# LANGUAGE\nRespond in: en-IN.\n\n${after}`;

  test("the September prompt's English-only rule is replaced by today's section", () => {
    const out = withCurrentLanguageSection(published, agent());
    assert.doesNotMatch(out, /Respond in: en-IN\./);
    assert.ok(out.includes(`# LANGUAGE\n${currentSection(agent())}\n\n# SAFETY`), out);
    assert.match(out, /Never refuse a call or claim you can only help in English/);
    assert.equal(out.match(/^# LANGUAGE$/gm)?.length, 1, "exactly one language section");
  });

  test("everything before and after the section is kept byte for byte", () => {
    const out = withCurrentLanguageSection(published, agent());
    assert.ok(out.startsWith(`${before}# LANGUAGE\n`));
    assert.ok(out.endsWith(`\n\n${after}`));
  });

  test("a prompt with no language section gets today's appended", () => {
    const withoutLanguage = `${before}${after}`;
    const out = withCurrentLanguageSection(withoutLanguage, agent());
    assert.ok(out.startsWith(withoutLanguage));
    assert.ok(out.endsWith(`\n\n# LANGUAGE\n${currentSection(agent())}\n`));
  });

  test("a freshly built prompt is left exactly as it is, and applying it twice changes nothing more", () => {
    const now = new Date("2026-10-29T06:00:00Z");
    const fresh = buildAgentInstructions(
      {
        business: {
          name: "X",
          business_type: "dental_clinic",
          timezone: "Asia/Kolkata",
          currency: "INR",
        },
        hours: [],
        services: [],
        faqs: [],
        rules: [{ rule: "Never quote prices over the phone.", priority: 1, is_active: true }],
        knowledge: [],
        agent: agent({ capabilities: { book_appointments: true } }),
      },
      now,
    );
    assert.equal(withCurrentLanguageSection(fresh, agent()), fresh);
    const once = withCurrentLanguageSection(published, agent());
    assert.equal(withCurrentLanguageSection(once, agent()), once);
  });

  test("only the generated (last) section is replaced, never a heading inside uploaded knowledge", () => {
    const knowledge =
      "# ADDITIONAL KNOWLEDGE\n## Policies\n# LANGUAGE\nOur staff speak Kannada.\n\n";
    const out = withCurrentLanguageSection(`${knowledge}${published}`, agent());
    assert.ok(out.startsWith(knowledge), "the uploaded text is untouched");
    assert.doesNotMatch(out, /Respond in: en-IN\./);
  });

  test("an English-primary agent still defaults to English; another primary language is kept", () => {
    assert.match(withCurrentLanguageSection(published, agent()), /Your default language is en-IN/);
    assert.match(
      withCurrentLanguageSection(
        published.replace("en-IN", "te-IN"),
        agent({ primary_language: "te-IN" }),
      ),
      /Your default language is te-IN/,
    );
  });

  test("an empty section directly followed by the next heading still leaves that heading on its own line", () => {
    const out = withCurrentLanguageSection(`${before}# LANGUAGE\n# SAFETY\nx`, agent());
    assert.ok(out.includes(`${currentSection(agent())}\n\n# SAFETY\nx`), out);
  });
});

describe("calls use the current language section, not the one saved at publish time", () => {
  test("routeToAgentRuntime passes published instructions through withCurrentLanguageSection with the snapshot's agent", () => {
    const src = repoFile("src", "lib", "telephony-runtime.ts");
    assert.match(
      src,
      /instructions = withCurrentLanguageSection\(publishedVersion\.instructions, snapshot\.agent\);/,
    );
    assert.doesNotMatch(src, /instructions = publishedVersion\.instructions;/);
  });
});
