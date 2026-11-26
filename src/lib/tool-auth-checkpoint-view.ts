import { CLICKAI_TOOL_NAMES, clickAiToolDefinitions } from "./sarvam-agent-tools-spec.ts";
import { OUTBOUND_AGENT_TOOLS, type AgentRole } from "./agent-roles.ts";

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
  agentRole: AgentRole;
  /** Fixed body value every tool must send; ClickAI refuses a credential of another agent. */
  agentRef: string;
  waitingSince: string;
  waitingMs: number;
  waitingLabel: string;
  /** Display only. Nothing times out or proceeds on its own. */
  attention: "normal" | "needs_intervention";
  attentionNote: string;
  /** True once the operator reported the tools, so confirmation can be accepted. */
  readyForConfirmation: boolean;
  resumeNote: string;
  /** No verified Sarvam console link format exists, so none is offered. */
  agentLink: null;
  tools: CheckpointTool[];
  instructions: string[];
  copyText: string;
}

export interface CheckpointInput {
  /** Default inbound. */
  role?: AgentRole;
  jobId: string;
  customerId: string;
  customer: string;
  agentId: string;
  credentialName: string;
  agentRef: string;
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
  const role = input.role ?? "inbound";
  const definitions = clickAiToolDefinitions("https://placeholder.invalid");
  // Outbound tools depend on the customer's capabilities: the report (checked against the
  // work order when it was accepted) names them. Without one, the template's full set.
  const names: readonly string[] =
    role === "inbound"
      ? CLICKAI_TOOL_NAMES
      : input.toolsReported.length
        ? OUTBOUND_AGENT_TOOLS.filter((t) => input.toolsReported.includes(t))
        : OUTBOUND_AGENT_TOOLS;
  const lifecycleOf = (name: string) =>
    (definitions.find((d) => d.name === name)?.connectorConfig as { lifecycle?: string })
      ?.lifecycle ?? "run";
  const expectedAuth = `Bearer, credential "${input.credentialName}"`;
  const reported = new Set(input.toolsReported);
  const tools: CheckpointTool[] = names.map((name, i) => ({
    order: i + 1,
    name,
    timing: TIMING[lifecycleOf(name)]!,
    expectedAuth,
    status: reported.has(name) ? "created_awaiting_credential" : "missing",
  }));
  const waitingMs = Math.max(0, input.now.getTime() - new Date(input.waitingSince).getTime());
  const stale = waitingMs > STALE_AFTER_MS;
  const ready = tools.every((t) => t.status === "created_awaiting_credential");
  const count = role === "inbound" ? "six" : String(tools.length);
  const outbound = role === "outbound";
  const instructions = [
    `Sarvam console: open the agent with ID ${input.agentId} (compare the whole ID). Never the master agent or another customer's agent.${outbound ? " This is the OUTBOUND agent: not the customer's inbound agent." : ""}`,
    `Open the DRAFT, then each of the ${count} tools below, in order.`,
    `On each tool set Authentication to Bearer and select the credential named "${input.credentialName}". If that exact name is not listed, stop: do not pick another.`,
    `Reopen all ${count} tools and check each shows Bearer with that same credential and the fixed body field agent_ref = ${input.agentRef}.`,
    "Commit the agent and note the committed version number.",
    `Read the committed version back: all ${count} tools must still show the credential. Then confirm it in your operator client (submit_agent_result with the agent ID, that version and, per tool, the credential type and agent_ref).`,
    outbound
      ? "ClickAI keeps this job paused until that confirmation is accepted. Nothing can be dialled before it, and calling still needs an admin's confirmation after a supervised call."
      : "ClickAI keeps this job paused until that confirmation is accepted. Nothing is deployed, mapped or activated before it.",
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
    `Agent role: ${role}`,
    `Credential to select (name only): ${input.credentialName}`,
    `Fixed body field on every tool: agent_ref = ${input.agentRef}`,
    "",
    `${outbound ? count : "Six"} tools (select this customer's ${role} credential on each):`,
    checklist,
    "",
    `Then: commit the agent, read the committed version back, confirm all ${count} show the credential, and submit the confirmation.`,
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
    agentRole: role,
    agentRef: input.agentRef,
    waitingSince: input.waitingSince,
    waitingMs,
    waitingLabel: waitingLabel(waitingMs),
    attention: stale ? "needs_intervention" : "normal",
    attentionNote: stale
      ? "Waiting over 24 hours. A person needs to finish the console step; nothing times out or skips it."
      : "",
    readyForConfirmation: ready,
    resumeNote: ready
      ? `Resumes this same job automatically when the committed version is confirmed with credentials on all ${count} tools.`
      : `Not all ${count} tools are reported as created; the operator must report them before confirming.`,
    agentLink: null,
    tools,
    instructions,
    copyText,
  };
}
