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
    /** Primary LLM: Claude through LiveKit's Anthropic plugin (the app's existing provider). */
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    CLAUDE_MODEL: z.string().default("claude-sonnet-4-6"),
    /** Optional fallback LLM: any OpenAI-compatible endpoint with tool calling. */
    FALLBACK_LLM_BASE_URL: z.string().url().optional(),
    FALLBACK_LLM_API_KEY: z.string().optional(),
    FALLBACK_LLM_MODEL: z.string().optional(),
    MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(1).max(200).default(8),
    HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8081),
    DRAIN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(3_600_000)
      .default(15 * 60_000),
    KLYRO_TIMEOUT_MS: z.coerce.number().int().min(500).max(20_000).default(4000),
    SILENCE_TIMEOUT_S: z.coerce.number().min(5).max(120).default(15),
    MAX_CALL_SECONDS: z.coerce.number().int().min(60).max(7200).default(1800),
    TURN_DETECTION: z.enum(["multilingual", "vad"]).default("multilingual"),
  })
  .superRefine((e, ctx) => {
    if (!e.ANTHROPIC_API_KEY && !e.FALLBACK_LLM_BASE_URL) {
      ctx.addIssue({
        code: "custom",
        message: "an LLM is required: ANTHROPIC_API_KEY or FALLBACK_LLM_BASE_URL",
      });
    }
    if (e.APP_ENV !== "development") {
      if (!e.LIVEKIT_URL.startsWith("wss://"))
        ctx.addIssue({ code: "custom", message: "LIVEKIT_URL must be wss:// outside development" });
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
