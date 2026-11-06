/**
 * Environment configuration, validated at start-up (the process refuses to
 * start on a bad config rather than failing on the first call). Secrets are
 * read from the environment only; this module never logs their values.
 */
import { z } from "zod";

const Env = z
  .object({
    APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
    LIVEKIT_URL: z.string().url(),
    /** Self-hosted LiveKit only: exact hosts allowed besides *.livekit.cloud (comma-separated). */
    LIVEKIT_ALLOWED_HOSTS: z.string().max(1000).optional(),
    LIVEKIT_API_KEY: z.string().min(1),
    LIVEKIT_API_SECRET: z.string().min(16),
    SARVAM_API_KEY: z.string().min(1),
    KLYRO_BASE_URL: z.string().url(),
    VOICE_AGENT_HMAC_SECRET: z.string().min(32),
    VOICE_AGENT_HMAC_KEY_ID: z.enum(["current", "previous"]).default("current"),
    AGENT_NAME: z
      .string()
      .regex(/^[a-z0-9-]{3,64}$/)
      .default("clickai-receptionist"),
    /**
     * Which LLM answers calls. Explicit, with no cross-provider fallback:
     *  - "sarvam": Sarvam chat completions (SARVAM_API_KEY) only. The target
     *    architecture; Anthropic and FALLBACK_LLM_* are never used.
     *  - "anthropic": the pre-2.18 setup (Claude, optional OpenAI-compatible
     *    fallback), kept only until Sarvam passes acceptance (PRODUCTION_READINESS.md §16).
     */
    LLM_PROVIDER: z.enum(["sarvam", "anthropic"]).default("anthropic"),
    SARVAM_LLM_MODEL: z
      .enum(["sarvam-105b-conversations", "sarvam-105b"])
      .default("sarvam-105b-conversations"),
    /** Development/test override only; outside development it must be https://api.sarvam.ai/v1. */
    SARVAM_LLM_BASE_URL: z.string().url().default("https://api.sarvam.ai/v1"),
    /** Sent as reasoning_effort only when set (unverified against Sarvam; benchmark first). */
    SARVAM_LLM_REASONING_EFFORT: z.enum(["low", "medium", "high"]).optional(),
    /** Primary LLM when LLM_PROVIDER=anthropic: Claude through LiveKit's Anthropic plugin. */
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    CLAUDE_MODEL: z.string().default("claude-sonnet-4-6"),
    /** Optional fallback LLM: any OpenAI-compatible endpoint with tool calling. */
    FALLBACK_LLM_BASE_URL: z.string().url().optional(),
    FALLBACK_LLM_API_KEY: z.string().optional(),
    FALLBACK_LLM_MODEL: z.string().optional(),
    MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(1).max(200).default(8),
    HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8081),
    /**
     * How long SIGTERM waits for active calls. Must cover the longest
     * possible call (MAX_CALL_SECONDS) plus a margin, or a call in progress
     * at shutdown is cut off (checked below). The pod's
     * terminationGracePeriodSeconds must exceed DRAIN_TIMEOUT_MS + 30 s (the
     * shutdown watchdog's hard cap); tests/runtime.spec.ts checks the k8s
     * manifest against the defaults.
     */
    DRAIN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(3_600_000)
      .default(31 * 60_000),
    KLYRO_TIMEOUT_MS: z.coerce.number().int().min(500).max(20_000).default(4000),
    SILENCE_TIMEOUT_S: z.coerce.number().min(5).max(120).default(15),
    MAX_CALL_SECONDS: z.coerce.number().int().min(60).max(7200).default(1800),
    TURN_DETECTION: z.enum(["multilingual", "vad"]).default("multilingual"),
    /** LiveKit outbound trunk (provision:sip creates "clickai-vobiz-outbound"); unset = no outbound. */
    SIP_OUTBOUND_TRUNK_ID: z.string().min(3).max(64).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.MAX_CALL_SECONDS * 1000 + 60_000 > e.DRAIN_TIMEOUT_MS) {
      ctx.addIssue({
        code: "custom",
        message:
          "DRAIN_TIMEOUT_MS must be at least MAX_CALL_SECONDS + 60 s, or calls in progress at shutdown are cut off",
      });
    }
    if (e.LLM_PROVIDER === "anthropic" && !e.ANTHROPIC_API_KEY && !e.FALLBACK_LLM_BASE_URL) {
      ctx.addIssue({
        code: "custom",
        message: "an LLM is required: ANTHROPIC_API_KEY or FALLBACK_LLM_BASE_URL",
      });
    }
    if (e.LLM_PROVIDER === "sarvam" && e.FALLBACK_LLM_BASE_URL) {
      // Sarvam-only: refuse a configured fallback rather than silently ignore it.
      ctx.addIssue({
        code: "custom",
        message: "FALLBACK_LLM_BASE_URL must not be set when LLM_PROVIDER=sarvam (no LLM fallback)",
      });
    }
    if (e.APP_ENV !== "development" && e.SARVAM_LLM_BASE_URL !== "https://api.sarvam.ai/v1") {
      // SARVAM_API_KEY is sent to this URL.
      ctx.addIssue({
        code: "custom",
        message: "SARVAM_LLM_BASE_URL must be https://api.sarvam.ai/v1 outside development",
      });
    }
    if (e.APP_ENV !== "development") {
      if (!e.LIVEKIT_URL.startsWith("wss://"))
        ctx.addIssue({ code: "custom", message: "LIVEKIT_URL must be wss:// outside development" });
      // F13: the worker sends LIVEKIT_API_KEY-signed tokens to this host.
      let host = "";
      let extra = false;
      try {
        const u = new URL(e.LIVEKIT_URL);
        host = u.hostname.toLowerCase();
        extra = !!(
          u.username ||
          u.password ||
          (u.pathname && u.pathname !== "/") ||
          u.search ||
          u.hash
        );
      } catch {
        /* reported by z.string().url() */
      }
      const allowed = (e.LIVEKIT_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
      const cloud = host.endsWith(".livekit.cloud") && host.length > ".livekit.cloud".length;
      if (host && !cloud && !allowed.includes(host))
        ctx.addIssue({
          code: "custom",
          message: "LIVEKIT_URL host must be *.livekit.cloud or listed in LIVEKIT_ALLOWED_HOSTS",
        });
      if (extra)
        ctx.addIssue({
          code: "custom",
          message: "LIVEKIT_URL must not contain credentials, a path, query or fragment",
        });
      if (!e.KLYRO_BASE_URL.startsWith("https://"))
        ctx.addIssue({
          code: "custom",
          message: "KLYRO_BASE_URL must be https:// outside development",
        });
    }
    if (e.APP_ENV === "production" && /localhost|127\.0\.0\.1/.test(e.KLYRO_BASE_URL)) {
      ctx.addIssue({ code: "custom", message: "KLYRO_BASE_URL points at localhost in production" });
    }
  });

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    // Names and messages only: never echo values (they may be secrets).
    const problems = r.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`);
    throw new Error(`invalid configuration:\n  ${problems.join("\n  ")}`);
  }
  return r.data;
}
