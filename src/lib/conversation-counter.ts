/** The public conversation-time counter: the wire shape and the arithmetic the page runs each second. */
export interface ConversationStats {
  /** Connected seconds of every finished call, all organizations. */
  completedSeconds: number;
  /** Calls connected right now. */
  activeCalls: number;
  /** Seconds those calls had been connected when the server read them. */
  activeElapsedSeconds: number;
}

const wholeNumber = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;

/** Accepts only the three numbers; anything else (a failed or odd response) is null, never a guess. */
export function parseConversationStats(body: unknown): ConversationStats | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const completedSeconds = wholeNumber(b["completedSeconds"]);
  const activeCalls = wholeNumber(b["activeCalls"]);
  const activeElapsedSeconds = wholeNumber(b["activeElapsedSeconds"]);
  if (completedSeconds === null || activeCalls === null || activeElapsedSeconds === null)
    return null;
  return { completedSeconds, activeCalls, activeElapsedSeconds };
}

/**
 * The total to show `sinceFetchSeconds` after the stats were read. Time is
 * measured on the visitor's own clock since the fetch, so timezone and clock
 * skew never matter. Each active call adds one second per second; a finished
 * call is already in completedSeconds and no longer active, so nothing is
 * counted twice.
 */
export function projectSeconds(stats: ConversationStats, sinceFetchSeconds: number): number {
  const since = Math.max(0, Math.floor(sinceFetchSeconds));
  return stats.completedSeconds + stats.activeElapsedSeconds + stats.activeCalls * since;
}

export const formatSeconds = (n: number) => Math.floor(n).toLocaleString("en-US");
