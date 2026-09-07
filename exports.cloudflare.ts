/**
 * Nitro's documented mechanism (cloudflare-module preset, "Additional
 * Exports") for adding extra exports — such as a Durable Object class — to
 * the actual Cloudflare Worker entrypoint module. Nitro auto-detects this
 * file at the project root and includes its exports in the final build,
 * regardless of how the rest of the app's own modules get chunked.
 *
 * This is needed because src/server.ts (this project's TanStack Start SSR
 * entry, see vite.config.ts's `tanstackStart.server.entry: "server"`) is
 * bundled by Nitro as a lazily-imported SSR chunk, not as the Worker's
 * `main` script itself — a plain `export` from src/server.ts never reaches
 * the entry module Wrangler resolves `durable_objects.bindings[].class_name`
 * against (verified: after a production build, `CallSessionDurableObject`
 * only appeared in `.output/server/_ssr/*.mjs`, never in
 * `.output/server/index.mjs`, the file wrangler.json's `main` points at).
 *
 * See wrangler.json for the binding (`CALL_SESSION`) and migration this
 * class name is registered under, and
 * src/lib/telephony/call-session-durable-object.server.ts for what it does
 * and why it exists (production audit finding E1).
 */
export { CallSessionDurableObject } from "./src/lib/telephony/call-session-durable-object.server";
