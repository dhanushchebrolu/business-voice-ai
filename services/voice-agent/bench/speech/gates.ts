/**
 * Gates for a LIVE (paid) speech run. Every one must hold; reasons name
 * settings, never values. Offline modes (dry run, simulate) do not use these.
 *
 *   --live                         explicit live mode
 *   --confirm-plan <hash>          the hash printed by a dry run with the SAME prices and budget
 *   --out <dir>                    where results go
 *   SARVAM_SPEECH_APPROVED=yes     explicit approval
 *   SARVAM_SPEECH_BUDGET_INR       cap incl. GST, 1..40
 *   SARVAM_PRICE_*, SARVAM_GST_RATE  actual prices (pricing.ts); never defaulted
 *   SARVAM_SPEECH_AUTH_MODE        "proxy-injected" (no key in the process) or unset/"api-key"
 */
import type { SarvamAuth } from "../../src/agent/sarvam-llm.ts";
import { noProxyBypassesSarvam, nodeSupportsEnvProxy } from "../smoke-gates.ts";
import { HARD_CAP_INR, parsePrices, type Prices } from "./pricing.ts";

type Env = Record<string, string | undefined>;

export type SpeechGates =
  | { ok: true; auth: SarvamAuth; prices: Prices; budgetInr: number; out: string; confirm: string }
  | { ok: false; reason: string };

export function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

export function parseBudget(env: Env): number | string {
  const raw = env.SARVAM_SPEECH_BUDGET_INR;
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw.trim()))
    return `SARVAM_SPEECH_BUDGET_INR must be the approved cap incl. GST (1..${HARD_CAP_INR})`;
  const v = Number(raw);
  if (!(v >= 1 && v <= HARD_CAP_INR))
    return `SARVAM_SPEECH_BUDGET_INR must be between 1 and ${HARD_CAP_INR} (incl. GST)`;
  return v;
}

export function resolveSpeechAuth(
  env: Env,
  nodeVersion: string,
): { ok: true; auth: SarvamAuth } | { ok: false; reason: string } {
  const mode = env.SARVAM_SPEECH_AUTH_MODE || "api-key";
  if (mode === "api-key") {
    const key = env.SARVAM_API_KEY ?? "";
    if (!key.trim()) return { ok: false, reason: "SARVAM_API_KEY is not set (api-key mode)." };
    return { ok: true, auth: { mode: "api-key", apiKey: key } };
  }
  if (mode !== "proxy-injected")
    return { ok: false, reason: "SARVAM_SPEECH_AUTH_MODE must be api-key or proxy-injected." };
  if (env.SARVAM_API_KEY !== undefined)
    return {
      ok: false,
      reason: "unset SARVAM_API_KEY: in proxy-injected mode the network proxy supplies the key.",
    };
  if (!env.HTTPS_PROXY && !env.https_proxy)
    return { ok: false, reason: "proxy-injected mode needs HTTPS_PROXY." };
  if (noProxyBypassesSarvam(env.NO_PROXY) || noProxyBypassesSarvam(env.no_proxy))
    return {
      ok: false,
      reason: "NO_PROXY bypasses api.sarvam.ai, so the proxy could not inject the key.",
    };
  if (env.NODE_USE_ENV_PROXY !== "1")
    return {
      ok: false,
      reason:
        "proxy-injected mode needs NODE_USE_ENV_PROXY=1 (fetch and WebSocket ignore HTTPS_PROXY without it).",
    };
  if (!nodeSupportsEnvProxy(nodeVersion))
    return { ok: false, reason: "NODE_USE_ENV_PROXY needs Node >= 22.21 (or >= 24.5)." };
  return { ok: true, auth: { mode: "proxy-injected" } };
}

export function resolveSpeechGates(
  env: Env,
  argv: readonly string[],
  nodeVersion: string = process.version,
): SpeechGates {
  const no = (reason: string): SpeechGates => ({ ok: false, reason });
  if (!argv.includes("--live")) return no("not a live run (pass --live).");
  if (env.SARVAM_SPEECH_APPROVED !== "yes")
    return no("this makes paid Sarvam requests; set SARVAM_SPEECH_APPROVED=yes once approved.");
  const budget = parseBudget(env);
  if (typeof budget === "string") return no(budget);
  const prices = parsePrices(env);
  if (!prices.ok) return no(prices.reason);
  const auth = resolveSpeechAuth(env, nodeVersion);
  if (!auth.ok) return no(auth.reason);
  const out = argValue(argv, "--out");
  if (!out) return no("--out <dir> is required.");
  const confirm = argValue(argv, "--confirm-plan");
  if (!confirm)
    return no(
      "--confirm-plan <hash> is required (run a dry run with the same prices and budget to get it).",
    );
  return { ok: true, auth: auth.auth, prices: prices.prices, budgetInr: budget, out, confirm };
}
