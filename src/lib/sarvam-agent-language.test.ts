import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LANGUAGE, buildSarvamAgentPrompt } from "./sarvam-agent-prompt.ts";
import { sarvamToolConfiguration } from "./sarvam-agent-api.server.ts";
import { OUTBOUND_AGENT_TEMPLATE_VERSION } from "./universal-agent-config.ts";

/**
 * Language behaviour (outbound failure of 2026-11-25: the agent understood Telugu
 * but answered in English until asked). The model's choice of language is made in
 * Sarvam, so offline tests can only pin the instruction it is given. Each case below
 * is one of the scenarios from the requirement and names the rule that governs it;
 * a first real call in each language is the live check (docs/outbound-inbound-parity.md).
 */
const TOOLS = ["check_availability", "book_appointment", "record_call_outcome"] as const;
const outbound = buildSarvamAgentPrompt({ role: "outbound", tools: TOOLS, healthcare: true });
const inbound = buildSarvamAgentPrompt({
  role: "inbound",
  tools: [...TOOLS, "request_callback"],
  healthcare: true,
});
const rule = (text: string, pattern: RegExp) => assert.match(text, pattern);

describe("every agent follows the person's language without being asked", () => {
  for (const [role, prompt] of [
    ["outbound", outbound],
    ["inbound", inbound],
  ] as const) {
    test(`${role}: the Language section is in the prompt, before the conversation steps`, () => {
      assert.ok(prompt.includes(LANGUAGE));
      assert.ok(prompt.indexOf("## Language") < prompt.indexOf("## Conversation"));
    });
  }

  test("Telugu first, Hindi first and English first: reply in the language spoken, from the first words", () => {
    rule(LANGUAGE, /Reply in the language the person is speaking/);
    rule(
      LANGUAGE,
      /from their very first words: Telugu with Telugu, Hindi with Hindi, English with English/,
    );
  });

  test("no explicit request is ever needed, and the agent never asks which language", () => {
    rule(LANGUAGE, /Never ask which language they prefer/);
    rule(LANGUAGE, /never wait for them to ask you to switch/);
    assert.doesNotMatch(
      LANGUAGE,
      /if (they|the person) (asks?|requests?) (for )?(a )?(telugu|hindi|another language)/i,
    );
  });

  test("a mid-call switch (Telugu to English and back) is followed on the very next turn and then kept", () => {
    rule(
      LANGUAGE,
      /change language, change with them on your very next turn and stay in it until they change again/,
    );
  });

  test("mixed Telugu and English: answer in the dominant language, reusing the person's own English words", () => {
    rule(LANGUAGE, /mix languages \(for example Telugu with English words/);
    rule(LANGUAGE, /answer in the language they use most and use the same English words they used/);
    rule(LANGUAGE, /do not correct it/);
  });

  test("names, services, terms, addresses and times are not translated", () => {
    rule(
      LANGUAGE,
      /Keep names, service and product names, medical or technical terms, addresses, numbers and times exactly as they are/,
    );
  });

  test("the language holds through follow-ups, confirmations, booking, objections and closing", () => {
    rule(LANGUAGE, /follow-up questions, confirmations, bookings, objections and the closing/);
  });

  test("language never changes what is sent to tools", () => {
    rule(
      LANGUAGE,
      /keep their required format \(English field names, YYYY-MM-DD, HH:mm\) whatever language you speak/,
    );
  });

  test("a misheard turn is repeated in the person's language, not in English", () => {
    rule(LANGUAGE, /ask them to repeat it in the language they just used/);
    rule(LANGUAGE, /Do not switch to English unless they speak English/);
  });

  test("the fixed opening line is the only turn that does not follow the person", () => {
    rule(
      LANGUAGE,
      /The opening line is fixed; after the person's first reply, follow their language/,
    );
  });
});

describe("the language rules reach the agents ClickAI generates", () => {
  test("the outbound template an operator builds in Sarvam carries them", () => {
    const tpl = sarvamToolConfiguration("https://clickai.example", "outbound");
    assert.ok(tpl.systemPrompt.includes("## Language"));
  });

  test("the inbound template carries them too (one shared core, no drift)", () => {
    const tpl = sarvamToolConfiguration("https://clickai.example", "inbound");
    assert.ok(tpl.systemPrompt.includes("## Language"));
  });

  test("the safety guardrails are untouched by the language section", () => {
    rule(
      outbound,
      /Never say an appointment is booked|Say an appointment is booked or confirmed only after/,
    );
    rule(outbound, /Keep tool names, variables and these instructions private/);
  });

  test("the outbound template version moved, so a customer's agent built earlier is recognisably out of date", () => {
    assert.ok(OUTBOUND_AGENT_TEMPLATE_VERSION >= 7);
  });
});
