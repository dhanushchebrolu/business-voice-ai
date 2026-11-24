/**
 * Pure logic for the campaign creation wizard (app.campaigns.new.tsx): step
 * validation, the contact-import preview and the campaign row it saves. No
 * I/O. Everything here only shapes a draft; the server re-validates contacts
 * (importCampaignContactsCsv), the call context (saveCampaignContext) and
 * every launch rule (launchCampaign), so nothing computed here is trusted.
 */
import {
  csvToTable,
  validateContactRows,
  type ContactImportSummary,
  type ParsedCsvTable,
} from "./contacts-import.ts";
import {
  CAMPAIGN_CONTEXT_VERSION,
  CAMPAIGN_DESCRIPTION_MAX,
  CONTEXT_LIMITS,
  compileCampaignContext,
  validateCampaignContext,
  type CampaignContext,
  type CompiledContext,
} from "./campaign-context.ts";
import {
  MAX_RETRY_AFTER_MINUTES,
  MIN_RETRY_AFTER_MINUTES,
  RETRYABLE_CALL_STATUSES,
} from "./campaign-outcome.ts";
import { isValidTimeZone, type CampaignSchedule } from "./campaign-schedule.ts";

/** Mirrors CALLING_HOURS (outbound-eligibility.server.ts); the database enforces it again on every call. */
export const PLATFORM_CALLING_HOURS = {
  start: "09:00",
  end: "21:00",
  timeZone: "Asia/Kolkata",
} as const;
/** Fixed by the dispatcher (campaign-dispatch.server.ts); not configurable per campaign. */
export const PLATFORM_PACING = { maxInFlightPerCampaign: 3, contactsPerMinute: 20 } as const;
/** Only these destinations are dialled today (OUTBOUND_ALLOWED_COUNTRY_CODES default). */
export const DIALLABLE_PREFIX = "+91";
/** Rows per import (wizard, campaign page and server): one import is one transaction under the Data API's 8 s timeout. */
export const MAX_IMPORT_ROWS = 5000;
export const MAX_WIZARD_CONTACTS = MAX_IMPORT_ROWS;
export const IMPORT_TOO_LARGE_MESSAGE = `Import at most ${MAX_IMPORT_ROWS.toLocaleString("en-IN")} rows at a time. Split the file and import each part.`;
export const CAMPAIGN_NAME_MAX = 120;

export const WIZARD_STEPS = [
  "Details",
  "Audience",
  "Agent & instructions",
  "Schedule",
  "Calling controls",
  "Review",
] as const;

/* ------------------------------------------------------------------ */
/* Step 1 — details                                                     */
/* ------------------------------------------------------------------ */

export interface DetailsStep {
  name: string;
  objective: string;
  description: string;
}

export function validateDetails(d: DetailsStep): string[] {
  const errors: string[] = [];
  if (!d.name.trim()) errors.push("Give the campaign a name.");
  if (d.name.trim().length > CAMPAIGN_NAME_MAX)
    errors.push(`Keep the name under ${CAMPAIGN_NAME_MAX} characters.`);
  if (!d.objective.trim()) errors.push("Say why the business is calling these people.");
  if (d.objective.trim().length > CONTEXT_LIMITS.objective)
    errors.push(`Keep the purpose under ${CONTEXT_LIMITS.objective} characters.`);
  if (d.description.length > CAMPAIGN_DESCRIPTION_MAX)
    errors.push(`Keep the description under ${CAMPAIGN_DESCRIPTION_MAX} characters.`);
  return errors;
}

/* ------------------------------------------------------------------ */
/* Step 2 — audience                                                    */
/* ------------------------------------------------------------------ */

export interface ManualContact {
  name: string;
  phone: string;
}

/** Which CSV columns hold what. customFields: {csvColumn: variableName}. */
export interface CsvMapping {
  phoneColumn: string;
  nameColumn: string;
  customFields: Record<string, string>;
}

export const PHONE_COLUMN = "phone";
export const NAME_COLUMN = "name";

/** A variable name the agent can use: lower snake case, never a reserved column. */
export function toVariableName(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export function mappingProblems(m: CsvMapping): string[] {
  const errors: string[] = [];
  const names = Object.values(m.customFields);
  for (const n of names) {
    if (!VARIABLE_NAME.test(n))
      errors.push(`"${n}" is not a valid field name (letters, digits and _; start with a letter).`);
    else if (n === PHONE_COLUMN || n === NAME_COLUMN || n === "customer_name")
      errors.push(`"${n}" is reserved; choose another field name.`);
  }
  if (new Set(names).size !== names.length) errors.push("Two columns use the same field name.");
  return errors;
}

/**
 * One table of everyone the user added (manual rows first, then the CSV),
 * in the column layout the import function receives: phone, name, then the
 * custom fields. Every input row becomes exactly one output row.
 */
export function combineAudience(
  manual: ManualContact[],
  csv: ParsedCsvTable | null,
  mapping: CsvMapping | null,
): ParsedCsvTable {
  const custom = mapping ? Object.entries(mapping.customFields) : [];
  const headers = [PHONE_COLUMN, NAME_COLUMN, ...custom.map(([, v]) => v)];
  const rows: Record<string, string>[] = [];
  for (const c of manual) {
    const row: Record<string, string> = {
      [PHONE_COLUMN]: c.phone.trim(),
      [NAME_COLUMN]: c.name.trim(),
    };
    for (const [, v] of custom) row[v] = "";
    rows.push(row);
  }
  if (csv && mapping) {
    for (const r of csv.rows) {
      const row: Record<string, string> = {
        [PHONE_COLUMN]: (r[mapping.phoneColumn] ?? "").trim(),
        [NAME_COLUMN]: mapping.nameColumn ? (r[mapping.nameColumn] ?? "").trim() : "",
      };
      for (const [col, v] of custom) row[v] = (r[col] ?? "").trim();
      rows.push(row);
    }
  }
  return { headers, rows };
}

export interface AudiencePreview extends ContactImportSummary {
  /** Valid numbers outside the country ClickAI dials today: kept, but never called. */
  notDiallable: number;
}

export function previewAudience(table: ParsedCsvTable): AudiencePreview {
  const summary = validateContactRows(table, PHONE_COLUMN);
  return {
    ...summary,
    notDiallable: summary.valid.filter((r) => !r.phone?.startsWith(DIALLABLE_PREFIX)).length,
  };
}

export function validateAudience(
  table: ParsedCsvTable,
  preview: AudiencePreview,
  reviewed: boolean,
): string[] {
  const errors: string[] = [];
  if (table.rows.length > MAX_WIZARD_CONTACTS)
    errors.push(`Add at most ${MAX_WIZARD_CONTACTS} contacts at a time.`);
  if (table.rows.length > 0 && !reviewed)
    errors.push("Review the import preview and confirm it before continuing.");
  if (table.rows.length > 0 && preview.valid.length === 0)
    errors.push("None of these phone numbers is valid. Fix them or remove them.");
  return errors;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV text for importCampaignContactsCsv; the server re-parses and re-validates it. */
export function audienceToCsv(table: ParsedCsvTable): string {
  const lines = [table.headers.map(csvCell).join(",")];
  for (const row of table.rows)
    lines.push(table.headers.map((h) => csvCell(row[h] ?? "")).join(","));
  return lines.join("\n");
}

/** The import mapping: name feeds the contact's name, custom fields become agent variables. */
export function audienceImportMapping(table: ParsedCsvTable): Record<string, string> {
  const mapping: Record<string, string> = { [NAME_COLUMN]: "customer_name" };
  for (const h of table.headers) if (h !== PHONE_COLUMN && h !== NAME_COLUMN) mapping[h] = h;
  return mapping;
}

export { csvToTable };

/**
 * The opening line every outbound call starts with. ClickAI sets it per call
 * (outboundOpeningLine, sarvam-outbound-mode.server.ts); a campaign cannot
 * change it. Shown read-only; a test keeps the two identical.
 */
export function openingLinePreview(businessName: string | null | undefined): string {
  const name = (businessName ?? "").replace(/\s+/g, " ").trim();
  return name
    ? `Hello, this is the virtual assistant calling from ${name}. Is this a good time to talk?`
    : "Hello, this is a virtual assistant calling. Is this a good time to talk?";
}

/* ------------------------------------------------------------------ */
/* Step 3 — agent and instructions                                       */
/* ------------------------------------------------------------------ */

export interface InstructionsStep {
  agentConfigId: string;
  language: string;
  audience: string;
  talkingPoints: string;
  questions: string;
  desiredOutcome: string;
  interestedHandling: string;
  uninterestedHandling: string;
  callbackHandling: string;
  closing: string;
  tone: string;
  extraInstructions: string;
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const INTERESTED_PREFIX = "If they are interested: ";
const EXTRA_SEPARATOR = " || ";

/**
 * "If interested" has no context field of its own, so it is written at the
 * start of the extra instructions with a label (visible in the preview) and a
 * separator that splitExtraInstructions reads back when the campaign is edited.
 */
export function joinExtraInstructions(interested: string, extra: string): string {
  const i = interested.trim().replace(/\|\|/g, "|");
  const e = extra.trim();
  if (!i) return e;
  return e ? `${INTERESTED_PREFIX}${i}${EXTRA_SEPARATOR}${e}` : `${INTERESTED_PREFIX}${i}`;
}

export function splitExtraInstructions(stored: string): { interested: string; extra: string } {
  if (!stored.startsWith(INTERESTED_PREFIX)) return { interested: "", extra: stored };
  const rest = stored.slice(INTERESTED_PREFIX.length);
  const at = rest.indexOf(EXTRA_SEPARATOR);
  return at === -1
    ? { interested: rest, extra: "" }
    : { interested: rest.slice(0, at), extra: rest.slice(at + EXTRA_SEPARATOR.length) };
}

/** The campaign's own call context (stored on the campaign, never on the agent). */
export function buildWizardContext(objective: string, s: InstructionsStep): unknown {
  const extra = joinExtraInstructions(s.interestedHandling, s.extraInstructions);
  return {
    version: CAMPAIGN_CONTEXT_VERSION,
    objective,
    audience: s.audience,
    talkingPoints: lines(s.talkingPoints),
    questions: lines(s.questions),
    servicesInScope: [],
    desiredOutcome: s.desiredOutcome,
    objectionHandling: s.uninterestedHandling,
    callbackHandling: s.callbackHandling,
    closing: s.closing,
    tone: s.tone,
    extraInstructions: extra,
    successCriteria: "",
  };
}

export function validateInstructions(
  objective: string,
  s: InstructionsStep,
  options: { requireAgent?: boolean } = {},
): { errors: string[]; context: CampaignContext | null; compiled: CompiledContext | null } {
  const errors: string[] = [];
  if (options.requireAgent !== false && !s.agentConfigId)
    errors.push("Choose the AI agent for these calls.");
  const result = validateCampaignContext(buildWizardContext(objective, s));
  if (!result.ok) {
    const label: Record<string, string> = {
      objective: "Purpose",
      audience: "Who you are calling",
      talkingPoints: "What to mention",
      questions: "Questions to ask",
      desiredOutcome: "Desired outcome",
      objectionHandling: "If they are not interested",
      callbackHandling: "If they want to be contacted later",
      closing: "How to end the call",
      tone: "Tone",
      extraInstructions: "Campaign instructions (with 'If they are interested')",
    };
    for (const e of result.errors) {
      const [field, ...rest] = e.split(": ");
      errors.push(`${label[field ?? ""] ?? field}: ${rest.join(": ")}`);
    }
    return { errors, context: null, compiled: null };
  }
  return { errors, context: result.context, compiled: compileCampaignContext(result.context) };
}

/* ------------------------------------------------------------------ */
/* Step 4 — schedule                                                    */
/* ------------------------------------------------------------------ */

export interface ScheduleStep {
  mode: "immediately" | "scheduled";
  startDate: string;
  endDate: string;
  timezone: string;
  days: number[];
  windowStart: string;
  windowEnd: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date (YYYY-MM-DD) in `timezone`. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now);
}

export function validateSchedule(
  s: ScheduleStep,
  now: Date = new Date(),
  /** Dates already saved on the campaign: unchanged, they may now be in the past. */
  saved: { startDate?: string | undefined; endDate?: string | undefined } = {},
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isValidTimeZone(s.timezone)) errors.push("Choose a valid time zone.");
  if (s.days.length === 0) errors.push("Choose at least one calling day.");
  if (!HHMM.test(s.windowStart) || !HHMM.test(s.windowEnd))
    errors.push("Enter calling hours as HH:MM.");
  else if (s.windowStart >= s.windowEnd) errors.push("Calling hours must end after they start.");
  else if (
    s.timezone === PLATFORM_CALLING_HOURS.timeZone &&
    (s.windowStart < PLATFORM_CALLING_HOURS.start || s.windowEnd > PLATFORM_CALLING_HOURS.end)
  )
    errors.push(
      `ClickAI only calls between ${PLATFORM_CALLING_HOURS.start} and ${PLATFORM_CALLING_HOURS.end} India time. Choose hours inside that window.`,
    );
  else if (s.timezone !== PLATFORM_CALLING_HOURS.timeZone)
    warnings.push(
      `Calls also only happen between ${PLATFORM_CALLING_HOURS.start} and ${PLATFORM_CALLING_HOURS.end} India time, whatever this time zone says.`,
    );
  const today = isValidTimeZone(s.timezone) ? todayIn(s.timezone, now) : "";
  if (s.mode === "scheduled") {
    if (!DATE.test(s.startDate)) errors.push("Choose a start date.");
    else if (today && s.startDate < today && s.startDate !== saved.startDate)
      errors.push("The start date is in the past.");
  }
  if (s.endDate) {
    if (!DATE.test(s.endDate)) errors.push("Enter a valid end date.");
    else if (today && s.endDate < today && s.endDate !== saved.endDate)
      errors.push("The end date is in the past.");
    else if (s.mode === "scheduled" && DATE.test(s.startDate) && s.endDate < s.startDate)
      errors.push("The end date must be on or after the start date.");
  }
  return { errors, warnings };
}

export function scheduleToJson(s: ScheduleStep): CampaignSchedule {
  return {
    ...(s.mode === "scheduled" && s.startDate ? { startDate: s.startDate } : {}),
    ...(s.endDate ? { endDate: s.endDate } : {}),
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    days: [...s.days].sort((a, b) => a - b),
    timezone: s.timezone,
  };
}

/* ------------------------------------------------------------------ */
/* Step 5 — calling controls                                            */
/* ------------------------------------------------------------------ */

export interface ControlsStep {
  maxAttempts: number;
  retryAfterMinutes: number;
  retryStatuses: string[];
  budgetRupees: string;
}

export const DEFAULT_CONTROLS: ControlsStep = {
  maxAttempts: 2,
  retryAfterMinutes: 120,
  retryStatuses: ["no_answer", "busy"],
  budgetRupees: "",
};

/** Budget in paise, null for none, or undefined when it is not a valid amount. */
export function budgetPaise(rupees: string): number | null | undefined {
  const t = rupees.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const paise = Math.round(n * 100);
  return Number.isSafeInteger(paise) && paise <= 2_000_000_000 ? paise : undefined;
}

export function validateControls(c: ControlsStep): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(c.maxAttempts) || c.maxAttempts < 1 || c.maxAttempts > 10)
    errors.push("Attempts per contact must be between 1 and 10.");
  if (
    !Number.isInteger(c.retryAfterMinutes) ||
    c.retryAfterMinutes < MIN_RETRY_AFTER_MINUTES ||
    c.retryAfterMinutes > MAX_RETRY_AFTER_MINUTES
  )
    errors.push("Retries must wait between 15 minutes and 7 days.");
  if (c.retryStatuses.some((s) => !(RETRYABLE_CALL_STATUSES as readonly string[]).includes(s)))
    errors.push("Only no-answer, busy or failed calls can be retried.");
  if (c.maxAttempts > 1 && c.retryStatuses.length === 0)
    errors.push("Choose which outcomes are retried, or set attempts to 1.");
  if (budgetPaise(c.budgetRupees) === undefined)
    errors.push("Enter the budget in rupees, or leave it empty for no limit.");
  return errors;
}

/* ------------------------------------------------------------------ */
/* Save                                                                 */
/* ------------------------------------------------------------------ */

export interface WizardState {
  details: DetailsStep;
  phoneNumberId: string;
  instructions: InstructionsStep;
  schedule: ScheduleStep;
  controls: ControlsStep;
}

/**
 * Statuses whose configuration may be changed. Running (and queued) campaigns
 * are being dialled, so nothing changes underneath the dispatcher; finished
 * ones are history. Scheduled and paused campaigns are not dialled (the
 * dispatcher only reads "running"), and a resume re-runs every launch check.
 */
export const CONFIG_EDITABLE_STATUSES: readonly string[] = ["draft", "scheduled", "paused"];

export function configEditBlockedReason(status: string): string | null {
  if (CONFIG_EDITABLE_STATUSES.includes(status)) return null;
  if (status === "running" || status === "queued")
    return "This campaign is calling. Pause it before changing its configuration.";
  return `This campaign is ${status}; its configuration can no longer be changed.`;
}

/** The campaign page query holding its launch checklist (campaign-launch-readiness.server.ts). */
export const campaignReadinessKey = (campaignId: string) => ["campaign-readiness", campaignId];

/**
 * Why a number cannot be a campaign's caller number, or null when it can. The
 * organization check is the caller's (RLS / server); this is the number's own
 * state: active, outbound-enabled by ClickAI, and a Sarvam number (the only
 * provider campaigns dial through). `provider` absent: not checked (old rows).
 */
export function callerNumberIneligibility(n: {
  status: string | null;
  outbound_enabled: boolean | null;
  provider?: string | null;
}): string | null {
  if (n.status !== "active") return `This number is ${n.status ?? "not active"}.`;
  if (n.provider !== undefined && n.provider !== "sarvam")
    return "Campaigns call only from Sarvam numbers; this number is inbound-only for campaigns.";
  if (n.outbound_enabled !== true)
    return "This number is not enabled for outbound calls yet (inbound only). ClickAI support enables it.";
  return null;
}

/** A caller number the campaign may use: the organization's own, active, outbound-enabled Sarvam number. */
export function isEligibleCallerNumber(n: {
  status: string | null;
  outbound_enabled: boolean | null;
  provider?: string | null;
}): boolean {
  return callerNumberIneligibility(n) === null;
}

/**
 * The caller-number picker's choices: eligible numbers (selectable) and the
 * workspace's other numbers with why they can't call out. Released numbers no
 * longer belong to the workspace, so they are in neither list. Display only:
 * saving and launching re-check the number on the server.
 */
export function callerNumberChoices<
  N extends {
    id: string;
    e164: string;
    status: string | null;
    outbound_enabled: boolean | null;
    provider?: string | null;
  },
>(numbers: N[]): { eligible: N[]; ineligible: { id: string; e164: string; reason: string }[] } {
  const listed = numbers.filter((n) => n.status !== "released");
  return {
    eligible: listed.filter(isEligibleCallerNumber),
    ineligible: listed.flatMap((n) => {
      const reason = callerNumberIneligibility(n);
      return reason ? [{ id: n.id, e164: n.e164, reason }] : [];
    }),
  };
}

/**
 * Checks everything a save stores. A draft may leave the agent and caller
 * number unchosen and the instructions unconfirmed, but every value it does
 * store must be valid (name and purpose are always required).
 */
export function validateWizardConfig(
  w: WizardState,
  options: { draft: boolean; now?: Date; savedSchedule?: CampaignSchedule | null },
): { errors: string[]; context: CampaignContext | null; compiled: CompiledContext | null } {
  const saved = options.savedSchedule ?? {};
  const instructions = validateInstructions(w.details.objective.trim(), w.instructions, {
    requireAgent: !options.draft,
  });
  return {
    errors: [
      ...validateDetails(w.details),
      ...instructions.errors,
      ...validateSchedule(w.schedule, options.now ?? new Date(), {
        startDate: saved.startDate,
        endDate: saved.endDate,
      }).errors,
      ...validateControls(w.controls),
    ],
    context: instructions.context,
    compiled: instructions.compiled,
  };
}

const str = (v: unknown, max = 5000) => (typeof v === "string" ? v.slice(0, max) : "");
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : NaN);

/** The wizard state from an untrusted request body; unknown keys are dropped. */
export function parseWizardState(raw: unknown): WizardState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, Record<string, unknown> | unknown>;
  const d = (r["details"] ?? {}) as Record<string, unknown>;
  const i = (r["instructions"] ?? {}) as Record<string, unknown>;
  const s = (r["schedule"] ?? {}) as Record<string, unknown>;
  const c = (r["controls"] ?? {}) as Record<string, unknown>;
  const days = Array.isArray(s["days"]) ? s["days"] : [];
  const statuses = Array.isArray(c["retryStatuses"]) ? c["retryStatuses"] : [];
  return {
    details: {
      name: str(d["name"], 500),
      objective: str(d["objective"], 1000),
      description: str(d["description"], 5000),
    },
    phoneNumberId: str(r["phoneNumberId"], 100),
    instructions: {
      agentConfigId: str(i["agentConfigId"], 100),
      language: str(i["language"], 20),
      audience: str(i["audience"]),
      talkingPoints: str(i["talkingPoints"]),
      questions: str(i["questions"]),
      desiredOutcome: str(i["desiredOutcome"]),
      interestedHandling: str(i["interestedHandling"]),
      uninterestedHandling: str(i["uninterestedHandling"]),
      callbackHandling: str(i["callbackHandling"]),
      closing: str(i["closing"]),
      tone: str(i["tone"]),
      extraInstructions: str(i["extraInstructions"]),
    },
    schedule: {
      mode: s["mode"] === "scheduled" ? "scheduled" : "immediately",
      startDate: str(s["startDate"], 10),
      endDate: str(s["endDate"], 10),
      timezone: str(s["timezone"], 64),
      days: [...new Set(days.filter((x): x is number => Number.isInteger(x) && x >= 0 && x <= 6))],
      windowStart: str(s["windowStart"], 5),
      windowEnd: str(s["windowEnd"], 5),
    },
    controls: {
      maxAttempts: int(c["maxAttempts"]),
      retryAfterMinutes: int(c["retryAfterMinutes"]),
      retryStatuses: [...new Set(statuses.filter((x): x is string => typeof x === "string"))],
      budgetRupees: str(c["budgetRupees"], 20),
    },
  };
}

/** The campaign's own configuration columns. Never organization, status or dispatch fields. */
export function campaignConfigRow(w: WizardState) {
  return {
    agent_config_id: w.instructions.agentConfigId || null,
    phone_number_id: w.phoneNumberId || null,
    name: w.details.name.trim(),
    objective: w.details.objective.trim(),
    description: w.details.description.trim() || null,
    language: w.instructions.language || null,
    schedule: scheduleToJson(w.schedule),
    max_attempts: w.controls.maxAttempts,
    retry_after_minutes: w.controls.retryAfterMinutes,
    retry_statuses: w.controls.maxAttempts > 1 ? w.controls.retryStatuses : [],
    budget_limit: budgetPaise(w.controls.budgetRupees) ?? null,
  };
}

/** A saved campaign as wizard state, so editing starts from exactly what is stored. */
export function wizardStateFromCampaign(row: {
  name: string;
  objective: string | null;
  description: string | null;
  agent_config_id: string | null;
  phone_number_id: string | null;
  language: string | null;
  schedule: unknown;
  max_attempts: number;
  retry_after_minutes: number;
  retry_statuses: string[] | null;
  budget_limit: number | null;
  context: unknown;
}): WizardState {
  const ctx = validateCampaignContext(row.context);
  const c = ctx.ok ? ctx.context : null;
  const split = splitExtraInstructions(c?.extraInstructions ?? "");
  const s = (
    row.schedule && typeof row.schedule === "object" ? row.schedule : {}
  ) as CampaignSchedule;
  const statuses = row.retry_statuses ?? [];
  return {
    details: {
      name: row.name,
      objective: c?.objective || row.objective || "",
      description: row.description ?? "",
    },
    phoneNumberId: row.phone_number_id ?? "",
    instructions: {
      agentConfigId: row.agent_config_id ?? "",
      language: row.language ?? "",
      audience: c?.audience ?? "",
      talkingPoints: (c?.talkingPoints ?? []).join("\n"),
      questions: (c?.questions ?? []).join("\n"),
      desiredOutcome: c?.desiredOutcome ?? "",
      interestedHandling: split.interested,
      uninterestedHandling: c?.objectionHandling ?? "",
      callbackHandling: c?.callbackHandling ?? "",
      closing: c?.closing ?? "",
      tone: c?.tone ?? "",
      extraInstructions: split.extra,
    },
    schedule: {
      mode: s.startDate ? "scheduled" : "immediately",
      startDate: s.startDate ?? "",
      endDate: s.endDate ?? "",
      timezone: s.timezone || PLATFORM_CALLING_HOURS.timeZone,
      days: s.days?.length ? [...s.days] : [0, 1, 2, 3, 4, 5, 6],
      windowStart: s.windowStart ?? PLATFORM_CALLING_HOURS.start,
      windowEnd: s.windowEnd ?? PLATFORM_CALLING_HOURS.end,
    },
    controls: {
      maxAttempts: row.max_attempts,
      retryAfterMinutes: row.retry_after_minutes,
      // One attempt stores no retry rules; offer the defaults if attempts are raised.
      retryStatuses: statuses.length ? [...statuses] : [...DEFAULT_CONTROLS.retryStatuses],
      budgetRupees: row.budget_limit ? String(row.budget_limit / 100) : "",
    },
  };
}

/** Things worth saying before save that do not block it. */
export function reviewWarnings(
  w: WizardState,
  audience: AudiencePreview,
  compiled: CompiledContext | null,
  outboundNumberCount: number,
): string[] {
  const out: string[] = [];
  if (!w.phoneNumberId)
    out.push("No caller number is chosen yet; one is needed before calls can start.");
  if (outboundNumberCount === 0)
    out.push(
      "None of your numbers is enabled for outbound calling yet; ClickAI support enables it.",
    );
  if (audience.valid.length === 0)
    out.push("No contacts yet; you can add them later on the campaign page.");
  if (audience.invalid.length)
    out.push(`${audience.invalid.length} contact(s) have invalid numbers and will not be added.`);
  if (audience.duplicates.length)
    out.push(`${audience.duplicates.length} duplicate row(s) will be added once.`);
  if (audience.notDiallable)
    out.push(`${audience.notDiallable} number(s) are outside India and will not be called.`);
  if (compiled?.omitted.length)
    out.push(`Too long to fit on a call, left out: ${compiled.omitted.join(", ")}.`);
  return out;
}

/* ------------------------------------------------------------------ */
/* Import results, in the customer's words                              */
/* ------------------------------------------------------------------ */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The counts one import recorded; null on history rows from before they were kept. */
export interface ImportCounts {
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  enrolled_rows: number | null;
  already_in_campaign_rows: number | null;
  opted_out_rows: number | null;
}

function countsSentence(c: ImportCounts): string {
  const parts = [plural(c.total_rows, "row")];
  if (c.enrolled_rows === null) {
    // Recorded before imports kept what they added: only the file's own totals are known.
    parts.push(`${c.valid_rows} valid`);
  } else {
    parts.push(`${c.enrolled_rows} added`);
    if (c.already_in_campaign_rows) parts.push(`${c.already_in_campaign_rows} already in campaign`);
    if (c.opted_out_rows) parts.push(`${c.opted_out_rows} skipped (do not call)`);
  }
  if (c.invalid_rows) parts.push(`${c.invalid_rows} invalid`);
  if (c.duplicate_rows) parts.push(`${plural(c.duplicate_rows, "duplicate row")} in file`);
  return parts.join(" · ");
}

/** One history row, for the campaign page. */
export function describeUploadRow(u: ImportCounts): string {
  return countsSentence(u);
}

/** The toast after an import (or its replay). */
export function describeImportResult(r: {
  replayed: boolean;
  totalRows: number;
  valid: number;
  invalid: number;
  duplicatesInFile: number;
  enrolled: number;
  alreadyInCampaign: number;
  optedOut: number;
}): string {
  const sentence = countsSentence({
    total_rows: r.totalRows,
    valid_rows: r.valid,
    invalid_rows: r.invalid,
    duplicate_rows: r.duplicatesInFile,
    enrolled_rows: r.enrolled,
    already_in_campaign_rows: r.alreadyInCampaign,
    opted_out_rows: r.optedOut,
  });
  return r.replayed
    ? `This import was already done; nothing was added again. ${sentence}.`
    : `Import complete: ${sentence}.`;
}
