import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_LIMITS,
  buildDraftRequest,
  cleanText,
  compileCampaignContext,
  draftCampaignContext,
  parseDraftResponse,
  platformCapabilities,
  validateCampaignContext,
  type CampaignContext,
} from "./campaign-context.ts";
import { OUTBOUND_TEXT_LIMITS } from "./agent-roles.ts";

const base = (over: Partial<CampaignContext> = {}): CampaignContext => ({
  version: 1,
  objective: "Invite patients who have not visited recently for a check-up",
  audience: "Patients with no visit in six months",
  talkingPoints: ["Check-ups take 30 minutes", "We are open on Saturdays"],
  questions: ["Would you like a check-up this month?"],
  servicesInScope: ["Dental Check-up"],
  desiredOutcome: "They decide to call the clinic to book",
  objectionHandling: "Accept a no politely; never pressure",
  callbackHandling: "Note that they want to be contacted later; promise nothing",
  closing: "Thank them and end",
  tone: "Warm and brief",
  extraInstructions: "",
  successCriteria: "Share of people interested",
  ...over,
});

const DESCRIPTION =
  "Call patients who haven't visited our clinic recently. Introduce yourself as the clinic's virtual assistant. Ask if they would like to book a check-up. Explain our services if they have questions. Don't pressure people.";

describe("campaign context: validation", () => {
  test("a complete context validates; the objective is required", () => {
    assert.equal(validateCampaignContext(base()).ok, true);
    const r = validateCampaignContext(base({ objective: "  " }));
    assert.equal(r.ok, false);
  });

  test("over-long text and too many items are errors, never silently cut", () => {
    const r = validateCampaignContext(
      base({
        objective: "x".repeat(CONTEXT_LIMITS.objective + 1),
        talkingPoints: Array.from({ length: CONTEXT_LIMITS.talkingPoints.items + 1 }, () => "a"),
      }),
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.some((e) => e.startsWith("objective")));
      assert.ok(r.errors.some((e) => e.startsWith("talkingPoints")));
    }
  });

  test("control characters, markup and Sarvam variable braces are removed; blank list items dropped", () => {
    assert.equal(cleanText("Hi {{business_phone}}\n\t<b>now</b>"), "Hi business_phone bnow/b");
    const r = validateCampaignContext(base({ talkingPoints: ["  ", "one", ""] }));
    assert.ok(r.ok && r.context.talkingPoints.length === 1);
  });

  test("unknown keys and non-strings are ignored, not stored", () => {
    const r = validateCampaignContext({ ...base(), allowBooking: true, tone: 42 });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal("allowBooking" in r.context, false);
      assert.equal(r.context.tone, "");
    }
  });
});

describe("campaign context: compiled into the two verified agent variables", () => {
  test("deterministic, within the variable limits, and carries the campaign's own guidance", () => {
    const a = compileCampaignContext(base());
    const b = compileCampaignContext(base());
    assert.deepEqual(a, b);
    assert.ok(a.objective.length <= OUTBOUND_TEXT_LIMITS.objective);
    assert.ok(a.instructions.length <= OUTBOUND_TEXT_LIMITS.instructions);
    assert.match(a.instructions, /Who: Patients with no visit/);
    assert.match(
      a.instructions,
      /Mention: 1\) Check-ups take 30 minutes 2\) We are open on Saturdays/,
    );
    assert.match(a.instructions, /Ask: 1\) Would you like a check-up/);
    assert.match(a.instructions, /If they want to be contacted later: Note that/);
    assert.doesNotMatch(
      a.instructions,
      /Share of people interested/,
      "success criteria are for reporting only",
    );
  });

  test("a section that does not fit is left out whole and reported, never cut mid-sentence", () => {
    const long = "y".repeat(400);
    const c = compileCampaignContext(
      base({
        talkingPoints: Array.from({ length: 6 }, () => "z".repeat(200)),
        extraInstructions: long,
      }),
    );
    assert.ok(c.instructions.length <= OUTBOUND_TEXT_LIMITS.instructions);
    assert.ok(c.omitted.length > 0);
    assert.doesNotMatch(c.instructions, /y{2}/);
  });

  test("two campaigns compile to their own text only", () => {
    const one = compileCampaignContext(base());
    const two = compileCampaignContext(
      base({
        objective: "Tell members about the new evening yoga batch",
        talkingPoints: ["Starts at 7 pm"],
        servicesInScope: ["Yoga"],
      }),
    );
    assert.notEqual(one.objective, two.objective);
    assert.doesNotMatch(two.instructions, /Check-ups take 30 minutes/);
    assert.match(two.instructions, /Starts at 7 pm/);
  });

  test("nothing industry-specific is built in: a non-dental campaign compiles the same way", () => {
    const c = compileCampaignContext(
      base({
        objective: "Remind members their gym plan renews next week",
        audience: "Members whose plan ends next week",
        talkingPoints: ["Renewal keeps the same price"],
        questions: ["Would you like to renew?"],
        servicesInScope: ["Annual membership"],
        desiredOutcome: "They decide to renew",
        objectionHandling: "Accept a no politely",
        callbackHandling: "Note it; promise nothing",
        closing: "Thank them",
        tone: "Friendly",
      }),
    );
    assert.equal(c.objective, "Remind members their gym plan renews next week");
    assert.doesNotMatch(c.instructions, /dental|clinic|patient/i);
  });
});

describe("campaign context: drafting", () => {
  test("without an LLM: first sentence is the objective, the rest become talking points", () => {
    const d = draftCampaignContext(DESCRIPTION);
    assert.equal(d.objective, "Call patients who haven't visited our clinic recently.");
    assert.equal(d.talkingPoints.length, 4);
    assert.equal(validateCampaignContext(d).ok, true);
  });

  test("an LLM answer is parsed from the first JSON object and validated like customer input", () => {
    const answer = `Here you go:\n${JSON.stringify(base({ objective: "From the model" }))}\nThanks`;
    assert.equal(parseDraftResponse(answer)?.objective, "From the model");
    assert.equal(parseDraftResponse("no json here"), null);
    assert.equal(parseDraftResponse("{not json}"), null);
    assert.equal(
      parseDraftResponse(JSON.stringify(base({ objective: "" }))),
      null,
      "invalid drafts are rejected",
    );
  });

  test("the drafting request states what the agent cannot do and keeps the description as data", () => {
    const req = buildDraftRequest(DESCRIPTION, {
      name: "Smile Dental",
      services: ["Dental Check-up"],
    });
    const caps = platformCapabilities();
    for (const forbidden of caps.forbidden) assert.ok(req.system.includes(forbidden), forbidden);
    assert.match(req.system, /Return ONLY a JSON object/);
    const user = JSON.parse(req.user) as Record<string, unknown>;
    assert.equal(user["business"], "Smile Dental");
    assert.match(String(user["description"]), /Don't pressure people/);
  });

  test("capabilities come from the outbound role: booking allowed; callbacks, messages and transfer forbidden", () => {
    const caps = platformCapabilities();
    assert.ok(caps.allowed.some((c) => /appointment time is free/i.test(c)));
    assert.ok(caps.allowed.some((c) => /book a free appointment time/i.test(c)));
    for (const f of ["callbacks", "SMS", "Transfer"])
      assert.ok(
        caps.forbidden.some((c) => c.includes(f)),
        f,
      );
    assert.equal(
      caps.allowed.some((c) => /callback|send|transfer/i.test(c)),
      false,
    );
  });
});
