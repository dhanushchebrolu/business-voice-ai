import { memorySupabase } from "./payments/memory-supabase.test-helper.ts";
import type { DeploymentView, PipelineDeps } from "./provisioning-pipeline.server.ts";
import type { AgentSnapshot } from "./agent-instructions.ts";

/** Shared in-memory customer world + mocked Sarvam deployment API for provisioning tests (mocks only). */
export const ORG = "org_new";
export const OTHER = "org_other";

export function snapshot(caps: Record<string, boolean> = { capture_lead: true }): AgentSnapshot {
  return {
    business: {
      name: "New Clinic",
      business_type: "dental_clinic",
      description: "Clinic.",
      country: "IN",
      timezone: "Asia/Kolkata",
      currency: "INR",
    },
    hours: [{ day_of_week: 1, is_closed: false, intervals: [{ start: "09:00", end: "18:00" }] }],
    services: [{ name: "Cleaning", currency: "INR", is_active: true }],
    faqs: [],
    rules: [],
    knowledge: [],
    agent: {
      agent_name: "Aria",
      persona: "friendly",
      objectives: [],
      capabilities: caps,
      primary_language: "en-IN",
      extra_languages: [],
      multilingual: true,
      voice_id: "ritu",
      speaking_pace: 1,
      greetings: {},
      transfer_number: null,
      after_hours_behavior: "take_message",
    },
  };
}

/**
 * A customer at the end of onboarding: business + agent, connection, assigned
 * number, inbound credential, and (unless outbound: false) the separate
 * outbound agent with its own credential.
 */
export function world(
  over: {
    appId?: string | null;
    numberStatus?: string;
    deploymentId?: string | null;
    outbound?: false | "no_agent" | "inbound_agent";
  } = {},
) {
  const outboundAppId =
    over.outbound === false || over.outbound === "no_agent"
      ? null
      : over.outbound === "inbound_agent"
        ? "Customer-app-1"
        : "Customer-out-1";
  return memorySupabase({
    uniques: [
      {
        table: "provisioning_runs",
        key: (r) =>
          ["pending", "running", "waiting"].includes(r["status"] as string)
            ? (r["organization_id"] as string)
            : null,
      },
    ],
    tables: {
      organizations: [
        { id: ORG, lifecycle_status: "setup_paid" },
        { id: OTHER, lifecycle_status: "active" },
      ],
      agent_configs: [
        {
          id: "agent_new",
          organization_id: ORG,
          business_id: "biz_new",
          sarvam_app_id: over.appId === undefined ? "Customer-app-1" : over.appId,
          sarvam_app_version: 1,
          sarvam_outbound_app_id: outboundAppId,
          sarvam_outbound_app_version: outboundAppId ? 1 : null,
        },
        {
          id: "agent_other",
          organization_id: OTHER,
          business_id: "biz_other",
          sarvam_app_id: "Other-app",
          sarvam_app_version: 4,
        },
      ],
      telephony_connections: [
        // One shared Sarvam/Vobiz connection, registered for both customers.
        {
          id: "conn_new",
          organization_id: ORG,
          provider: "sarvam",
          provider_connection_id: "conn-shared",
        },
        {
          id: "conn_other",
          organization_id: OTHER,
          provider: "sarvam",
          provider_connection_id: "conn-shared",
        },
      ],
      phone_numbers: [
        {
          id: "num_new",
          e164: "+917900000002",
          status: over.numberStatus ?? "provisioning",
          provider: "sarvam",
          organization_id: ORG,
          connection_id: null,
          agent_config_id: null,
          provider_deployment_id: over.deploymentId ?? null,
          inbound_enabled: false,
          sarvam_number_confirmed_at: "2026-11-14T09:00:00Z",
        },
        {
          id: "num_other",
          e164: "+917900000001",
          status: "active",
          provider: "sarvam",
          organization_id: OTHER,
          connection_id: "conn_other",
          agent_config_id: "agent_other",
          provider_deployment_id: "dep-other",
          inbound_enabled: true,
        },
      ],
      sarvam_agent_integrations: [
        {
          id: "int_new",
          agent_config_id: "agent_new",
          status: "active",
          expires_at: null,
          role: "inbound",
        },
        ...(over.outbound === false
          ? []
          : [
              {
                id: "int_new_out",
                agent_config_id: "agent_new",
                status: "active",
                expires_at: null,
                role: "outbound",
              },
            ]),
      ],
      agent_voice_language_settings: [
        {
          id: "vl_new",
          organization_id: ORG,
          agent_config_id: "agent_new",
          default_language: "English",
          allowed_languages: ["English", "Hindi"],
          auto_language_switch: true,
          // Simran - Hinglish Support Agent (v4)
          sarvam_voice_internal_id: "01a0cf17-12bd-7de3-9df0-f607db604d52",
          status: "applied",
          applied_sarvam_app_id: "Customer-app-1",
          applied_sarvam_app_version: 1,
        },
      ],
    },
  });
}

/**
 * Mocked Sarvam deployment API with state, following the documented
 * behaviour: a created deployment starts "active"; PUT status pauses or
 * resumes it; PATCH (via the sync) changes app_version. `deployment`
 * overrides are applied on every read (a deployment stuck that way).
 */
export function deps(
  db: ReturnType<typeof world>,
  over: Partial<PipelineDeps> & {
    deployment?: Partial<DeploymentView>;
    initialStatus?: string;
    resumeFails?: boolean;
  } = {},
) {
  const calls = { create: 0, get: 0, pause: 0, resume: 0, sync: 0, log: [] as string[] };
  const sarvam = {
    status: over.initialStatus ?? "active",
    appId: "Customer-app-1",
    appVersion: 1 as number | null,
  };
  const { deployment, initialStatus, resumeFails, ...rest } = over;
  void initialStatus;
  const d: PipelineDeps = {
    loadSnapshot: async () => snapshot(),
    createDeployment: async (_admin, { phoneNumberIds }) => {
      calls.create++;
      calls.log.push("create");
      sarvam.status = "active";
      const row = db.tables["phone_numbers"]!.find((n) => n["id"] === phoneNumberIds[0])!;
      row["provider_deployment_id"] = "dep-new";
      return { deploymentId: "dep-new", outcome: "created" };
    },
    getDeployment: async (id) => {
      calls.get++;
      calls.log.push("get");
      return {
        deploymentId: id,
        appId: sarvam.appId,
        appVersion: sarvam.appVersion,
        status: sarvam.status,
        phoneNumbers: ["+917900000002"],
        webhookUrlConfigured: true,
        ...deployment,
      };
    },
    setDeploymentStatus: async (_id, action) => {
      calls.log.push(action);
      if (action === "pause") {
        calls.pause++;
        sarvam.status = "paused";
      } else {
        calls.resume++;
        if (resumeFails) throw new Error("Sarvam is temporarily unavailable. Please retry.");
        sarvam.status = "active";
      }
    },
    syncDeployments: async () => {
      calls.sync++;
      calls.log.push("sync");
      sarvam.appVersion = Number(db.tables["agent_configs"]![0]!["sarvam_app_version"]);
    },
    masterAgentAppId: "Master-agent",
    now: () => new Date("2026-11-14T10:00:00Z"),
    ...rest,
  };
  return { d, calls, sarvam };
}

export const num = (db: ReturnType<typeof world>, id: string) =>
  db.tables["phone_numbers"]!.find((n) => n["id"] === id)!;
