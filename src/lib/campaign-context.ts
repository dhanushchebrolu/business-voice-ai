/**
 * Campaign context engine (pure: no I/O).
 *
 * A customer describes a campaign in their own words. That description is kept
 * unchanged; from it a structured CampaignContext is drafted (by an LLM when one
 * is configured, else deterministically), reviewed and edited by the customer,
 * validated here, and stored. Every call of the campaign then receives the
 * context COMPILED into the two agent variables the outbound agent declares and
 * reads as data (verified live): `campaign_objective` (≤ 300 chars) and
 * `campaign_instructions` (≤ 1500). Sarvam does not take arbitrary variables, so
 * nothing else is sent.
 *
 * Separation: the context only describes WHY and HOW to talk. What the agent may
 * DO comes from its role (OUTBOUND_AGENT_TOOLS, enforced by ClickAI's backend for
 * the outbound credential); the context can neither grant nor describe extra
 * capabilities, and the agent's own prompt treats it as data.
 */
import {
  OUTBOUND_AGENT_TOOLS,
  OUTBOUND_FORBIDDEN_TOOLS,
  OUTBOUND_TEXT_LIMITS,
} from "./agent-roles.ts";

export const CAMPAIGN_CONTEXT_VERSION = 1;
export const CAMPAIGN_DESCRIPTION_MAX = 4000;

export interface CampaignContext {
  version: typeof CAMPAIGN_CONTEXT_VERSION;
  /** Why the business is calling, in one sentence (the agent says this). */
  objective: string;
  /** Who is being called and what they have in common. */
  audience: string;
  /** What to mention, in order of importance. */
  talkingPoints: string[];
  /** What to ask the person. */
  questions: string[];
  /** Services or products the call may be about (from the business's own list). */
  servicesInScope: string[];
  /** What a good result looks like for this person. */
  desiredOutcome: string;
  /** How to respond to doubts or a "no". */
  objectionHandling: string;
  /** What to do if they want to be contacted later. */
  callbackHandling: string;
  /** How to end the call. */
  closing: string;
  /** Tone and style. */
  tone: string;
  /** Anything else for this campaign. */
  extraInstructions: string;
  /** How the business will judge the campaign (shown in reporting, not sent). */
  successCriteria: string;
}

type TextField = Exclude<
  keyof CampaignContext,
  "version" | "talkingPoints" | "questions" | "servicesInScope"
>;
type ListField = "talkingPoints" | "questions" | "servicesInScope";

export const CONTEXT_LIMITS: Record<TextField, number> &
  Record<ListField, { items: number; each: number }> = {
  objective: 200,
  audience: 200,
  desiredOutcome: 200,
  objectionHandling: 300,
  callbackHandling: 200,
  closing: 200,
  tone: 120,
  extraInstructions: 400,
  successCriteria: 200,
  talkingPoints: { items: 6, each: 200 },
  questions: { items: 5, each: 160 },
  servicesInScope: { items: 8, each: 80 },
};

const TEXT_FIELDS: TextField[] = [
  "objective",
  "audience",
  "desiredOutcome",
  "objectionHandling",
  "callbackHandling",
  "closing",
  "tone",
  "extraInstructions",
  "successCriteria",
];
const LIST_FIELDS: ListField[] = ["talkingPoints", "questions", "servicesInScope"];

/** One line of plain text: no control characters, no markup braces, collapsed spaces. */
export function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      // `{{x}}` would be read as a Sarvam variable reference.
      .replace(/[{}<>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export type ValidationResult =
  { ok: true; context: CampaignContext } | { ok: false; errors: string[] };

/** Validates customer- or LLM-supplied context. Over-long text is an error, never silently cut. */
export function validateCampaignContext(input: unknown): ValidationResult {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const context = { version: CAMPAIGN_CONTEXT_VERSION } as CampaignContext;
  for (const field of TEXT_FIELDS) {
    const value = cleanText(raw[field]);
    if (value.length > CONTEXT_LIMITS[field])
      errors.push(`${field}: at most ${CONTEXT_LIMITS[field]} characters`);
    context[field] = value;
  }
  for (const field of LIST_FIELDS) {
    const limit = CONTEXT_LIMITS[field];
    const items = (Array.isArray(raw[field]) ? (raw[field] as unknown[]) : [])
      .map(cleanText)
      .filter(Boolean);
    if (items.length > limit.items) errors.push(`${field}: at most ${limit.items} items`);
    if (items.some((i) => i.length > limit.each))
      errors.push(`${field}: each at most ${limit.each} characters`);
    context[field] = items;
  }
  if (!context.objective) errors.push("objective: say why the business is calling");
  return errors.length ? { ok: false, errors } : { ok: true, context };
}

export interface CompiledContext {
  /** → campaign_objective */
  objective: string;
  /** → campaign_instructions */
  instructions: string;
  /** Sections left out because the instructions would exceed their limit. */
  omitted: string[];
}

/**
 * Deterministic: the same context always gives the same text. Sections are in
 * priority order; a section that does not fit whole is left out (and reported),
 * never cut mid-sentence.
 */
export function compileCampaignContext(context: CampaignContext): CompiledContext {
  const list = (items: string[]) => items.map((t, i) => `${i + 1}) ${t}`).join(" ");
  const sections: [string, string][] = [
    ["Who", context.audience],
    ["Mention", list(context.talkingPoints)],
    ["Ask", list(context.questions)],
    ["Services in scope", context.servicesInScope.join(", ")],
    ["Good result", context.desiredOutcome],
    ["If they hesitate or decline", context.objectionHandling],
    ["If they want to be contacted later", context.callbackHandling],
    ["Closing", context.closing],
    ["Tone", context.tone],
    ["Also", context.extraInstructions],
  ];
  const parts: string[] = [];
  const omitted: string[] = [];
  let length = 0;
  for (const [label, text] of sections) {
    if (!text) continue;
    const part = `${label}: ${text}`;
    const added = (parts.length ? 3 : 0) + part.length; // " | " separator
    if (length + added > OUTBOUND_TEXT_LIMITS.instructions) {
      omitted.push(label);
      continue;
    }
    parts.push(part);
    length += added;
  }
  return {
    objective: context.objective.slice(0, OUTBOUND_TEXT_LIMITS.objective),
    instructions: parts.join(" | "),
    omitted,
  };
}

/** A first draft without an LLM: the first sentence is the objective, the rest are talking points. */
export function draftCampaignContext(description: string): CampaignContext {
  const text = cleanText(description).slice(0, CAMPAIGN_DESCRIPTION_MAX);
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const fit = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
  return {
    version: CAMPAIGN_CONTEXT_VERSION,
    objective: fit(sentences[0] ?? "", CONTEXT_LIMITS.objective),
    audience: "",
    talkingPoints: sentences
      .slice(1, 1 + CONTEXT_LIMITS.talkingPoints.items)
      .map((s) => fit(s, CONTEXT_LIMITS.talkingPoints.each)),
    questions: [],
    servicesInScope: [],
    desiredOutcome: "",
    objectionHandling: "",
    callbackHandling: "",
    closing: "",
    tone: "",
    extraInstructions: "",
    successCriteria: "",
  };
}

/** What the outbound agent can and cannot do, from its role (shown in review; never editable). */
export function platformCapabilities(): { allowed: string[]; forbidden: string[] } {
  const label: Record<string, string> = {
    clickai_business_context: "Read the business's current details",
    get_business_info: "Answer questions from the business's verified information",
    check_availability: "Check whether an appointment time is free",
    record_call_outcome: "Record the result of the call",
    book_appointment: "Book, hold or change appointments",
    request_callback: "Schedule callbacks",
    send_reminder: "Send reminders, SMS, WhatsApp or e-mail",
    call_transfer: "Transfer the call",
  };
  return {
    allowed: OUTBOUND_AGENT_TOOLS.map((t) => label[t] ?? t),
    forbidden: OUTBOUND_FORBIDDEN_TOOLS.map((t) => label[t] ?? t),
  };
}

/**
 * The drafting request for an LLM. The model only restructures the customer's
 * words into the JSON fields; its output is validated like customer input and
 * reviewed before use, and it cannot change what the agent may do.
 */
export function buildDraftRequest(
  description: string,
  business: { name?: string | null; services?: string[] },
): { system: string; user: string } {
  const capabilities = platformCapabilities();
  const fields = [
    `objective (one sentence, ≤${CONTEXT_LIMITS.objective} chars: why the business is calling)`,
    `audience (≤${CONTEXT_LIMITS.audience})`,
    `talkingPoints (≤${CONTEXT_LIMITS.talkingPoints.items} items)`,
    `questions (≤${CONTEXT_LIMITS.questions.items} items)`,
    `servicesInScope (only names from the business's service list)`,
    `desiredOutcome`,
    `objectionHandling`,
    `callbackHandling`,
    `closing`,
    `tone`,
    `extraInstructions`,
    `successCriteria`,
  ];
  return {
    system: [
      "You turn a business owner's description of an outbound phone campaign into structured guidance for a voice assistant.",
      "Return ONLY a JSON object with these keys: " +
        fields.join("; ") +
        ". Use empty strings or empty arrays when the description says nothing.",
      "Use only facts in the description or the business's service list. Never invent offers, prices, discounts or dates.",
      `The assistant CAN: ${capabilities.allowed.join("; ")}. It CANNOT: ${capabilities.forbidden.join("; ")}. Never write guidance that asks it to do something it cannot; for those, guide it to give the business's phone number.`,
      "Never ask for card numbers, OTPs or ID numbers. Be respectful; never pressure.",
    ].join("\n"),
    user: JSON.stringify({
      business: business.name ?? "",
      services: (business.services ?? []).slice(0, 40),
      description: cleanText(description).slice(0, CAMPAIGN_DESCRIPTION_MAX),
    }),
  };
}

/** Parses an LLM draft: the first JSON object in the text, validated. Null when unusable. */
export function parseDraftResponse(text: string): CampaignContext | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = validateCampaignContext(parsed);
  return result.ok ? result.context : null;
}
