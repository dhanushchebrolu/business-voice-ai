import type { SupabaseClient } from "@supabase/supabase-js";
import {
  acquireDeploymentLock,
  withDeploymentLock,
  type DeploymentLock,
} from "./sarvam-deployment-lock.server.ts";
import {
  recoveryMarkerOf,
  saveRecoveryMarker,
  type RecoveryMarker,
} from "./sarvam-webhook-rotation.server.ts";
import type { Database } from "@/integrations/supabase/types";
import { getTelephonyAdapter, sarvamOutboundWebhookUrl } from "./telephony.server.ts";
import { SarvamTelephonyAdapter } from "./telephony/sarvam-provider.server.ts";
import { normalizeCustomerPhone } from "./phone-number.ts";

export interface CreateInboundDeploymentForNumbersResult {
  deploymentId: string;
  organizationId: string;
  /**
   * created: a new Sarvam deployment. adopted: Sarvam already had one for
   * these numbers and this agent (e.g. a create whose response was lost), so
   * it was recorded instead of creating a duplicate. already_recorded: Klyro
   * already had it on file; nothing was sent to Sarvam.
   */
  outcome?: "created" | "adopted" | "already_recorded";
}

const canonical = (n: string) => normalizeCustomerPhone(n, null) ?? n;

/**
 * Core validation + Sarvam call for creating an inbound deployment across
 * one or more Klyro phone numbers. Extracted from
 * sarvam-admin.functions.ts's createSarvamInboundDeployment (which still
 * does its own assertPlatformAdmin gate and audit write, then delegates
 * here) so the automatic provisioning orchestrator can call exactly the
 * same validated logic the admin UI already used, instead of a second
 * reimplementation. This is the one place that logic exists.
 *
 * Callers own authorization: this function performs no auth check itself.
 * The admin server function gates on assertPlatformAdmin("numbers.write")
 * before calling it; the automatic orchestrator runs with service-role
 * trust from inside the Razorpay webhook, which has no end-user session to
 * gate on.
 *
 * Does not fake success: no provider_deployment_id write happens unless
 * Sarvam's own createInboundDeployment call actually succeeds (see
 * SarvamTelephonyAdapter.createInboundDeployment's doc for that call's
 * verification status).
 */
export async function createInboundDeploymentForNumbers(
  supabaseAdmin: SupabaseClient<Database>,
  params: { phoneNumberIds: string[]; name: string },
): Promise<CreateInboundDeploymentForNumbersResult> {
  // Every creator (admin action, test action, provisioning job) comes through here, and
  // everything is read again once the lock is held.
  return withDeploymentLock(supabaseAdmin, params.phoneNumberIds, (lock) =>
    createUnderLock(supabaseAdmin, params, lock),
  );
}

/**
 * Records a deployment on numbers that still have none AND still belong to the customer it was
 * made for: the write itself carries both conditions, so a reassignment made while Sarvam was
 * answering, or a creator that lost its lock, records nothing.
 */
async function recordDeployment(
  supabaseAdmin: SupabaseClient<Database>,
  organizationId: string,
  phoneNumberIds: string[],
  deploymentId: string,
) {
  const { data, error } = await supabaseAdmin
    .from("phone_numbers")
    .update({ provider_deployment_id: deploymentId })
    .in("id", phoneNumberIds)
    .eq("organization_id", organizationId)
    .is("provider_deployment_id", null)
    .select("id");
  if (error) throw error;
  if (data?.length !== phoneNumberIds.length)
    throw new Error(
      `The number was reassigned or another change recorded a deployment for it first, so Sarvam deployment ${deploymentId} was not recorded for it: check it in the Sarvam console.`,
    );
}

async function createUnderLock(
  supabaseAdmin: SupabaseClient<Database>,
  params: { phoneNumberIds: string[]; name: string },
  lock: DeploymentLock,
): Promise<CreateInboundDeploymentForNumbersResult> {
  const { phoneNumberIds, name } = params;

  const { data: numbers, error: numbersError } = await supabaseAdmin
    .from("phone_numbers")
    .select(
      "id, e164, status, inbound_enabled, organization_id, connection_id, agent_config_id, provider_deployment_id",
    )
    .in("id", phoneNumberIds);
  if (numbersError) throw numbersError;
  if (!numbers || numbers.length !== phoneNumberIds.length)
    throw new Error("One or more phone numbers were not found.");

  // A new Sarvam deployment answers calls at once, so a number a person switched off is refused.
  const off = numbers.find(
    (n) =>
      n.status === "suspended" ||
      n.status === "released" ||
      (n.status === "active" && !n.inbound_enabled),
  );
  if (off)
    throw new Error(
      `${off.e164} is ${off.status === "active" ? "switched off for inbound calls" : off.status}; no deployment was created or changed.`,
    );

  // A single deployment binds one connection + one app to a set of
  // numbers — every number in the request must share both, and (as a
  // direct consequence) the same organization. Rejecting a mixed set here
  // is what makes "cross-tenant mapping" structurally impossible: there is
  // no way to smuggle a number from a different organization into a
  // deployment for this one.
  const orgIds = new Set(numbers.map((n) => n.organization_id));
  if (orgIds.size > 1)
    throw new Error("All phone numbers in one deployment must belong to the same organization.");
  const connectionIds = new Set(numbers.map((n) => n.connection_id));
  if (connectionIds.size > 1 || numbers.some((n) => !n.connection_id))
    throw new Error(
      "All phone numbers in one deployment must share the same telephony connection.",
    );
  const agentConfigIds = new Set(numbers.map((n) => n.agent_config_id));
  if (agentConfigIds.size > 1 || numbers.some((n) => !n.agent_config_id))
    throw new Error("All phone numbers in one deployment must share the same agent.");

  const organizationId = numbers[0]!.organization_id;
  if (!organizationId) throw new Error("These phone numbers have no organization assigned yet.");

  // Never a second deployment for a number Klyro already has one on file for.
  const recorded = new Set(numbers.map((n) => n.provider_deployment_id ?? null));
  if (!recorded.has(null)) {
    if (recorded.size === 1)
      return {
        deploymentId: numbers[0]!.provider_deployment_id!,
        organizationId,
        outcome: "already_recorded",
      };
    throw new Error("These numbers are already in different Sarvam deployments.");
  }
  if (recorded.size > 1)
    throw new Error(
      "Some of these numbers already have a Sarvam deployment. Deploy the remaining numbers separately.",
    );
  const connectionId = numbers[0]!.connection_id!;
  const agentConfigId = numbers[0]!.agent_config_id!;

  const { data: connection } = await supabaseAdmin
    .from("telephony_connections")
    .select("id, organization_id, provider, provider_connection_id")
    .eq("id", connectionId)
    .maybeSingle();
  if (!connection) throw new Error("Telephony connection not found.");
  if (connection.organization_id !== organizationId)
    throw new Error(
      "The connection's organization does not match the phone numbers' organization.",
    );
  if (connection.provider !== "sarvam")
    throw new Error("This deployment flow only applies to sarvam connections.");
  if (!connection.provider_connection_id)
    throw new Error(
      "This connection has not been registered with Sarvam yet — call registerTelephonyConnection first.",
    );

  const { data: agentConfig } = await supabaseAdmin
    .from("agent_configs")
    .select("id, organization_id, sarvam_app_id, sarvam_app_version")
    .eq("id", agentConfigId)
    .maybeSingle();
  if (!agentConfig) throw new Error("Agent not found.");
  if (agentConfig.organization_id !== organizationId)
    throw new Error("The agent's organization does not match the phone numbers' organization.");
  if (!agentConfig.sarvam_app_id || !agentConfig.sarvam_app_version)
    throw new Error(
      "This agent has not been mapped to a Sarvam app yet — call setSarvamAppMapping first.",
    );

  const adapter = getTelephonyAdapter("sarvam");
  if (!adapter) throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");
  if (!(adapter instanceof SarvamTelephonyAdapter))
    throw new Error("Unexpected adapter type for provider 'sarvam'.");

  // Real HTTP request against Sarvam's documented deployment-creation
  // endpoint — see SarvamTelephonyAdapter.createInboundDeployment's doc
  // comment for its verification status. No provider_deployment_id write
  // happens unless it genuinely succeeds.
  // Each inbound call's result must reach Klyro (call log, billing), so a
  // deployment is never created without the authenticated result webhook.
  const webhook = sarvamOutboundWebhookUrl();
  if (!webhook.ok)
    throw new Error(
      "The Sarvam result webhook is not configured (TELEPHONY_WEBHOOK_BASE_URL and SARVAM_WEBHOOK_SECRET); inbound call results would never reach ClickAI.",
    );

  // A deployment Sarvam already has for these numbers (for example one whose
  // create response was lost) is adopted, never duplicated; one serving a
  // different agent is a conflict for an operator to resolve in Sarvam.
  const wanted = new Set(numbers.map((n) => canonical(n.e164)));
  const existing = (await adapter.listDeployments(numbers[0]!.e164)).filter((d) =>
    d.phoneNumbers.some((p) => wanted.has(canonical(p))),
  );
  if (existing.length > 0) {
    // Adopted only when there is exactly one, running this agent on exactly these numbers:
    // never a pick among several, never one that also answers someone else's number.
    const [match] = existing;
    if (
      existing.length > 1 ||
      match!.appId !== agentConfig.sarvam_app_id ||
      !sameNumbers(match!.phoneNumbers, [...wanted])
    )
      throw new Error(
        `Sarvam already routes ${numbers[0]!.e164} through ${existing.map((d) => `deployment ${d.deploymentId} (agent ${d.appId})`).join(" and ")}. Resolve that in Sarvam first; no duplicate was created.`,
      );
    await lock.confirm();
    await recordDeployment(supabaseAdmin, organizationId, phoneNumberIds, match!.deploymentId);
    return { deploymentId: match!.deploymentId, organizationId, outcome: "adopted" };
  }

  await lock.confirm();
  const created = await adapter.createInboundDeployment({
    name,
    appId: agentConfig.sarvam_app_id,
    appVersion: agentConfig.sarvam_app_version,
    connectionId: connection.provider_connection_id,
    phoneNumbers: numbers.map((n) => n.e164),
    webhookConfig: { url: webhook.url, metadata: { organization_id: organizationId } },
  });

  await recordDeployment(supabaseAdmin, organizationId, phoneNumberIds, created.deploymentId);

  return { deploymentId: created.deploymentId, organizationId, outcome: "created" };
}

/**
 * Moves one deployment to another committed version of the SAME agent
 * (documented PATCH app_version), keeping its paused/active state: an
 * active deployment is paused for the edit (Sarvam edits only paused ones)
 * and always resumed afterwards; a paused one is edited and left paused.
 */
const sameNumbers = (a: string[], b: string[]) => {
  const set = new Set(a.map(canonical));
  return set.size === new Set(b.map(canonical)).size && b.every((n) => set.has(canonical(n)));
};

/**
 * The admin "Pause" and "Resume" actions: only a deployment recorded on this customer's own
 * numbers (never a raw id), and never in the middle of another change to it.
 */
export async function setCustomerDeploymentStatus(
  supabaseAdmin: SupabaseClient<Database>,
  params: { organizationId: string; deploymentId: string; action: "pause" | "resume" },
) {
  const { data: numbers, error } = await supabaseAdmin
    .from("phone_numbers")
    .select("id, organization_id, provider")
    .eq("organization_id", params.organizationId)
    .eq("provider_deployment_id", params.deploymentId);
  if (error) throw error;
  const own = (numbers ?? []).filter(
    (n) => n.organization_id === params.organizationId && n.provider === "sarvam",
  );
  if (!own.length) throw new Error("That deployment does not belong to this customer.");
  const adapter = getTelephonyAdapter("sarvam");
  if (!adapter || !(adapter instanceof SarvamTelephonyAdapter))
    throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");
  const ids = own.map((n) => n.id);
  return withDeploymentLock(supabaseAdmin, ids, async () => {
    const after = await adapter.setDeploymentStatus(params.deploymentId, params.action);
    // A person's pause, or their resume that Sarvam confirms, settles any recovery owed.
    if (params.action === "pause" || after.status === "active") {
      if (!(await saveRecoveryMarker(supabaseAdmin, ids, params.deploymentId, null)))
        console.error("sarvam_deployment:recovery_clear_failed", params.deploymentId);
    }
    return after;
  });
}

export async function setDeploymentAppVersion(
  adapter: Pick<
    SarvamTelephonyAdapter,
    "getDeployment" | "setDeploymentStatus" | "updateInboundDeployment"
  >,
  deploymentId: string,
  appVersion: number,
): Promise<void> {
  const current = await adapter.getDeployment(deploymentId);
  const wasActive = current.status === "active";
  if (wasActive) await adapter.setDeploymentStatus(deploymentId, "pause");
  try {
    await adapter.updateInboundDeployment(deploymentId, { appVersion });
  } finally {
    if (wasActive) await adapter.setDeploymentStatus(deploymentId, "resume");
  }
}

export interface DeploymentSyncItem {
  deploymentId: string;
  /** updated: version and/or webhook patched. in_sync: nothing to do. app_mismatch: needs a new deployment. */
  action: "updated" | "in_sync" | "app_mismatch" | "error";
  fromVersion: number | null;
  toVersion: number | null;
  webhookAdded: boolean;
  detail?: string;
}

/**
 * Brings every Sarvam deployment of an agent's numbers in line with the
 * agent's current mapping, through documented PATCH fields only: a newly
 * committed version of the same app (app_version), and the result webhook
 * when it is missing. A deployment on a different app cannot be repointed
 * (app_id is not updatable) and is reported, never replaced automatically.
 * A number that has gone live (or is suspended) is only brought back to the version it was
 * verified on; moving it needs the verify-first registration. A released number's deployment
 * is never touched. Each deployment is changed under its numbers' lock; `held` is the
 * provisioning job's own lock.
 * A recovery marker is on record before an active deployment is paused and cleared only once
 * Sarvam confirms it active again. While one is outstanding, or a live number's deployment is
 * not active, the result is never in_sync or updated.
 * Idempotent: a deployment already in line is not touched.
 */
export async function syncAgentDeployments(
  supabaseAdmin: SupabaseClient<Database>,
  agentConfigId: string,
  held?: DeploymentLock,
): Promise<{ items: DeploymentSyncItem[] }> {
  const { data: agent } = await supabaseAdmin
    .from("agent_configs")
    .select("id, organization_id, sarvam_app_id, sarvam_app_version")
    .eq("id", agentConfigId)
    .maybeSingle();
  if (!agent) throw new Error("Agent not found.");
  const { data: linked } = await supabaseAdmin
    .from("phone_numbers")
    .select("id, e164, status, organization_id, provider, provider_deployment_id")
    .eq("agent_config_id", agentConfigId);
  // A released number is gone: neither it nor its deployment is this sync's to change.
  const numbers = (linked ?? []).filter(
    (n) => n.status !== "released" && n.organization_id === agent.organization_id,
  );
  const deploymentIds = [
    ...new Set(
      numbers
        .filter((n) => n.provider === "sarvam" && n.provider_deployment_id)
        .map((n) => n.provider_deployment_id as string),
    ),
  ];
  if (deploymentIds.length === 0) return { items: [] };
  if (!agent.sarvam_app_id || !agent.sarvam_app_version)
    throw new Error("This agent is not mapped to a Sarvam app version.");

  const adapter = getTelephonyAdapter("sarvam");
  if (!adapter || !(adapter instanceof SarvamTelephonyAdapter))
    throw new Error("Sarvam is not connected. Configure SARVAM_API_KEY first.");
  const webhook = sarvamOutboundWebhookUrl();

  const items: DeploymentSyncItem[] = [];
  for (const deploymentId of deploymentIds) {
    const routed = numbers.filter((n) => n.provider_deployment_id === deploymentId);
    const refuse = (detail: string, fromVersion: number | null = null) =>
      items.push({
        deploymentId,
        action: "error",
        fromVersion,
        toVersion: null,
        webhookAdded: false,
        detail,
      });
    let lock = held;
    try {
      lock ??= await acquireDeploymentLock(
        supabaseAdmin,
        routed.map((n) => n.id),
      );
      const current = await adapter.getDeployment(deploymentId);
      if (current.appId !== agent.sarvam_app_id) {
        items.push({
          deploymentId,
          action: "app_mismatch",
          fromVersion: current.appVersion,
          toVersion: null,
          webhookAdded: false,
          detail: `Deployment runs agent ${current.appId}; the mapped agent is ${agent.sarvam_app_id}. Create a deployment for the new agent and remove this one in Sarvam.`,
        });
        continue;
      }
      if (
        routed.some(
          (n) => n.e164 && !current.phoneNumbers.map(canonical).includes(canonical(n.e164)),
        )
      ) {
        refuse(
          `Deployment ${deploymentId} does not route this customer's number; nothing was changed.`,
          current.appVersion,
        );
        continue;
      }
      // Read again under the lock, after Sarvam answered: a number released meanwhile is left
      // alone.
      const { data: fresh, error: freshError } = await supabaseAdmin
        .from("phone_numbers")
        .select(
          "id, status, organization_id, inbound_enabled, provider_deployment_id, verified_sarvam_app_id, verified_sarvam_app_version, metadata",
        )
        .in(
          "id",
          routed.map((n) => n.id),
        );
      if (freshError) throw freshError;
      const rows = (fresh ?? []).filter(
        (n) =>
          n.status !== "released" &&
          n.organization_id === agent.organization_id &&
          n.provider_deployment_id === deploymentId,
      );
      if (!rows.length) {
        refuse(
          "The number changed while Sarvam was being read; nothing was changed.",
          current.appVersion,
        );
        continue;
      }
      const ids = rows.map((n) => n.id);
      const live = rows.some((n) => n.status === "active" && n.inbound_enabled);
      const notAnswering = `The number is live but deployment ${deploymentId} is ${current.status ?? "in an unknown state"}: calls are not answered. Resume it.`;
      if (rows.some((n) => recoveryMarkerOf(n.metadata)?.deploymentId === deploymentId)) {
        // The provisioning job (held lock) takes over the pause of a number not yet live: it
        // resumes it itself when it activates. Anything else waits until it is confirmed back.
        const takenOver = held && rows.every((n) => n.status === "provisioning");
        if (current.status !== "active" && !takenOver) {
          refuse(
            `An earlier change paused deployment ${deploymentId} and it is not confirmed back: run "Resume deployment" (or "Re-verify live deployment" if a version move was interrupted). Nothing was changed.`,
            current.appVersion,
          );
          continue;
        }
        if (!(await saveRecoveryMarker(supabaseAdmin, ids, deploymentId, null))) {
          refuse("Could not clear the recovery record; nothing was changed.", current.appVersion);
          continue;
        }
      }
      const needsVersion = current.appVersion !== agent.sarvam_app_version;
      const needsWebhook = !current.webhookUrlConfigured && webhook.ok;
      if (!needsVersion && !needsWebhook) {
        if (live && current.status !== "active") {
          refuse(notAnswering, current.appVersion);
          continue;
        }
        items.push({
          deploymentId,
          action: "in_sync",
          fromVersion: current.appVersion,
          toVersion: current.appVersion,
          webhookAdded: false,
        });
        continue;
      }
      const unverified = rows.some(
        (n) =>
          (n.status === "active" || n.status === "suspended") &&
          (n.verified_sarvam_app_id !== agent.sarvam_app_id ||
            n.verified_sarvam_app_version !== agent.sarvam_app_version),
      );
      if (needsVersion && unverified) {
        refuse(
          `This number is live or suspended and v${agent.sarvam_app_version} is not verified on it. Register the version (or "Re-verify live deployment") with the number on; nothing was changed.`,
          current.appVersion,
        );
        continue;
      }
      // Sarvam edits only paused deployments (422 "Only paused deployments can be edited"):
      // pause, edit, and always resume one we paused, so a failed edit never leaves calls unanswered.
      const wasActive = current.status === "active";
      await lock.confirm();
      const owe = (state: RecoveryMarker["state"]) =>
        saveRecoveryMarker(supabaseAdmin, ids, deploymentId, {
          deploymentId,
          originalStatus: "active",
          appId: current.appId,
          appVersion: current.appVersion,
          alsoVersion: agent.sarvam_app_version!,
          state,
          recordedAt: new Date().toISOString(),
        });
      // On record before the pause: no record, no pause.
      if (wasActive && !(await owe("in_progress"))) {
        refuse(
          "Could not record the recovery marker, so the deployment was not paused; nothing was changed.",
          current.appVersion,
        );
        continue;
      }
      let failure: Error | null = null;
      try {
        if (wasActive) await adapter.setDeploymentStatus(deploymentId, "pause");
        try {
          await lock.confirm();
          await adapter.updateInboundDeployment(deploymentId, {
            ...(needsVersion ? { appVersion: agent.sarvam_app_version } : {}),
            ...(needsWebhook && webhook.ok
              ? {
                  webhookConfig: {
                    url: webhook.url,
                    metadata: { organization_id: agent.organization_id },
                  },
                }
              : {}),
          });
        } finally {
          if (wasActive) await adapter.setDeploymentStatus(deploymentId, "resume");
        }
      } catch (err) {
        failure = err as Error;
      }
      if (wasActive) {
        // Whatever the calls said, only Sarvam's own answer settles the record.
        const back = await adapter.getDeployment(deploymentId).catch(() => null);
        if (back?.status !== "active") {
          await owe("recovery_required");
          refuse(
            `Deployment ${deploymentId} was paused for the edit and is not confirmed active again, so calls may not be answered: run "Resume deployment".${failure ? ` (${failure.message})` : ""}`,
            current.appVersion,
          );
          continue;
        }
        if (!(await saveRecoveryMarker(supabaseAdmin, ids, deploymentId, null)))
          console.error("sarvam_deployment:recovery_clear_failed", deploymentId);
      }
      if (failure) throw failure;
      if (live && !wasActive) {
        refuse(`The deployment was edited and left paused. ${notAnswering}`, current.appVersion);
        continue;
      }
      items.push({
        deploymentId,
        action: "updated",
        fromVersion: current.appVersion,
        toVersion: agent.sarvam_app_version,
        webhookAdded: needsWebhook,
      });
    } catch (err) {
      items.push({
        deploymentId,
        action: "error",
        fromVersion: null,
        toVersion: null,
        webhookAdded: false,
        detail: (err as Error).message,
      });
    } finally {
      if (lock && lock !== held) await lock.release();
    }
  }
  return { items };
}
