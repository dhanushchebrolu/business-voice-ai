import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * The Sarvam client-context endpoint (Task #94): what lets a Sarvam agent
 * answer a caller's questions about the specific business behind whichever
 * number/deployment/connection the call arrived on. Two responsibilities,
 * kept in this one file since they must never be split apart: resolving
 * WHICH organization a request is about, and WHAT to tell Sarvam about it.
 *
 * Tenant resolution is the entire security model here. Nothing accepts a
 * caller-supplied organization_id — there is no such field in this file's
 * public interface, and there never should be one. The only inputs trusted
 * are identifiers Klyro itself assigned and that only genuinely belong to
 * one organization each: a currently-active phone number's E.164, a
 * registered Sarvam connection's provider_connection_id, or a deployment's
 * provider_deployment_id. Each is looked up against Klyro's own tables;
 * none is trusted at face value.
 *
 * DOCUMENTED, STABLE RESPONSE SCHEMA (SarvamClientContext below) — treat
 * this as a versioned contract: adding fields is fine, renaming or removing
 * one is a breaking change for whatever Sarvam configuration references it.
 *
 * VERIFICATION STATUS: Sarvam's own mechanism for calling out to a
 * "business context" tool mid-call (its shape, timing, and whether the
 * on-start API tool in Sarvam's dashboard can be configured via API at all
 * rather than only manually) is NOT confirmed — no Sarvam documentation for
 * this specific capability was available to this session (see the module
 * doc in telephony/sarvam-provider.server.ts for the same egress
 * constraint). This file only controls Klyro's side: a plain authenticated
 * HTTP GET that returns business data for a resolved organization. Wiring
 * a specific Sarvam deployment's on-start tool to call this URL is,
 * given that, a manual one-time step in Sarvam's dashboard per
 * connection/deployment (the same category of manual step as connection
 * registration and agent-app creation documented elsewhere) — not
 * something this endpoint or any function in this codebase can automate,
 * since no API for configuring it was found.
 */

export interface SarvamClientContext {
  business: {
    name: string;
    businessType: string;
    description: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    postalCode: string | null;
    website: string | null;
    email: string | null;
    primaryPhone: string | null;
    secondaryPhone: string | null;
    whatsapp: string | null;
    timezone: string;
    currency: string;
  };
  hours: Array<{ dayOfWeek: number; isClosed: boolean; intervals: unknown }>;
  services: Array<{
    name: string;
    description: string | null;
    category: string | null;
    price: number | null;
    currency: string;
    durationMinutes: number | null;
  }>;
  faqs: Array<{ question: string; answer: string; category: string | null }>;
  rules: Array<{ rule: string; priority: number }>;
  knowledge: Array<{ title: string; content: string }>;
  agent: {
    name: string;
    persona: string;
    customPersonality: string | null;
    objectives: string[];
    primaryLanguage: string;
    extraLanguages: string[];
    multilingual: boolean;
    voiceId: string;
    speakingPace: number;
    greetings: unknown;
    transferNumber: string | null;
    afterHoursBehavior: string;
  } | null;
}

export interface ResolveContextParams {
  phoneNumber?: string | undefined;
  connectionId?: string | undefined;
  deploymentId?: string | undefined;
}

/**
 * Resolves the one organization a context request is about, in priority
 * order deployment_id > connection_id > phone_number (most specific and
 * least reusable identifier first). Returns null if none of the supplied
 * identifiers resolve to a real, currently-valid Klyro record — never
 * guesses, never falls back to "the most recently active organization" or
 * any other heuristic.
 */
export async function resolveOrganizationForSarvamContext(
  supabaseAdmin: SupabaseClient<Database>,
  params: ResolveContextParams,
): Promise<string | null> {
  if (params.deploymentId) {
    const { data } = await supabaseAdmin
      .from("phone_numbers")
      .select("organization_id")
      .eq("provider", "sarvam")
      .eq("provider_deployment_id", params.deploymentId)
      .not("organization_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (data?.organization_id) return data.organization_id;
  }

  if (params.connectionId) {
    const { data } = await supabaseAdmin
      .from("telephony_connections")
      .select("organization_id")
      .eq("provider", "sarvam")
      .eq("provider_connection_id", params.connectionId)
      .maybeSingle();
    if (data?.organization_id) return data.organization_id;
  }

  if (params.phoneNumber) {
    const { data } = await supabaseAdmin
      .from("phone_numbers")
      .select("organization_id")
      .eq("provider", "sarvam")
      .eq("e164", params.phoneNumber)
      .eq("status", "active")
      .not("organization_id", "is", null)
      .maybeSingle();
    if (data?.organization_id) return data.organization_id;
  }

  return null;
}

/**
 * Builds the documented business-context payload for an already-resolved
 * organization. Returns null only if the organization has no business
 * record yet (onboarding incomplete) — callers must respond 404, never
 * substitute placeholder content.
 */
export async function buildSarvamClientContext(
  supabaseAdmin: SupabaseClient<Database>,
  organizationId: string,
): Promise<SarvamClientContext | null> {
  const { data: business } = await supabaseAdmin
    .from("businesses")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!business) return null;

  const [
    { data: hours },
    { data: services },
    { data: faqs },
    { data: rules },
    { data: docs },
    { data: agent },
  ] = await Promise.all([
    supabaseAdmin
      .from("business_hours")
      .select("day_of_week, is_closed, intervals")
      .eq("business_id", business.id)
      .order("day_of_week", { ascending: true }),
    supabaseAdmin
      .from("services")
      .select("name, description, category, price, currency, duration_minutes")
      .eq("business_id", business.id)
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    supabaseAdmin
      .from("faqs")
      .select("question, answer, category")
      .eq("business_id", business.id)
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    supabaseAdmin
      .from("business_rules")
      .select("rule, priority")
      .eq("business_id", business.id)
      .eq("is_active", true)
      .order("priority", { ascending: true }),
    supabaseAdmin
      .from("knowledge_documents")
      .select("title, content")
      .eq("business_id", business.id)
      .eq("status", "ready")
      .not("content", "is", null),
    supabaseAdmin
      .from("agent_configs")
      .select(
        "agent_name, persona, custom_personality, objectives, primary_language, extra_languages, multilingual, voice_id, speaking_pace, greetings, transfer_number, after_hours_behavior",
      )
      .eq("business_id", business.id)
      .maybeSingle(),
  ]);

  return {
    business: {
      name: business.name,
      businessType: business.business_type,
      description: business.description,
      address: business.address,
      city: business.city,
      state: business.state,
      country: business.country,
      postalCode: business.postal_code,
      website: business.website,
      email: business.email,
      primaryPhone: business.primary_phone,
      secondaryPhone: business.secondary_phone,
      whatsapp: business.whatsapp,
      timezone: business.timezone,
      currency: business.currency,
    },
    hours: (hours ?? []).map((h) => ({
      dayOfWeek: h.day_of_week,
      isClosed: h.is_closed,
      intervals: h.intervals,
    })),
    services: (services ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      category: s.category,
      price: s.price,
      currency: s.currency,
      durationMinutes: s.duration_minutes,
    })),
    faqs: (faqs ?? []).map((f) => ({
      question: f.question,
      answer: f.answer,
      category: f.category,
    })),
    rules: (rules ?? []).map((r) => ({ rule: r.rule, priority: r.priority })),
    knowledge: (docs ?? [])
      .filter((d): d is { title: string; content: string } => Boolean(d.content))
      .map((d) => ({ title: d.title, content: d.content })),
    agent: agent
      ? {
          name: agent.agent_name,
          persona: agent.persona,
          customPersonality: agent.custom_personality,
          objectives: agent.objectives,
          primaryLanguage: agent.primary_language,
          extraLanguages: agent.extra_languages,
          multilingual: agent.multilingual,
          voiceId: agent.voice_id,
          speakingPace: agent.speaking_pace,
          greetings: agent.greetings,
          transferNumber: agent.transfer_number,
          afterHoursBehavior: agent.after_hours_behavior,
        }
      : null,
  };
}
