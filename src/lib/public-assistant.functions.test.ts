import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runPublicChat,
  runPublicVoiceTurn,
  type PublicChatDeps,
  type PublicVoiceTurnDeps,
} from "./public-assistant.functions.ts";

const ALLOWED = { allowed: true, retryAfterSeconds: 0 };
const DENIED = { allowed: false, retryAfterSeconds: 600 };

const ENABLED_SETTINGS = {
  chatbotEnabled: true,
  voiceEnabled: true,
  welcomeMessage: "hi",
  fallbackResponse: "not sure",
};

function chatDeps(
  overrides: Partial<PublicChatDeps> = {},
): PublicChatDeps & { sarvamCalls: number } {
  const calls = { count: 0 };
  const deps: PublicChatDeps & { sarvamCalls: number } = {
    checkRateLimit: async () => ALLOWED,
    clientKey: "test-client",
    loadSettings: async () => ENABLED_SETTINGS,
    buildSystemPrompt: async () => "system prompt",
    sarvam: {
      isConfigured: () => true,
      runConversation: async () => {
        calls.count++;
        return { reply: "hello there", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
    get sarvamCalls() {
      return calls.count;
    },
    ...overrides,
  };
  return deps;
}

test("runPublicChat: an allowed request calls Sarvam and returns its reply", async () => {
  const deps = chatDeps();
  const result = await runPublicChat({ message: "hi", history: [] }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.reply, "hello there");
  assert.equal(deps.sarvamCalls, 1);
});

test("runPublicChat: a rate-limited request never calls Sarvam", async () => {
  const deps = chatDeps({ checkRateLimit: async () => DENIED });
  const result = await runPublicChat({ message: "hi", history: [] }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.rateLimited, true);
  assert.equal(deps.sarvamCalls, 0, "Sarvam must not be invoked once rate-limited");
});

test("runPublicChat: chatbot disabled short-circuits before Sarvam", async () => {
  const deps = chatDeps({
    loadSettings: async () => ({ ...ENABLED_SETTINGS, chatbotEnabled: false }),
  });
  const result = await runPublicChat({ message: "hi", history: [] }, deps);
  assert.equal(result.ok, false);
  assert.equal(deps.sarvamCalls, 0);
});

test("runPublicChat: missing Sarvam configuration short-circuits before calling it", async () => {
  const deps = chatDeps({
    sarvam: {
      isConfigured: () => false,
      runConversation: async () => {
        throw new Error("must not be called");
      },
    },
  });
  const result = await runPublicChat({ message: "hi", history: [] }, deps);
  assert.equal(result.ok, false);
  assert.match(result.reply, /configured/i);
});

test("runPublicChat: a Sarvam failure returns ok:false instead of throwing", async () => {
  const deps = chatDeps({
    sarvam: {
      isConfigured: () => true,
      runConversation: async () => {
        throw new Error("upstream 500: <html>internal details</html>");
      },
    },
  });
  const result = await runPublicChat({ message: "hi", history: [] }, deps);
  assert.equal(result.ok, false);
  assert.doesNotMatch(
    result.reply,
    /internal details|upstream 500/,
    "must not leak the raw provider error",
  );
});

function voiceDeps(overrides: Partial<PublicVoiceTurnDeps> = {}) {
  const calls = { stt: 0, chat: 0, tts: 0 };
  const deps: PublicVoiceTurnDeps & { calls: typeof calls } = {
    checkRateLimit: async () => ALLOWED,
    clientKey: "test-client",
    loadSettings: async () => ENABLED_SETTINGS,
    buildSystemPrompt: async () => "system prompt",
    sarvam: {
      isConfigured: () => true,
      speechToText: async () => {
        calls.stt++;
        return { transcript: "what languages do you support" };
      },
      runConversation: async () => {
        calls.chat++;
        return { reply: "eleven Indian languages", usage: { input_tokens: 1, output_tokens: 1 } };
      },
      generateSpeech: async () => {
        calls.tts++;
        return "base64-audio";
      },
    },
    calls,
    ...overrides,
  };
  return deps;
}

test("runPublicVoiceTurn: an allowed request runs STT -> chat -> TTS and returns audio", async () => {
  const deps = voiceDeps();
  const result = await runPublicVoiceTurn(
    { audioBase64: "abc", mimeType: "audio/webm", history: [] },
    deps,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.transcript, "what languages do you support");
    assert.equal(result.reply, "eleven Indian languages");
    assert.equal(result.audioBase64, "base64-audio");
  }
  assert.deepEqual(deps.calls, { stt: 1, chat: 1, tts: 1 });
});

test("runPublicVoiceTurn: a rate-limited request never calls STT, chat, or TTS", async () => {
  const deps = voiceDeps({ checkRateLimit: async () => DENIED });
  const result = await runPublicVoiceTurn(
    { audioBase64: "abc", mimeType: "audio/webm", history: [] },
    deps,
  );
  assert.equal(result.ok, false);
  assert.equal("rateLimited" in result && result.rateLimited, true);
  assert.deepEqual(deps.calls, { stt: 0, chat: 0, tts: 0 });
});

test("runPublicVoiceTurn: missing configuration never calls STT", async () => {
  const deps = voiceDeps({
    sarvam: {
      isConfigured: () => false,
      speechToText: async () => {
        throw new Error("must not be called");
      },
      runConversation: async () => {
        throw new Error("must not be called");
      },
      generateSpeech: async () => {
        throw new Error("must not be called");
      },
    },
  });
  const result = await runPublicVoiceTurn(
    { audioBase64: "abc", mimeType: "audio/webm", history: [] },
    deps,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(deps.calls, { stt: 0, chat: 0, tts: 0 });
});

test("runPublicVoiceTurn: an STT failure returns ok:false and never calls chat/TTS", async () => {
  const deps = voiceDeps({
    sarvam: {
      isConfigured: () => true,
      speechToText: async () => {
        deps.calls.stt++;
        throw new Error("provider secret-key-1234 rejected");
      },
      runConversation: async () => {
        throw new Error("must not be called");
      },
      generateSpeech: async () => {
        throw new Error("must not be called");
      },
    },
  });
  const result = await runPublicVoiceTurn(
    { audioBase64: "abc", mimeType: "audio/webm", history: [] },
    deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.doesNotMatch(result.reason, /secret-key-1234/, "must not leak the raw provider error");
  }
  assert.deepEqual(deps.calls, { stt: 1, chat: 0, tts: 0 });
});

test("runPublicVoiceTurn: an empty transcript is treated as a failure without calling chat/TTS", async () => {
  const deps = voiceDeps({
    sarvam: {
      isConfigured: () => true,
      speechToText: async () => {
        return { transcript: "" };
      },
      runConversation: async () => {
        throw new Error("must not be called");
      },
      generateSpeech: async () => {
        throw new Error("must not be called");
      },
    },
  });
  const result = await runPublicVoiceTurn(
    { audioBase64: "abc", mimeType: "audio/webm", history: [] },
    deps,
  );
  assert.equal(result.ok, false);
  assert.equal(deps.calls.chat, 0);
});

test("runPublicVoiceTurn: a chat failure returns ok:false and never calls TTS", async () => {
  const deps = voiceDeps({
    sarvam: {
      isConfigured: () => true,
      speechToText: async () => ({ transcript: "hello" }),
      runConversation: async () => {
        throw new Error("upstream chat failure with internal trace");
      },
      generateSpeech: async () => {
        throw new Error("must not be called");
      },
    },
  });
  const result = await runPublicVoiceTurn(
    { audioBase64: "abc", mimeType: "audio/webm", history: [] },
    deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.doesNotMatch(result.reason, /internal trace/);
  }
  assert.equal(deps.calls.tts, 0);
});

test("runPublicVoiceTurn: a TTS failure returns ok:false with a safe message", async () => {
  const deps = voiceDeps({
    sarvam: {
      isConfigured: () => true,
      speechToText: async () => ({ transcript: "hello" }),
      runConversation: async () => ({
        reply: "hi there",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      generateSpeech: async () => {
        throw new Error("tts provider internal failure");
      },
    },
  });
  const result = await runPublicVoiceTurn(
    { audioBase64: "abc", mimeType: "audio/webm", history: [] },
    deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.doesNotMatch(result.reason, /tts provider internal failure/);
  }
});
