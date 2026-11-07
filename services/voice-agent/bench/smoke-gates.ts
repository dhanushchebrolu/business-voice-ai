/**
 * Phase 2.19 smoke-test gates (bench/sarvam-smoke.ts), as a pure function so
 * every refusal is covered offline by tests/sarvam-smoke-gates.spec.ts.
 * Reasons name settings, never values.
 *
 * Auth mode (SARVAM_SMOKE_AUTH_MODE), never inferred:
 *   unset or "api-key"   SARVAM_API_KEY is required and sent as api-subscription-key.
 *   "proxy-injected"     this process holds no key. SARVAM_API_KEY must be unset
 *                        (no placeholder or fake key), and requests go through the
 *                        egress proxy that adds api-subscription-key for api.sarvam.ai:
 *                        HTTPS_PROXY must be set, NO_PROXY must not bypass
 *                        api.sarvam.ai, and NODE_USE_ENV_PROXY=1 is required
 *                        because Node's built-in fetch ignores HTTPS_PROXY without it.
 */
import type { SarvamAuth } from "../src/agent/sarvam-llm.ts";

export const SMOKE_MAX_BUDGET_INR = 50;

export type SmokeGates =
  { ok: true; auth: SarvamAuth; budgetInr: number; out: string } | { ok: false; reason: string };

type Env = Record<string, string | undefined>;

const set = (v: string | undefined) => v !== undefined && v !== "";

/** NO_PROXY entries that would send api.sarvam.ai around the proxy. */
export function noProxyBypassesSarvam(noProxy: string | undefined): boolean {
  return (noProxy ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase().replace(/:\d+$/, ""))
    .filter(Boolean)
    .some(
      (e) =>
        e === "*" ||
        e === "api.sarvam.ai" ||
        e === "sarvam.ai" ||
        e === ".sarvam.ai" ||
        e === "*.sarvam.ai",
    );
}

/** NODE_USE_ENV_PROXY is honoured from Node 22.21 / 24.5. */
export function nodeSupportsEnvProxy(version: string): boolean {
  const [maj = 0, min = 0] = version.replace(/^v/, "").split(".").map(Number);
  return maj > 24 || (maj === 24 && min >= 5) || (maj === 22 && min >= 21) || maj === 23;
}

export function resolveSmokeGates(
  env: Env,
  argv: readonly string[],
  nodeVersion: string = process.version,
): SmokeGates {
  const no = (reason: string): SmokeGates => ({ ok: false, reason });

  if (env.SARVAM_SMOKE_APPROVED !== "yes")
    return no("this makes paid Sarvam calls; set SARVAM_SMOKE_APPROVED=yes once approved.");

  const mode = env.SARVAM_SMOKE_AUTH_MODE || "api-key";
  let auth: SarvamAuth;
  if (mode === "api-key") {
    const key = env.SARVAM_API_KEY ?? "";
    if (!key.trim()) return no("SARVAM_API_KEY is not set.");
    auth = { mode: "api-key", apiKey: key };
  } else if (mode === "proxy-injected") {
    if (env.SARVAM_API_KEY !== undefined)
      return no(
        "unset SARVAM_API_KEY: in proxy-injected mode the network proxy supplies the key, and no local or placeholder key is used.",
      );
    if (!set(env.HTTPS_PROXY) && !set(env.https_proxy))
      return no("proxy-injected mode needs HTTPS_PROXY (the proxy that injects the Sarvam key).");
    if (noProxyBypassesSarvam(env.NO_PROXY) || noProxyBypassesSarvam(env.no_proxy))
      return no("NO_PROXY bypasses api.sarvam.ai, so the proxy could not inject the key.");
    if (env.NODE_USE_ENV_PROXY !== "1")
      return no(
        "proxy-injected mode needs NODE_USE_ENV_PROXY=1: Node's built-in fetch ignores HTTPS_PROXY without it.",
      );
    if (!nodeSupportsEnvProxy(nodeVersion))
      return no("NODE_USE_ENV_PROXY needs Node >= 22.21 (or >= 24.5).");
    auth = { mode: "proxy-injected" };
  } else {
    return no("SARVAM_SMOKE_AUTH_MODE must be api-key or proxy-injected.");
  }

  const budgetInr = Number(env.SARVAM_SMOKE_BUDGET_INR);
  if (
    !set(env.SARVAM_SMOKE_BUDGET_INR) ||
    !Number.isFinite(budgetInr) ||
    budgetInr <= 0 ||
    budgetInr > SMOKE_MAX_BUDGET_INR
  )
    return no(
      "SARVAM_SMOKE_BUDGET_INR must be the approved cap, between 1 and 50 (Phase 2.19 approval).",
    );
  if (set(env.OPENAI_LOG))
    return no("unset OPENAI_LOG: the OpenAI SDK's debug log does not redact api-subscription-key.");
  const outIdx = argv.indexOf("--out");
  const out = outIdx > 0 ? argv[outIdx + 1] : undefined;
  if (!out || out.startsWith("--")) return no("--out <file.json> is required.");
  return { ok: true, auth, budgetInr, out };
}
