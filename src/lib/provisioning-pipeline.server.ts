import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AgentSnapshot } from "./agent-instructions.ts";
import type { ProvisionOrganizationResult } from "./provisioning-orchestrator.server.ts";
import type { ProvisioningState } from "./provisioning-state.ts";
import { normalizeCustomerPhone } from "./phone-number.ts";
import { buildUniversalAgentConfig, type UniversalAgentConfig } from "./universal-agent-config.ts";
import type { FailureCode, JobStepKey } from "./voice-provisioning-job.ts";
import { DEFAULT_MASTER_AGENT_APP_ID } from "./sarvam-agent-tools-spec.ts";
import type { EnsureAgentContext, EnsureAgentOutcome } from "./sarvam-agent-provisioner.server.ts";

/**
 * Provisioning pipeline: one dedicated Sarvam agent per customer, copied
 * from ONE universal master agent, on the customer's pre-assigned Sarvam
 * number. Ten steps, each idempotent and safe to re-run:
 *
 *   1  validate onboarding        business, agent and the data each enabled capability needs
 *   2  validate assigned number   a non-released number owned by this customer, on its own
 *                                 connection row, confirmed by an admin to exist in Sarvam
 *   3  generate agent config      universal-agent-config.ts, stored on the run with a fingerprint
 *   4  integration credential     an active per-agent credential must exist (issued by an admin, shown once)
 *   5  manual Sarvam step         an admin copies the master agent, applies the config, commits it
 *   6  register agent id/version  agent_configs.sarvam_app_id/version (never the master template),
 *                                 with voice & languages recorded as applied to that agent+version
 *   7  create or adopt deployment createInboundDeploymentForNumbers (adopts, never duplicates);
 *                                 a definite Sarvam refusal stops at manual_action_required
 *   8  verify deployment          deployment id, agent, version, webhook; a new deployment is paused
 *   9  verify number mapping      Sarvam routes this number and ClickAI's row points at it;
 *                                 the verified ids are saved while the number stays inactive
 *  10  activate                   resume, read back and re-verify, and only then mark the ClickAI
 *                                 number ACTIVE; any failure leaves it inactive
 *  11  outbound credential        an active credential with role "outbound" (separate from the
 *                                 inbound one; ClickAI refuses every write tool for it)
 *  12  outbound agent registered  agent_configs.sarvam_outbound_app_id/version: the customer's own
 *                                 outbound agent, never a master template or the inbound agent
 *
 * The inbound number goes live at step 10 whatever happens to the outbound
 * agent; steps 11-12 only decide whether the run is complete. Registering the
 * outbound agent never switches outbound calling on: that still needs the
 * separate confirmation after a supervised call (setOutboundReady).
 *
 * The admission gate (sarvam-inbound-admission.server.ts) serves business
 * data only to ACTIVE numbers whose saved verified ids match the mapping.
 *
 * Steps 4-6 and 11-12 need a person (Sarvam has no unattended agent-authoring
 * API and the raw credential is shown once to an admin), so the pipeline stops
 * there with a "waiting" state and resumes on the next run. Every step reads
 * what is already done first, so a retry after a partial success never
 * creates a second deployment, credential or agent registration. It never throws for
 * provider or data problems: those come back as a state plus a note; only
 * unexpected database errors throw (provisioning-runs.server.ts records them).
 */

type Admin = SupabaseClient<Database>;

export interface DeploymentView {
  deploymentId: string;
  appId: string;
  appVersion: number | null;
  status: string | null;
  phoneNumbers: string[];
  webhookUrlConfigured: boolean;
  /**
   * Which accepted token the deployment's webhook URL carries, when the read
   * classified it: "current", "previous" (rotation grace period), "unknown"
   * (one ClickAI would reject) or "none". Absent when not classified.
   */
  webhookTokenStatus?: string;
}

/** The webhook would reach ClickAI and be accepted (presence alone is not enough once classified). */
export function webhookAccepted(
  d: Pick<DeploymentView, "webhookUrlConfigured" | "webhookTokenStatus">,
): boolean {
  if (!d.webhookUrlConfigured) return false;
  return (
    d.webhookTokenStatus === undefined ||
    d.webhookTokenStatus === "current" ||
    d.webhookTokenStatus === "previous"
  );
}

export interface PipelineDeps {
  loadSnapshot: (admin: Admin, businessId: string) => Promise<AgentSnapshot>;
  createDeployment: (
    admin: Admin,
    params: { phoneNumberIds: string[]; name: string },
  ) => Promise<{ deploymentId: string; outcome?: string }>;
  getDeployment: (deploymentId: string) => Promise<DeploymentView>;
  /** Documented PUT .../deployments/{id}/status (pause | resume). */
  setDeploymentStatus: (deploymentId: string, action: "pause" | "resume") => Promise<unknown>;
  /** Brings the agent's deployments to its registered version, keeping each one's paused/active state. */
  syncDeployments: (admin: Admin, agentConfigId: string) => Promise<unknown>;
  /** The universal master agent's Sarvam app id; a customer may never be mapped to it. */
  masterAgentAppId: string | null;
  /** The outbound master template's Sarvam app id; never a customer's outbound agent. */
  outboundMasterAgentAppId?: string | null;
  now: () => Date;
  /** The agent an operator reported (tools created, credentials pending), before any version is registered. */
  reportedAgent?: (admin: Admin, organizationId: string) => Promise<{ appId: string } | null>;
  /** Tool-authentication checkpoint lookup (defaults to the job event trail). */
  toolAuthStatus?: (
    admin: Admin,
    input: { organizationId: string; appId: string; version: number },
  ) => Promise<{ required: boolean; confirmed: boolean }>;
  /**
   * Creates/configures/verifies/registers the customer's own Sarvam agent when
   * the provider supports it. Absent or "unsupported": the pipeline waits for
   * an admin to register the agent by hand (Sarvam has no documented create API).
   */
  ensureAgent?: (admin: Admin, ctx: EnsureAgentContext) => Promise<EnsureAgentOutcome>;
}

export interface VerificationCheck {
  id: string;
  label: string;
  ok: boolean;
  /** Plain-language reason, meaningful when ok is false. */
  detail: string;
}

/** Expected vs actual for steps 8-9, stored on the run for the admin screen. */
export interface VerificationReport {
  deploymentId: string;
  expected: { appId: string; appVersion: number; number: string };
  actual: {
    appId: string;
    appVersion: number | null;
    status: string | null;
    phoneNumbers: string[];
    webhookUrlConfigured: boolean;
    clickaiDeploymentId: string | null;
    /** The Sarvam status the deployment had when this run found it. */
    statusBeforeRun?: string | null;
  };
  checks: VerificationCheck[];
}

export interface PipelineResult extends ProvisionOrganizationResult {
  step: number;
  /** An explicit failure classification from the step itself (overrides state-based defaults). */
  failure?: { code: FailureCode; retryable: boolean };
  generatedConfig: UniversalAgentConfig | null;
  deploymentVerifiedAt: string | null;
  verification: VerificationReport | null;
}

const canonical = (n: string) => normalizeCustomerPhone(n, null) ?? n;

/**
 * The identity checks every verification makes against Sarvam's own view of a
 * deployment: the deployment id itself, its status, agent, version, result
 * webhook, the routed number, and ClickAI's record pointing at it.
 */
export function deploymentVerificationChecks(
  d: DeploymentView,
  exp: {
    deploymentId: string;
    appId: string;
    appVersion: number;
    e164: string;
    organizationId: string;
    /** true: must be active; false (before activation): paused or active. */
    wantActive: boolean;
  },
  mapped: { provider_deployment_id: string | null; organization_id: string | null },
): VerificationCheck[] {
  const check = (id: string, label: string, ok: boolean, detail: string): VerificationCheck => ({
    id,
    label,
    ok,
    detail,
  });
  return [
    check(
      "deployment_id",
      "Sarvam returned the expected deployment",
      d.deploymentId === exp.deploymentId,
      `Sarvam returned deployment ${d.deploymentId}, not ${exp.deploymentId}`,
    ),
    check(
      "status",
      exp.wantActive ? "Deployment is active" : "Deployment is paused or active",
      exp.wantActive ? d.status === "active" : d.status === "active" || d.status === "paused",
      `status is ${d.status ?? "unknown"}`,
    ),
    check(
      "agent",
      "Runs this customer's agent",
      d.appId === exp.appId,
      `it runs agent ${d.appId}, not ${exp.appId}`,
    ),
    check(
      "version",
      "Runs the registered version",
      d.appVersion === exp.appVersion,
      `it runs version ${d.appVersion ?? "unknown"}, not ${exp.appVersion}`,
    ),
    check(
      "webhook",
      "Call-result webhook configured with a token ClickAI accepts",
      webhookAccepted(d),
      d.webhookUrlConfigured
        ? "its result webhook carries a verification token ClickAI does not accept (update the webhook token)"
        : "its result webhook is not configured",
    ),
    check(
      "routes_number",
      "Sarvam routes the assigned number",
      d.phoneNumbers.map(canonical).includes(canonical(exp.e164)),
      `deployment ${exp.deploymentId} does not route ${exp.e164}`,
    ),
    check(
      "clickai_mapping",
      "ClickAI's number record points at this deployment",
      mapped.provider_deployment_id === exp.deploymentId &&
        mapped.organization_id === exp.organizationId,
      `ClickAI's record for ${exp.e164} does not point at deployment ${exp.deploymentId}`,
    ),
  ];
}

/** Identity failures (not status or webhook) mean a saved verification is wrong. */
export const isIdentityFailure = (checks: VerificationCheck[]) =>
  checks.some((c) => !c.ok && c.id !== "status" && c.id !== "webhook");

export async function defaultPipelineDeps(): Promise<PipelineDeps> {
  const [
    { loadSnapshot },
    { createInboundDeploymentForNumbers, syncAgentDeployments },
    telephony,
    sarvam,
  ] = await Promise.all([
    import("./agent-service.server.ts"),
    import("./sarvam-inbound-deployment.server.ts"),
    import("./telephony.server.ts"),
    import("./telephony/sarvam-provider.server.ts"),
  ]);
  const sarvamAdapter = () => {
    const adapter = telephony.getTelephonyAdapter("sarvam");
    if (!adapter || !(adapter instanceof sarvam.SarvamTelephonyAdapter))
      throw new Error("Sarvam is not connected.");
    return adapter;
  };
  return {
    loadSnapshot,
    createDeployment: createInboundDeploymentForNumbers,
    getDeployment: async (id) => sarvamAdapter().getDeployment(id),
    setDeploymentStatus: async (id, action) => sarvamAdapter().setDeploymentStatus(id, action),
    syncDeployments: syncAgentDeployments,
    masterAgentAppId:
      process.env["SARVAM_MASTER_AGENT_APP_ID"]?.trim() || DEFAULT_MASTER_AGENT_APP_ID,
    outboundMasterAgentAppId: process.env["SARVAM_OUTBOUND_MASTER_AGENT_APP_ID"]?.trim() || null,
    now: () => new Date(),
    ensureAgent: async (a, ctx) => {
      const { ensureCustomerAgent, defaultAgentProvisioner } =
        await import("./sarvam-agent-provisioner.server.ts");
      return ensureCustomerAgent(a, ctx, defaultAgentProvisioner());
    },
  };
}

export async function runProvisioningPipeline(
  admin: Admin,
  organizationId: string,
  depsIn?: PipelineDeps,
  /** Reports the step the run is on (persisted by provisioning-runs.server.ts for real progress). */
  onStep?: (key: JobStepKey) => Promise<void> | void,
): Promise<PipelineResult> {
  const step = async (key: JobStepKey) => {
    await onStep?.(key);
  };
  const deps = depsIn ?? (await defaultPipelineDeps());
  let generatedConfig: UniversalAgentConfig | null = null;
  let phoneNumberId: string | null = null;
  let deploymentId: string | null = null;
  let deploymentCreatedNow = false;
  let verification: VerificationReport | null = null;

  const done = (
    step: number,
    state: ProvisioningState,
    note: string,
    verifiedAt: string | null = null,
    failure?: { code: FailureCode; retryable: boolean },
  ): PipelineResult => ({
    organizationId,
    phoneNumberId,
    numberClaimedNow: false,
    deploymentCreatedNow,
    deploymentId,
    note: `Step ${step}: ${note}`,
    state,
    step,
    generatedConfig,
    deploymentVerifiedAt: verifiedAt,
    verification,
    ...(failure ? { failure } : {}),
  });

  await step("validating");
  // 1. Onboarding.
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, lifecycle_status")
    .eq("id", organizationId)
    .maybeSingle();
  if (orgError) throw orgError;
  if (!org) return done(1, "failed", "organization not found.");
  if (["suspended", "cancelled", "archived"].includes(org.lifecycle_status))
    return done(1, "failed", `organization is ${org.lifecycle_status}; nothing provisioned.`);
  // Payment done, setup underway (forward only; ready/active stay the admin handover's call).
  if (org.lifecycle_status === "setup_paid") {
    const { error } = await admin
      .from("organizations")
      .update({ lifecycle_status: "provisioning" })
      .eq("id", organizationId)
      .eq("lifecycle_status", "setup_paid");
    if (error) throw error;
  }

  const { data: agent, error: agentError } = await admin
    .from("agent_configs")
    .select(
      "id, organization_id, business_id, sarvam_app_id, sarvam_app_version, sarvam_outbound_app_id, sarvam_outbound_app_version",
    )
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (agentError) throw agentError;
  if (!agent?.business_id)
    return done(
      1,
      "waiting_for_onboarding",
      "the customer has not finished onboarding (no business profile or agent yet).",
    );

  const snapshot = await deps.loadSnapshot(admin, agent.business_id);
  if (!snapshot.business.business_type?.trim())
    return done(
      1,
      "waiting_for_onboarding",
      "the business category is missing; choose it in your business profile.",
    );

  const { data: voiceLanguage, error: vlError } = await admin
    .from("agent_voice_language_settings")
    .select(
      "organization_id, default_language, allowed_languages, auto_language_switch, sarvam_voice_internal_id, status, applied_sarvam_app_id, applied_sarvam_app_version",
    )
    .eq("agent_config_id", agent.id)
    .maybeSingle();
  if (vlError) throw vlError;
  if (voiceLanguage && voiceLanguage.organization_id !== organizationId)
    return done(
      3,
      "failed",
      "voice/language settings belong to another customer; fix them by hand.",
    );

  // 3 (computed early so step 1 can report missing capability data).
  generatedConfig = buildUniversalAgentConfig(snapshot, voiceLanguage ?? null);
  if (generatedConfig.blockers.length)
    return done(1, "waiting_for_onboarding", generatedConfig.blockers.join(" "));
  if (generatedConfig.voiceLanguageProblem)
    return done(
      3,
      "waiting_for_voice_language",
      `${generatedConfig.voiceLanguageProblem} Set them in Voice & language.`,
    );

  // 2. Assigned number.
  const { data: numbers, error: numbersError } = await admin
    .from("phone_numbers")
    .select(
      "id, e164, status, provider, organization_id, connection_id, agent_config_id, provider_deployment_id, inbound_enabled, sarvam_number_confirmed_at",
    )
    .eq("organization_id", organizationId)
    .neq("status", "released")
    .order("created_at", { ascending: true });
  if (numbersError) throw numbersError;
  const sarvamNumbers = (numbers ?? []).filter((n) => n.provider === "sarvam");
  const number = sarvamNumbers[0] ?? null;
  // One customer = one Sarvam number. Sarvam's tool requests do not say which
  // number was dialled, so the admission gate cannot tell two numbers apart.
  if (sarvamNumbers.length > 1) {
    phoneNumberId = number!.id;
    return done(
      2,
      "manual_action_required",
      `this customer has ${sarvamNumbers.length} Sarvam numbers (${sarvamNumbers.map((n) => n.e164).join(", ")}); ClickAI supports one per customer. Release or reassign the extra ones by hand.`,
    );
  }
  if (!number)
    return done(
      2,
      "waiting_for_number",
      "no Sarvam number is assigned to this customer yet. Assign one from the admin numbers page.",
    );
  phoneNumberId = number.id;
  if (number.status === "suspended")
    return done(2, "failed", `number ${number.e164} is suspended; resolve that first.`, null, {
      code: "NUMBER_UNUSABLE",
      retryable: false,
    });

  const { data: connection, error: connError } = await admin
    .from("telephony_connections")
    .select("id, organization_id, provider_connection_id")
    .eq("organization_id", organizationId)
    .eq("provider", "sarvam")
    .maybeSingle();
  if (connError) throw connError;
  if (!connection?.provider_connection_id)
    return done(
      2,
      "waiting_for_connection",
      "register the Sarvam connection for this customer first.",
    );

  // Link the number to this customer's own connection row and agent (ClickAI-internal write).
  const link: { connection_id?: string; agent_config_id?: string } = {};
  if (number.connection_id !== connection.id) link.connection_id = connection.id;
  if (number.agent_config_id !== agent.id) link.agent_config_id = agent.id;
  if (Object.keys(link).length) {
    if (number.provider_deployment_id)
      return done(
        2,
        "failed",
        `number ${number.e164} already has deployment ${number.provider_deployment_id} but is linked to a different connection or agent; fix it by hand.`,
        null,
        { code: "NUMBER_UNUSABLE", retryable: false },
      );
    const { error } = await admin
      .from("phone_numbers")
      .update(link)
      .eq("id", number.id)
      .eq("organization_id", organizationId);
    if (error) throw error;
  }

  // The number must already exist in Sarvam on this customer's connection.
  // Sarvam documents no API to list or import numbers, so an admin confirms
  // it by hand; nothing here rents, buys or claims a number.
  if (!number.provider_deployment_id && !number.sarvam_number_confirmed_at)
    return done(
      2,
      "waiting_for_number_confirmation",
      `confirm that ${number.e164} already exists in Sarvam on this customer's connection (Sarvam console, Phone numbers), then record it here. ClickAI never rents or claims numbers.`,
    );

  // 4. Integration credential.
  await step("preparing");
  const { data: credential, error: credError } = await admin
    .from("sarvam_agent_integrations")
    .select("id, expires_at")
    .eq("agent_config_id", agent.id)
    .eq("role", "inbound")
    .eq("status", "active")
    .maybeSingle();
  if (credError) throw credError;
  const credentialLive =
    credential && (!credential.expires_at || new Date(credential.expires_at) > deps.now());
  if (!credentialLive)
    return done(
      4,
      "waiting_for_integration_credential",
      "issue this customer's integration credential (Sarvam agent data integration panel), then put it in the customer's Sarvam agent secret.",
    );

  // 5 + 6. The customer's own Sarvam agent, registered as agent id + version:
  // created through the provider when it supports that, else by an admin.
  await step("creating_agent");
  if (!agent.sarvam_app_id || !agent.sarvam_app_version) {
    const ensured: EnsureAgentOutcome = deps.ensureAgent
      ? await deps.ensureAgent(admin, {
          organizationId,
          agentConfigId: agent.id,
          config: generatedConfig,
          masterAgentAppId: deps.masterAgentAppId,
          outboundMasterAgentAppId: deps.outboundMasterAgentAppId ?? null,
          onStep: step,
        })
      : { kind: "unsupported" };
    if (ensured.kind === "unsupported") {
      // The operator already built the agent and its tools; only the credentials (a console
      // step) and the commit are pending: say so, with the agent id, instead of "waiting for agent".
      const lookup =
        deps.reportedAgent ?? (await import("./tool-auth-checkpoint.server.ts")).reportedAgent;
      const reported = await lookup(admin, organizationId);
      if (reported) {
        await step("authorizing_tools");
        return done(
          6,
          "waiting_for_tool_authentication",
          `agent ${reported.appId} and its six tools exist in Sarvam; credentials are not confirmed. Select the ClickAI credential on each tool in the Sarvam console, commit the agent, then confirm it with submit_agent_result.`,
          null,
          { code: "TOOL_AUTH_PENDING", retryable: false },
        );
      }
    }
    if (ensured.kind === "unsupported")
      return done(
        5,
        "waiting_for_agent",
        "the agent has to be built in Sarvam by a signed-in operator (Sarvam has no unattended agent API): connect an MCP client to the ClickAI operator bridge on the Provisioning page and let it process this work order, or copy the master agent by hand and register its agent id and version. The job continues by itself once the agent is registered.",
      );
    // Provider authorization is the one thing ClickAI cannot fix itself: wait for a person
    // (the operator bridge still works), recording exactly why.
    if (ensured.kind === "unauthorized")
      return done(5, "waiting_for_agent", ensured.message, null, {
        code: ensured.code,
        retryable: false,
      });
    if (ensured.kind !== "ready")
      return done(5, "failed", ensured.message, null, {
        code: ensured.code,
        retryable: ensured.kind === "retry",
      });
    agent.sarvam_app_id = ensured.appId;
    agent.sarvam_app_version = ensured.version;
    if (voiceLanguage) {
      voiceLanguage.status = "applied";
      voiceLanguage.applied_sarvam_app_id = ensured.appId;
      voiceLanguage.applied_sarvam_app_version = ensured.version;
    }
  }
  await step("verifying_agent");
  if (deps.masterAgentAppId && agent.sarvam_app_id === deps.masterAgentAppId)
    return done(
      6,
      "failed",
      "this customer is mapped to the universal master agent itself; register the customer's own copy instead.",
    );
  // The registered version must carry the saved voice and languages (step 6).
  if (
    voiceLanguage?.status !== "applied" ||
    voiceLanguage.applied_sarvam_app_id !== agent.sarvam_app_id ||
    voiceLanguage.applied_sarvam_app_version !== agent.sarvam_app_version
  )
    return done(
      6,
      "waiting_for_voice_language",
      `the saved voice and languages are not recorded as applied to Sarvam agent ${agent.sarvam_app_id} version ${agent.sarvam_app_version}. Apply them in Sarvam, commit, and register that agent and version.`,
    );

  // 6b. Tool authentication checkpoint, MANDATORY for every number that is not live yet,
  // however the agent was registered (operator bridge or the admin screen). Sarvam's MCP
  // cannot set tool credentials, so the number is not deployed or activated until a person's
  // confirmation (submit_agent_result) is on record for THIS agent id and version. A number
  // that is already live is only re-verified, never gated.
  await step("authorizing_tools");
  if (!(number.status === "active" && number.inbound_enabled)) {
    const lookup =
      deps.toolAuthStatus ?? (await import("./tool-auth-checkpoint.server.ts")).toolAuthStatus;
    const gate = await lookup(admin, {
      organizationId,
      appId: agent.sarvam_app_id!,
      version: agent.sarvam_app_version!,
    });
    if (!gate.confirmed)
      return done(
        6,
        "waiting_for_tool_authentication",
        `agent ${agent.sarvam_app_id} version ${agent.sarvam_app_version} has no confirmed tool credentials yet: select the ClickAI credential on each of the six tools in the Sarvam console, commit, then confirm the committed version with submit_agent_result (agent ID, version and each tool's credential type).`,
        null,
        { code: "TOOL_AUTH_PENDING", retryable: false },
      );
  }

  // 7. Deployment (create or adopt; never a duplicate).
  await step("creating_deployment");
  deploymentId = number.provider_deployment_id ?? null;
  if (!deploymentId) {
    try {
      const created = await deps.createDeployment(admin, {
        phoneNumberIds: [number.id],
        name: `ClickAI ${organizationId.slice(0, 8)} inbound`,
      });
      deploymentId = created.deploymentId;
      deploymentCreatedNow =
        created.outcome !== "adopted" && created.outcome !== "already_recorded";
    } catch (err) {
      const message = (err as Error).message;
      // Sarvam refused outright (bad input, unknown number or connection) or
      // the number is already routed elsewhere: retrying cannot help, an admin
      // must act in Sarvam. Timeouts, 5xx and 429 may have succeeded, so a
      // retry is safe: it adopts instead of duplicating.
      const status = (err as { status?: number }).status;
      const definite =
        (err as { outcomeUnknown?: boolean }).outcomeUnknown === false &&
        typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 429;
      if (definite || /already routes|already in different|already have a Sarvam/.test(message))
        return done(
          7,
          "manual_action_required",
          `Sarvam did not create the deployment: ${message} Resolve it in the Sarvam console, then retry.`,
        );
      return done(7, "failed", `deployment could not be created: ${message}`);
    }
  }

  const numberLive = number.status === "active" && number.inbound_enabled;
  const readDeployment = async (stepNo: number): Promise<DeploymentView | PipelineResult> => {
    try {
      return await deps.getDeployment(deploymentId!);
    } catch (err) {
      return done(
        stepNo,
        "verification_failed",
        `could not read deployment ${deploymentId} from Sarvam: ${(err as Error).message}`,
      );
    }
  };
  const isResult = (v: DeploymentView | PipelineResult): v is PipelineResult => "state" in v;

  // Safe reuse. A deployment ClickAI created or adopted for this customer's
  // admin-confirmed number is ClickAI's to pause until it is verified. Any
  // other deployment on a number that is not live in ClickAI may be serving
  // real calls (a legacy or hand-made deployment): stop for a person. A
  // number that IS live is never paused (re-verification only).
  const { data: sharers, error: sharersError } = await admin
    .from("phone_numbers")
    .select("id, organization_id, status")
    .eq("provider_deployment_id", deploymentId);
  if (sharersError) throw sharersError;
  const others = (sharers ?? []).filter((n) => n.id !== number.id && n.status !== "released");
  if (others.length)
    return done(
      8,
      "manual_action_required",
      `deployment ${deploymentId} is also recorded for ${others.length} other ClickAI number(s); a deployment serves one customer's one number. Resolve it by hand.`,
    );
  const clickaiProvisioned = deploymentCreatedNow || Boolean(number.sarvam_number_confirmed_at);
  if (!numberLive && !clickaiProvisioned)
    return done(
      8,
      "manual_action_required",
      `deployment ${deploymentId} was not created through ClickAI's confirmed-number flow and ${number.e164} is not live in ClickAI, so it may already be answering calls. Check it in the Sarvam console; for a working live customer use "Re-verify live deployment" instead.`,
    );

  // 8. Read the deployment. Sarvam creates deployments active (documented):
  // a not-yet-live number's deployment is paused (and the pause confirmed)
  // until step 10. Calls can still ring through in the seconds before the
  // pause; only the admission gate keeps business data away from them.
  let stateChangedByUs = false;
  await step("verifying_deployment");
  let read = await readDeployment(8);
  if (isResult(read)) return read;
  let deployment = read;
  const statusBeforeRun = deployment.status;
  if (deployment.status !== "active" && deployment.status !== "paused")
    return done(
      8,
      "manual_action_required",
      `deployment ${deploymentId} is in an unexpected state (${deployment.status ?? "unknown"}); check it in the Sarvam console.`,
    );
  if (!numberLive && deployment.status === "active") {
    try {
      await deps.setDeploymentStatus(deploymentId, "pause");
      stateChangedByUs = true;
    } catch (err) {
      return done(
        8,
        "verification_failed",
        `could not pause deployment ${deploymentId} before verification: ${(err as Error).message}`,
      );
    }
    read = await readDeployment(8);
    if (isResult(read)) return read;
    deployment = read;
    if (deployment.status !== "paused")
      return done(
        8,
        "manual_action_required",
        `deployment ${deploymentId} still reports ${deployment.status ?? "unknown"} after pausing; check it in the Sarvam console.`,
      );
  }
  // A deployment on an older version of this same agent is brought up to the
  // registered version (documented PATCH; the sync keeps paused/active as it was).
  if (
    deployment.appId === agent.sarvam_app_id &&
    deployment.appVersion !== agent.sarvam_app_version
  ) {
    try {
      await deps.syncDeployments(admin, agent.id);
    } catch {
      // Reported by the version check below.
    }
    read = await readDeployment(8);
    if (isResult(read)) return read;
    deployment = read;
  }

  // 9 (read ClickAI's side now so both checks are recorded together).
  await step("connecting_number");
  const { data: mapped, error: mappedError } = await admin
    .from("phone_numbers")
    .select("provider_deployment_id, organization_id")
    .eq("id", number.id)
    .single();
  if (mappedError) throw mappedError;

  const checksFor = (d: DeploymentView, wantActive: boolean): VerificationCheck[] =>
    deploymentVerificationChecks(
      d,
      {
        deploymentId: deploymentId!,
        appId: agent.sarvam_app_id!,
        appVersion: agent.sarvam_app_version!,
        e164: number.e164,
        organizationId,
        wantActive,
      },
      mapped,
    );
  const report = (d: DeploymentView, checks: VerificationCheck[]): VerificationReport => ({
    deploymentId: deploymentId!,
    expected: {
      appId: agent.sarvam_app_id!,
      appVersion: agent.sarvam_app_version!,
      number: number.e164,
    },
    actual: {
      appId: d.appId,
      appVersion: d.appVersion,
      status: d.status,
      phoneNumbers: d.phoneNumbers,
      webhookUrlConfigured: d.webhookUrlConfigured,
      clickaiDeploymentId: mapped.provider_deployment_id,
      statusBeforeRun,
    },
    checks,
  });
  const MAPPING_CHECKS = ["routes_number", "clickai_mapping"];
  const failNote = (checks: VerificationCheck[]) =>
    `${checks
      .filter((c) => !c.ok)
      .map((c) => c.detail)
      .join("; ")}.`;
  const failStep = (checks: VerificationCheck[]) =>
    checks.some((c) => !c.ok && !MAPPING_CHECKS.includes(c.id)) ? 8 : 9;
  // An identity mismatch (agent, version, number, deployment, mapping; not a
  // status or webhook problem) withdraws any earlier verification, so the
  // admission gate stops serving business data for this number.
  const clearVerified = async (checks: VerificationCheck[]) => {
    if (!isIdentityFailure(checks)) return;
    const { error } = await admin
      .from("phone_numbers")
      .update({
        verified_deployment_id: null,
        verified_sarvam_app_id: null,
        verified_sarvam_app_version: null,
        deployment_verified_at: null,
      })
      .eq("id", number.id)
      .eq("organization_id", organizationId);
    if (error) throw error;
  };

  const firstChecks = checksFor(deployment, numberLive);
  verification = report(deployment, firstChecks);
  if (firstChecks.some((c) => !c.ok)) {
    // The exact failing step: a deployment check or the number mapping.
    const deploymentCheck = failStep(firstChecks) === 8;
    await step(deploymentCheck ? "verifying_deployment" : "verifying_number");
    await clearVerified(firstChecks);
    return done(failStep(firstChecks), "verification_failed", failNote(firstChecks), null, {
      code: deploymentCheck ? "DEPLOYMENT_VERIFY_FAILED" : "NUMBER_MAPPING_FAILED",
      retryable: true,
    });
  }
  await step("verifying_number");

  // Persist what was verified while the ClickAI number stays inactive.
  const verifiedAt = deps.now().toISOString();
  const { data: persisted, error: persistError } = await admin
    .from("phone_numbers")
    .update({
      verified_deployment_id: deploymentId,
      verified_sarvam_app_id: agent.sarvam_app_id,
      verified_sarvam_app_version: agent.sarvam_app_version,
      deployment_verified_at: verifiedAt,
    })
    .eq("id", number.id)
    .eq("organization_id", organizationId)
    .eq("provider_deployment_id", deploymentId)
    .select("id");
  if (persistError) throw persistError;
  if (!persisted?.length)
    return done(9, "verification_failed", "the number changed during verification; run again.");

  if (numberLive)
    return outboundSteps(`${number.e164} is live on deployment ${deploymentId}.`, verifiedAt);

  // 10. Resume in Sarvam, read it back, and only then mark ClickAI's number
  // ACTIVE. Any failure leaves the ClickAI number inactive and re-pauses.
  await step("activating");
  const repause = async () => {
    if (!stateChangedByUs) return;
    try {
      await deps.setDeploymentStatus(deploymentId!, "pause");
    } catch {
      // Best effort; the admission gate still refuses business data.
    }
  };
  if (deployment.status !== "active") {
    try {
      stateChangedByUs = true;
      await deps.setDeploymentStatus(deploymentId, "resume");
    } catch (err) {
      await repause();
      return done(
        10,
        "verification_failed",
        `could not resume deployment ${deploymentId}: ${(err as Error).message}`,
        verifiedAt,
      );
    }
  }
  read = await readDeployment(10);
  if (isResult(read)) {
    await repause();
    return read;
  }
  const finalChecks = checksFor(read, true);
  verification = report(read, finalChecks);
  if (finalChecks.some((c) => !c.ok)) {
    await repause();
    await clearVerified(finalChecks);
    return done(10, "verification_failed", failNote(finalChecks), verifiedAt);
  }

  const { data: activated, error } = await admin
    .from("phone_numbers")
    .update({ status: "active", inbound_enabled: true })
    .eq("id", number.id)
    .eq("organization_id", organizationId)
    .eq("provider_deployment_id", deploymentId)
    .eq("verified_deployment_id", deploymentId)
    .eq("verified_sarvam_app_id", agent.sarvam_app_id!)
    .eq("verified_sarvam_app_version", agent.sarvam_app_version!)
    .select("id");
  if (error) {
    await repause();
    if ((error as { code?: string }).code === "23505")
      return done(
        10,
        "failed",
        `${number.e164} is already active for another customer.`,
        verifiedAt,
      );
    throw error;
  }
  if (!activated?.length) {
    await repause();
    return done(
      10,
      "verification_failed",
      "the number changed during activation; run again.",
      verifiedAt,
    );
  }
  return outboundSteps(`${number.e164} is live on deployment ${deploymentId}.`, verifiedAt);

  // 11 + 12. The outbound agent. Read-only checks: nothing here can disturb
  // the live inbound number, and a retry repeats nothing that is done.
  async function outboundSteps(inboundNote: string, at: string | null): Promise<PipelineResult> {
    const { data: outboundCredential, error: outboundCredError } = await admin
      .from("sarvam_agent_integrations")
      .select("id, expires_at")
      .eq("agent_config_id", agent!.id)
      .eq("role", "outbound")
      .eq("status", "active")
      .maybeSingle();
    if (outboundCredError) throw outboundCredError;
    const outboundLive =
      outboundCredential &&
      (!outboundCredential.expires_at || new Date(outboundCredential.expires_at) > deps.now());
    if (!outboundLive)
      return done(
        11,
        "waiting_for_outbound_credential",
        `${inboundNote} Next: issue the outbound agent's credential (role outbound) and put it in the outbound agent's Sarvam secret.`,
        at,
      );
    const outAppId = agent!.sarvam_outbound_app_id;
    const outVersion = agent!.sarvam_outbound_app_version;
    if (!outAppId || !outVersion)
      return done(
        12,
        "waiting_for_outbound_agent",
        `${inboundNote} Next: create the customer's outbound agent in Sarvam from the outbound template, commit it, and register its agent id and version.`,
        at,
      );
    if (
      outAppId === agent!.sarvam_app_id ||
      [deps.masterAgentAppId, deps.outboundMasterAgentAppId].some((m) => m && m === outAppId)
    )
      return done(
        12,
        "failed",
        `${inboundNote} The registered outbound agent ${outAppId} is the inbound agent or a master template; register the customer's own outbound agent.`,
        at,
      );
    return done(
      12,
      "active",
      `${inboundNote} Outbound agent ${outAppId} v${outVersion} is registered; outbound calling stays off until it is confirmed after a supervised call.`,
      at,
    );
  }
}
