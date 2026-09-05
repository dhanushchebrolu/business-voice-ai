/**
 * Runtime validation for the public assistant's request shape. TypeScript
 * types alone only constrain what the *widget* sends — a raw HTTP caller
 * hitting these unauthenticated server functions directly can send anything
 * in the JSON body, so `role`/`content` must be checked at runtime, not
 * just declared in an interface.
 */

export const MAX_MESSAGE_LENGTH = 800;
/** 6 user/assistant exchanges. */
export const MAX_HISTORY_ENTRIES = 12;
/** Hard cap on the raw input array length, checked before any trimming, so an oversized payload is rejected outright rather than processed. */
const MAX_RAW_HISTORY_ENTRIES = 100;

export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

/**
 * Validates and normalizes a caller-supplied `history` value. Throws a
 * plain `Error` (surfaced by the enclosing `inputValidator` as a rejected
 * request) for anything malformed, rather than silently coercing it.
 */
export function validateHistory(input: unknown): HistoryEntry[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("history must be an array");
  if (input.length > MAX_RAW_HISTORY_ENTRIES) {
    throw new Error(`history must contain at most ${MAX_RAW_HISTORY_ENTRIES} entries`);
  }

  const cleaned: HistoryEntry[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") {
      throw new Error("each history entry must be an object");
    }
    const role = (entry as Record<string, unknown>)["role"];
    const content = (entry as Record<string, unknown>)["content"];
    if (role !== "user" && role !== "assistant") {
      throw new Error('each history entry\'s role must be "user" or "assistant"');
    }
    if (typeof content !== "string") {
      throw new Error("each history entry's content must be a string");
    }
    cleaned.push({ role, content: content.slice(0, MAX_MESSAGE_LENGTH) });
  }

  // Keep only the most recent turns — bounds both the prompt size sent to
  // the LLM and the token cost of any single request.
  return cleaned.slice(-MAX_HISTORY_ENTRIES);
}

/** Validates the free-text `message` field shared by both public endpoints. */
export function validateMessage(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("A message is required");
  }
  return input.trim().slice(0, MAX_MESSAGE_LENGTH);
}
