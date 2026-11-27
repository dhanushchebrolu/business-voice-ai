import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  return withDeploymentLock(supabaseAdmin, params.phoneNumberIds, () =>
    createUnderLock(supabaseAdmin, params),
  );
}

const DEPLOYMENT_BUSY_MESSAGE =
  "A deployment for this number is already being created. Try again in a few minutes.";
/** Far longer than a creation's two provider calls, so only a crashed holder's lock lapses. */
const DEPLOYMENT_LOCK_MS = 5 * 60_000;

interface DeploymentLock {
  token: string;
  until: string;
}

/**
 * Takes (until) or releases (null) one number's lock, kept in phone_numbers.metadata and
 * written only if the row is unchanged since it was read. false: someone else holds it.
 */
async function writeLock(
  admin: SupabaseClient<Database>,
  numberId: string,
  token: string,
  until: string | null,
): Promise<boolean> {
  const { data: row, error } = await admin
    .from("phone_numbers")
    .select("metadata, updated_at")
    .eq("id", numberId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return true; // no such number: the creation itself reports that
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata
      : {};
  const { deployment_lock, ...rest } = metadata;
  const held = deployment_lock as unknown as DeploymentLock | undefined;
  if (held?.token !== token) {
    if (until === null) return true; // lapsed and taken over: not ours to release
    if (held && Date.parse(held.until) > Date.now()) return false;
  }
  const { data, error: writeError } = await admin
    .from("phone_numbers")
    .update({ metadata: until ? { ...rest, deployment_lock: { token, until } } : rest })
    .eq("id", numberId)
    .eq("updated_at", row.updated_at)
    .select("id");
  if (writeError) throw writeError;
  return Boolean(data?.length);
}

async function withDeploymentLock<T>(
  admin: SupabaseClient<Database>,
  numberIds: string[],
  work: () => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  const held: string[] = [];
  try {
    // Sorted, so two callers naming the same numbers cannot each hold half.
    for (const id of [...new Set(numberIds)].sort()) {
      const until = new Date(Date.now() + DEPLOYMENT_LOCK_MS).toISOString();
      if (!(await writeLock(admin, id, token, until))) throw new Error(DEPLOYMENT_BUSY_MESSAGE);
      held.push(id);
    }
    return await work();
  } finally {
    for (const id of held) {
      let released = false;
      for (let attempt = 0; attempt < 3 && !released; attempt++)
        released = await writeLock(admin, id, token, null).catch(() => false);
      if (!released) console.error("sarvam_deployment:lock_release_failed", id);
    }
  }
}

async function createUnderLock(
  supabaseAdmin: SupabaseClient<Database>,
  params: { phoneNumberIds: string[]; name: string },
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
    const match = existing.find(
      (d) =>
        d.appId === agentConfig.sarvam_app_id &&
        [...wanted].every((w) => d.phoneNumbers.some((p) => canonical(p) === w)),
    );
    if (!match)
      throw new Error(
        `Sarvam already routes ${numbers[0]!.e164} through deployment ${existing[0]!.deploymentId} (agent ${existing[0]!.appId}). Resolve that deployment in Sarvam first; no duplicate was created.`,
      );
    const { error: adoptError } = await supabaseAdmin
      .from("phone_numbers")
      .update({ provider_deployment_id: match.deploymentId })
      .in("id", phoneNumberIds);
    if (adoptError) throw adoptError;
    return { deploymentId: match.deploymentId, organizationId, outcome: "adopted" };
  }

  const created = await adapter.createInboundDeployment({
    name,
    appId: agentConfig.sarvam_app_id,
    appVersion: agentConfig.sarvam_app_version,
    connectionId: connection.provider_connection_id,
    phoneNumbers: numbers.map((n) => n.e164),
    webhookConfig: { url: webhook.url, metadata: { organization_id: organizationId } },
  });

  const { error: updateError } = await supabaseAdmin
    .from("phone_numbers")
    .update({ provider_deployment_id: created.deploymentId })
    .in("id", phoneNumberIds);
  if (updateError) throw updateError;

  return { deploymentId: created.deploymentId, organizationId, outcome: "created" };
}

/**
 * Moves one deployment to another committed version of the SAME agent
 * (documented PATCH app_version), keeping its paused/active state: an
 * active deployment is paused for the edit (Sarvam edits only paused ones)
 * and always resumed afterwards; a paused one is edited and left paused.
 */
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
 * Idempotent: a deployment already in line is not touched.
 */
export async function syncAgentDeployments(
  supabaseAdmin: SupabaseClient<Database>,
  agentConfigId: string,
): Promise<{ items: DeploymentSyncItem[] }> {
  const { data: agent } = await supabaseAdmin
    .from("agent_configs")
    .select("id, organization_id, sarvam_app_id, sarvam_app_version")
    .eq("id", agentConfigId)
    .maybeSingle();
  if (!agent) throw new Error("Agent not found.");
  const { data: numbers } = await supabaseAdmin
    .from("phone_numbers")
    .select("organization_id, provider, provider_deployment_id")
    .eq("agent_config_id", agentConfigId);
  const deploymentIds = [
    ...new Set(
      (numbers ?? [])
        .filter(
          (n) =>
            n.provider === "sarvam" &&
            n.provider_deployment_id &&
            n.organization_id === agent.organization_id,
        )
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
    try {
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
      const needsVersion = current.appVersion !== agent.sarvam_app_version;
      const needsWebhook = !current.webhookUrlConfigured && webhook.ok;
      if (!needsVersion && !needsWebhook) {
        items.push({
          deploymentId,
          action: "in_sync",
          fromVersion: current.appVersion,
          toVersion: current.appVersion,
          webhookAdded: false,
        });
        continue;
      }
      // Sarvam edits only paused deployments (422 "Only paused deployments can be edited"):
      // pause, edit, and always resume one we paused, so a failed edit never leaves calls unanswered.
      const wasActive = current.status === "active";
      if (wasActive) await adapter.setDeploymentStatus(deploymentId, "pause");
      try {
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
    }
  }
  return { items };
}
