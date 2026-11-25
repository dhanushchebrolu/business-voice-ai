import { CLICKAI_TOOL_NAMES, clickAiToolDefinitions } from "./sarvam-agent-tools-spec.ts";

/**
 * What the admin sees while a job waits at the tool-authentication checkpoint. Pure: built
 * from facts ClickAI already holds (job, agent, the operator's "tools created" report). It
 * never carries a credential value, and it never claims a tool is authenticated: ClickAI
 * cannot read Sarvam's tool credentials, so per-tool state is only "created" until the
 * operator submits the committed version with read-back evidence (then the job resumes and
 * leaves this queue).
 */

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type ToolTiming = "On call start" | "During the call" | "On call end";

export interface CheckpointTool {
  order: number;
  name: string;
  timing: ToolTiming;
  expectedAuth: string;
  /** Never "authenticated": that is only known after the committed version is submitted. */
  status: "created_awaiting_credential" | "missing";
}

export interface ToolAuthCheckpoint {
  status: "awaiting_credentials";
  customer: string;
  customerId: string;
  jobId: string;
  agentId: string;
  master: { agentId: string; version: number } | null;
  /** Name to look for in the console. A label only; ClickAI does not know it exists there. */
  credentialName: string;
  waitingSince: string;
  waitingMs: number;
  waitingLabel: string;
  /** Display only. Nothing times out or proceeds on its own. */
  attention: "normal" | "needs_intervention";
  attentionNote: string;
  /** True once the operator reported all six tools, so confirmation can be accepted. */
  readyForConfirmation: boolean;
  resumeNote: string;
  /** No verified Sarvam console link format exists, so none is offered. */
  agentLink: null;
  tools: CheckpointTool[];
  instructions: string[];
  copyText: string;
}

export interface CheckpointInput {
  jobId: string;
  customerId: string;
  customer: string;
  agentId: string;
  credentialName: string;
  master: { agentId: string; version: number } | null;
  waitingSince: string;
  now: Date;
  /** The tool names the operator reported creating. */
  toolsReported: readonly string[];
}

const TIMING: Record<string, ToolTiming> = {
  on_start: "On call start",
  run: "During the call",
  on_end: "On call end",
};

export function waitingLabel(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export function buildToolAuthCheckpoint(input: CheckpointInput): ToolAuthCheckpoint {
  const definitions = clickAiToolDefinitions("https://placeholder.invalid");
  const expectedAuth = `Bearer, credential "${input.credentialName}"`;
  const reported = new Set(input.toolsReported);
  const tools: CheckpointTool[] = CLICKAI_TOOL_NAMES.map((name, i) => ({
    order: i + 1,
    name,
    timing:
      TIMING[
        (definitions.find((d) => d.name === name)!.connectorConfig as { lifecycle: string })
          .lifecycle
      ]!,
    expectedAuth,
    status: reported.has(name) ? "created_awaiting_credential" : "missing",
  }));
  const waitingMs = Math.max(0, input.now.getTime() - new Date(input.waitingSince).getTime());
  const stale = waitingMs > STALE_AFTER_MS;
  const ready = tools.every((t) => t.status === "created_awaiting_credential");
  const instructions = [
    `Sarvam console: open the agent with ID ${input.agentId} (compare the whole ID). Never the master agent or another customer's agent.`,
    "Open the DRAFT, then each of the six tools below, in order.",
    `On each tool set Authentication to Bearer and select the credential named "${input.credentialName}". If that exact name is not listed, stop: do not pick another.`,
    "Reopen all six tools and check each shows Bearer with that same credential.",
    "Commit the agent and note the committed version number.",
    "Read the committed version back: all six tools must still show the credential. Then confirm it in your operator client (submit_agent_result with the agent ID, that version and the per-tool credential types).",
    "ClickAI keeps this job paused until that confirmation is accepted. Nothing is deployed, mapped or activated before it.",
  ];
  const checklist = tools
    .map((t) => `[ ] ${t.order}. ${t.name} | ${t.timing} | Bearer "${input.credentialName}"`)
    .join("\n");
  const copyText = [
    `ClickAI tool authentication: ${input.customer}`,
    `Customer ID: ${input.customerId}`,
    `Provisioning job: ${input.jobId}`,
    `Sarvam agent ID: ${input.agentId}`,
    `Cloned from master ${input.master ? `${input.master.agentId} v${input.master.version}` : "(not recorded)"}`,
    `Credential to select (name only): ${input.credentialName}`,
    "",
    "Six tools (select this customer's credential on each):",
    checklist,
    "",
    "Then: commit the agent, read the committed version back, confirm all six show the credential, and submit the confirmation.",
    "Never paste a credential value into a tool, a chat or this checklist.",
  ].join("\n");
  return {
    status: "awaiting_credentials",
    customer: input.customer,
    customerId: input.customerId,
    jobId: input.jobId,
    agentId: input.agentId,
    master: input.master,
    credentialName: input.credentialName,
    waitingSince: input.waitingSince,
    waitingMs,
    waitingLabel: waitingLabel(waitingMs),
    attention: stale ? "needs_intervention" : "normal",
    attentionNote: stale
      ? "Waiting over 24 hours. A person needs to finish the console step; nothing times out or skips it."
      : "",
    readyForConfirmation: ready,
    resumeNote: ready
      ? "Resumes this same job automatically when the committed version is confirmed with credentials on all six tools."
      : "Not all six tools are reported as created; the operator must report them before confirming.",
    agentLink: null,
    tools,
    instructions,
    copyText,
  };
}
