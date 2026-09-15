// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { loadEnv, type Plugin } from "vite";

/**
 * Build-time guard for the two Supabase variables the browser bundle has no
 * runtime fallback for. client.ts's fallback chain is
 * `import.meta.env['VITE_SUPABASE_URL'] || process.env['SUPABASE_URL']` —
 * but Vite statically replaces bare `process.env` with `{}` in the client
 * build (there is no real process.env in a browser), so that fallback is
 * dead code there. The browser bundle depends entirely on
 * VITE_SUPABASE_URL/VITE_SUPABASE_PUBLISHABLE_KEY being present the moment
 * `vite build` runs, baked in as literal strings — nothing set afterward
 * (a Cloudflare Worker runtime variable, a dashboard secret) can fix an
 * already-built bundle. Missing either one previously surfaced only when a
 * real visitor tried to sign in, as a generic "Application configuration is
 * incomplete." toast (client.ts's own runtime guard, unchanged — this is
 * purely an earlier, build-time trip of the same wire). This plugin catches
 * it in whatever CI/build pipeline produced the artifact instead.
 *
 * VITE_SUPABASE_PROJECT_ID is deliberately NOT checked here: nothing in
 * src/ reads it (grepped — only .env.example documents the name), so
 * requiring it would be validating a variable production code doesn't
 * demonstrably need.
 *
 * Scoped to `command === "build"` only — `vite dev` (both local development
 * and Lovable's own preview) is untouched. Those environments source these
 * values differently (an auto-provisioned `.env`/`.env.local`), and
 * client.ts's existing runtime guard already degrades gracefully there
 * without needing a hard block.
 *
 * Reads via Vite's own `loadEnv` — the exact call
 * @lovable.dev/vite-tanstack-config's own VITE_* injection already makes
 * internally (`loadEnv(mode, process.cwd(), "VITE_")`) — rather than raw
 * `process.env`, so this stays correct for a value sourced from a
 * `.env`/`.env.local` file rather than an exported shell variable; checking
 * `process.env` directly would false-positive for that common local setup.
 */
function validateSupabasePublicEnv(): Plugin {
  return {
    name: "validate-supabase-public-env",
    config(_config, { command, mode }) {
      if (command !== "build") return;

      const env = loadEnv(mode, process.cwd(), "VITE_");
      const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"] as const;
      const missing = required.filter((name) => !env[name]);
      if (missing.length === 0) return;

      // Names only, never a value — safe to print in a build log.
      throw new Error(
        `Build-time environment variable(s) missing: ${missing.join(", ")}. ` +
          "These must be set as BUILD-TIME environment variables in the Cloudflare " +
          "Workers Build project's build configuration — NOT as Worker runtime " +
          '"Variables and Secrets", which only takes effect after the build has ' +
          "already run and cannot fix an already-built client bundle. See " +
          "DEPLOYMENT.md. Left unset, every sign-in attempt on the deployed site " +
          'fails with "Application configuration is incomplete."',
      );
    },
  };
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  plugins: [validateSupabasePublicEnv()],
});
