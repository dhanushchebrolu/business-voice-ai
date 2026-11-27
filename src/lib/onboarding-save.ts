import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DAYS, getBusinessType } from "./business-types.ts";
import { describeBusinessHoursWriteError } from "./calendar/business-hours-validation.ts";

/**
 * Saves the setup wizard. The writes are separate (the browser client has no transaction), so
 * every one is checked and the whole save can be run again after a failure: it continues the
 * same business and never duplicates what is already there. The receptionist (agent_configs) is
 * written last, so a customer without one is sent back to the wizard (app.tsx). A customer who
 * already has a receptionist is set up: nothing of theirs is overwritten.
 */

export interface OnboardingInput {
  orgId: string;
  typeId: string;
  info: {
    name: string;
    description: string;
    address: string;
    city: string;
    state: string;
    postal_code: string;
    primary_phone: string;
    email: string;
    website: string;
  };
  openDays: number[];
  openTime: string;
  closeTime: string;
  items: { name: string; price: string }[];
  agentName: string;
  language: string;
  voiceId: string;
  greeting: string;
}

export async function saveOnboarding(
  supabase: SupabaseClient<Database>,
  input: OnboardingInput,
): Promise<{ alreadySetUp: boolean }> {
  const { orgId, info } = input;
  const type = getBusinessType(input.typeId);
  const check = (error: { message: string } | null) => {
    if (error) throw new Error(error.message);
  };
  const markCompleted = async () => {
    const { error } = await supabase
      .from("organizations")
      .update({ onboarding_completed: true })
      .eq("id", orgId);
    check(error);
  };

  // Any receptionist of this customer, on whichever business: never a second one.
  const { data: agents, error: agentsError } = await supabase
    .from("agent_configs")
    .select("id")
    .eq("organization_id", orgId)
    .limit(1);
  check(agentsError);
  if (agents?.length) {
    await markCompleted();
    return { alreadySetUp: true };
  }

  // The same business the workspace shows (workspaceQuery: the first one).
  const { data: existing, error: existingError } = await supabase
    .from("businesses")
    .select("id")
    .eq("organization_id", orgId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  check(existingError);

  const required = {
    name: info.name.trim(),
    business_type: input.typeId,
    description: info.description.trim(),
  };
  const optional = {
    address: info.address,
    city: info.city,
    state: info.state,
    postal_code: info.postal_code,
    primary_phone: info.primary_phone,
    email: info.email,
    website: info.website,
  };
  let businessId: string;
  if (existing) {
    // A field left blank this time keeps what was saved before.
    const filled = Object.fromEntries(Object.entries(optional).filter(([, v]) => v));
    const { error } = await supabase
      .from("businesses")
      .update({ ...required, ...filled })
      .eq("id", existing.id)
      .eq("organization_id", orgId);
    check(error);
    businessId = existing.id;
  } else {
    const { data, error } = await supabase
      .from("businesses")
      .insert({
        organization_id: orgId,
        ...required,
        ...(Object.fromEntries(Object.entries(optional).map(([k, v]) => [k, v || null])) as Record<
          keyof typeof optional,
          string | null
        >),
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    businessId = data.id;
  }
  const owned = { organization_id: orgId, business_id: businessId };

  const hours = DAYS.map((_, day) => ({
    ...owned,
    day_of_week: day,
    is_closed: !input.openDays.includes(day),
    // {start, end} — matches calendar-service.server.ts's BusinessHoursInterval (the booking
    // engine's own contract).
    intervals: input.openDays.includes(day)
      ? [{ start: input.openTime, end: input.closeTime }]
      : [],
  }));
  const { error: hoursError } = await supabase
    .from("business_hours")
    .upsert(hours, { onConflict: "business_id,day_of_week" });
  if (hoursError)
    throw new Error(describeBusinessHoursWriteError(hoursError) ?? hoursError.message);

  const saved = async (table: "services" | "faqs" | "business_rules") => {
    const { data, error } = await supabase.from(table).select("*").eq("business_id", businessId);
    check(error);
    return data ?? [];
  };

  const have = new Set((await saved("services")).map((s) => (s as { name: string }).name));
  const services = input.items
    .filter((i) => i.name.trim() && !have.has(i.name.trim()))
    .map((i, idx) => ({
      ...owned,
      name: i.name.trim(),
      price: i.price ? Number(i.price) : null,
      sort_order: have.size + idx,
    }));
  if (services.length) check((await supabase.from("services").insert(services)).error);

  if (type.suggestedFaqs.length && !(await saved("faqs")).length) {
    const faqs = type.suggestedFaqs.map((f, idx) => ({
      ...owned,
      question: f.question,
      answer: f.answer,
      sort_order: idx,
    }));
    check((await supabase.from("faqs").insert(faqs)).error);
  }

  if (type.suggestedRules.length && !(await saved("business_rules")).length) {
    const rules = type.suggestedRules.map((r, idx) => ({ ...owned, rule: r, priority: idx + 1 }));
    check((await supabase.from("business_rules").insert(rules)).error);
  }

  const { error: agentError } = await supabase.from("agent_configs").insert({
    organization_id: orgId,
    business_id: businessId,
    agent_name: input.agentName,
    primary_language: input.language,
    voice_id: input.voiceId,
    greetings: { [input.language]: input.greeting },
    capabilities: {
      answer_faqs: true,
      explain_services: true,
      quote_prices: true,
      check_hours: true,
      capture_lead: true,
      collect_details: true,
    },
    objectives: ["answer_questions", "handle_faqs", "capture_leads", "provide_pricing"],
  });
  // 23505: another tab saved the receptionist first; the setup is complete.
  if (agentError && (agentError as { code?: string }).code !== "23505") check(agentError);

  await markCompleted();
  return { alreadySetUp: false };
}
