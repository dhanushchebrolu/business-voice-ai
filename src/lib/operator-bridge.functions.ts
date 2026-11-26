import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPlatformAdmin, writeAudit } from "@/lib/platform-admin.server";

/**
 * Platform-admin control of the operator bridge (operator-bridge.server.ts):
 * create a short-lived token (one customer, one job, one agent role) for one's own MCP
 * client, see what is waiting, revoke. The raw token is returned once and never stored.
 */

export const getOperatorBridgeStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { listWorkOrders } = await import("@/lib/operator-bridge.server");
    const { AUTHORING_STATUS } = await import("@/lib/sarvam-agent-authoring-status");
    const now = new Date().toISOString();
    const [{ data: tokens, error }, workOrders] = await Promise.all([
      supabaseAdmin
        .from("operator_bridge_tokens")
        .select("id, token_prefix, expires_at, last_used_at, created_at, run_id, agent_role")
        .is("revoked_at", null)
        .gt("expires_at", now)
        .order("created_at", { ascending: false })
        .limit(10),
      listWorkOrders(supabaseAdmin),
    ]);
    if (error) throw error;
    return {
      endpoint: process.env["TELEPHONY_WEBHOOK_BASE_URL"]
        ? `${process.env["TELEPHONY_WEBHOOK_BASE_URL"].replace(/\/+$/, "")}/api/public/operator/mcp`
        : null,
      tokens: tokens ?? [],
      workOrders,
      authoring: AUTHORING_STATUS,
    };
  });

export const issueOperatorBridgeToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { runId: string; role: "inbound" | "outbound"; reason: string }) => {
    if (!input?.runId) throw new Error("runId is required");
    // The role the admin saw: refused if the job has moved to the other agent since.
    if (input.role !== "inbound" && input.role !== "outbound") throw new Error("role is required");
    if (!input.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { issueBridgeToken } = await import("@/lib/operator-bridge.server");
    const issued = await issueBridgeToken(supabaseAdmin, {
      createdBy: context.userId,
      runId: data.runId,
      role: data.role,
    });
    await writeAudit(admin, {
      action: "OPERATOR_BRIDGE_TOKEN_ISSUED",
      entityType: "operator_bridge_token",
      organizationId: issued.organizationId,
      newValue: {
        token_prefix: issued.prefix,
        expires_at: issued.expiresAt,
        run_id: issued.runId,
        agent_role: issued.role,
      },
      reason: data.reason,
    });
    // The only time the raw token leaves the server.
    return issued;
  });

export const revokeOperatorBridgeTokens = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { reason: string }) => {
    if (!input?.reason?.trim()) throw new Error("A reason is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const admin = await assertPlatformAdmin(context.supabase, context.userId, "agents.write");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { revokeBridgeTokens } = await import("@/lib/operator-bridge.server");
    const revoked = await revokeBridgeTokens(supabaseAdmin);
    await writeAudit(admin, {
      action: "OPERATOR_BRIDGE_TOKENS_REVOKED",
      entityType: "operator_bridge_token",
      newValue: { revoked },
      reason: data.reason,
    });
    return { revoked };
  });
