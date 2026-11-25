import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Customer-selectable outbound concurrency (migration 20261202090000). The stored choice is
 * checked here for the customer's message, and again by the database where each call is
 * written, so this is never the only enforcement.
 */

async function orgFor(
  context: { supabase: unknown; userId: string },
  organizationId: string,
  change: boolean,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { requireRole } = await import("@/lib/outbound-authorization.server");
  await requireRole(
    { supabase: context.supabase as typeof supabaseAdmin, supabaseAdmin },
    context.userId,
    organizationId,
    change,
    "Workspace not found.",
  );
  return supabaseAdmin;
}

const needOrg = (input: { organizationId?: string }) => {
  if (!input?.organizationId) throw new Error("organizationId is required");
};

/** The workspace's outbound allowance and what it is using now (any member). */
export const getOutboundConcurrency = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { organizationId: string }) => {
    needOrg(input);
    return input;
  })
  .handler(async ({ data, context }) => {
    const db = await orgFor(context, data.organizationId, false);
    const { readOrgConcurrency } = await import("@/lib/outbound-concurrency.server");
    return readOrgConcurrency(db, data.organizationId);
  });

/** Changes the choice (owner or admin). Calls already running are never ended. */
export const setOutboundConcurrency = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { organizationId: string; value: number }) => {
    needOrg(input);
    return input;
  })
  .handler(async ({ data, context }) => {
    const db = await orgFor(context, data.organizationId, true);
    const { saveOrgConcurrency } = await import("@/lib/outbound-concurrency.server");
    return saveOrgConcurrency(db, {
      organizationId: data.organizationId,
      userId: context.userId,
      value: data.value,
    });
  });

/** Platform usage and every customer's choice, activity and limit (platform admins). */
export const getConcurrencyOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { assertPlatformAdmin } = await import("@/lib/platform-admin.server");
    await assertPlatformAdmin(context.supabase, context.userId, "customers.read");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { readConcurrencyOverview } = await import("@/lib/outbound-concurrency.server");
    return readConcurrencyOverview(supabaseAdmin);
  });
