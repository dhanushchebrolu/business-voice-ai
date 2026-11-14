import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin, writeAudit } from "@/lib/platform-admin.server";
import {
  sarvamAgentConfigPatch,
  validateVoiceLanguageSettings,
  type VoiceLanguageSettingsInput,
} from "@/lib/sarvam-voice-catalog";

/**
 * Voice & language settings for a customer's own Sarvam agent, set by the
 * ClickAI onboarding team (platform admins only). Customers have no write
 * path; they can read their row under RLS (for a future dashboard section).
 *
 * Saving never claims the Sarvam agent changed: Sarvam has no unattended API
 * for agent voice/language, so a save is 'pending' until an admin records
 * the committed Sarvam agent version that carries it (markVoiceLanguageApplied).
 */

const SELECT =
  "id, agent_config_id, default_language, allowed_languages, auto_language_switch, sarvam_voice_internal_id, sarvam_voice_name, status, applied_sarvam_app_id, applied_sarvam_app_version, applied_at, updated_at";

export const getVoiceLanguageSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: agent, error: agentError } = await supabaseAdmin
      .from("agent_configs")
      .select("id, agent_name, primary_language, sarvam_app_id, sarvam_app_version")
      .eq("organization_id", data.orgId)
      .maybeSingle();
    if (agentError) throw agentError;
    if (!agent) return { agent: null, settings: null };
    const { data: settings, error } = await supabaseAdmin
      .from("agent_voice_language_settings")
      .select(SELECT)
      .eq("agent_config_id", agent.id)
      .maybeSingle();
    if (error) throw error;
    return { agent, settings };
  });

export const saveVoiceLanguageSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (
      input: VoiceLanguageSettingsInput & { orgId: string; agentConfigId: string; reason: string },
    ) => {
      if (!input?.orgId || !input.agentConfigId)
        throw new Error("orgId and agentConfigId are required");
      if (!input.reason?.trim()) throw new Error("A reason is required");
      if (!Array.isArray(input.allowedLanguages))
        throw new Error("allowedLanguages must be a list");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const settings = validateVoiceLanguageSettings(data);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: agent } = await supabaseAdmin
      .from("agent_configs")
      .select("id, organization_id")
      .eq("id", data.agentConfigId)
      .maybeSingle();
    if (!agent || agent.organization_id !== data.orgId)
      throw new Error("That agent does not belong to this customer.");

    const { data: before } = await supabaseAdmin
      .from("agent_voice_language_settings")
      .select(SELECT)
      .eq("agent_config_id", agent.id)
      .maybeSingle();

    const row = {
      organization_id: data.orgId,
      agent_config_id: agent.id,
      default_language: settings.defaultLanguage,
      allowed_languages: settings.allowedLanguages,
      auto_language_switch: settings.autoLanguageSwitch,
      sarvam_voice_internal_id: settings.voice.internalId,
      sarvam_voice_name: settings.voice.name,
      // Any change must be applied to the Sarvam agent again.
      status: "pending",
      applied_sarvam_app_id: null,
      applied_sarvam_app_version: null,
      applied_at: null,
      applied_by: null,
      updated_by: context.userId,
    };
    const { error } = await supabaseAdmin
      .from("agent_voice_language_settings")
      .upsert(row, { onConflict: "agent_config_id" });
    if (error) throw error;

    await writeAudit(admin, {
      action: "VOICE_LANGUAGE_SETTINGS_SAVED",
      entityType: "agent_config",
      entityId: agent.id,
      organizationId: data.orgId,
      oldValue: before ?? null,
      newValue: {
        default_language: row.default_language,
        allowed_languages: row.allowed_languages,
        auto_language_switch: row.auto_language_switch,
        sarvam_voice_internal_id: row.sarvam_voice_internal_id,
      },
      reason: data.reason,
    });
    return {
      status: "pending" as const,
      warnings: settings.warnings,
      sarvamConfig: sarvamAgentConfigPatch(settings),
    };
  });

/**
 * Records that the customer's Sarvam agent now carries the saved settings.
 * The version must be the one ClickAI has mapped for this agent, so
 * "applied" always refers to the version calls actually run on.
 */
export const markVoiceLanguageApplied = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orgId: string; sarvamAppVersion: number; reason: string }) => {
    if (!input?.orgId) throw new Error("orgId is required");
    if (!Number.isInteger(input.sarvamAppVersion) || input.sarvamAppVersion < 1)
      throw new Error("sarvamAppVersion must be a positive integer");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: agent } = await supabaseAdmin
      .from("agent_configs")
      .select("id, sarvam_app_id, sarvam_app_version")
      .eq("organization_id", data.orgId)
      .maybeSingle();
    if (!agent) throw new Error("This customer has no agent.");
    if (!agent.sarvam_app_id) throw new Error("Register the customer's Sarvam agent first.");
    if (agent.sarvam_app_version !== data.sarvamAppVersion)
      throw new Error(
        `This customer's agent is mapped to Sarvam version ${agent.sarvam_app_version ?? "none"}, not ${data.sarvamAppVersion}. Map the new version first.`,
      );
    const { data: updated, error } = await supabaseAdmin
      .from("agent_voice_language_settings")
      .update({
        status: "applied",
        // The agent the version belongs to: a version number alone could match another agent.
        applied_sarvam_app_id: agent.sarvam_app_id,
        applied_sarvam_app_version: data.sarvamAppVersion,
        applied_at: new Date().toISOString(),
        applied_by: context.userId,
      })
      .eq("agent_config_id", agent.id)
      .eq("organization_id", data.orgId)
      .select("id");
    if (error) throw error;
    if (!updated?.length) throw new Error("Save the voice and language settings first.");
    await writeAudit(admin, {
      action: "VOICE_LANGUAGE_SETTINGS_APPLIED",
      entityType: "agent_config",
      entityId: agent.id,
      organizationId: data.orgId,
      newValue: {
        applied_sarvam_app_id: agent.sarvam_app_id,
        applied_sarvam_app_version: data.sarvamAppVersion,
      },
      reason: data.reason,
    });
    return { status: "applied" as const };
  });
