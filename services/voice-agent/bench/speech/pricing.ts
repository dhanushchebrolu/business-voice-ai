/**
 * Prices and the spending ledger for the speech harness.
 *
 * Prices are NEVER defaulted: each must be entered at runtime from Sarvam's
 * pricing page (https://docs.sarvam.ai/api/getting-started/pricing, prices
 * exclude GST). The GST rate is also entered (Sarvam does not state it).
 *
 * Billing model (conservative):
 *  - TTS: per character, counted as UTF-16 code units (>= Unicode code
 *    points, so never under-counts), at the model's own rate;
 *  - STT: per second, each request's audio rounded UP to a whole second;
 *  - every attempt that may have reached Sarvam is charged in full, even if
 *    it failed (5xx, timeout, dropped socket, malformed reply), and each
 *    retry is a new charge. Only attempts refused locally before sending
 *    (guard, budget, network disabled) are free.
 *  - an attempt is allowed only if its full cost fits under the cap and the
 *    volume limits; otherwise the run stops before sending it.
 */

export const HARD_CAP_INR = 40;

export type TtsModel = "bulbul:v3" | "bulbul:v4-flash";
export type SttModel = "saaras:v3" | "saaras:v4";

export interface Prices {
  /** ₹ per minute of audio, excl. GST (same for saaras:v3 and v4 on the pricing page). */
  sttPerMinute: number;
  /** ₹ per 1,000 characters, excl. GST. */
  ttsPer1k: Record<TtsModel, number>;
  /** e.g. 0.18 */
  gstRate: number;
}

export const PRICE_ENV = {
  stt: "SARVAM_PRICE_STT_INR_PER_MIN",
  ttsV3: "SARVAM_PRICE_TTS_V3_INR_PER_1K_CHARS",
  ttsV4Flash: "SARVAM_PRICE_TTS_V4_FLASH_INR_PER_1K_CHARS",
  gst: "SARVAM_GST_RATE",
} as const;

type Env = Record<string, string | undefined>;

/** Strict decimal: "0.49", "3", "0.18". No defaults, no units, no expressions. */
function num(env: Env, name: string, min: number, max: number): number | string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "")
    return `${name} is required (enter it from Sarvam's pricing page)`;
  if (!/^\d+(?:\.\d+)?$/.test(raw.trim())) return `${name} must be a plain number`;
  const v = Number(raw);
  if (!(v >= min && v <= max)) return `${name} must be between ${min} and ${max}`;
  return v;
}

export function parsePrices(
  env: Env,
): { ok: true; prices: Prices } | { ok: false; reason: string } {
  const stt = num(env, PRICE_ENV.stt, 0.01, 10);
  const v3 = num(env, PRICE_ENV.ttsV3, 0.01, 50);
  const v4 = num(env, PRICE_ENV.ttsV4Flash, 0.01, 50);
  const gst = num(env, PRICE_ENV.gst, 0, 0.5);
  for (const v of [stt, v3, v4, gst]) if (typeof v === "string") return { ok: false, reason: v };
  return {
    ok: true,
    prices: {
      sttPerMinute: stt as number,
      ttsPer1k: { "bulbul:v3": v3 as number, "bulbul:v4-flash": v4 as number },
      gstRate: gst as number,
    },
  };
}

export const ttsChars = (text: string): number => text.length;
export const sttBillableSeconds = (durationSec: number): number =>
  Math.max(1, Math.ceil(durationSec));

/** Cost of one attempt, excl. GST. */
export function attemptCost(
  p: Prices,
  a: { kind: "tts"; model: TtsModel; chars: number } | { kind: "stt"; seconds: number },
): number {
  return a.kind === "tts"
    ? (a.chars / 1000) * p.ttsPer1k[a.model]
    : (sttBillableSeconds(a.seconds) / 60) * p.sttPerMinute;
}

export interface Limits {
  /** Hard cap incl. GST; never above HARD_CAP_INR. */
  capInclGst: number;
  ttsChars: Record<TtsModel, number>;
  sttSeconds: number;
  maxAttempts: number;
}

export type Attempt =
  { kind: "tts"; model: TtsModel; chars: number } | { kind: "stt"; seconds: number };

export class Ledger {
  readonly prices: Prices;
  readonly limits: Limits;
  spentExclGst = 0;
  billedAttempts = 0;
  freeAttempts = 0;
  ttsCharsUsed: Record<TtsModel, number> = { "bulbul:v3": 0, "bulbul:v4-flash": 0 };
  sttSecondsUsed = 0;

  constructor(prices: Prices, limits: Limits) {
    if (!(limits.capInclGst > 0) || limits.capInclGst > HARD_CAP_INR)
      throw new Error(`cap must be > 0 and <= ₹${HARD_CAP_INR} incl. GST`);
    this.prices = prices;
    this.limits = limits;
  }

  get spentInclGst(): number {
    return this.spentExclGst * (1 + this.prices.gstRate);
  }

  costInclGst(a: Attempt): number {
    return attemptCost(this.prices, a) * (1 + this.prices.gstRate);
  }

  /** Whether this attempt may be SENT. Checked before every attempt, retries included. */
  check(a: Attempt): { ok: true; costInclGst: number } | { ok: false; reason: string } {
    const cost = this.costInclGst(a);
    if (this.billedAttempts + 1 > this.limits.maxAttempts)
      return { ok: false, reason: `request limit reached (${this.limits.maxAttempts})` };
    // A tiny epsilon only absorbs float noise; it can never admit a real overshoot.
    if (this.spentInclGst + cost > this.limits.capInclGst + 1e-9)
      return {
        ok: false,
        reason: `spending cap: ₹${this.spentInclGst.toFixed(4)} spent + ₹${cost.toFixed(4)} would exceed ₹${this.limits.capInclGst} incl. GST`,
      };
    if (a.kind === "tts" && this.ttsCharsUsed[a.model] + a.chars > this.limits.ttsChars[a.model])
      return { ok: false, reason: `${a.model} character limit (${this.limits.ttsChars[a.model]})` };
    if (
      a.kind === "stt" &&
      this.sttSecondsUsed + sttBillableSeconds(a.seconds) > this.limits.sttSeconds
    )
      return { ok: false, reason: `STT seconds limit (${this.limits.sttSeconds})` };
    return { ok: true, costInclGst: cost };
  }

  /** Record an attempt that was SENT (or may have been): always billed in full. */
  billed(a: Attempt): void {
    this.spentExclGst += attemptCost(this.prices, a);
    this.billedAttempts++;
    if (a.kind === "tts") this.ttsCharsUsed[a.model] += a.chars;
    else this.sttSecondsUsed += sttBillableSeconds(a.seconds);
  }

  /** Record an attempt refused locally before sending (free). */
  notSent(): void {
    this.freeAttempts++;
  }
}
