import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONTROLS,
  audienceImportMapping,
  audienceToCsv,
  budgetPaise,
  buildWizardContext,
  campaignConfigRow,
  combineAudience,
  configEditBlockedReason,
  callerNumberChoices,
  callerNumberIneligibility,
  isEligibleCallerNumber,
  joinExtraInstructions,
  parseWizardState,
  splitExtraInstructions,
  validateWizardConfig,
  wizardStateFromCampaign,
  csvToTable,
  mappingProblems,
  openingLinePreview,
  previewAudience,
  reviewWarnings,
  scheduleToJson,
  toVariableName,
  validateAudience,
  validateControls,
  validateDetails,
  validateInstructions,
  validateSchedule,
  type InstructionsStep,
  type ScheduleStep,
  type WizardState,
} from "./campaign-wizard.ts";
import { validateContactRows } from "./contacts-import.ts";
import { outboundOpeningLine } from "./sarvam-outbound-mode.server.ts";

const NOW = new Date("2026-11-21T06:00:00Z"); // 11:30 India time

const instructions = (over: Partial<InstructionsStep> = {}): InstructionsStep => ({
  agentConfigId: "agent-1",
  language: "",
  audience: "",
  talkingPoints: "",
  questions: "",
  desiredOutcome: "",
  interestedHandling: "",
  uninterestedHandling: "",
  callbackHandling: "",
  closing: "",
  tone: "",
  extraInstructions: "",
  ...over,
});

const schedule = (over: Partial<ScheduleStep> = {}): ScheduleStep => ({
  mode: "immediately",
  startDate: "",
  endDate: "",
  timezone: "Asia/Kolkata",
  days: [1, 2, 3, 4, 5],
  windowStart: "10:00",
  windowEnd: "18:00",
  ...over,
});

const wizard = (over: Partial<WizardState> = {}): WizardState => ({
  details: { name: "Check-ups", objective: "Remind patients about check-ups", description: "" },
  phoneNumberId: "",
  instructions: instructions(),
  schedule: schedule(),
  controls: DEFAULT_CONTROLS,
  ...over,
});

describe("step 1 — details", () => {
  test("name and purpose are required; limits are enforced, never cut", () => {
    assert.deepEqual(validateDetails({ name: "A", objective: "B", description: "" }), []);
    assert.equal(validateDetails({ name: " ", objective: "", description: "" }).length, 2);
    assert.match(
      validateDetails({ name: "A", objective: "x".repeat(201), description: "" }).join(),
      /under 200/,
    );
    assert.match(
      validateDetails({ name: "A", objective: "B", description: "x".repeat(4001) }).join(),
      /4000/,
    );
  });
});

describe("step 2 — contacts: normalization, invalid rows and duplicates", () => {
  const csv = csvToTable(
    [
      "Mobile,Full Name,Plan",
      "98765 43210,Asha,Gold",
      "+91 98765 43210,Asha again,Gold",
      "12,Bad,Silver",
      ",Missing,",
      "+44 20 7946 0958,London,",
    ].join("\n"),
  );
  const mapping = {
    phoneColumn: "Mobile",
    nameColumn: "Full Name",
    customFields: { Plan: "plan" },
  };

  test("manual and CSV rows are combined; every input row becomes one row", () => {
    const table = combineAudience([{ name: "Ravi", phone: "9123456789" }], csv, mapping);
    assert.deepEqual(table.headers, ["phone", "name", "plan"]);
    assert.equal(table.rows.length, 6);
    assert.equal(table.rows[1]!["plan"], "Gold");
  });

  test("numbers are normalized to E.164 and nothing is silently dropped", () => {
    const table = combineAudience([{ name: "Ravi", phone: "9123456789" }], csv, mapping);
    const p = previewAudience(table);
    assert.equal(p.valid[0]!.phone, "+919123456789");
    assert.equal(p.valid[1]!.phone, "+919876543210");
    assert.equal(p.valid.length + p.invalid.length + p.duplicates.length, p.totalRows);
    assert.equal(p.duplicates.length, 1); // "+91 98765 43210" repeats row 2
    assert.deepEqual(p.invalid.map((i) => i.reason).sort(), [
      "Invalid or unrecognized phone number",
      "Missing phone number",
    ]);
    assert.equal(p.notDiallable, 1); // the London number is valid but outside India
  });

  test("the wizard's CSV survives the server's parser unchanged (quotes, commas, newlines)", () => {
    const table = combineAudience([{ name: 'Rao, "Dr" K', phone: "9123456789" }], null, null);
    const back = csvToTable(audienceToCsv(table));
    assert.deepEqual(back.rows, table.rows);
    // The server re-validates the same text and reaches the same counts.
    const server = validateContactRows(back, "phone");
    assert.equal(server.valid.length, previewAudience(table).valid.length);
  });

  test("the import mapping sends the name as customer_name and keeps custom fields", () => {
    const table = combineAudience([], csv, mapping);
    assert.deepEqual(audienceImportMapping(table), { name: "customer_name", plan: "plan" });
  });

  test("custom field names must be valid, unique and not reserved", () => {
    assert.equal(toVariableName("Last Visit Date"), "last_visit_date");
    assert.deepEqual(
      mappingProblems({ phoneColumn: "a", nameColumn: "", customFields: { b: "ok" } }),
      [],
    );
    assert.equal(
      mappingProblems({ phoneColumn: "a", nameColumn: "", customFields: { b: "1x" } }).length,
      1,
    );
    assert.equal(
      mappingProblems({ phoneColumn: "a", nameColumn: "", customFields: { b: "phone" } }).length,
      1,
    );
    assert.equal(
      mappingProblems({ phoneColumn: "a", nameColumn: "", customFields: { b: "x", c: "x" } })
        .length,
      1,
    );
  });

  test("contacts cannot be saved until the import was reviewed, and an all-invalid list is refused", () => {
    const table = combineAudience([{ name: "", phone: "9123456789" }], null, null);
    assert.match(
      validateAudience(table, previewAudience(table), false).join(),
      /Review the import/,
    );
    assert.deepEqual(validateAudience(table, previewAudience(table), true), []);
    const bad = combineAudience([{ name: "", phone: "12" }], null, null);
    assert.match(validateAudience(bad, previewAudience(bad), true).join(), /None of these/);
    const empty = combineAudience([], null, null);
    assert.deepEqual(validateAudience(empty, previewAudience(empty), false), []);
  });
});

describe("step 3 — campaign instructions", () => {
  test("they become the campaign's own call context and compile to the preview text", () => {
    const r = validateInstructions(
      "Remind patients about check-ups",
      instructions({
        questions: "Would you like to book?\n\nAny questions?",
        uninterestedHandling: "Thank them and end politely",
        interestedHandling: "Offer the nearest free times",
        extraInstructions: "Mention parking",
      }),
    );
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.context!.questions, ["Would you like to book?", "Any questions?"]);
    assert.equal(r.context!.objectionHandling, "Thank them and end politely");
    assert.equal(
      r.context!.extraInstructions,
      "If they are interested: Offer the nearest free times || Mention parking",
    );
    assert.match(r.compiled!.instructions, /Ask: 1\) Would you like to book\? 2\) Any questions\?/);
  });

  test("an agent is required and over-long fields are errors with readable labels", () => {
    const r = validateInstructions(
      "Purpose",
      instructions({ agentConfigId: "", tone: "x".repeat(121) }),
    );
    assert.match(r.errors.join(), /Choose the AI agent/);
    assert.match(r.errors.join(), /Tone: at most 120/);
    assert.equal(r.context, null);
  });

  test("text that would read as a Sarvam variable or markup is cleaned", () => {
    const ctx = buildWizardContext("Hi {{secret}} <b>", instructions());
    const r = validateInstructions("Hi {{secret}} <b>", instructions());
    assert.equal((ctx as { objective: string }).objective, "Hi {{secret}} <b>");
    assert.equal(r.context!.objective, "Hi secret b");
  });

  test("the opening line preview matches what ClickAI sends on every call", () => {
    for (const name of ["Smile Dental", "  Two  Spaces ", "", null])
      assert.equal(openingLinePreview(name), outboundOpeningLine(name));
  });
});

describe("step 4 — schedule respects the platform calling hours", () => {
  test("hours outside 09:00-21:00 India time are refused, never widened", () => {
    assert.deepEqual(validateSchedule(schedule(), NOW).errors, []);
    assert.match(
      validateSchedule(schedule({ windowStart: "08:00" }), NOW).errors.join(),
      /09:00 and 21:00/,
    );
    assert.match(
      validateSchedule(schedule({ windowEnd: "21:30" }), NOW).errors.join(),
      /09:00 and 21:00/,
    );
    assert.match(
      validateSchedule(schedule({ windowStart: "18:00", windowEnd: "10:00" }), NOW).errors.join(),
      /end after/,
    );
  });

  test("another time zone is allowed but warns that India hours still apply", () => {
    const r = validateSchedule(schedule({ timezone: "Europe/London" }), NOW);
    assert.deepEqual(r.errors, []);
    assert.match(r.warnings.join(), /India time/);
    assert.match(
      validateSchedule(schedule({ timezone: "Mars/Base" }), NOW).errors.join(),
      /time zone/,
    );
  });

  test("dates: a scheduled start is required and not in the past; the end is not before the start", () => {
    assert.match(
      validateSchedule(schedule({ mode: "scheduled" }), NOW).errors.join(),
      /start date/,
    );
    assert.match(
      validateSchedule(schedule({ mode: "scheduled", startDate: "2026-11-20" }), NOW).errors.join(),
      /past/,
    );
    assert.deepEqual(
      validateSchedule(schedule({ mode: "scheduled", startDate: "2026-11-21" }), NOW).errors,
      [],
    );
    assert.match(
      validateSchedule(
        schedule({ mode: "scheduled", startDate: "2026-11-25", endDate: "2026-11-24" }),
        NOW,
      ).errors.join(),
      /on or after/,
    );
    assert.match(validateSchedule(schedule({ days: [] }), NOW).errors.join(), /calling day/);
  });

  test("the saved schedule uses the dispatcher's shape; 'immediately' stores no start date", () => {
    assert.deepEqual(scheduleToJson(schedule({ days: [5, 1] })), {
      windowStart: "10:00",
      windowEnd: "18:00",
      days: [1, 5],
      timezone: "Asia/Kolkata",
    });
    assert.equal(
      scheduleToJson(schedule({ mode: "scheduled", startDate: "2026-12-01" })).startDate,
      "2026-12-01",
    );
    assert.equal(scheduleToJson(schedule({ startDate: "2026-12-01" })).startDate, undefined);
  });
});

describe("step 5 — calling controls match the database limits", () => {
  test("safe defaults are valid", () => {
    assert.deepEqual(validateControls(DEFAULT_CONTROLS), []);
  });

  test("attempts 1-10, retry wait 15 min to 7 days, only no-answer/busy/failed retried", () => {
    assert.ok(validateControls({ ...DEFAULT_CONTROLS, maxAttempts: 11 }).length);
    assert.ok(validateControls({ ...DEFAULT_CONTROLS, maxAttempts: 0 }).length);
    assert.ok(validateControls({ ...DEFAULT_CONTROLS, retryAfterMinutes: 14 }).length);
    assert.ok(validateControls({ ...DEFAULT_CONTROLS, retryAfterMinutes: 10081 }).length);
    assert.ok(validateControls({ ...DEFAULT_CONTROLS, retryStatuses: ["completed"] }).length);
    assert.ok(validateControls({ ...DEFAULT_CONTROLS, maxAttempts: 3, retryStatuses: [] }).length);
    assert.deepEqual(
      validateControls({ ...DEFAULT_CONTROLS, maxAttempts: 1, retryStatuses: [] }),
      [],
    );
  });

  test("budget is whole paise above zero, or none", () => {
    assert.equal(budgetPaise(""), null);
    assert.equal(budgetPaise("250.5"), 25050);
    assert.equal(budgetPaise("0"), undefined);
    assert.equal(budgetPaise("abc"), undefined);
    assert.ok(validateControls({ ...DEFAULT_CONTROLS, budgetRupees: "-5" }).length);
  });
});

describe("save — the campaign row", () => {
  test("never sets organization, status, launch timestamps or dispatch fields", () => {
    const row = campaignConfigRow(wizard());
    for (const forbidden of [
      "organization_id",
      "status",
      "launched_at",
      "paused_at",
      "dispatch_mode",
      "provider_campaign_id",
      "created_by",
    ])
      assert.ok(!(forbidden in row), `${forbidden} must not be written from the wizard`);
    assert.equal(row.phone_number_id, null);
    assert.equal(row.budget_limit, null);
  });

  test("one attempt means no retry statuses are stored", () => {
    const row = campaignConfigRow(wizard({ controls: { ...DEFAULT_CONTROLS, maxAttempts: 1 } }));
    assert.deepEqual(row.retry_statuses, []);
  });

  test("review warnings say what is missing before calls could start", () => {
    const empty = previewAudience(combineAudience([], null, null));
    const w = reviewWarnings(wizard(), empty, null, 0);
    assert.ok(w.some((x) => /caller number/.test(x)));
    assert.ok(w.some((x) => /enabled for outbound/.test(x)));
    assert.ok(w.some((x) => /No contacts/.test(x)));
  });
});

const FULL: WizardState = {
  details: {
    name: "QA - Check-ups",
    objective: "Remind patients about check-ups",
    description: "Internal list from March",
  },
  phoneNumberId: "num-1",
  instructions: {
    agentConfigId: "agent-1",
    language: "hi-IN",
    audience: "Patients not seen in six months",
    talkingPoints: "Six months since the last visit\nOpen on Saturdays",
    questions: "Would you like to book?",
    desiredOutcome: "They book a check-up",
    interestedHandling: "Offer the nearest free times",
    uninterestedHandling: "Thank them and end politely",
    callbackHandling: "Give the clinic number",
    closing: "Say goodbye",
    tone: "Warm",
    extraInstructions: "Mention parking",
  },
  schedule: {
    mode: "scheduled",
    startDate: "2026-12-01",
    endDate: "2026-12-20",
    timezone: "Asia/Kolkata",
    days: [1, 3, 5],
    windowStart: "10:00",
    windowEnd: "17:30",
  },
  controls: {
    maxAttempts: 3,
    retryAfterMinutes: 90,
    retryStatuses: ["busy"],
    budgetRupees: "1500",
  },
};

/** What the server stores (campaign-config.server.ts) and the edit page reads back. */
function stored(w: WizardState) {
  const checked = validateWizardConfig(w, { draft: true, now: NOW });
  assert.deepEqual(checked.errors, []);
  return { ...campaignConfigRow(w), name: w.details.name.trim(), context: checked.context };
}

describe("edit — the saved campaign loads back into exactly what was entered", () => {
  test("every field round-trips: details, agent, number, instructions, schedule, controls", () => {
    assert.deepEqual(wizardStateFromCampaign(stored(FULL)), FULL);
  });

  test("'If they are interested' and other instructions are stored together and split back", () => {
    const joined = joinExtraInstructions("Offer times || now", "Mention parking");
    assert.deepEqual(splitExtraInstructions(joined), {
      interested: "Offer times | now",
      extra: "Mention parking",
    });
    assert.deepEqual(splitExtraInstructions(joinExtraInstructions("", "Only extra")), {
      interested: "",
      extra: "Only extra",
    });
    assert.deepEqual(splitExtraInstructions(joinExtraInstructions("Only interested", "")), {
      interested: "Only interested",
      extra: "",
    });
  });

  test("a minimal draft (no agent, no number, start when launched) loads with safe values", () => {
    const draft: WizardState = {
      ...FULL,
      phoneNumberId: "",
      instructions: { ...FULL.instructions, agentConfigId: "" },
      schedule: { ...FULL.schedule, mode: "immediately", startDate: "", endDate: "" },
      controls: { ...FULL.controls, maxAttempts: 1 },
    };
    const back = wizardStateFromCampaign(stored(draft));
    assert.equal(back.phoneNumberId, "");
    assert.equal(back.instructions.agentConfigId, "");
    assert.equal(back.schedule.mode, "immediately");
    assert.equal(back.controls.maxAttempts, 1);
    assert.deepEqual(back.controls.retryStatuses, DEFAULT_CONTROLS.retryStatuses);
  });

  test("a campaign saved before the wizard (no context) still opens, from its own columns", () => {
    const back = wizardStateFromCampaign({
      name: "Old",
      objective: "Old purpose",
      description: null,
      agent_config_id: null,
      phone_number_id: null,
      language: null,
      schedule: {},
      max_attempts: 1,
      retry_after_minutes: 120,
      retry_statuses: [],
      budget_limit: null,
      context: null,
    });
    assert.equal(back.details.objective, "Old purpose");
    assert.equal(back.schedule.windowStart, "09:00");
    assert.deepEqual(back.schedule.days, [0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("drafts and confirmed saves", () => {
  test("a draft needs no agent or caller number; a confirmed save needs the agent", () => {
    const noAgent = {
      ...FULL,
      phoneNumberId: "",
      instructions: { ...FULL.instructions, agentConfigId: "" },
    };
    assert.deepEqual(validateWizardConfig(noAgent, { draft: true, now: NOW }).errors, []);
    assert.match(
      validateWizardConfig(noAgent, { draft: false, now: NOW }).errors.join(),
      /Choose the AI agent/,
    );
    assert.deepEqual(validateWizardConfig(FULL, { draft: false, now: NOW }).errors, []);
  });

  test("a draft still stores its instructions as a valid context", () => {
    const r = validateWizardConfig(FULL, { draft: true, now: NOW });
    assert.equal(r.context!.desiredOutcome, "They book a check-up");
    assert.equal(r.context!.questions[0], "Would you like to book?");
  });

  test("even a draft refuses values the database or platform would reject", () => {
    const bad = { ...FULL, controls: { ...FULL.controls, retryAfterMinutes: 5 } };
    assert.ok(validateWizardConfig(bad, { draft: true, now: NOW }).errors.length);
    const late = { ...FULL, schedule: { ...FULL.schedule, windowEnd: "22:00" } };
    assert.ok(validateWizardConfig(late, { draft: true, now: NOW }).errors.length);
    const noName = { ...FULL, details: { ...FULL.details, name: "" } };
    assert.ok(validateWizardConfig(noName, { draft: true, now: NOW }).errors.length);
  });

  test("editing keeps an already-saved start date even once it is in the past", () => {
    const later = new Date("2026-12-05T06:00:00Z");
    assert.match(validateWizardConfig(FULL, { draft: true, now: later }).errors.join(), /past/);
    assert.deepEqual(
      validateWizardConfig(FULL, {
        draft: true,
        now: later,
        savedSchedule: { startDate: "2026-12-01", endDate: "2026-12-20" },
      }).errors,
      [],
    );
  });
});

describe("status and caller-number rules", () => {
  test("only draft, scheduled and paused campaigns can be edited", () => {
    for (const s of ["draft", "scheduled", "paused"])
      assert.equal(configEditBlockedReason(s), null);
    assert.match(configEditBlockedReason("running")!, /Pause it/);
    assert.match(configEditBlockedReason("queued")!, /Pause it/);
    for (const s of ["completed", "cancelled", "failed"])
      assert.match(configEditBlockedReason(s)!, /can no longer be changed/);
  });

  test("a caller number must be active and enabled for outbound calls", () => {
    assert.equal(isEligibleCallerNumber({ status: "active", outbound_enabled: true }), true);
    assert.equal(isEligibleCallerNumber({ status: "active", outbound_enabled: false }), false);
    assert.equal(isEligibleCallerNumber({ status: "suspended", outbound_enabled: true }), false);
  });

  test("the request body is read field by field; anything extra is dropped", () => {
    const parsed = parseWizardState({
      ...FULL,
      status: "running",
      organization_id: "org-evil",
      controls: { ...FULL.controls, maxAttempts: "3" },
      schedule: { ...FULL.schedule, days: [1, 1, 9, "2"] },
    })!;
    assert.ok(!("status" in parsed) && !("organization_id" in parsed));
    assert.ok(Number.isNaN(parsed.controls.maxAttempts), "a string is not a number");
    assert.deepEqual(parsed.schedule.days, [1]);
    assert.equal(parseWizardState(null), null);
  });
});

describe("callerNumberIneligibility: each reason is named", () => {
  const ok = { status: "active", provider: "sarvam", outbound_enabled: true, connection_id: "c1" };
  test("an active, connected, outbound-enabled Sarvam number is selectable (any workspace)", () => {
    assert.equal(callerNumberIneligibility(ok), null);
    assert.equal(isEligibleCallerNumber(ok), true);
  });
  test("each blocker has its own reason", () => {
    assert.match(callerNumberIneligibility({ ...ok, status: "released" })!, /released/);
    assert.match(callerNumberIneligibility({ ...ok, provider: "vobiz" })!, /only from Sarvam/);
    assert.match(
      callerNumberIneligibility({ ...ok, connection_id: null })!,
      /setup with Sarvam is not finished/,
    );
    assert.match(
      callerNumberIneligibility({ ...ok, outbound_enabled: false })!,
      /switched off on this number/,
    );
  });
  test("a number whose connection isn't loaded is not blocked for that reason", () => {
    const { connection_id: _omit, ...withoutConnection } = ok;
    assert.equal(callerNumberIneligibility(withoutConnection), null);
  });
});

describe("callerNumberChoices: the caller-number picker", () => {
  const n = (
    id: string,
    over: Partial<{ status: string; provider: string; outbound_enabled: boolean }>,
  ) => ({
    id,
    e164: `+9179000000${id}`,
    status: "active",
    provider: "sarvam",
    outbound_enabled: true,
    ...over,
  });
  // Smile Dental's numbers as they are in production: three released, one Vobiz, one Sarvam (outbound off).
  const numbers = [
    n("01", { status: "released", outbound_enabled: false }),
    n("02", { status: "released", provider: "exotel", outbound_enabled: false }),
    n("03", { status: "released", provider: "exotel", outbound_enabled: true }),
    n("04", { provider: "Vobiz", outbound_enabled: false }),
    n("05", { outbound_enabled: false }),
    n("06", {}),
  ];
  const { eligible, ineligible } = callerNumberChoices(numbers);

  test("released numbers appear in neither list, so they can never be chosen", () => {
    const shown = [...eligible.map((x) => x.id), ...ineligible.map((x) => x.id)];
    for (const id of ["01", "02", "03"]) assert.ok(!shown.includes(id), `released ${id} is hidden`);
  });

  test("an active Vobiz number is listed as ineligible: campaigns call only from Sarvam numbers", () => {
    assert.match(
      ineligible.find((x) => x.id === "04")?.reason ?? "",
      /Campaigns call only from Sarvam numbers/,
    );
  });

  test("an active Sarvam number with outbound off is listed with that reason", () => {
    assert.match(
      ineligible.find((x) => x.id === "05")?.reason ?? "",
      /switched off on this number/,
    );
  });

  test("an active, outbound-enabled Sarvam number is the only selectable one", () => {
    assert.deepEqual(
      eligible.map((x) => x.id),
      ["06"],
    );
    assert.ok(!ineligible.some((x) => x.id === "06"));
  });

  test("the eligibility rule itself is unchanged: a released number is still ineligible", () => {
    assert.equal(isEligibleCallerNumber(numbers[0]!), false);
  });
});
