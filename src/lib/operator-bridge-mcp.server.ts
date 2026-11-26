import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  BridgeError,
  getWorkOrder,
  listWorkOrders,
  reportBlocker,
  reportToolsCreated,
  submitAgentResult,
  type BridgeAuth,
  type WorkOrderDeps,
} from "./operator-bridge.server.ts";

/**
 * Minimal MCP server (Streamable HTTP, JSON responses only, stateless) for the
 * operator bridge; see operator-bridge.server.ts for the model. No tool ever returns a
 * credential: everything returned here enters the operator's AI model context.
 * Only what the MCP spec needs for tools is implemented: initialize, ping,
 * tools/list, tools/call.
 */

type Admin = SupabaseClient<Database>;
type Json = Record<string, unknown>;

export const BRIDGE_TOOLS = [
  {
    name: "list_agent_work_orders",
    description:
      "List ClickAI customers whose voice agent still has to be built in Sarvam. Returns work order ids.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_agent_work_order",
    description:
      "Everything needed to build one customer's Sarvam agent: exact name, template agent id, prompt, HTTP tools, voice, languages, a fingerprint, and the steps to follow.",
    inputSchema: {
      type: "object",
      properties: { workOrderId: { type: "string" } },
      required: ["workOrderId"],
      additionalProperties: false,
    },
  },
  {
    name: "report_blocker",
    description:
      "Stop cleanly when you cannot continue, e.g. Sarvam MCP authentication is missing or expired (reason sarvam_auth_required). ClickAI marks the job waiting for the operator, shows it in the admin page, and does not retry. Call this instead of looping.",
    inputSchema: {
      type: "object",
      properties: {
        workOrderId: { type: "string" },
        reason: { type: "string", enum: ["sarvam_auth_required", "other"] },
        message: { type: "string" },
      },
      required: ["workOrderId", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "report_tools_created",
    description:
      "Report that the customer's agent was cloned from the COMMITTED master version and all six ClickAI tools were created on it (no credentials; the MCP cannot set them). ClickAI shows the job as waiting for tool authentication with this agent id. Call it BEFORE the credentials are selected in the Sarvam console and before committing. Safe to repeat for the same agent.",
    inputSchema: {
      type: "object",
      properties: {
        workOrderId: { type: "string" },
        agentId: { type: "string" },
        clonedFrom: {
          type: "object",
          properties: { agentId: { type: "string" }, version: { type: "integer", minimum: 1 } },
          required: ["agentId", "version"],
          additionalProperties: false,
        },
        tools: { type: "array", items: { type: "string" }, minItems: 6, maxItems: 6 },
      },
      required: ["workOrderId", "agentId", "clonedFrom", "tools"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_agent_result",
    description:
      "Report the COMMITTED Sarvam agent (id + version) after report_tools_created, after the credentials were selected on the draft in the Sarvam console and the committed version was read back showing a credential on all six tools. ClickAI registers it and continues provisioning (deployment, number routing, verification, activation). Safe to repeat.",
    inputSchema: {
      type: "object",
      properties: {
        workOrderId: { type: "string" },
        agentId: { type: "string" },
        version: { type: "integer", minimum: 1 },
        fingerprint: { type: "string" },
        toolAuth: {
          type: "array",
          description:
            "Read back from the COMMITTED version: one entry per tool with the credential type it shows (bearer, api_key or basic). Never include a secret value.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              authType: { type: "string", enum: ["bearer", "api_key", "basic", "none"] },
            },
            required: ["name", "authType"],
            additionalProperties: false,
          },
          minItems: 6,
          maxItems: 6,
        },
      },
      required: ["workOrderId", "agentId", "version", "fingerprint", "toolAuth"],
      additionalProperties: false,
    },
  },
];

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const text = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export const AUTH_FAILURE_MESSAGE: Record<string, string> = {
  missing: "Missing bridge token.",
  invalid: "Invalid bridge token.",
  expired: "The bridge token has expired. Ask a ClickAI admin to create a new one and reconnect.",
  revoked: "The bridge token was revoked. Ask a ClickAI admin to create a new one.",
};

/** Returns null for notifications (HTTP 202, no body). */
export async function handleBridgeRpc(
  admin: Admin,
  auth: Extract<BridgeAuth, { ok: true }>,
  deps: WorkOrderDeps,
  body: unknown,
): Promise<Json | null> {
  const req = body as { jsonrpc?: string; id?: unknown; method?: string; params?: Json };
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string")
    return rpcError(null, -32600, "Invalid request");
  if (req.method.startsWith("notifications/")) return null;
  switch (req.method) {
    case "initialize":
      return ok(req.id, {
        protocolVersion:
          typeof req.params?.["protocolVersion"] === "string"
            ? req.params["protocolVersion"]
            : "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "clickai-operator-bridge", version: "1.0.0" },
        instructions:
          "Build customer voice agents in Sarvam from ClickAI work orders. Start with list_agent_work_orders.",
      });
    case "ping":
      return ok(req.id, {});
    case "tools/list":
      return ok(req.id, { tools: BRIDGE_TOOLS });
    case "tools/call": {
      const name = req.params?.["name"];
      const args = (req.params?.["arguments"] ?? {}) as Json;
      const id = typeof args["workOrderId"] === "string" ? args["workOrderId"] : "";
      try {
        if (name === "list_agent_work_orders") return ok(req.id, text(await listWorkOrders(admin)));
        if (!BRIDGE_TOOLS.some((t) => t.name === name))
          return rpcError(req.id, -32602, "Unknown tool");
        if (!id)
          return ok(req.id, text({ error: "invalid", message: "workOrderId is required" }, true));
        if (name === "get_agent_work_order")
          return ok(req.id, text(await getWorkOrder(admin, id, deps)));
        if (name === "report_blocker")
          return ok(
            req.id,
            text(
              await reportBlocker(
                admin,
                {
                  workOrderId: id,
                  reason: String(args["reason"] ?? "other"),
                  message: typeof args["message"] === "string" ? args["message"] : undefined,
                },
                auth,
              ),
            ),
          );
        if (name === "report_tools_created") {
          const from = (args["clonedFrom"] ?? {}) as { agentId?: unknown; version?: unknown };
          return ok(
            req.id,
            text(
              await reportToolsCreated(
                admin,
                {
                  workOrderId: id,
                  appId: String(args["agentId"] ?? ""),
                  clonedFrom: {
                    agentId: String(from.agentId ?? ""),
                    version: Number(from.version),
                  },
                  tools: args["tools"],
                },
                auth,
                deps,
              ),
            ),
          );
        }
        return ok(
          req.id,
          text(
            await submitAgentResult(
              admin,
              {
                workOrderId: id,
                appId: String(args["agentId"] ?? ""),
                version: Number(args["version"]),
                fingerprint: String(args["fingerprint"] ?? ""),
                toolAuth: args["toolAuth"],
              },
              auth,
              deps,
            ),
          ),
        );
      } catch (e) {
        if (e instanceof BridgeError)
          return ok(req.id, text({ error: e.code, message: e.message }, true));
        console.error("operator_bridge:tool_failed", (e as Error).message);
        return ok(
          req.id,
          text({ error: "internal", message: "Unexpected error; try again." }, true),
        );
      }
    }
    default:
      return rpcError(req.id, -32601, "Method not found");
  }
}
