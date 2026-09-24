import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  startRuntimeSession,
  terminateRuntimeSession,
  type StartRuntimeSessionInput,
  type RuntimeDeps,
  type ToolExecContext,
} from "./voice-runtime.server.ts";
import { createHarness } from "./telephony/voice-runtime-test-harness.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ClaudeTool } from "./claude.server.ts";

/**
 * INTEGRATION-tier coverage for the Phase 4 AI tool-calling path added to
 * voice-runtime.server.ts's `getReply` — same tier and harness as
 * voice-runtime-harness.test.ts, extended with the three new optional
 * RuntimeDeps fields (generateReplyWithTools/resolveAvailableTools/
 * executeTool). createHarness()'s base deps deliberately omit all three,
 * so every OTHER test in voice-runtime-harness.test.ts already proves the
 * fully-backward-compatible case; this file proves the opt-in path works
 * end to end through the real, unmodified startRuntimeSession/
 * handleUserUtterance code.
 */

const minimalAgent: AgentSnapshot["agent"] = {
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
  greetings: { "en-IN": "Hello, thanks for calling Test Business." },
  transfer_number: null,
  after_hours_behavior: "take_message",
};

function baseInput(
  callId: string,
  bridge: StartRuntimeSessionInput["bridge"],
): StartRuntimeSessionInput {
  return {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: "00000000-0000-0000-0000-000000000002",
    agentVersion: 3,
    instructions: "You are Aria, a helpful receptionist for Test Business.",
    snapshotAgent: minimalAgent,
    businessName: "Test Business",
    bridge,
  };
}

async function drain(hops = 8) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

function newCallId(): string {
  return `harness-tools-call-${crypto.randomUUID()}`;
}

describe("voice-runtime tool-calling path (getReply)", () => {
  test("an agent with zero permitted tools falls back to plain generateReply — generateReplyWithTools is never invoked", async () => {
    const h = createHarness();
    const callId = newCallId();

    let resolveAvailableToolsCalls = 0;
    let generateReplyWithToolsCalls = 0;
    const deps: RuntimeDeps = {
      ...h.deps,
      resolveAvailableTools: async () => {
        resolveAvailableToolsCalls++;
        return [];
      },
      generateReplyWithTools: async () => {
        generateReplyWithToolsCalls++;
        return { reply: "should not be used", toolCalls: [] };
      },
      executeTool: async () => ({ content: "{}" }),
    };

    const handle = await startRuntimeSession(baseInput(callId, h.bridge), deps);
    h.llm.setNextReply("Plain path reply.");
    h.stt.speakUtterance("What are your hours?");
    await drain();

    assert.equal(resolveAvailableToolsCalls, 1);
    assert.equal(
      generateReplyWithToolsCalls,
      0,
      "no permitted tools means the tool-calling call is skipped entirely",
    );
    assert.equal(h.llm.calls.length, 1, "falls through to the plain generateReply path");
    assert.ok(h.tts.sentTexts.some((t) => t.includes("Plain path reply")));
    assert.equal(handle.state, "listening");

    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a permitted tool is resolved, the model's tool_use is executed with server-derived context (never model input), and the final reply is spoken", async () => {
    const h = createHarness();
    const callId = newCallId();
    const input = baseInput(callId, h.bridge);

    const availableTools: ClaudeTool[] = [
      { name: "check_calendar_availability", description: "d", input_schema: { type: "object" } },
    ];
    const seenExecuteCalls: {
      name: string;
      input: Record<string, unknown>;
      ctx: ToolExecContext;
    }[] = [];
    let seenResolveArgs: { organizationId: string; businessId: string } | null = null;

    const deps: RuntimeDeps = {
      ...h.deps,
      resolveAvailableTools: async (organizationId, businessId) => {
        seenResolveArgs = { organizationId, businessId };
        return availableTools;
      },
      executeTool: async (name, toolInput, ctx) => {
        seenExecuteCalls.push({ name, input: toolInput, ctx });
        return { content: JSON.stringify({ success: true, data: { slots: ["15:00"] } }) };
      },
      generateReplyWithTools: async (messages, tools, executeTool) => {
        assert.deepEqual(tools, availableTools);
        assert.equal(messages[0]?.role, "system");
        const toolResult = await executeTool("check_calendar_availability", {
          dateIso: "2026-10-01",
        });
        assert.equal(JSON.parse(toolResult.content).success, true);
        return {
          reply: "You're free at 3pm tomorrow.",
          toolCalls: [
            {
              name: "check_calendar_availability",
              input: { dateIso: "2026-10-01" },
              isError: false,
            },
          ],
        };
      },
    };

    const handle = await startRuntimeSession(input, deps);
    h.stt.speakUtterance("Do you have any slots tomorrow?");
    await drain();

    assert.deepEqual(seenResolveArgs, {
      organizationId: input.organizationId,
      businessId: input.businessId,
    });
    assert.equal(seenExecuteCalls.length, 1);
    assert.deepEqual(seenExecuteCalls[0]!.ctx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      agentConfigId: input.agentConfigId,
      callId: input.callId,
    });
    assert.ok(h.tts.sentTexts.some((t) => t.includes("free at 3pm")));
    assert.equal(handle.state, "listening");
    // The plain generateReply path must not have been used for this turn.
    assert.equal(h.llm.calls.length, 0);

    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a stale tool-calling reply is discarded exactly like a plain-path reply when the caller barged in first", async () => {
    const h = createHarness();
    const callId = newCallId();
    const input = baseInput(callId, h.bridge);

    type ToolReply = {
      reply: string;
      toolCalls: { name: string; input: Record<string, unknown>; isError: boolean }[];
    };
    let releaseToolReply: ((value: ToolReply) => void) | undefined;
    const pendingToolReply = new Promise<ToolReply>((resolve) => {
      releaseToolReply = resolve;
    });
    const deps: RuntimeDeps = {
      ...h.deps,
      resolveAvailableTools: async () => [
        { name: "check_calendar_availability", description: "d", input_schema: { type: "object" } },
      ],
      executeTool: async () => ({ content: "{}" }),
      generateReplyWithTools: async () => pendingToolReply,
    };

    const handle = await startRuntimeSession(input, deps);
    h.stt.speakUtterance("Book me a slot");
    await drain();

    // Barge in before the in-flight tool-calling turn resolves.
    h.stt.emit({ type: "speech_start" });
    await drain();
    releaseToolReply!({ reply: "stale reply, must be discarded", toolCalls: [] });
    await drain();

    assert.ok(
      !h.tts.sentTexts.some((t) => t.includes("stale reply")),
      "a reply from a superseded generation must never reach TTS",
    );
    assert.notEqual(handle.state, "failed");

    await terminateRuntimeSession(callId, "test cleanup");
  });
});
