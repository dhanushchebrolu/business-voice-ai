import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { AgentSnapshot } from "./agent-instructions";

type Client = SupabaseClient<Database>;

export async function loadSnapshot(supabase: Client, businessId: string): Promise<AgentSnapshot> {
  const [business, hours, services, faqs, rules, agent, knowledge] = await Promise.all([
    supabase.from("businesses").select("*").eq("id", businessId).maybeSingle(),
    supabase.from("business_hours").select("*").eq("business_id", businessId),
    supabase.from("services").select("*").eq("business_id", businessId).order("sort_order"),
    supabase.from("faqs").select("*").eq("business_id", businessId).order("sort_order"),
    supabase.from("business_rules").select("*").eq("business_id", businessId).order("priority"),
    supabase.from("agent_configs").select("*").eq("business_id", businessId).maybeSingle(),
    supabase.from("knowledge_documents").select("title, content, status").eq("business_id", businessId).eq("status", "ready"),
  ]);

  if (!business.data) throw new Error("Business not found in your workspace.");
  const a = agent.data;

  return {
    business: {
      name: business.data.name,
      business_type: business.data.business_type,
      description: business.data.description,
      address: business.data.address,
      city: business.data.city,
      state: business.data.state,
      country: business.data.country,
      postal_code: business.data.postal_code,
      website: business.data.website,
      email: business.data.email,
      primary_phone: business.data.primary_phone,
      whatsapp: business.data.whatsapp,
      timezone: business.data.timezone,
      currency: business.data.currency,
    },
    hours: (hours.data ?? []).map((h) => ({
      day_of_week: h.day_of_week,
      is_closed: h.is_closed,
      intervals: (h.intervals as unknown as { from: string; to: string }[]) ?? [],
    })),
    services: (services.data ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      category: s.category,
      price: s.price == null ? null : Number(s.price),
      currency: s.currency,
      duration_minutes: s.duration_minutes,
      attributes: (s.attributes as unknown as Record<string, string>) ?? {},
      is_active: s.is_active,
    })),
    faqs: (faqs.data ?? []).map((f) => ({ question: f.question, answer: f.answer, is_active: f.is_active })),
    rules: (rules.data ?? []).map((r) => ({ rule: r.rule, priority: r.priority, is_active: r.is_active })),
    knowledge: (knowledge.data ?? []).map((k) => ({ title: k.title, content: k.content })),
    agent: {
      agent_name: a?.agent_name ?? "Aria",
      persona: a?.persona ?? "professional",
      custom_personality: a?.custom_personality ?? null,
      objectives: a?.objectives ?? ["answer_questions"],
      capabilities: (a?.capabilities as unknown as Record<string, boolean>) ?? {},
      primary_language: a?.primary_language ?? "en-IN",
      extra_languages: a?.extra_languages ?? [],
      multilingual: a?.multilingual ?? false,
      voice_id: a?.voice_id ?? "ritu",
      speaking_pace: Number(a?.speaking_pace ?? 1),
      greetings: (a?.greetings as unknown as Record<string, string>) ?? {},
      transfer_number: a?.transfer_number ?? null,
      after_hours_behavior: a?.after_hours_behavior ?? "take_message",
    },
  };
}

export async function requireBusinessAccess(supabase: Client, businessId: string): Promise<{ organizationId: string }> {
  const { data } = await supabase.from("businesses").select("id, organization_id").eq("id", businessId).maybeSingle();
  if (!data) throw new Error("Business not found in your workspace.");
  return { organizationId: data.organization_id };
}
