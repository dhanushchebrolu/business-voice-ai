import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { handleExotelMediaUpgrade } from "./lib/telephony/exotel-media-route.server";
import {
  CALL_SESSION_COORDINATOR_NAME,
  type CloudflareEnv,
} from "./lib/telephony/cloudflare-env.server";

// The CallSessionDurableObject class itself is exported to the Cloudflare
// Worker entrypoint from ../exports.cloudflare.ts (Nitro's documented
// mechanism for this — see that file's comment for why it can't be
// re-exported from here: this file is bundled as a lazily-loaded SSR
// chunk, not Nitro's actual `main` entry module, so a normal `export`
// here never reaches the entry Wrangler resolves Durable Object class
// names against).

const MEDIA_STREAM_PATH = "/api/public/media-stream/exotel";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      // Phase D.1: Exotel's Voicebot Applet is the WebSocket *client* — it
      // connects to us. TanStack Start's route convention has no WebSocket
      // support (verified: neither @tanstack/react-start nor
      // @tanstack/start-server-core reference "websocket" anywhere in their
      // source), so this one path is intercepted here, at the raw
      // Cloudflare Workers fetch handler, before TanStack Start's own
      // request handling — see exotel-media-route.server.ts and
      // PHASE_D1_EXOTEL_FINAL_REPORT.md §16 for why this is the correct
      // and, on this deployment target, sufficient place to do it.
      //
      // Production audit finding E1: accepting and holding this WebSocket
      // directly in this ambient fetch handler is not durable on Cloudflare
      // Workers (no guarantee this isolate keeps running, or that a later,
      // separate webhook request lands here to terminate it correctly) —
      // see call-session-durable-object.server.ts. When the CALL_SESSION
      // Durable Object binding is configured, forward the upgrade request
      // to it unconditionally so it — not this ambient handler — accepts
      // and durably owns the WebSocket for the life of the call. Fall back
      // to the original in-process handling only when the binding isn't
      // configured (local `vite dev`, where there is no cross-isolate risk
      // in the first place, since it's a single process).
      const url = new URL(request.url);
      if (
        url.pathname === MEDIA_STREAM_PATH &&
        (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket"
      ) {
        const cfEnv = env as CloudflareEnv | null | undefined;
        const namespace = cfEnv?.CALL_SESSION;
        if (namespace) {
          const stub = namespace.get(namespace.idFromName(CALL_SESSION_COORDINATOR_NAME));
          return await stub.fetch(request);
        }
        const mediaUpgrade = await handleExotelMediaUpgrade(request);
        if (mediaUpgrade) return mediaUpgrade;
      }

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
