/**
 * The first thing a caller hears. Shared by the dashboard preview and the
 * Sarvam call context so both always show the same text.
 *
 * An empty custom greeting means "automatic": a short welcome with the
 * business name and no self-introduction. A custom greeting is used as the
 * customer wrote it (never translated or rewritten); only the placeholders
 * {business_name} and {agent_name} are filled in.
 */
export const GREETING_MAX_LENGTH = 300;

export function automaticGreeting(businessName: string): string {
  const name = businessName.trim();
  return name
    ? `Welcome to ${name}. How can I help you today?`
    : "Hello. How can I help you today?";
}

export function renderGreeting(
  custom: string | null | undefined,
  values: { businessName: string; agentName?: string | null | undefined },
): string {
  const text = (custom ?? "").trim();
  if (!text) return automaticGreeting(values.businessName);
  return text
    .replace(/\{\{?\s*business_name\s*\}?\}/gi, values.businessName.trim())
    .replace(/\{\{?\s*agent_name\s*\}?\}/gi, (values.agentName ?? "").trim())
    .replace(/\s{2,}/g, " ")
    .slice(0, GREETING_MAX_LENGTH);
}

/** The custom greeting stored for a language (agent_configs.greetings is keyed by language code). */
export function customGreetingFor(greetings: unknown, language: string): string {
  if (!greetings || typeof greetings !== "object" || Array.isArray(greetings)) return "";
  const value = (greetings as Record<string, unknown>)[language];
  return typeof value === "string" ? value.trim() : "";
}
