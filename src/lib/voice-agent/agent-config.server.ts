/**
 * The agent configuration a LiveKit SIP call runs with, resolved exactly as
 * the Cloudflare Worker voice runtime resolves it (telephony-runtime.ts
 * routeToAgentRuntime), from the same building blocks:
 *
 *  1. The business's latest ACTIVE published `agent_versions` row: its
 *     published instructions, with only the sections that must be current
 *     brought up to date by withCurrentCallSections (language, escalation,
 *     safety, today's date, and the live services and prices). The greeting,
 *     languages and voice come from the published snapshot, never the draft.
 *  2. No published version: the call is REFUSED, unless draft use was
 *     explicitly allowed for a development or staging deployment
 *     (draftConfigPolicy). Then the live configuration is used only when it
 *     passes validateAgentConfig (the same rules publishing uses), reported
 *     as `source: "live_snapshot"` (recorded on the call row and logged).
 *     Production never runs an unpublished draft, even a valid one (the
 *     Worker runtime still has that fallback; the LiveKit path does not).
 *  A published version that is structurally unusable (no instructions, no
 *  agent or business in its snapshot) is refused too, never patched up.
 *
 * Resolved once per call (at session start): the call keeps this
 * configuration even if the business publishes a new version meanwhile.
 *
 * The query mirrors telephony-runtime.ts on purpose (that file's tests pin
 * its source text); both use the same agent-instructions.ts functions.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AgentSnapshot } from "@/lib/agent-instructions";

type Client = SupabaseClient<Database>;

export interface CallAgentService {
  id: string;
  name: string;
  price: number | null;
  durationMinutes: number | null;
}

export type CallAgentConfig =
  | {
      ok: true;
      source: "published_version" | "live_snapshot";
      /** The published version number; null for a live snapshot. */
      agentVersion: number | null;
      instructions: string;
      agent: AgentSnapshot["agent"];
      businessName: string;
      timezone: string;
      country: string | null;
      currency: string;
      /** The business's active services as they are now (ids for booking). */
      services: CallAgentService[];
      /** The live services read failed: the published prices are flagged as unconfirmed. */
      servicesUnavailable: boolean;
    }
  | {
      ok: false;
      reason:
        | "no_business"
        | "agent_config_incomplete"
        | "no_published_version"
        | "invalid_published_version";
      /** Which configuration fields are missing (field names only). */
      fields: string[];
    };

/**
 * Whether a call may run on an unpublished draft. Only when the deployment
 * says it is development or staging (VOICE_AGENT_ENV) AND draft use is
 * explicitly switched on (VOICE_AGENT_ALLOW_DRAFT_AGENT_CONFIG=true). An
 * unset or unknown VOICE_AGENT_ENV counts as production: never.
 */
export function draftConfigPolicy(env: (name: string) => string | undefined): {
  environment: "production" | "staging" | "development";
  allowDraft: boolean;
  /** The opt-in was set but ignored (production): worth a warning. */
  optInIgnored: boolean;
} {
  const raw = (env("VOICE_AGENT_ENV") ?? "").trim().toLowerCase();
  const environment = raw === "development" || raw === "staging" ? raw : "production";
  const optIn = (env("VOICE_AGENT_ALLOW_DRAFT_AGENT_CONFIG") ?? "").trim().toLowerCase() === "true";
  return {
    environment,
    allowDraft: environment !== "production" && optIn,
    optInIgnored: environment === "production" && optIn,
  };
}

export interface AgentConfigDeps {
  /** agent-service.server.ts loadSnapshot (live configuration). */
  loadSnapshot: (db: Client, businessId: string) => Promise<AgentSnapshot>;
  /** agent-instructions.ts functions. */
  withCurrentCallSections: typeof import("@/lib/agent-instructions").withCurrentCallSections;
  buildAgentInstructions: typeof import("@/lib/agent-instructions").buildAgentInstructions;
  validateAgentConfig: typeof import("@/lib/agent-instructions").validateAgentConfig;
}

export async function defaultAgentConfigDeps(): Promise<AgentConfigDeps> {
  const [agentService, instr] = await Promise.all([
    import("@/lib/agent-service.server"),
    import("@/lib/agent-instructions"),
  ]);
  return {
    loadSnapshot: (db, id) => agentService.loadSnapshot(db, id),
    withCurrentCallSections: instr.withCurrentCallSections,
    buildAgentInstructions: instr.buildAgentInstructions,
    validateAgentConfig: instr.validateAgentConfig,
  };
}

export async function resolveCallAgentConfig(
  db: Client,
  businessId: string,
  deps: AgentConfigDeps,
  now: Date = new Date(),
  /** draftConfigPolicy(...).allowDraft; default false (production behaviour). */
  opts: { allowDraft?: boolean } = {},
): Promise<CallAgentConfig> {
  const [{ data: publishedVersion }, { data: businessRow }, servicesRes] = await Promise.all([
    db
      .from("agent_versions")
      .select("version, snapshot, instructions")
      .eq("business_id", businessId)
      .eq("status", "active")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from("businesses")
      .select("name, country, timezone, currency")
      .eq("id", businessId)
      .maybeSingle(),
    Promise.resolve(
      db
        .from("services")
        .select(
          "id, name, description, category, price, currency, duration_minutes, attributes, is_active",
        )
        .eq("business_id", businessId)
        .eq("is_active", true)
        .order("sort_order"),
    ).catch((error: unknown) => ({ data: null, error })),
  ]);
  if (!businessRow) return { ok: false, reason: "no_business", fields: [] };

  const liveRows = servicesRes.error ? null : (servicesRes.data ?? []);
  const liveServices = liveRows as unknown as AgentSnapshot["services"] | null;
  const services: CallAgentService[] = (
    (liveRows ?? []) as {
      id: string;
      name: string;
      price: number | null;
      duration_minutes: number | null;
      is_active: boolean;
    }[]
  )
    .filter((r) => r.is_active)
    .map((r) => ({
      id: r.id,
      name: r.name,
      price: r.price ?? null,
      durationMinutes: r.duration_minutes ?? null,
    }));

  if (publishedVersion) {
    const snapshot = publishedVersion.snapshot as unknown as AgentSnapshot | null;
    const missing = [
      typeof publishedVersion.instructions === "string" && publishedVersion.instructions.trim()
        ? null
        : "instructions",
      snapshot?.agent ? null : "agent",
      snapshot?.business?.name ? null : "business",
    ].filter((x): x is string => x !== null);
    if (!snapshot || missing.length) {
      return { ok: false, reason: "invalid_published_version", fields: missing };
    }
    const timezone = businessRow.timezone ?? snapshot.business.timezone ?? "Asia/Kolkata";
    return {
      ok: true,
      source: "published_version",
      agentVersion: publishedVersion.version,
      instructions: deps.withCurrentCallSections(
        publishedVersion.instructions,
        snapshot.agent,
        liveServices,
        { now, timezone },
      ),
      agent: snapshot.agent,
      businessName: snapshot.business.name,
      timezone,
      country: businessRow.country ?? null,
      currency: businessRow.currency ?? snapshot.business.currency ?? "INR",
      services,
      servicesUnavailable: liveRows === null,
    };
  }

  if (!opts.allowDraft) return { ok: false, reason: "no_published_version", fields: [] };
  const snapshot = await deps.loadSnapshot(db, businessId);
  const issues = deps.validateAgentConfig(snapshot);
  if (issues.length) {
    return { ok: false, reason: "agent_config_incomplete", fields: issues.map((i) => i.field) };
  }
  return {
    ok: true,
    source: "live_snapshot",
    agentVersion: null,
    instructions: deps.buildAgentInstructions(snapshot),
    agent: snapshot.agent,
    businessName: snapshot.business.name,
    timezone: businessRow.timezone ?? snapshot.business.timezone ?? "Asia/Kolkata",
    country: businessRow.country ?? null,
    currency: businessRow.currency ?? snapshot.business.currency ?? "INR",
    services,
    servicesUnavailable: liveRows === null,
  };
}
