import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { registeredAgent, type AgentRole } from "./agent-roles.ts";
import { agentRef } from "./sarvam-agent-tools-spec.ts";
import { SARVAM_APP_ID_PATTERN } from "./sarvam-agent-registration.server.ts";
import {
  AGENT_AUDIT,
  CONFIRMATION_ACTIONS,
  releasedRecordIds,
  reportedAgent,
} from "./tool-auth-checkpoint.server.ts";

/**
 * Admin recovery for the two ways agent setup could get stuck. Both change ClickAI's own
 * records only: nothing here calls Sarvam or Vobiz, or touches a number or deployment.
 *
 *   release      a wrong agent id was reported (or confirmed) for a customer. Its records stop
 *                counting, the customer's bridge tokens end, and the job accepts another id.
 *   confirm      the registered outbound agent version's tool credentials, checked by an admin
 *                when no provisioning job can carry the confirmation.
 *
 * Every action is written to audit_logs BEFORE it takes effect, and fails if it cannot be.
 * Callers own authorization.
 */

type Admin = SupabaseClient<Database>;

export interface Actor {
  userId: string;
  email: string | null;
}

async function record(
  admin: Admin,
  entry: {
    action: string;
    organizationId: string;
    agentConfigId: string;
    actor: Actor | undefined;
    reason: string;
    newValue: Record<string, unknown>;
  },
) {
  const { error } = await admin.from("audit_logs").insert({
    admin_user_id: entry.actor?.userId ?? null,
    admin_email: entry.actor?.email ?? null,
    action: entry.action,
    entity_type: "agent_config",
    entity_id: entry.agentConfigId,
    organization_id: entry.organizationId,
    new_value: entry.newValue as Json,
    reason: entry.reason,
  });
  if (error) throw error;
}

/** Keeps the proof that a version was confirmed for calling. false: it could not be written. */
export async function preserveOutboundConfirmation(
  admin: Admin,
  input: {
    organizationId: string;
    agentConfigId: string;
    appId: string;
    version: number;
    actor?: Actor | undefined;
  },
): Promise<boolean> {
  try {
    await record(admin, {
      action: AGENT_AUDIT.preserved,
      organizationId: input.organizationId,
      agentConfigId: input.agentConfigId,
      actor: input.actor,
      reason: "Kept the confirmation of an outbound version before it was withdrawn or replaced.",
      newValue: { app_id: input.appId, app_version: input.version },
    });
    return true;
  } catch (error) {
    console.error("agent_recovery:preserve_failed", (error as { message?: string }).message);
    return false;
  }
}

async function agentOf(admin: Admin, organizationId: string) {
  const { data, error } = await admin
    .from("agent_configs")
    .select(
      "id, sarvam_app_id, sarvam_app_version, sarvam_outbound_app_id, sarvam_outbound_app_version, sarvam_outbound_ready_app_id",
    )
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("This customer has no agent yet.");
  return data;
}

async function openRun(admin: Admin, organizationId: string) {
  const { data, error } = await admin
    .from("provisioning_runs")
    .select("id, status, current_step")
    .eq("organization_id", organizationId)
    .in("status", ["pending", "running", "waiting"])
    .maybeSingle();
  if (error) throw error;
  return data;
}

const AFTER_RELEASE: Record<string, { role: AgentRole; step: string }> = {
  waiting_for_tool_authentication: { role: "inbound", step: "waiting_for_agent" },
  waiting_for_outbound_tool_authentication: {
    role: "outbound",
    step: "waiting_for_outbound_agent",
  },
};

export async function releaseAgentId(
  admin: Admin,
  input: { organizationId: string; appId: string; actor: Actor; reason: string; now?: Date },
) {
  const appId = input.appId.trim();
  const reason = input.reason.trim();
  if (!SARVAM_APP_ID_PATTERN.test(appId))
    throw new Error("That does not look like a Sarvam agent id.");
  if (!reason) throw new Error("A reason is required");
  const { organizationId } = input;
  const agent = await agentOf(admin, organizationId);
  if (appId === agent.sarvam_app_id || appId === agent.sarvam_outbound_app_id)
    throw new Error(
      "That agent is registered for this customer. Register the correct agent first, then release this ID.",
    );
  const run = await openRun(admin, organizationId);
  if (run?.status === "running")
    throw new Error("Provisioning is running for this customer. Try again in a minute.");

  const [events, confirmations, carried, released] = await Promise.all([
    admin
      .from("provisioning_run_events")
      .select("id")
      .eq("organization_id", organizationId)
      .in("event", ["agent_tools_created", "tool_auth_confirmed"])
      .eq("detail->>appId", appId),
    admin
      .from("audit_logs")
      .select("id")
      .eq("organization_id", organizationId)
      .in("action", CONFIRMATION_ACTIONS)
      .eq("new_value->>app_id", appId),
    admin
      .from("provisioning_runs")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("sarvam_agent_id", appId),
    releasedRecordIds(admin, organizationId),
  ]);
  for (const r of [events, confirmations, carried]) if (r.error) throw r.error;
  const recordIds = [...(events.data ?? []), ...(confirmations.data ?? [])]
    .map((r) => r.id)
    .filter((id) => !released.has(id));
  const wasReady = agent.sarvam_outbound_ready_app_id === appId;
  if (!recordIds.length && !carried.data?.length && !wasReady)
    throw new Error("Nothing is recorded for that agent id for this customer.");

  // Tokens first: a stale operator session ends before anything else changes.
  const { data: revoked, error: revokeError } = await admin
    .from("operator_bridge_tokens")
    .update({ revoked_at: (input.now ?? new Date()).toISOString() })
    .eq("organization_id", organizationId)
    .is("revoked_at", null)
    .select("id");
  if (revokeError) throw revokeError;
  await record(admin, {
    action: AGENT_AUDIT.released,
    organizationId,
    agentConfigId: agent.id,
    actor: input.actor,
    reason,
    newValue: { appId, recordIds, runId: run?.id ?? null },
  });

  // A confirmation for calling of an agent that is no longer this customer's must not revive.
  if (wasReady) {
    const { error } = await admin
      .from("agent_configs")
      .update({
        sarvam_outbound_ready_app_id: null,
        sarvam_outbound_ready_version: null,
        sarvam_outbound_max_call_seconds: null,
      })
      .eq("id", agent.id)
      .eq("organization_id", organizationId)
      .eq("sarvam_outbound_ready_app_id", appId);
    if (error) throw error;
  }

  // A job that was waiting on the released report goes back to waiting for an agent.
  const next = run ? AFTER_RELEASE[run.current_step ?? ""] : undefined;
  let jobState = run?.current_step ?? null;
  if (
    run &&
    next &&
    !registeredAgent(agent, next.role) &&
    !(await reportedAgent(admin, organizationId, run.id, next.role))
  ) {
    const { data: moved, error } = await admin
      .from("provisioning_runs")
      .update({
        current_step: next.step,
        failure_code: null,
        note: `A wrongly reported agent id was released; waiting for the correct ${next.role} agent.`,
      })
      .eq("id", run.id)
      .eq("organization_id", organizationId)
      .eq("status", "waiting")
      .eq("current_step", run.current_step!)
      .select("id");
    if (error) throw error;
    if (moved?.length) jobState = next.step;
  }
  if (carried.data?.length) {
    const { error } = await admin
      .from("provisioning_runs")
      .update({ sarvam_agent_id: null })
      .eq("organization_id", organizationId)
      .eq("sarvam_agent_id", appId);
    if (error) throw error;
  }
  if (run) {
    const { error } = await admin.from("provisioning_run_events").insert({
      run_id: run.id,
      organization_id: organizationId,
      step: "creating_agent",
      event: "agent_id_released",
      detail: { appId, by: input.actor.userId },
    });
    if (error) console.error("agent_recovery:event_write_failed", error.message);
  }
  return {
    released: recordIds.length,
    tokensRevoked: revoked?.length ?? 0,
    jobState,
  };
}

export async function confirmOutboundToolCredentials(
  admin: Admin,
  input: {
    organizationId: string;
    appId: string;
    version: number;
    /** The agent_ref value the admin read on the tools in Sarvam. */
    agentRef: string;
    masterAgentAppIds: (string | null)[];
    actor: Actor;
    reason: string;
    /** Continues a job that is waiting on the outbound agent. */
    resume: () => Promise<unknown>;
    now?: Date;
  },
) {
  const appId = input.appId.trim();
  const reason = input.reason.trim();
  if (!reason) throw new Error("A reason is required");
  const agent = await agentOf(admin, input.organizationId);
  const registered = registeredAgent(agent, "outbound");
  if (!registered) throw new Error("Register this customer's outbound Sarvam agent first.");
  if (registered.appId !== appId || registered.version !== input.version)
    throw new Error(
      `The registered outbound agent is ${registered.appId} v${registered.version}. Register the version you checked first, then confirm it.`,
    );
  if (appId === agent.sarvam_app_id || input.masterAgentAppIds.includes(appId))
    throw new Error("The outbound agent must not be the inbound agent or a master template.");
  const expected = agentRef("outbound", agent.id);
  if (input.agentRef.trim() !== expected)
    throw new Error(
      `Every tool must send agent_ref = ${expected}. Add it in Sarvam, commit, register that version, then confirm it.`,
    );
  const now = input.now ?? new Date();
  const { data: credential, error } = await admin
    .from("sarvam_agent_integrations")
    .select("id, expires_at")
    .eq("agent_config_id", agent.id)
    .eq("role", "outbound")
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  if (!credential || (credential.expires_at && new Date(credential.expires_at) <= now))
    throw new Error("This customer has no live outbound credential. Generate one first.");
  await record(admin, {
    action: AGENT_AUDIT.adminConfirmed,
    organizationId: input.organizationId,
    agentConfigId: agent.id,
    actor: input.actor,
    reason,
    newValue: { app_id: appId, app_version: input.version, agent_ref: expected },
  });
  // Only a job that already reached the outbound stage is continued; no other job is run.
  const run = await openRun(admin, input.organizationId);
  let jobResumed = false;
  if (run?.status === "waiting" && run.current_step?.startsWith("waiting_for_outbound")) {
    jobResumed = await input.resume().then(
      () => true,
      (e) => {
        console.error("agent_recovery:resume_failed", (e as Error).message);
        return false;
      },
    );
  }
  return { confirmed: true as const, jobResumed };
}
