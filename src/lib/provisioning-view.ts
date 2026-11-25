/**
 * Pure view-model for the admin provisioning screens (queue + detail): which
 * status a job shows, the ten-step checklist, and whether registering the
 * Sarvam agent or running verification + activation is allowed. The server
 * functions use the same gates (provisioning-admin.functions.ts), so the UI
 * never decides anything the server does not also enforce.
 */

export type QueueStatus =
  | "pending"
  | "running"
  | "retrying"
  | "stuck"
  | "waiting"
  | "blocked"
  | "failed"
  | "succeeded"
  | "cancelled";

/** A "running" job untouched for this long is a crashed attempt (provisioning-runs STALE_RUNNING_MS). */
export const STUCK_AFTER_MS = 10 * 60 * 1000;

/** Waiting on the customer or on data/assignment, not on the ClickAI team's Sarvam step. */
export const BLOCKED_STEPS = [
  "waiting_for_onboarding",
  "waiting_for_number",
  "waiting_for_connection",
] as const;

export const QUEUE_FILTERS: QueueStatus[] = [
  "pending",
  "running",
  "retrying",
  "stuck",
  "waiting",
  "blocked",
  "failed",
  "succeeded",
];

export function queueStatus(
  run: {
    status: string;
    current_step: string | null;
    attempts?: number;
    next_attempt_at?: string | null;
    updated_at?: string;
  },
  now: number = Date.now(),
): QueueStatus {
  if (run.status === "pending" && (run.attempts ?? 0) > 0 && run.next_attempt_at) return "retrying";
  if (
    run.status === "running" &&
    run.updated_at &&
    now - new Date(run.updated_at).getTime() > STUCK_AFTER_MS
  )
    return "stuck";
  if (
    run.status === "waiting" &&
    (BLOCKED_STEPS as readonly string[]).includes(run.current_step ?? "")
  )
    return "blocked";
  return (QUEUE_FILTERS as string[]).includes(run.status) || run.status === "cancelled"
    ? (run.status as QueueStatus)
    : "pending";
}

export function queueStatusTone(s: QueueStatus): "live" | "ready" | "error" | "idle" {
  if (s === "succeeded") return "live";
  if (s === "failed" || s === "blocked" || s === "stuck") return "error";
  if (s === "waiting" || s === "running" || s === "retrying") return "ready";
  return "idle";
}

export interface ChecklistInput {
  /** Missing onboarding / capability data (universal config blockers). */
  blockers: string[];
  number: {
    e164: string;
    status: string;
    deploymentId: string | null;
    /** An admin confirmed the number exists in Sarvam on this customer's connection. */
    confirmedInSarvam: boolean;
    /** The deployment ClickAI last verified for it (the admission gate needs this). */
    verifiedDeploymentId: string | null;
    /** Set when a call reached the agent through a deployment ClickAI never verified. */
    admissionBlockedReason: string | null;
  } | null;
  connectionRegistered: boolean;
  credential: { status: string; expiresAt: string | null } | null;
  agent: { appId: string | null; appVersion: number | null };
  masterAgentAppId: string | null;
  verification: { checks: { id: string; ok: boolean }[] } | null;
  /** Saved voice/language: problem = not set / invalid; applied* = the Sarvam agent + version recorded as carrying it. */
  voiceLanguage: {
    problem: string | null;
    appliedAppId: string | null;
    appliedVersion: number | null;
  };
  now: Date;
}

/** Whether the saved voice/language is recorded as applied to the registered Sarvam agent AND version. */
export function voiceLanguageApplied(i: ChecklistInput): boolean {
  return (
    !i.voiceLanguage.problem &&
    i.voiceLanguage.appliedVersion !== null &&
    i.voiceLanguage.appliedAppId !== null &&
    i.voiceLanguage.appliedAppId === i.agent.appId &&
    i.voiceLanguage.appliedVersion === i.agent.appVersion
  );
}

/** A deployment may be created only for a number an admin confirmed exists in Sarvam. */
export function numberConfirmed(n: ChecklistInput["number"]): boolean {
  return Boolean(n && (n.confirmedInSarvam || n.deploymentId));
}

export type ChecklistStatus = "done" | "todo" | "blocked" | "failed";

export interface ChecklistItem {
  step: number;
  label: string;
  status: ChecklistStatus;
  detail: string;
  /** Needs the ClickAI team in the Sarvam console (no API exists). */
  manual?: boolean;
}

export function credentialLive(c: ChecklistInput["credential"], now: Date): boolean {
  return Boolean(c && c.status === "active" && (!c.expiresAt || new Date(c.expiresAt) > now));
}

const MAPPING_CHECKS = ["routes_number", "clickai_mapping"];

export function provisioningChecklist(i: ChecklistInput): ChecklistItem[] {
  const onboarded = i.blockers.length === 0;
  const registered = Boolean(i.agent.appId && i.agent.appVersion);
  const isMaster = Boolean(i.masterAgentAppId && i.agent.appId === i.masterAgentAppId);
  const checks = i.verification?.checks ?? [];
  const deploymentChecksOk =
    checks.length > 0 && checks.filter((c) => !MAPPING_CHECKS.includes(c.id)).every((c) => c.ok);
  const mappingOk =
    checks.length > 0 && checks.filter((c) => MAPPING_CHECKS.includes(c.id)).every((c) => c.ok);
  const live = credentialLive(i.credential, i.now);
  // Step 10 is done only when ClickAI really serves business data for the number.
  const numberServed = (x: ChecklistInput) =>
    Boolean(
      x.number?.status === "active" &&
      x.number.deploymentId &&
      x.number.verifiedDeploymentId === x.number.deploymentId &&
      deploymentChecksOk &&
      mappingOk,
    );
  const item = (
    step: number,
    label: string,
    status: ChecklistStatus,
    detail: string,
    manual = false,
  ): ChecklistItem => ({
    step,
    label,
    status,
    detail,
    ...(manual ? { manual } : {}),
  });

  return [
    item(
      1,
      "Onboarding complete",
      onboarded ? "done" : "blocked",
      onboarded ? "Business data covers every enabled capability." : i.blockers.join(" "),
    ),
    item(
      2,
      "Sarvam number assigned and confirmed",
      !i.number || !i.connectionRegistered
        ? "blocked"
        : numberConfirmed(i.number)
          ? "done"
          : "todo",
      !i.number
        ? "Assign this customer's existing number on the Phone numbers page (ClickAI never rents or buys numbers)."
        : !i.connectionRegistered
          ? "Register the Sarvam connection for this customer."
          : numberConfirmed(i.number)
            ? `${i.number.e164} (${i.number.status}).`
            : `${i.number.e164}: confirm it already exists in Sarvam on this customer's connection.`,
    ),
    item(
      3,
      "Agent configuration generated (incl. voice & languages)",
      !onboarded ? "blocked" : i.voiceLanguage.problem ? "todo" : "done",
      !onboarded
        ? "Finish onboarding first."
        : i.voiceLanguage.problem
          ? `${i.voiceLanguage.problem} Set them in Voice & language below.`
          : "Generated from the customer's data and voice/language settings (below).",
    ),
    item(
      4,
      "Integration credential issued",
      live ? "done" : "todo",
      live
        ? "An active credential exists (its value is never shown again)."
        : "Issue it, then store it as the Sarvam secret on the customer's agent.",
    ),
    item(
      5,
      "Customer agent created in Sarvam",
      registered ? "done" : "todo",
      "Copy the universal master agent, apply the configuration and credential, commit a version.",
      true,
    ),
    item(
      6,
      "Sarvam agent registered",
      isMaster ? "failed" : registered && voiceLanguageApplied(i) ? "done" : "todo",
      isMaster
        ? "Registered agent is the master template; register the customer's own copy."
        : !registered
          ? "Enter the copied agent's id and version."
          : voiceLanguageApplied(i)
            ? `${i.agent.appId} v${i.agent.appVersion}, voice & languages applied.`
            : `${i.agent.appId} v${i.agent.appVersion}, but voice & languages are not recorded as applied to this agent and version.`,
    ),
    item(
      7,
      "Deployment created",
      i.number?.deploymentId ? "done" : "todo",
      i.number?.deploymentId ?? "Created automatically when you run verification.",
    ),
    item(
      8,
      "Deployment verified",
      checks.length === 0 ? "todo" : deploymentChecksOk ? "done" : "failed",
      checks.length === 0
        ? "Not verified yet."
        : deploymentChecksOk
          ? "Active, right agent and version, webhook set."
          : "See the failed checks below.",
    ),
    item(
      9,
      "Number mapping verified",
      checks.length === 0 ? "todo" : mappingOk ? "done" : "failed",
      checks.length === 0
        ? "Not verified yet."
        : mappingOk
          ? "Sarvam and ClickAI agree on the number."
          : "See the failed checks below.",
    ),
    item(
      10,
      "Number active",
      i.number?.admissionBlockedReason ? "failed" : numberServed(i) ? "done" : "todo",
      i.number?.admissionBlockedReason
        ? `Business data blocked: ${i.number.admissionBlockedReason}`
        : numberServed(i)
          ? "Answering calls with ClickAI business data."
          : i.number?.status === "active"
            ? "Active in ClickAI, but business data is blocked until its deployment is verified (Re-verify live deployment)."
            : "Activated only after the resumed deployment is read back and verified.",
    ),
  ];
}

export interface Gate {
  allowed: boolean;
  reasons: string[];
}

/** Registering the customer's Sarvam agent id/version (step 6). */
export function registrationGate(i: ChecklistInput, appId: string): Gate {
  const reasons: string[] = [];
  if (i.blockers.length)
    reasons.push("Onboarding is incomplete; the agent configuration cannot be generated yet.");
  if (!credentialLive(i.credential, i.now)) reasons.push("Issue the integration credential first.");
  if (i.voiceLanguage.problem) reasons.push("Save valid voice & language settings first.");
  if (i.masterAgentAppId && appId.trim() === i.masterAgentAppId)
    reasons.push("That is the universal master agent, not the customer's copy.");
  return { allowed: reasons.length === 0, reasons };
}

/** Running create/verify/activate (steps 7-10). The pipeline re-checks all of this server-side. */
export function activationGate(i: ChecklistInput): Gate {
  const reasons: string[] = [];
  if (i.blockers.length) reasons.push("Onboarding is incomplete.");
  if (!i.number) reasons.push("No number is assigned.");
  else if (!numberConfirmed(i.number))
    reasons.push("Confirm the number exists in Sarvam on this customer's connection first.");
  if (i.number?.admissionBlockedReason)
    reasons.push("Business data is blocked for this number; review and clear the block first.");
  if (!i.connectionRegistered) reasons.push("No Sarvam connection is registered.");
  if (!credentialLive(i.credential, i.now)) reasons.push("No active integration credential.");
  if (!i.agent.appId || !i.agent.appVersion)
    reasons.push("The customer's Sarvam agent is not registered.");
  if (i.masterAgentAppId && i.agent.appId === i.masterAgentAppId)
    reasons.push("The registered agent is the master template.");
  if (i.agent.appVersion && !voiceLanguageApplied(i))
    reasons.push(
      "Voice & languages are not recorded as applied to the registered Sarvam agent and version.",
    );
  return { allowed: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Outbound agent (steps 11-13; agent-roles.ts)                          */
/* ------------------------------------------------------------------ */

export interface OutboundChecklistInput {
  /** The inbound agent's id: the outbound agent must be a different agent. */
  inboundAppId: string | null;
  credential: { status: string; expiresAt: string | null } | null;
  appId: string | null;
  appVersion: number | null;
  readyAppId: string | null;
  readyVersion: number | null;
  /** Inbound and outbound master template ids (never a customer's agent). */
  masterAgentAppIds: (string | null)[];
  /** Missing onboarding data (the outbound configuration cannot be generated yet). */
  blockers: string[];
  voiceLanguageProblem: string | null;
  now: Date;
}

const isMasterId = (ids: (string | null)[], appId: string | null) =>
  Boolean(appId && ids.some((m) => m && m === appId));

/** The outbound agent's three steps, shown after the inbound ten. */
export function outboundChecklist(o: OutboundChecklistInput): ChecklistItem[] {
  const live = credentialLive(o.credential, o.now);
  const registered = Boolean(o.appId && o.appVersion);
  const wrongAgent =
    registered && (o.appId === o.inboundAppId || isMasterId(o.masterAgentAppIds, o.appId));
  const confirmed =
    registered && !wrongAgent && o.readyAppId === o.appId && o.readyVersion === o.appVersion;
  return [
    {
      step: 11,
      label: "Outbound credential issued",
      status: live ? "done" : "todo",
      detail: live
        ? "An active outbound credential exists. ClickAI lets it book only for the number it dialled on an open call, and refuses callbacks and every other write tool."
        : "Issue the outbound credential, then store it as the Sarvam secret on the outbound agent (never the inbound agent's secret).",
    },
    {
      step: 12,
      label: "Outbound agent created in Sarvam and registered",
      status: wrongAgent ? "failed" : registered ? "done" : "todo",
      detail: wrongAgent
        ? `${o.appId} is the inbound agent or a master template. Register the customer's own outbound agent.`
        : registered
          ? `${o.appId} v${o.appVersion}.`
          : "Create the outbound agent from the outbound template below (only the tools listed), commit it, then register its id and version.",
      manual: true,
    },
    {
      step: 13,
      label: "Confirmed for outbound calling (after a supervised call)",
      status: confirmed ? "done" : "todo",
      detail: confirmed
        ? "ClickAI may dial this outbound agent version."
        : registered
          ? "Not confirmed: ClickAI dials nothing for this customer. Confirm only after a supervised call."
          : "Register the outbound agent first.",
    },
  ];
}

/** Registering the customer's outbound agent (step 12). The server re-checks every rule. */
export function outboundRegistrationGate(o: OutboundChecklistInput, appId: string): Gate {
  const reasons: string[] = [];
  const id = appId.trim();
  if (o.blockers.length)
    reasons.push("Onboarding is incomplete; the outbound configuration cannot be generated yet.");
  if (o.voiceLanguageProblem) reasons.push("Save valid voice & language settings first.");
  if (!credentialLive(o.credential, o.now)) reasons.push("Issue the outbound credential first.");
  if (id && id === o.inboundAppId)
    reasons.push("That is this customer's inbound agent; the outbound agent must be separate.");
  if (isMasterId(o.masterAgentAppIds, id))
    reasons.push("That is a master template, not the customer's own outbound agent.");
  return { allowed: reasons.length === 0, reasons };
}
