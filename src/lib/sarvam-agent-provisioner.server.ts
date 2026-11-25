import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { UniversalAgentConfig } from "./universal-agent-config.ts";
import type { FailureCode, JobStepKey } from "./voice-provisioning-job.ts";

/**
 * Creating and configuring a customer's Sarvam agent, behind an interface.
 *
 * Sarvam documents NO public API to create, clone, configure or commit an
 * agent (checked 2026-11-19 against docs.sarvam.ai; agents are authored in
 * the Sarvam console). So the only implementation shipped is
 * `unsupportedAgentProvisioner`: the job stops at "creating_agent" in a
 * waiting state and an admin registers the agent by hand (existing flow).
 * The moment Sarvam documents such an API, implement `AgentProvisioner`
 * against it and return it from `defaultAgentProvisioner()`; every other
 * guarantee (look up before create, ambiguous timeouts, verify before
 * mapping, master-template protection) already lives in `ensureCustomerAgent`
 * and is tested against mocks. Nothing here is verified against live Sarvam.
 */

type Admin = SupabaseClient<Database>;

export interface ProviderError extends Error {
  /** HTTP status when the provider answered. */
  status?: number;
  /** true when the provider may have acted but the answer was lost (timeout, dropped connection). */
  outcomeUnknown?: boolean;
}

export interface FoundAgent {
  appId: string;
  /** Latest committed version, null when none is committed yet. */
  version: number | null;
}

export interface AgentProvisioner {
  /** false: the provider has no verified create API; the job waits for a person. */
  readonly supported: boolean;
  /** Finds this customer's agent by its deterministic name (never creates). */
  findAgentByName(name: string): Promise<FoundAgent | null>;
  /** Creates the agent from the master template. The name is the idempotency key. */
  createAgent(input: { name: string; templateAppId: string | null }): Promise<{ appId: string }>;
  /**
   * Applies instructions, tools, capabilities, voice and language and commits a version.
   * Must be a no-op returning the existing version when it already carries `config.fingerprint`.
   */
  configureAgent(input: {
    appId: string;
    config: UniversalAgentConfig;
  }): Promise<{ version: number }>;
  /** Reads the agent back and compares it with the generated config. */
  verifyAgent(input: {
    appId: string;
    version: number;
    config: UniversalAgentConfig;
  }): Promise<{ ok: boolean; detail: string }>;
}

export const unsupportedAgentProvisioner: AgentProvisioner = {
  supported: false,
  findAgentByName: async () => null,
  createAgent: async () => {
    throw new Error("Sarvam has no documented agent-creation API.");
  },
  configureAgent: async () => {
    throw new Error("Sarvam has no documented agent-configuration API.");
  },
  verifyAgent: async () => ({ ok: false, detail: "no agent API" }),
};

/** The provisioner the job uses. Swap here once Sarvam documents agent authoring. */
export function defaultAgentProvisioner(): AgentProvisioner {
  return unsupportedAgentProvisioner;
}

/** Deterministic, per-customer: the same customer always resolves to the same agent name. */
export function customerAgentName(organizationId: string, agentConfigId: string): string {
  return `clickai-${organizationId.slice(0, 8)}-${agentConfigId.slice(0, 8)}`;
}

export interface EnsureAgentContext {
  organizationId: string;
  agentConfigId: string;
  config: UniversalAgentConfig;
  masterAgentAppId: string | null;
  outboundMasterAgentAppId: string | null;
  /** Called as the work moves between agent steps (real progress). */
  onStep?: ((key: JobStepKey) => Promise<void> | void) | undefined;
}

export type EnsureAgentOutcome =
  | { kind: "unsupported" }
  | { kind: "ready"; appId: string; version: number; createdNow: boolean }
  | { kind: "retry" | "failed"; code: FailureCode; message: string };

const isTransient = (e: ProviderError) =>
  e.outcomeUnknown === true ||
  e.status === undefined ||
  e.status === 429 ||
  e.status >= 500 ||
  e.status === 408;

/**
 * Find-then-create-then-configure-then-verify-then-register. Never throws for
 * provider problems. A lost answer (timeout) is never answered by creating
 * again: the agent is looked up by name first, on every attempt.
 */
export async function ensureCustomerAgent(
  admin: Admin,
  ctx: EnsureAgentContext,
  provisioner: AgentProvisioner,
): Promise<EnsureAgentOutcome> {
  if (!provisioner.supported) return { kind: "unsupported" };
  const name = customerAgentName(ctx.organizationId, ctx.agentConfigId);
  const fail = (e: unknown, code: FailureCode, what: string): EnsureAgentOutcome => {
    const err = e as ProviderError;
    return {
      kind: isTransient(err) ? "retry" : "failed",
      code,
      message: `${what}: ${err?.message ?? "unknown error"}`,
    };
  };

  await ctx.onStep?.("creating_agent");
  let found: FoundAgent | null;
  try {
    found = await provisioner.findAgentByName(name);
  } catch (e) {
    return fail(e, "AGENT_CREATE_FAILED", "could not look up the agent");
  }
  let createdNow = false;
  if (!found) {
    try {
      const created = await provisioner.createAgent({
        name,
        templateAppId: ctx.masterAgentAppId,
      });
      found = { appId: created.appId, version: null };
      createdNow = true;
    } catch (e) {
      const err = e as ProviderError;
      // The create may have succeeded with the answer lost: look again, never blindly retry the create.
      if (isTransient(err)) {
        try {
          found = await provisioner.findAgentByName(name);
        } catch {
          found = null;
        }
        if (!found)
          return {
            kind: "retry",
            code: "AGENT_CREATE_AMBIGUOUS",
            message: `agent creation outcome unknown (${err.message}); will look it up before trying again`,
          };
      } else return fail(e, "AGENT_CREATE_FAILED", "Sarvam refused to create the agent");
    }
  }

  const appId = found.appId;
  if (appId === ctx.masterAgentAppId || appId === ctx.outboundMasterAgentAppId)
    return {
      kind: "failed",
      code: "AGENT_MAPPING_INVALID",
      message: "the agent resolved to a master template; refusing to map a customer to it",
    };

  await ctx.onStep?.("configuring_agent");
  let version: number;
  try {
    version = (await provisioner.configureAgent({ appId, config: ctx.config })).version;
  } catch (e) {
    return fail(e, "AGENT_CONFIG_FAILED", "could not configure the agent");
  }

  await ctx.onStep?.("verifying_agent");
  try {
    const v = await provisioner.verifyAgent({ appId, version, config: ctx.config });
    if (!v.ok)
      return {
        kind: "retry",
        code: "AGENT_VERIFY_FAILED",
        message: `agent check failed: ${v.detail}`,
      };
  } catch (e) {
    return fail(e, "AGENT_VERIFY_FAILED", "could not verify the agent");
  }

  try {
    await registerProvisionedAgent(admin, {
      organizationId: ctx.organizationId,
      agentConfigId: ctx.agentConfigId,
      appId,
      version,
      masterAgentAppId: ctx.masterAgentAppId,
    });
  } catch (e) {
    return {
      kind: "failed",
      code: "AGENT_MAPPING_INVALID",
      message: `the agent could not be registered: ${(e as Error).message}`,
    };
  }
  return { kind: "ready", appId, version, createdNow };
}

/**
 * Registers a provisioned agent for a customer: the same rules as the admin
 * registration (one customer per agent, never a master template, never an
 * outbound agent), and records that the saved voice and languages were applied
 * to this exact agent version. Re-registering the same id and version is a no-op.
 * Throws with a plain message when a rule refuses it.
 */
export async function registerProvisionedAgent(
  admin: Admin,
  input: {
    organizationId: string;
    agentConfigId: string;
    appId: string;
    version: number;
    masterAgentAppId: string | null;
  },
): Promise<void> {
  const { applySarvamAgentMapping } = await import("./sarvam-agent-registration.server.ts");
  await applySarvamAgentMapping(admin, {
    agentConfigId: input.agentConfigId,
    organizationId: input.organizationId,
    sarvamAppId: input.appId,
    sarvamAppVersion: input.version,
    masterAgentAppId: input.masterAgentAppId,
  });
  const { data: applied, error } = await admin
    .from("agent_voice_language_settings")
    .update({
      status: "applied",
      applied_sarvam_app_id: input.appId,
      applied_sarvam_app_version: input.version,
      applied_at: new Date().toISOString(),
    })
    .eq("agent_config_id", input.agentConfigId)
    .eq("organization_id", input.organizationId)
    .select("id");
  if (error) throw error;
  if (!applied?.length) throw new Error("voice and language settings not found");
}
