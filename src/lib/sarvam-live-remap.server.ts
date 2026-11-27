import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  deploymentVerificationChecks,
  isIdentityFailure,
  type DeploymentView,
  type VerificationCheck,
} from "./provisioning-pipeline.server.ts";
import { applySarvamAgentMapping } from "./sarvam-agent-registration.server.ts";
import { withDeploymentLock, type DeploymentLock } from "./sarvam-deployment-lock.server.ts";

/**
 * Re-verification for a customer whose Sarvam number is ALREADY LIVE
 * (Phase 5 fix). Changing a live customer's Sarvam agent version must not
 * cut their business data, and must never record an unverified mapping:
 *
 *   1. read the deployment and check it still matches the current mapping
 *      (deployment id, agent, number, ClickAI record);
 *   2. move the deployment to the new version of the SAME agent (documented
 *      PATCH app_version; paused/active state kept);
 *   3. read it back and verify deployment id, agent, NEW version, number,
 *      active status and webhook;
 *   4. only then save the new mapping AND the new verified fields.
 *
 * If step 2 or 3 fails, the Sarvam deployment is put back on the old
 * version and read back: when the old mapping is confirmed the existing
 * verification is kept (business data keeps flowing); when it cannot be
 * confirmed the verified fields are cleared (fail closed) and a person must
 * look. ClickAI's mapping only changes after step 3 passes. No onboarding,
 * voice settings or new-customer steps are required; nothing here creates,
 * pauses for longer than an edit, or activates anything.
 *
 * Calling it with the current agent and version is a plain re-verification
 * (no Sarvam write): it refreshes the verified fields on success.
 */

type Admin = SupabaseClient<Database>;

export interface LiveRemapDeps {
  getDeployment: (deploymentId: string) => Promise<DeploymentView>;
  /** Same agent, other committed version; keeps paused/active (setDeploymentAppVersion). */
  setDeploymentAppVersion: (deploymentId: string, appVersion: number) => Promise<void>;
  masterAgentAppId: string | null;
  now: () => Date;
}

export interface LiveNumber {
  id: string;
  e164: string;
  organizationId: string;
  deploymentId: string;
}

export type LiveRemapOutcome =
  /** Verified; mapping and verified fields saved. */
  | "verified"
  /** Failed; Sarvam is back on (or never left) the old version, confirmed; old verification kept. */
  | "rolled_back"
  /** Failed and the old mapping could not be confirmed: verified fields cleared, business data blocked. */
  | "blocked";

export interface LiveRemapResult {
  outcome: LiveRemapOutcome;
  detail: string;
  checks: VerificationCheck[];
}

export async function defaultLiveRemapDeps(): Promise<LiveRemapDeps> {
  const [telephony, sarvam, { setDeploymentAppVersion }, { masterAgentAppId }] = await Promise.all([
    import("./telephony.server.ts"),
    import("./telephony/sarvam-provider.server.ts"),
    import("./sarvam-inbound-deployment.server.ts"),
    import("./sarvam-agent-registration.server.ts"),
  ]);
  const adapter = () => {
    const a = telephony.getTelephonyAdapter("sarvam");
    if (!a || !(a instanceof sarvam.SarvamTelephonyAdapter))
      throw new Error("Sarvam is not connected.");
    return a;
  };
  return {
    getDeployment: async (id) => adapter().getDeployment(id),
    setDeploymentAppVersion: async (id, v) => setDeploymentAppVersion(adapter(), id, v),
    masterAgentAppId: masterAgentAppId(),
    now: () => new Date(),
  };
}

/**
 * The customer's one live Sarvam number for this agent, or null when the
 * customer is not live (not ACTIVE, inbound off, no deployment). Throws when
 * the customer has more than one Sarvam number: that needs a person.
 */
export async function findLiveNumber(
  admin: Admin,
  organizationId: string,
  agentConfigId: string,
): Promise<LiveNumber | null> {
  const { data, error } = await admin
    .from("phone_numbers")
    .select(
      "id, e164, status, provider, organization_id, agent_config_id, inbound_enabled, provider_deployment_id",
    )
    .eq("organization_id", organizationId)
    .eq("provider", "sarvam");
  if (error) throw error;
  const numbers = (data ?? []).filter(
    (n) => n.status !== "released" && n.organization_id === organizationId,
  );
  const live = numbers.filter(
    (n) =>
      n.status === "active" &&
      n.inbound_enabled &&
      n.provider_deployment_id &&
      n.agent_config_id === agentConfigId,
  );
  if (live.length === 0) return null;
  if (numbers.length > 1)
    throw new Error(
      "This live customer has more than one Sarvam number; ClickAI supports one per customer. Resolve the extra numbers by hand first.",
    );
  const n = live[0]!;
  return {
    id: n.id,
    e164: n.e164,
    organizationId,
    deploymentId: n.provider_deployment_id!,
  };
}

interface LiveRemapInput {
  organizationId: string;
  agentConfigId: string;
  number: LiveNumber;
  appId: string;
  appVersion: number;
}

export async function remapLiveAgent(
  admin: Admin,
  input: LiveRemapInput,
  deps: LiveRemapDeps,
): Promise<LiveRemapResult> {
  return withDeploymentLock(admin, [input.number.id], (lock) =>
    remapUnderLock(admin, input, deps, lock),
  );
}

async function remapUnderLock(
  admin: Admin,
  input: LiveRemapInput,
  deps: LiveRemapDeps,
  lock: DeploymentLock,
): Promise<LiveRemapResult> {
  const { number } = input;
  const appId = input.appId.trim();
  const { data: agent, error: agentError } = await admin
    .from("agent_configs")
    .select("id, organization_id, sarvam_app_id, sarvam_app_version")
    .eq("id", input.agentConfigId)
    .maybeSingle();
  if (agentError) throw agentError;
  if (!agent || agent.organization_id !== input.organizationId)
    throw new Error("That agent does not belong to this customer.");
  if (!agent.sarvam_app_id || !agent.sarvam_app_version)
    throw new Error("This live customer's agent has no Sarvam mapping to start from.");
  if (deps.masterAgentAppId && appId === deps.masterAgentAppId)
    throw new Error(
      "That is the universal master agent. Register the customer's own copy of it instead.",
    );
  // Sarvam cannot repoint a deployment to another agent (app_id is not updatable).
  if (appId !== agent.sarvam_app_id)
    throw new Error(
      `A live customer can only move to another version of its own Sarvam agent (${agent.sarvam_app_id}). A different agent needs a new deployment, set up by hand; nothing was changed.`,
    );
  const oldVersion = agent.sarvam_app_version;
  const newVersion = input.appVersion;

  const mapped = {
    provider_deployment_id: number.deploymentId,
    organization_id: number.organizationId,
  };
  const checksFor = (d: DeploymentView, version: number) =>
    deploymentVerificationChecks(
      d,
      {
        deploymentId: number.deploymentId,
        appId,
        appVersion: version,
        e164: number.e164,
        organizationId: input.organizationId,
        wantActive: true,
      },
      mapped,
    );
  const failed = (checks: VerificationCheck[]) =>
    checks
      .filter((c) => !c.ok)
      .map((c) => c.detail)
      .join("; ");

  const saveVerified = async (version: number) => {
    const { data, error } = await admin
      .from("phone_numbers")
      .update({
        verified_deployment_id: number.deploymentId,
        verified_sarvam_app_id: appId,
        verified_sarvam_app_version: version,
        deployment_verified_at: deps.now().toISOString(),
      })
      .eq("id", number.id)
      .eq("organization_id", input.organizationId)
      .eq("provider_deployment_id", number.deploymentId)
      .eq("status", "active")
      .select("id");
    if (error) throw error;
    if (!data?.length)
      throw new Error("The number changed while it was being verified; run it again.");
  };
  const clearVerified = async () => {
    const { error } = await admin
      .from("phone_numbers")
      .update({
        verified_deployment_id: null,
        verified_sarvam_app_id: null,
        verified_sarvam_app_version: null,
        deployment_verified_at: null,
      })
      .eq("id", number.id)
      .eq("organization_id", input.organizationId);
    if (error) throw error;
  };
  const read = async (): Promise<DeploymentView | null> => {
    try {
      return await deps.getDeployment(number.deploymentId);
    } catch {
      return null;
    }
  };

  // 1. Before changing anything, the deployment must match the current mapping.
  const before = await read();
  if (!before)
    throw new Error(
      `Could not read deployment ${number.deploymentId} from Sarvam; nothing was changed and the existing verification is kept.`,
    );
  const beforeChecks = checksFor(before, oldVersion);
  /** ClickAI's mapping, saved only once Sarvam is confirmed on the version. */
  const saveMapping = () =>
    applySarvamAgentMapping(admin, {
      agentConfigId: input.agentConfigId,
      organizationId: input.organizationId,
      sarvamAppId: appId,
      sarvamAppVersion: newVersion,
      masterAgentAppId: deps.masterAgentAppId,
      verifiedWithSarvam: true,
    });
  // An earlier attempt may have moved Sarvam and stopped before saving: finish it.
  const alreadyMoved = checksFor(before, newVersion);
  if (newVersion !== oldVersion && alreadyMoved.every((c) => c.ok)) {
    await saveMapping();
    await saveVerified(newVersion);
    return {
      outcome: "verified",
      detail: `${number.e164} already runs ${appId} v${newVersion}, verified with Sarvam.`,
      checks: alreadyMoved,
    };
  }
  if (isIdentityFailure(beforeChecks)) {
    // The saved verification no longer describes reality: never keep it.
    await clearVerified();
    return {
      outcome: "blocked",
      detail: `Deployment ${number.deploymentId} no longer matches this customer's mapping (${failed(beforeChecks)}). Business data is blocked until it is fixed by hand and re-verified.`,
      checks: beforeChecks,
    };
  }

  // Not active, or no result webhook: change nothing until a person looks.
  if (beforeChecks.some((c) => !c.ok))
    return {
      outcome: "rolled_back",
      detail: `Not verified: ${failed(beforeChecks)}. Nothing was changed; the existing verification is kept.`,
      checks: beforeChecks,
    };

  // Plain re-verification (same version): refresh on success, never write Sarvam.
  if (newVersion === oldVersion) {
    await saveVerified(oldVersion);
    return {
      outcome: "verified",
      detail: `${number.e164} re-verified on ${appId} v${oldVersion}.`,
      checks: beforeChecks,
    };
  }

  // 2 + 3. Move Sarvam to the new version, read back and verify.
  let changeError: string | null = null;
  try {
    await lock.confirm();
    await deps.setDeploymentAppVersion(number.deploymentId, newVersion);
  } catch (err) {
    changeError = (err as Error).message;
  }
  const after = await read();
  const afterChecks = after ? checksFor(after, newVersion) : [];
  if (after && afterChecks.every((c) => c.ok)) {
    // 4. Only now: ClickAI's mapping and the verified fields.
    await saveMapping();
    await saveVerified(newVersion);
    return {
      outcome: "verified",
      detail: `${number.e164} now runs ${appId} v${newVersion}, verified with Sarvam.`,
      checks: afterChecks,
    };
  }
  const why =
    changeError ?? (after ? failed(afterChecks) : "the deployment could not be read back");

  // Roll back: put Sarvam back on the old version unless it never left it.
  if (!after || after.appVersion !== oldVersion) {
    try {
      await lock.confirm();
      await deps.setDeploymentAppVersion(number.deploymentId, oldVersion);
    } catch {
      // Confirmed (or not) by the read below.
    }
  }
  const back = await read();
  const backChecks = back ? checksFor(back, oldVersion) : [];
  if (back && backChecks.every((c) => c.ok)) {
    await saveVerified(oldVersion);
    return {
      outcome: "rolled_back",
      detail: `Moving to v${newVersion} was not verified (${why}). Sarvam is confirmed back on v${oldVersion}; the mapping and existing verification are kept.`,
      checks: afterChecks,
    };
  }
  await clearVerified();
  return {
    outcome: "blocked",
    detail: `Moving to v${newVersion} was not verified (${why}) and the old v${oldVersion} could not be confirmed${back ? ` (${failed(backChecks)})` : " (Sarvam could not be read)"}. Business data is blocked until a person checks the deployment and re-verifies.`,
    checks: backChecks,
  };
}
