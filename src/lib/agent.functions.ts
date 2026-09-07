import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { buildAgentInstructions, validateAgentConfig } from "./agent-instructions";
import { loadSnapshot, requireBusinessAccess } from "./agent-service.server";
import { sarvam, ProviderError } from "./sarvam.server";
import { assertFeatureUnlocked } from "./feature-gate.server.ts";

export const getProviderStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({
    ai: sarvam.isConfigured() ? ("connected" as const) : ("not_connected" as const),
    aiProvider: "Sarvam AI",
    deploymentSupported: sarvam.deploymentSupported(),
    telephony: "not_connected" as const,
  }));

// previewAgentConfig, testAgentText and synthesizeVoicePreview are
// deliberately NOT feature-gated: they configure and preview an agent
// (read-only or sandboxed, never touch agent_versions/agent_configs'
// active/published state) rather than activating or running the voice
// receptionist for real callers — a customer mid-setup, before any
// payment, must still be able to prepare their agent. The actual gated
// actions are publishAgentVersion/rollbackAgentVersion (activation, below)
// and the real call path (checkTelephonyAccess in telephony-guard.server.ts,
// unchanged by this file).
export const previewAgentConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ businessId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const snapshot = await loadSnapshot(context.supabase, data.businessId);
    return {
      instructions: buildAgentInstructions(snapshot),
      issues: validateAgentConfig(snapshot),
    };
  });

export const publishAgentVersion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ businessId: z.string().uuid(), changeNote: z.string().max(300).optional() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { organizationId } = await requireBusinessAccess(context.supabase, data.businessId);
    // Publishing makes this version the one a real call uses (per the
    // "voice" feature's own description: "Publishing and running the
    // voice receptionist") — this is activation, not configuration, so it
    // must independently enforce the canonical feature gate server-side.
    // organizationId above is resolved from the businessId's row via the
    // caller's RLS-scoped client, never from a client-supplied org id, so
    // a customer cannot name another tenant's organization to bypass this.
    await assertFeatureUnlocked(organizationId, "voice");

    const snapshot = await loadSnapshot(context.supabase, data.businessId);
    const issues = validateAgentConfig(snapshot);
    if (issues.length) return { ok: false as const, issues };

    const instructions = buildAgentInstructions(snapshot);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: last } = await supabaseAdmin
      .from("agent_versions")
      .select("version")
      .eq("business_id", data.businessId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    const version = (last?.version ?? 0) + 1;

    const { error: insertError } = await supabaseAdmin.from("agent_versions").insert({
      organization_id: organizationId,
      business_id: data.businessId,
      version,
      snapshot: JSON.parse(JSON.stringify(snapshot)),
      instructions,
      status: "active",
      change_note: data.changeNote ?? "Configuration updated",
      created_by: context.userId,
    });
    if (insertError) throw new Error("Could not save the new agent version. Please retry.");

    await supabaseAdmin
      .from("agent_versions")
      .update({ status: "archived" })
      .eq("business_id", data.businessId)
      .neq("version", version);

    // Sarvam has no public agent-deployment API, so the runtime stays "ready"
    // (configuration generated and stored) until a phone number is connected.
    await supabaseAdmin
      .from("agent_configs")
      .update({ active_version: version, status: "ready" })
      .eq("business_id", data.businessId);

    return { ok: true as const, version, issues: [] as { field: string; message: string }[] };
  });

export const rollbackAgentVersion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ businessId: z.string().uuid(), version: z.number().int() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { organizationId } = await requireBusinessAccess(context.supabase, data.businessId);
    // Rollback re-activates a previous version the same way publish does
    // (agent_versions.status + agent_configs.active_version) — same gate,
    // same reasoning as publishAgentVersion above.
    await assertFeatureUnlocked(organizationId, "voice");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: target } = await supabaseAdmin
      .from("agent_versions")
      .select("version")
      .eq("business_id", data.businessId)
      .eq("version", data.version)
      .maybeSingle();
    if (!target) throw new Error("That version no longer exists.");
    await supabaseAdmin
      .from("agent_versions")
      .update({ status: "archived" })
      .eq("business_id", data.businessId);
    await supabaseAdmin
      .from("agent_versions")
      .update({ status: "active" })
      .eq("business_id", data.businessId)
      .eq("version", data.version);
    await supabaseAdmin
      .from("agent_configs")
      .update({ active_version: data.version })
      .eq("business_id", data.businessId);
    return { ok: true as const, version: data.version };
  });

export const testAgentText = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        businessId: z.string().uuid(),
        history: z
          .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) }))
          .max(24),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const started = Date.now();
    const snapshot = await loadSnapshot(context.supabase, data.businessId);
    const instructions = buildAgentInstructions(snapshot);
    try {
      const { reply, usage } = await sarvam.runConversation([
        { role: "system", content: instructions },
        ...data.history,
      ]);
      return {
        ok: true as const,
        reply,
        latencyMs: Date.now() - started,
        usage,
        language: snapshot.agent.primary_language,
      };
    } catch (error) {
      const message =
        error instanceof ProviderError
          ? error.message
          : "The assistant could not respond. Please retry.";
      return { ok: false as const, error: message, latencyMs: Date.now() - started };
    }
  });

export const synthesizeVoicePreview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        voiceId: z.string().min(1).max(40),
        language: z.string().min(2).max(10),
        pace: z.number().min(0.5).max(2),
        text: z.string().min(1).max(400),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    try {
      const audio = await sarvam.generateSpeech({
        text: data.text,
        speaker: data.voiceId,
        language: data.language,
        pace: data.pace,
      });
      return { ok: true as const, audioBase64: audio };
    } catch (error) {
      const message =
        error instanceof ProviderError ? error.message : "Voice preview failed. Please retry.";
      return { ok: false as const, error: message };
    }
  });
