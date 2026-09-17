import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sarvam } from "./sarvam.server.ts";
import { claude } from "./claude.server.ts";
import { resolveVoiceLlmProvider, resolveGenerateReply } from "./llm-provider.server.ts";

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prior[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("resolveVoiceLlmProvider — defaults to Sarvam, never silently changes live behavior", () => {
  test("defaults to 'sarvam' when VOICE_LLM_PROVIDER is unset — this production system runs on Sarvam today, and adding Claude must not flip that on its own", async () => {
    await withEnv({ VOICE_LLM_PROVIDER: undefined }, () => {
      assert.equal(resolveVoiceLlmProvider(), "sarvam");
      return Promise.resolve();
    });
  });

  test("VOICE_LLM_PROVIDER=claude (any casing/whitespace) selects Claude", async () => {
    for (const raw of ["claude", "Claude", "CLAUDE", " claude "]) {
      await withEnv({ VOICE_LLM_PROVIDER: raw }, () => {
        assert.equal(resolveVoiceLlmProvider(), "claude", `expected "${raw}" to select claude`);
        return Promise.resolve();
      });
    }
  });

  test("an unrecognized value fails closed to 'sarvam', never throws, never silently no-ops the call", async () => {
    await withEnv({ VOICE_LLM_PROVIDER: "gpt-5" }, () => {
      assert.equal(resolveVoiceLlmProvider(), "sarvam");
      return Promise.resolve();
    });
  });
});

describe("resolveGenerateReply — returns the exact function reference for the resolved provider", () => {
  test("resolves to sarvam.runConversation by default", async () => {
    await withEnv({ VOICE_LLM_PROVIDER: undefined }, () => {
      assert.equal(resolveGenerateReply(), sarvam.runConversation);
      return Promise.resolve();
    });
  });

  test("resolves to claude.runConversation when selected", async () => {
    await withEnv({ VOICE_LLM_PROVIDER: "claude" }, () => {
      assert.equal(resolveGenerateReply(), claude.runConversation);
      return Promise.resolve();
    });
  });
});

describe("REGRESSION: voice-runtime.server.ts's STT/TTS wiring is untouched by the LLM-provider change", () => {
  test("defaultRuntimeDeps still wires connectStt/connectTts to Sarvam's realtime clients directly — only generateReply goes through llm-provider.server.ts", () => {
    const source = readFileSync(new URL("./voice-runtime.server.ts", import.meta.url), "utf8");
    const depsIdx = source.indexOf("export const defaultRuntimeDeps: RuntimeDeps = {");
    assert.ok(depsIdx > -1);
    const block = source.slice(depsIdx, source.indexOf("};", depsIdx));
    assert.match(block, /connectStt:\s*connectSarvamStt/);
    assert.match(block, /connectTts:\s*connectSarvamTts/);
    assert.match(block, /generateReply:\s*resolveGenerateReply\(\)/);
  });

  test("voice-runtime.server.ts no longer imports sarvam.server.ts's `sarvam` export directly — the LLM choice is fully delegated to llm-provider.server.ts", () => {
    const source = readFileSync(new URL("./voice-runtime.server.ts", import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /import\s*\{\s*sarvam,/,
      "expected no direct `sarvam` import left in voice-runtime.server.ts",
    );
    assert.match(
      source,
      /import\s*\{\s*resolveGenerateReply\s*\}\s*from\s*["']\.\/llm-provider\.server\.ts["']/,
    );
  });
});
