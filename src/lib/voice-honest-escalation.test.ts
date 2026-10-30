import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentInstructions,
  withCurrentCallSections,
  type AgentSnapshot,
} from "./agent-instructions.ts";
import { classifyCallerClosingIntent } from "./call-lifecycle-policy.ts";
import {
  claimsTransferOrCallback,
  startRuntimeSession,
  terminateRuntimeSession,
  type StartRuntimeSessionInput,
} from "./voice-runtime.server.ts";
import { localizedFallback } from "./voice-fallback-messages.ts";
import { callOutcomeLine } from "./voice-call-outcomes.ts";
import { VOICE_LANGUAGES } from "./voice-languages.ts";
import { createHarness, type Harness } from "./telephony/voice-runtime-test-harness.ts";

/**
 * This line has no live transfer, no callback queue and no message-taking
 * tool. Earlier published prompts told the model to "Transfer to <number>"
 * and to "offer a callback from the team", and several fixed lines promised
 * "someone will call you back" — none of which happens. These tests hold
 * the agent to what it can actually do.
 */

const agent = (transfer_number: string | null): AgentSnapshot["agent"] => ({
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
  greetings: { "en-IN": "Hello, thanks for calling Smile Dental. How can I help you today?" },
  transfer_number,
  after_hours_behavior: "take_message",
});

/** The shape buildAgentInstructions produced before this change. */
const OLD_PUBLISHED =
  "# BUSINESS CONTEXT\nYou are the receptionist for Smile Dental.\n\n" +
  "# SERVICES AND PRICING\n- Cleaning: ₹800\n\n" +
  "# ESCALATION\nTransfer to +919999999999 when the caller asks for a human, is upset, describes an emergency, or asks something outside this document.\n\n" +
  "# LANGUAGE\nRespond in: en-IN.\n\n" +
  "# SAFETY\n- Only use information from this document and confirmed tool results.\n- Never invent prices, availability, timings, offers or policies.\n- Never claim a booking, cancellation or message was completed unless a tool confirmed it.\n- If you do not know something, say so and offer a callback from the team.";

describe("published prompts: calls never run the old transfer and callback promises", () => {
  test("ESCALATION and SAFETY are replaced; business facts stay byte for byte", () => {
    const out = withCurrentCallSections(OLD_PUBLISHED, agent("+919999999999"));
    assert.doesNotMatch(out, /Transfer to \+919999999999 when/);
    assert.doesNotMatch(out, /offer a callback from the team/);
    assert.doesNotMatch(out, /Respond in: en-IN\./);
    assert.match(out, /You cannot transfer this call/);
    assert.match(out, /reach the team directly on \+919999999999/);
    assert.match(out, /Never say you have transferred the call/);
    assert.match(out, /Do not diagnose or give medical or treatment advice/);
    assert.ok(
      out.startsWith(
        "# BUSINESS CONTEXT\nYou are the receptionist for Smile Dental.\n\n# SERVICES AND PRICING\n- Cleaning: ₹800\n\n# ESCALATION\n",
      ),
      "everything before the replaced sections is unchanged",
    );
  });

  test("without a number: no message-taking, just calling back during opening hours", () => {
    const old = OLD_PUBLISHED.replace(
      /# ESCALATION\n.*\n/,
      "# ESCALATION\nNo transfer number configured — take a message and record the caller's contact details instead of transferring.\n",
    );
    const out = withCurrentCallSections(old, agent(null));
    assert.doesNotMatch(out, /take a message and record/);
    assert.match(out, /calling back during opening hours/);
  });

  for (const old of [
    "take a message and promise a callback during business hours",
    "offer to transfer or take a message",
  ]) {
    test(`the old after-hours line ("${old}") is replaced with an honest one`, () => {
      const published = OLD_PUBLISHED.replace(
        "# SERVICES AND PRICING",
        `# BUSINESS HOURS\nMon: 09:00–18:00\nNever claim the business is open outside these hours. When the caller reaches you outside business hours, ${old}.\n\n# SERVICES AND PRICING`,
      );
      const out = withCurrentCallSections(published, agent(null));
      assert.ok(!out.includes(old), out);
      assert.match(out, /tell them the business is closed right now and when it next opens/);
      assert.match(out, /Mon: 09:00–18:00/, "the hours themselves are kept");
    });
  }

  test("newly built instructions never offer a message, callback or transfer after hours", () => {
    for (const behavior of ["take_message", "transfer"]) {
      const out = buildAgentInstructions({
        business: {
          name: "Smile Dental",
          business_type: "dental_clinic",
          description: null,
          address: null,
          city: null,
          state: null,
          postal_code: null,
          primary_phone: null,
          whatsapp: null,
          email: null,
          website: null,
          timezone: "Asia/Kolkata",
        },
        agent: { ...agent("+919999999999"), after_hours_behavior: behavior },
        services: [],
        faqs: [],
        rules: [],
        knowledge: [],
        hours: [],
      } as unknown as AgentSnapshot);
      assert.doesNotMatch(out, /promise a callback|offer to transfer|take a message and/, behavior);
      assert.match(out, /Never offer to take a message, arrange a callback or transfer the call\./);
    }
  });

  test("applying it again changes nothing", () => {
    const once = withCurrentCallSections(OLD_PUBLISHED, agent("+919999999999"));
    assert.equal(withCurrentCallSections(once, agent("+919999999999")), once);
  });
});

describe("a request for a person, in the caller's language", () => {
  const intent = (said: string) =>
    classifyCallerClosingIntent(said, { awaitingAnythingElse: false, hasNewRequest: false });

  test("Telugu, Hindi and romanized requests are recognised", () => {
    for (const said of [
      "Can I talk to a real person?",
      "మనిషితో మాట్లాడాలి",
      "డాక్టర్‌తో మాట్లాడొచ్చా?",
      "किसी इंसान से बात कराइए",
      "डॉक्टर से बात करनी है",
      "kisi se baat karni hai",
      "doctor tho matladali",
    ]) {
      assert.equal(intent(said), "human_requested", said);
    }
  });

  test("mentions of people or talking that are not requests", () => {
    for (const said of [
      "किसी बात की चिंता नहीं",
      "డాక్టర్ ఎప్పుడు ఉంటారు?",
      "doctor eppudu untaru",
      "What does the doctor charge?",
    ]) {
      assert.notEqual(intent(said), "human_requested", said);
    }
  });
});

describe("replies that claim a transfer or a callback", () => {
  test("claims in English, Telugu, Hindi and romanized are caught", () => {
    for (const reply of [
      "Sure, I'm transferring you to our receptionist now.",
      "Let me put you through to the doctor.",
      "Our team will call you back within the hour.",
      "I've noted your message for the team.",
      "మిమ్మల్ని కనెక్ట్ చేస్తున్నాను.",
      "మీకు కాల్ బ్యాక్ చేస్తాము.",
      "मैं आपको ट्रांसफर कर रहा हूँ।",
      "हमारी टीम आपको कॉल करेगी।",
      "Main aapko transfer kar raha hoon.",
    ]) {
      assert.equal(claimsTransferOrCallback(reply), true, reply);
    }
  });

  test("the agent's own honest lines never trip it, in any language", () => {
    for (const { code } of VOICE_LANGUAGES) {
      for (const line of [
        localizedFallback("humanUnavailable", code),
        callOutcomeLine(code, "calendarCheckFailed"),
        callOutcomeLine(code, "lineCannotBook"),
      ]) {
        if (line === null) continue;
        assert.equal(claimsTransferOrCallback(line), false, `${code}: ${line}`);
        assert.doesNotMatch(line, /call you back/i, `${code}: ${line}`);
      }
    }
    assert.equal(claimsTransferOrCallback("I'm sorry, I can't transfer you to a person."), false);
  });
});

async function drain(hops = 300) {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

async function openCall() {
  const h: Harness = createHarness();
  const callId = `honest-${crypto.randomUUID()}`;
  const input: StartRuntimeSessionInput = {
    callId,
    organizationId: "00000000-0000-0000-0000-000000000000",
    businessId: "00000000-0000-0000-0000-000000000001",
    agentConfigId: "00000000-0000-0000-0000-000000000002",
    agentVersion: 3,
    instructions: withCurrentCallSections(OLD_PUBLISHED, agent("+919999999999")),
    snapshotAgent: agent("+919999999999"),
    businessName: "Smile Dental",
    bridge: h.bridge,
    businessCountry: "IN",
    callerNumber: "+919876543210",
    services: [],
  };
  await startRuntimeSession(input, h.deps);
  await drain();
  let flushed = 0;
  const turn = async (said: string, reply: string, language = "en-IN") => {
    while (flushed < h.tts.sentTexts.length) {
      h.tts.emit({ type: "flushed" });
      flushed++;
    }
    h.llm.setNextReply(reply);
    const before = h.tts.sentTexts.length;
    h.stt.emit({ type: "speech_start" });
    h.stt.emit({ type: "final_transcript", text: said, language, languageConfidence: 0.95 });
    await drain();
    return h.tts.sentTexts.slice(before).join(" ");
  };
  return { h, callId, turn };
}

describe("through the runtime", () => {
  test("a model reply promising a transfer is replaced by the honest line", async () => {
    const { callId, turn } = await openCall();
    const said = await turn(
      "My tooth hurts, what should I do?",
      "I'm transferring you to our doctor now.",
    );
    assert.doesNotMatch(said, /transferring/i, said);
    assert.ok(said.includes(localizedFallback("humanUnavailable", "en-IN")), said);
    await terminateRuntimeSession(callId, "test cleanup");
  });

  test("a Telugu request for a person gets the honest Telugu answer, without the model", async () => {
    const { h, callId, turn } = await openCall();
    const callsBefore = h.llm.calls.length;
    const said = await turn("మనిషితో మాట్లాడాలి", "ignored", "te-IN");
    assert.ok(said.includes(localizedFallback("humanUnavailable", "te-IN")), said);
    assert.equal(h.llm.calls.length, callsBefore, "answered deterministically");
    await terminateRuntimeSession(callId, "test cleanup");
  });
});
