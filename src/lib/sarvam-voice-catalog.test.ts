import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SARVAM_LANGUAGE_NAMES,
  SARVAM_VOICE_CATALOG,
  findSarvamVoice,
  sarvamAgentConfigPatch,
  validateVoiceLanguageSettings,
  voicesForLanguages,
} from "./sarvam-voice-catalog.ts";

// Real catalog entries (snapshot 2026-11-14).
const SIMRAN_HINGLISH_V4 = "01a0cf17-12bd-7de3-9df0-f607db604d52";
const SIMRAN_V31 = "01a0cf16-5db4-7924-a37d-8f3bb1234d7c";
const KAVITHA_TELUGU_V4 = "01a0cf16-897b-76f8-8de9-34f27e861df6";

const base = {
  defaultLanguage: "Telugu",
  allowedLanguages: [] as string[],
  autoLanguageSwitch: true,
  voiceInternalId: KAVITHA_TELUGU_V4,
};

describe("Sarvam language list", () => {
  test("is 11 Indian languages plus English, including Assamese", () => {
    assert.equal(SARVAM_LANGUAGE_NAMES.length, 12);
    assert.ok(SARVAM_LANGUAGE_NAMES.includes("Assamese"));
    assert.ok(SARVAM_LANGUAGE_NAMES.includes("English"));
  });

  test("the migration's language whitelist matches the code list exactly", () => {
    const sql = readFileSync(
      new URL(
        "../../supabase/migrations/20261114090000_agent_voice_language_settings.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const listed = [...sql.matchAll(/'([A-Z][a-z]+)'/g)].map((m) => m[1]);
    for (const name of SARVAM_LANGUAGE_NAMES)
      assert.ok(listed.includes(name), `${name} missing in SQL`);
  });
});

describe("voice catalog snapshot", () => {
  test("has v4 voices covering every language, and no v3.1 voice covers Assamese", () => {
    for (const l of SARVAM_LANGUAGE_NAMES) assert.ok(voicesForLanguages([l]).length > 0, l);
    assert.ok(
      SARVAM_VOICE_CATALOG.filter((v) => v.model === "v3.1").every(
        (v) => !v.languages.includes("Assamese"),
      ),
    );
  });

  test("voicesForLanguages returns only v4 voices, native speakers first", () => {
    const list = voicesForLanguages(["Telugu", "English", "Hindi"]);
    assert.ok(list.every((v) => v.model === "v4"));
    assert.ok(list[0]!.nativeLanguages.includes("Telugu"));
  });
});

describe("validateVoiceLanguageSettings", () => {
  test("always adds English and Hindi after the default, without duplicates", () => {
    const s = validateVoiceLanguageSettings({ ...base, allowedLanguages: ["Hindi", "Tamil"] });
    assert.deepEqual(s.allowedLanguages, ["Telugu", "English", "Hindi", "Tamil"]);
  });

  test("allows at most two extra regional languages", () => {
    assert.ok(validateVoiceLanguageSettings({ ...base, allowedLanguages: ["Tamil", "Kannada"] }));
    assert.throws(
      () =>
        validateVoiceLanguageSettings({ ...base, allowedLanguages: ["Tamil", "Kannada", "Odia"] }),
      /At most 2 extra regional/,
    );
  });

  test("an English default still allows two regional languages", () => {
    const s = validateVoiceLanguageSettings({
      ...base,
      defaultLanguage: "English",
      allowedLanguages: ["Telugu", "Tamil"],
      voiceInternalId: SIMRAN_HINGLISH_V4,
    });
    assert.deepEqual(s.allowedLanguages, ["English", "Hindi", "Telugu", "Tamil"]);
  });

  test("rejects unknown languages, unknown voices and legacy v3.1 voices", () => {
    assert.throws(
      () => validateVoiceLanguageSettings({ ...base, defaultLanguage: "Urdu" }),
      /not a supported/,
    );
    assert.throws(
      () => validateVoiceLanguageSettings({ ...base, allowedLanguages: ["Sanskrit"] }),
      /Unsupported/,
    );
    assert.throws(
      () => validateVoiceLanguageSettings({ ...base, voiceInternalId: "nope" }),
      /not in the Sarvam/,
    );
    assert.throws(
      () => validateVoiceLanguageSettings({ ...base, voiceInternalId: SIMRAN_V31 }),
      /legacy v3\.1 voice/,
    );
  });

  test("warns when the voice is not native in the default language", () => {
    const s = validateVoiceLanguageSettings({ ...base, voiceInternalId: SIMRAN_HINGLISH_V4 });
    assert.ok(s.warnings.some((w) => w.includes("native Telugu speaker")));
    const native = validateVoiceLanguageSettings(base);
    assert.equal(native.warnings.length, 0);
  });

  test("warns that the switch tool cannot target Assamese", () => {
    const s = validateVoiceLanguageSettings({ ...base, allowedLanguages: ["Assamese"] });
    assert.ok(s.warnings.some((w) => w.includes("cannot switch into Assamese")));
  });
});

describe("sarvamAgentConfigPatch", () => {
  test("auto-switch on: every allowed language is supported and identified", () => {
    const s = validateVoiceLanguageSettings({ ...base, allowedLanguages: ["Tamil"] });
    const p = sarvamAgentConfigPatch(s);
    assert.equal(p.language_config.initial_language_name, "Telugu");
    assert.deepEqual(p.language_config.supported_languages, [
      "Telugu",
      "English",
      "Hindi",
      "Tamil",
    ]);
    assert.equal(p.language_config.enable_language_identification, true);
    assert.equal(p.text_to_speech_config.internal_id, KAVITHA_TELUGU_V4);
    assert.ok(findSarvamVoice(p.text_to_speech_config.internal_id));
  });

  test("auto-switch off: the agent knows only its default language", () => {
    const s = validateVoiceLanguageSettings({ ...base, autoLanguageSwitch: false });
    const p = sarvamAgentConfigPatch(s);
    assert.deepEqual(p.language_config.supported_languages, ["Telugu"]);
    assert.equal(p.language_config.enable_language_identification, false);
  });
});

describe("defaults (Phase 4A)", () => {
  test("default language follows the customer's main language code, English when unknown", async () => {
    const { sarvamLanguageFromCode, suggestVoiceLanguageDefaults } =
      await import("./sarvam-voice-catalog.ts");
    assert.equal(sarvamLanguageFromCode("te-IN"), "Telugu");
    assert.equal(sarvamLanguageFromCode("or-IN"), "Odia");
    assert.equal(sarvamLanguageFromCode("xx-YY"), null);
    assert.equal(suggestVoiceLanguageDefaults(null).defaultLanguage, "English");
    const te = suggestVoiceLanguageDefaults("te-IN");
    assert.equal(te.defaultLanguage, "Telugu");
    // The suggestion must itself pass validation.
    const v = validateVoiceLanguageSettings({
      defaultLanguage: te.defaultLanguage,
      allowedLanguages: [],
      autoLanguageSwitch: true,
      voiceInternalId: te.voiceInternalId!,
    });
    assert.ok(v.voice.nativeLanguages.includes("Telugu"));
  });
});
