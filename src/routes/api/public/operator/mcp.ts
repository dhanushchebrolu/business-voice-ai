import { createFileRoute } from "@tanstack/react-router";

/**
 * ClickAI operator bridge (MCP over HTTP, POST only). Authenticated by a
 * short-lived platform-admin bridge token; see operator-bridge.server.ts.
 */
export const Route = createFileRoute("/api/public/operator/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { authenticateBridge, defaultWorkOrderDeps } =
          await import("@/lib/operator-bridge.server");
        const { handleBridgeRpc, AUTH_FAILURE_MESSAGE } =
          await import("@/lib/operator-bridge-mcp.server");
        const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json", ...headers },
          });
        const auth = await authenticateBridge(supabaseAdmin, request.headers.get("authorization"));
        if (!auth.ok)
          return json({ error: "unauthorized", message: AUTH_FAILURE_MESSAGE[auth.reason] }, 401, {
            "www-authenticate": 'Bearer realm="clickai-operator-bridge"',
          });
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return json(
            { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
            400,
          );
        }
        const out = await handleBridgeRpc(supabaseAdmin, auth, await defaultWorkOrderDeps(), body);
        return out ? json(out) : new Response(null, { status: 202 });
      },
      GET: async () => new Response("POST only", { status: 405, headers: { allow: "POST" } }),
    },
  },
});
