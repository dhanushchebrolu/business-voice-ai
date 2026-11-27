import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { DAYS, getBusinessType } from "./business-types.ts";
import { describeBusinessHoursWriteError } from "./calendar/business-hours-validation.ts";

/**
 * The setup wizard's data: what is already saved (to prefill it) and the save.
 *
 * The save is one database function (save_business_setup, migration 20261205090000): a single
 * transaction, one submission at a time per customer. Two things are sent:
 *   changes  what the person edited on screen. Applied; a blank never replaces a saved value.
 *   initial  everything on screen, used only for what does not exist yet.
 * So a second tab, or a wizard opened before another save, cannot put its untouched defaults
 * over saved data.
 */

const INFO_KEYS = [
  "name",
  "description",
  "address",
  "city",
  "state",
  "postal_code",
  "primary_phone",
  "email",
  "website",
] as const;

export type OnboardingInfo = Record<(typeof INFO_KEYS)[number], string>;

export interface OnboardingForm {
  typeId: string;
  info: OnboardingInfo;
  openDays: number[];
  openTime: string;
  closeTime: string;
  /** `id`: a saved service. */
  items: { id?: string; name: string; price: string }[];
  agentName: string;
  language: string;
  voiceId: string;
  greeting: string;
}

export interface SavedSetup {
  business:
    | ({ business_type: string | null } & Partial<Record<keyof OnboardingInfo, string | null>>)
    | null;
  hours: { day_of_week: number; is_closed: boolean; intervals: unknown }[];
  services: { id: string; name: string; price: number | null }[];
  agent: {
    agent_name: string | null;
    primary_language: string | null;
    voice_id: string | null;
    greetings: unknown;
  } | null;
}

/** Reads the customer's saved setup. Any failed read throws: it must never look like "nothing saved". */
export async function loadSetup(
  supabase: SupabaseClient<Database>,
  orgId: string,
): Promise<SavedSetup> {
  // The same records the save writes to: the receptionist's business, else the first business.
  const { data: agent, error: agentError } = await supabase
    .from("agent_configs")
    .select("business_id, agent_name, primary_language, voice_id, greetings")
    .eq("organization_id", orgId)
    .order("created_at")
    .order("id")
    .limit(1)
    .maybeSingle();
  if (agentError) throw agentError;
  let query = supabase.from("businesses").select("*").eq("organization_id", orgId);
  if (agent) query = query.eq("id", agent.business_id);
  const { data: business, error: businessError } = await query
    .order("created_at")
    .order("id")
    .limit(1)
    .maybeSingle();
  if (businessError) throw businessError;
  if (!business) return { business: null, hours: [], services: [], agent };
  const [hours, services] = await Promise.all([
    supabase
      .from("business_hours")
      .select("day_of_week, is_closed, intervals")
      .eq("business_id", business.id)
      .order("day_of_week"),
    supabase
      .from("services")
      .select("id, name, price")
      .eq("business_id", business.id)
      .order("sort_order")
      .order("created_at"),
  ]);
  if (hours.error) throw hours.error;
  if (services.error) throw services.error;
  return { business, hours: hours.data ?? [], services: services.data ?? [], agent };
}

const firstInterval = (intervals: unknown) => {
  const first = Array.isArray(intervals)
    ? (intervals[0] as { start?: unknown; end?: unknown } | undefined)
    : undefined;
  return typeof first?.start === "string" && typeof first.end === "string"
    ? { start: first.start, end: first.end }
    : null;
};

/** The wizard shows one opening time; true when saved days differ or have breaks. */
export function hasMixedHours(saved: SavedSetup): boolean {
  const open = saved.hours.filter((h) => !h.is_closed);
  return (
    new Set(open.map((h) => JSON.stringify(h.intervals))).size > 1 ||
    open.some((h) => Array.isArray(h.intervals) && h.intervals.length > 1)
  );
}

/** The wizard as it opens: saved values where there are any, the usual defaults elsewhere. */
export function formFromSaved(saved: SavedSetup): OnboardingForm {
  const open = saved.hours.filter((h) => !h.is_closed);
  const time = open.map((h) => firstInterval(h.intervals)).find(Boolean);
  const language = saved.agent?.primary_language || "en-IN";
  const greetings = (saved.agent?.greetings ?? {}) as Record<string, unknown>;
  const greeting = greetings[language];
  return {
    typeId: saved.business?.business_type ?? "",
    info: Object.fromEntries(
      INFO_KEYS.map((k) => [k, saved.business?.[k] ?? ""]),
    ) as OnboardingInfo,
    openDays: saved.hours.length ? open.map((h) => h.day_of_week) : [1, 2, 3, 4, 5, 6],
    openTime: time?.start ?? "09:00",
    closeTime: time?.end ?? "19:00",
    items: saved.services.length
      ? saved.services.map((s) => ({
          id: s.id,
          name: s.name,
          price: s.price === null ? "" : String(Number(s.price)),
        }))
      : [1, 2, 3].map(() => ({ name: "", price: "" })),
    agentName: saved.agent?.agent_name || "Aria",
    language,
    voiceId: saved.agent?.voice_id || "simran",
    greeting: typeof greeting === "string" ? greeting : "",
  };
}

const price = (text: string) => {
  const n = Number(text);
  return text.trim() && Number.isFinite(n) ? n : null;
};
/** Edited, and not to a blank. */
const edited = (now: string, was: string) => now.trim() !== "" && now.trim() !== was.trim();
const only = (entries: [string, string | false][]): Record<string, string> =>
  Object.fromEntries(entries.filter((e): e is [string, string] => Boolean(e[1])));

/** What to send: `loaded` is the form as it opened. */
export function buildSetupPayload(
  form: OnboardingForm,
  loaded: OnboardingForm,
  defaultGreeting: string,
) {
  const type = getBusinessType(form.typeId);
  const day = (d: number) => {
    const open = form.openDays.includes(d);
    return {
      day_of_week: d,
      is_closed: !open,
      // {start, end} — matches calendar-service.server.ts's BusinessHoursInterval (the booking
      // engine's own contract).
      intervals: open ? [{ start: form.openTime, end: form.closeTime }] : [],
    };
  };
  const days = DAYS.map((_, d) => d);
  const timeEdited = form.openTime !== loaded.openTime || form.closeTime !== loaded.closeTime;

  return {
    initial: {
      business: only([
        ["business_type", form.typeId],
        ...INFO_KEYS.map((k): [string, string] => [k, form.info[k].trim()]),
      ]),
      hours: days.map(day),
      agent: {
        agent_name: form.agentName.trim(),
        primary_language: form.language,
        voice_id: form.voiceId,
        greeting: form.greeting.trim() || defaultGreeting,
        capabilities: {
          answer_faqs: true,
          explain_services: true,
          quote_prices: true,
          check_hours: true,
          capture_lead: true,
          collect_details: true,
        },
        objectives: ["answer_questions", "handle_faqs", "capture_leads", "provide_pricing"],
      },
      faqs: type.suggestedFaqs.map((f) => ({ question: f.question, answer: f.answer })),
      rules: type.suggestedRules,
    },
    changes: {
      business: only([
        ["business_type", edited(form.typeId, loaded.typeId) && form.typeId],
        ...INFO_KEYS.map((k): [string, string | false] => [
          k,
          edited(form.info[k], loaded.info[k]) && form.info[k].trim(),
        ]),
      ]),
      // Only the days the person touched: other saved days (and their breaks) stay.
      hours: days
        .filter((d) => {
          const open = form.openDays.includes(d);
          return open !== loaded.openDays.includes(d) || (open && timeEdited);
        })
        .map(day),
      services: form.items.flatMap((item) => {
        const row = { name: item.name.trim(), price: price(item.price) };
        if (!item.id) return row.name ? [row] : [];
        const was = loaded.items.find((i) => i.id === item.id);
        if (was && !edited(item.name, was.name) && !edited(item.price, was.price)) return [];
        return [{ id: item.id, ...row }];
      }),
      agent: only([
        ["agent_name", edited(form.agentName, loaded.agentName) && form.agentName.trim()],
        ["primary_language", edited(form.language, loaded.language) && form.language],
        ["voice_id", edited(form.voiceId, loaded.voiceId) && form.voiceId],
        ["greeting", edited(form.greeting, loaded.greeting) && form.greeting.trim()],
      ]),
    },
  };
}

export type SetupPayload = ReturnType<typeof buildSetupPayload>;

export async function saveOnboarding(
  supabase: SupabaseClient<Database>,
  orgId: string,
  payload: SetupPayload,
): Promise<{ createdAgent: boolean }> {
  const { data, error } = await supabase.rpc("save_business_setup", {
    _org: orgId,
    _initial: payload.initial as unknown as Json,
    _changes: payload.changes as unknown as Json,
  });
  if (error) {
    if (error.message.includes("BUSINESS_SETUP_NAME_REQUIRED"))
      throw new Error("Add your business name.");
    throw new Error(describeBusinessHoursWriteError(error) ?? error.message);
  }
  return { createdAgent: Boolean((data as { created_agent?: boolean } | null)?.created_agent) };
}
