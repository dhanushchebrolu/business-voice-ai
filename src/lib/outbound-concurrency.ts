/**
 * Customer-selectable outbound concurrency (migration 20261202090000).
 *
 * The platform has one limit L on simultaneous Sarvam calls. A customer chooses how many of
 * those their OUTBOUND calls may use; the remainder stays free for incoming calls:
 *
 *   cap              = min(max(choice or 2, 1), L)      so it follows L if the platform limit moves
 *   reserved inbound = L - cap
 *
 * The database enforces this where each call is written (enforce_outbound_concurrency); this
 * module is the same arithmetic for choosing, validating and describing it.
 */
export const DEFAULT_OUTBOUND_CONCURRENCY = 2;
/** Most choices the customer is offered, however high the platform limit goes. */
export const MAX_OFFERED_CONCURRENCY = 10;

export const effectiveCap = (selected: number | null | undefined, limit: number): number =>
  Math.min(Math.max(selected ?? DEFAULT_OUTBOUND_CONCURRENCY, 1), Math.max(limit, 1));

/** The choices offered at the current platform limit: 1 up to L. */
export function concurrencyOptions(limit: number): number[] {
  const top = Math.min(Math.max(Math.floor(limit), 1), MAX_OFFERED_CONCURRENCY);
  return Array.from({ length: top }, (_, i) => i + 1);
}

export interface OrgConcurrency {
  /** What the customer chose, or null: they have not chosen and the default applies. */
  selected: number | null;
  /** The limit actually enforced for their outbound calls. */
  cap: number;
  /** The platform-wide limit. */
  slotLimit: number;
  /** Calls running on the whole account right now (every customer's outbound plus live inbound). */
  globalInUse: number;
  /** This customer's outbound calls running now. */
  activeOutbound: number;
  /** How many more outbound calls may start right now (their cap and the free platform slots). */
  remaining: number;
  /** Slots kept clear of this customer's outbound calls, for incoming calls. */
  reservedInbound: number;
  options: number[];
  defaultValue: number;
}

const whole = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : 0);

/** outbound_org_concurrency's row, as the page uses it. */
export function parseOrgConcurrency(
  row: Record<string, unknown> | null | undefined,
): OrgConcurrency {
  const slotLimit = Math.max(whole(row?.["slot_limit"]) || 4, 1);
  const selected = typeof row?.["selected"] === "number" ? (row["selected"] as number) : null;
  return {
    selected,
    cap: effectiveCap(selected, slotLimit),
    slotLimit,
    globalInUse: whole(row?.["global_in_use"]),
    activeOutbound: whole(row?.["active_outbound"]),
    remaining: whole(row?.["remaining"]),
    reservedInbound: whole(row?.["reserved_inbound"]),
    options: concurrencyOptions(slotLimit),
    defaultValue: Math.min(DEFAULT_OUTBOUND_CONCURRENCY, slotLimit),
  };
}

export type SelectionCheck = { ok: true; value: number } | { ok: false; message: string };

export function validateSelection(value: unknown, limit: number): SelectionCheck {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1)
    return { ok: false, message: "Choose a whole number of calls, 1 or more." };
  const options = concurrencyOptions(limit);
  if (!options.includes(n))
    return {
      ok: false,
      message: `Choose between 1 and ${options.at(-1)} simultaneous outbound calls. ClickAI's current capacity is ${limit}.`,
    };
  return { ok: true, value: n };
}

export const EXPLANATION =
  "Choose how many outbound calls can run simultaneously. The remaining capacity is reserved for incoming calls.";

/** What changing the setting does to calls already running (they are never ended). */
export function changeNote(activeOutbound: number, newCap: number): string | null {
  return activeOutbound > newCap
    ? `${activeOutbound} outbound calls are running now. They will finish normally; no new outbound call starts until fewer than ${newCap} are running.`
    : null;
}

export const orgBusyMessage = (cap: number) =>
  `Your outbound limit of ${cap} simultaneous ${cap === 1 ? "call" : "calls"} is reached. The next call starts when one finishes. You can change the limit in your campaign settings.`;

/** The refused insert's own words: "ORG_CONCURRENCY_LIMIT: 2 of 2 outbound calls are running". */
export function orgLimitFromError(message: string): number | null {
  const m = /ORG_CONCURRENCY_LIMIT: \d+ of (\d+)/.exec(message);
  return m ? Number(m[1]) : null;
}
